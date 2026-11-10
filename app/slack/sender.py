"""Slack outbox sender.

pending/retry -> sending -> sent | retry (429, definite errors) | unconfirmed (timeout/unknown) | failed.
'unconfirmed' is never auto-resent: Slack may have accepted it. Operators reconcile with
``python -m app.cli outbox``.
"""
from __future__ import annotations

import asyncio
import logging
import os
import socket
import sqlite3
import time
from datetime import datetime, timedelta, timezone
from typing import Protocol

from ..db.repo import Tx, iso, ops_event, utcnow
from .format import render

log = logging.getLogger(__name__)


class RateLimited(Exception):
    def __init__(self, retry_after: float):
        super().__init__(f"rate_limited {retry_after}s")
        self.retry_after = retry_after


class Definite(Exception):
    """Slack definitely did not post (API error response, connection refused, no token)."""


class Uncertain(Exception):
    """The request may have reached Slack (timeout, reset, unknown)."""


class Poster(Protocol):
    def post(self, token: str, channel: str, text: str) -> str: ...
    def update(self, token: str, channel: str, ts: str, text: str) -> None: ...


class SlackSdkPoster:
    def __init__(self, timeout: float = 10):
        self.timeout = timeout
        self._clients: dict[str, object] = {}

    def _client(self, token: str):
        from slack_sdk import WebClient

        if token not in self._clients:
            # retry_handlers=[]: the SDK's built-in connection retry could double-post.
            self._clients[token] = WebClient(token=token, timeout=self.timeout, retry_handlers=[])
        return self._clients[token]

    def _call(self, fn, **kw):
        import urllib.error

        from slack_sdk.errors import SlackApiError

        try:
            return fn(**kw)
        except SlackApiError as e:
            if e.response.status_code == 429:
                raise RateLimited(float(e.response.headers.get("Retry-After", 30))) from e
            raise Definite(str(e.response.get("error", "api_error"))) from e
        except urllib.error.URLError as e:
            if isinstance(e.reason, (ConnectionRefusedError, socket.gaierror)):
                raise Definite(type(e.reason).__name__) from e
            raise Uncertain(type(e.reason).__name__ if e.reason else "url_error") from e
        except (ConnectionRefusedError, socket.gaierror) as e:
            raise Definite(type(e).__name__) from e
        except Exception as e:  # timeouts, resets, anything else after the request may have left
            raise Uncertain(type(e).__name__) from e

    def post(self, token: str, channel: str, text: str) -> str:
        c = self._client(token)
        resp = self._call(
            c.chat_postMessage, channel=channel, text=text, mrkdwn=True, parse="none",
            link_names=False, unfurl_links=False, unfurl_media=False,
        )
        return resp["ts"]

    def update(self, token: str, channel: str, ts: str, text: str) -> None:
        c = self._client(token)
        self._call(c.chat_update, channel=channel, ts=ts, text=text, parse="none", link_names=False)


