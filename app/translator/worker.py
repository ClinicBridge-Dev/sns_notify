"""Translation worker: pending -> not_needed | done | retry | failed, then outbox rules."""
from __future__ import annotations

import asyncio
import logging
import sqlite3
from datetime import datetime, timedelta, timezone
from typing import Awaitable, Callable

from ..db.repo import Tx, iso, ops_event, utcnow
from ..slack import outbox
from .detect import detect
from .gpt import ContentError, ServiceError, TranslationResult

log = logging.getLogger(__name__)

TranslateFn = Callable[[str], Awaitable[TranslationResult]]


class TranslatorWorker:
    def __init__(
        self,
        conn: sqlite3.Connection,
        translate: TranslateFn,
        *,
        model: str,
        max_attempts: int = 5,
        wait_before_slack_sec: float = 60,
        batch: int = 20,
        on_change: Callable[[list[int]], None] | None = None,
    ):
        self.conn = conn
        self.translate = translate
        self.model = model
        self.max_attempts = max_attempts
        self.wait_before_slack_sec = wait_before_slack_sec
        self.batch = batch
        self.on_change = on_change
        self._service_failing = False

    async def tick(self) -> int:
        now = utcnow()
        rows = self.conn.execute(
            """SELECT t.message_id, t.attempts, m.body, m.kind FROM translations t JOIN messages m ON m.id = t.message_id
               WHERE t.status IN ('pending','retry') AND (t.next_attempt_at IS NULL OR t.next_attempt_at <= ?)
               ORDER BY (m.collect_mode = 'baseline'), t.message_id LIMIT ?""",
            (now, self.batch),
        ).fetchall()
        self._enqueue_stale()
        changed: list[int] = []
        for r in rows:
            ok = await self._one(r)
            if ok:
                changed.append(r["message_id"])
            elif self._service_failing:
                break  # API down: don't burn a timeout per row; the 60s Slack fallback must not slip
        self._enqueue_stale()
        if changed and self.on_change:
            self.on_change(changed)
        return len(rows)

    def _enqueue_stale(self) -> None:
        cutoff = iso(datetime.now(timezone.utc) - timedelta(seconds=self.wait_before_slack_sec))
        with Tx(self.conn):
            outbox.enqueue_stale(self.conn, cutoff)

    async def _one(self, r: sqlite3.Row) -> bool:
        mid = r["message_id"]
        if r["kind"] not in ("text", "caption") or not (r["body"] or "").strip():
            self._finish(mid, "not_needed", None, None)
            return True
        lang, needs_api = detect(r["body"])
        if not needs_api:
            self._finish(mid, "not_needed", lang, None)
            return True
        try:
            res = await self.translate(r["body"])
        except ServiceError as e:
            self._fail(mid, r["attempts"], str(e), count=False)
            self._service_down(str(e))
            return False
        except ContentError as e:
            self._fail(mid, r["attempts"], str(e), count=True)
            return False
        except Exception as e:  # unexpected: treat as content error so it cannot loop forever
            log.exception("translate crashed")
            self._fail(mid, r["attempts"], type(e).__name__, count=True)
            return False
        self._service_up()
        if res.lang == "ko":
            self._finish(mid, "not_needed", "ko", None)
        else:
            self._finish(mid, "done", res.lang, res.ko)
        return True

    def _finish(self, mid: int, status: str, lang: str | None, ko: str | None) -> None:
        now = utcnow()
        with Tx(self.conn):
            self.conn.execute(
                """UPDATE translations SET status=?, lang=?, ko_text=?, model=?, translated_at=?, updated_at=?,
                   next_attempt_at=NULL, last_error=NULL WHERE message_id=?""",
                (status, lang, ko, self.model if status == "done" else None, now, now, mid),
            )
            outbox.on_translation_final(self.conn, mid, status)

    def _fail(self, mid: int, attempts: int, err: str, *, count: bool) -> None:
        attempts = attempts + 1 if count else attempts
        final = count and attempts >= self.max_attempts
        delay = min(5 * 2 ** max(attempts, 1), 600)
        nxt = iso(datetime.now(timezone.utc) + timedelta(seconds=delay))
        now = utcnow()
        with Tx(self.conn):
            self.conn.execute(
                """UPDATE translations SET status=?, attempts=?, last_error=?, next_attempt_at=?, updated_at=?
                   WHERE message_id=?""",
                ("failed" if final else "retry", attempts, err[:300], None if final else nxt, now, mid),
            )
            if final:
                outbox.on_translation_final(self.conn, mid, "failed")
        if final and self.on_change:
            self.on_change([mid])

    def _service_down(self, err: str) -> None:
        if not self._service_failing:
            self._service_failing = True
            ops_event(self.conn, "error", "translation_failing", err[:200])

    def _service_up(self) -> None:
        if self._service_failing:
            self._service_failing = False
            ops_event(self.conn, "info", "translation_recovered", None)


async def run_translator(worker: TranslatorWorker, interval: float = 2.0) -> None:
    while True:
        try:
            n = await worker.tick()
        except Exception:
            log.exception("translator tick failed")
            n = 0
        if n == 0:
            await asyncio.sleep(interval)