class SlackSender:
    def __init__(
        self,
        conn: sqlite3.Connection,
        poster: Poster,
        *,
        tokens: dict[str, str] | None = None,
        max_attempts: int = 5,
        min_interval_sec: float = 1.1,
        worker_id: str | None = None,
    ):
        self.conn = conn
        self.poster = poster
        self.tokens = tokens  # None -> read os.environ at send time
        self.max_attempts = max_attempts
        self.min_interval_sec = min_interval_sec
        self.worker_id = worker_id or f"sender-{os.getpid()}"
        self._blocked: dict[tuple[str, str], float] = {}  # (token_ref, channel) -> monotonic time allowed

    def _token(self, ref: str) -> str | None:
        return (self.tokens if self.tokens is not None else os.environ).get(ref)

    def recover(self) -> int:
        """Rows left in 'sending' by a crash may or may not have been posted: mark unconfirmed."""
        with Tx(self.conn):
            rows = self.conn.execute("SELECT id FROM slack_outbox WHERE status='sending'").fetchall()
            for r in rows:
                self.conn.execute(
                    "UPDATE slack_outbox SET status='unconfirmed', last_error='interrupted_while_sending', locked_by=NULL WHERE id=?",
                    (r["id"],),
                )
                ops_event(self.conn, "warning", "slack_unconfirmed", f"outbox {r['id']}: interrupted while sending")
        return len(rows)

    def _ready(self, key: tuple[str, str]) -> bool:
        return self._blocked.get(key, 0) <= time.monotonic()

    def _block(self, key: tuple[str, str], seconds: float) -> None:
        self._blocked[key] = time.monotonic() + seconds

    def _compose(self, message_id: int) -> tuple[str, bool]:
        m = self.conn.execute(
            """SELECT m.*, cv.display_name AS conv_name, c.name AS client_name FROM messages m
               JOIN conversations cv ON cv.id=m.conversation_id JOIN clients c ON c.id=m.client_id WHERE m.id=?""",
            (message_id,),
        ).fetchone()
        tr = self.conn.execute("SELECT status, lang, ko_text FROM translations WHERE message_id=?", (message_id,)).fetchone()
        return render(dict(m), m["conv_name"], m["client_name"], dict(tr) if tr else None)

    async def tick(self) -> int:
        now = utcnow()
        rows = self.conn.execute(
            """SELECT * FROM slack_outbox WHERE status IN ('pending','retry')
               AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY id LIMIT 50""",
            (now,),
        ).fetchall()
        done = 0
        for r in rows:
            key = (r["token_ref"], r["channel_id"])
            if not self._ready(key):
                continue
            claimed = self.conn.execute(
                """UPDATE slack_outbox SET status='sending', locked_by=?, locked_at=?
                   WHERE id=? AND status IN ('pending','retry')""",
                (self.worker_id, utcnow(), r["id"]),
            ).rowcount
            if not claimed:
                continue
            await self._send(r, key)
            done += 1
        done += await self._updates(now)
        return done

    async def _send(self, r: sqlite3.Row, key: tuple[str, str]) -> None:
        text, included = self._compose(r["message_id"])
        token = self._token(r["token_ref"])
        try:
            if not token:
                raise Definite(f"missing_token:{r['token_ref']}")
            ts = await asyncio.to_thread(self.poster.post, token, r["channel_id"], text)
        except RateLimited as e:
            self._block(key, e.retry_after)
            self._set(r["id"], status="retry", next_attempt_at=self._later(e.retry_after), last_error=str(e))
            return
        except Definite as e:
            attempts = r["attempts"] + 1
            final = attempts >= self.max_attempts
            self._set(
                r["id"], status="failed" if final else "retry", attempts=attempts, last_error=str(e)[:300],
                next_attempt_at=None if final else self._later(min(10 * 2 ** attempts, 900)),
            )
            if final:
                ops_event(self.conn, "error", "slack_failed", f"outbox {r['id']}: {e}")
            return
        except Uncertain as e:
            self._set(r["id"], status="unconfirmed", attempts=r["attempts"] + 1, last_error=str(e)[:300])
            ops_event(self.conn, "warning", "slack_unconfirmed", f"outbox {r['id']}: {e}")
            return
        finally:
            self._block(key, max(self.min_interval_sec, self._blocked.get(key, 0) - time.monotonic()))
        with Tx(self.conn):
            # Translation may have finished while we were posting.
            tr = self.conn.execute("SELECT status FROM translations WHERE message_id=?", (r["message_id"],)).fetchone()
            upd = "pending" if (not included and tr and tr["status"] == "done") else "none"
            self.conn.execute(
                """UPDATE slack_outbox SET status='sent', slack_ts=?, sent_at=?, attempts=attempts+1, translation_included=?,
                   update_status=?, locked_by=NULL, next_attempt_at=NULL, last_error=NULL WHERE id=?""",
                (ts, utcnow(), int(included), upd, r["id"]),
            )

    async def _updates(self, now: str) -> int:
        rows = self.conn.execute(
            """SELECT * FROM slack_outbox WHERE status='sent' AND update_status='pending' AND slack_ts IS NOT NULL
               AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY id LIMIT 20""",
            (now,),
        ).fetchall()
        n = 0
        for r in rows:
            key = (r["token_ref"], r["channel_id"])
            if not self._ready(key):
                continue
            text, included = self._compose(r["message_id"])
            token = self._token(r["token_ref"])
            try:
                if not token:
                    raise Definite("missing_token")
                await asyncio.to_thread(self.poster.update, token, r["channel_id"], r["slack_ts"], text)
            except RateLimited as e:
                self._block(key, e.retry_after)
                self._set(r["id"], next_attempt_at=self._later(e.retry_after))
                continue
            except Definite as e:
                self._set(r["id"], update_status="failed", last_error=f"update: {e}"[:300])
                continue
            except Uncertain as e:  # chat.update is idempotent: safe to retry later
                self._set(r["id"], next_attempt_at=self._later(60), last_error=f"update: {e}"[:300])
                continue
            finally:
                self._block(key, max(self.min_interval_sec, self._blocked.get(key, 0) - time.monotonic()))
            self._set(r["id"], update_status="done" if included else "pending", translation_included=int(included),
                      next_attempt_at=None)
            n += 1
        return n

    @staticmethod
    def _later(seconds: float) -> str:
        return iso(datetime.now(timezone.utc) + timedelta(seconds=seconds))

    def _set(self, outbox_id: int, **fields) -> None:
        if fields.get("status") and fields["status"] != "sending":
            fields.setdefault("locked_by", None)
        cols = ", ".join(f"{k}=?" for k in fields)
        self.conn.execute(f"UPDATE slack_outbox SET {cols} WHERE id=?", (*fields.values(), outbox_id))


async def run_sender(sender: SlackSender, interval: float = 1.0) -> None:
    sender.recover()
    while True:
        try:
            n = await sender.tick()
        except Exception:
            log.exception("slack sender tick failed")
            n = 0
        await asyncio.sleep(interval if n == 0 else 0.2)
