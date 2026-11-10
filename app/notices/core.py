"""Shared "a new message arrived" notices for channels we only watch (WhatsApp chat list, Instagram
DM list). We never open a conversation, so nothing is marked as read on the account.

A watcher hands in list snapshots (``observe``). A row becomes a notice when it is eligible (WhatsApp:
last message is from the customer; Instagram: row is unread) and either its content changed or its
unread count grew. The very first snapshot of a list is a silent baseline.

``NoticeSender`` posts ONE Slack message per account per burst:

    새로운 왓츠앱 알림이 있습니다 · A 상담 계정
    • 새로운 알림: 2건
    • 확인하지 않은 알림: 4건
    > 김민수: 내일 예약 가능할까요?
"""
from __future__ import annotations

import asyncio
import logging
import os
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from ..db.repo import Tx, iso, meta_get, meta_set, ops_event, utcnow
from ..slack.format import escape
from ..slack.sender import Definite, RateLimited, Uncertain

log = logging.getLogger(__name__)

TITLE = {"whatsapp": "새로운 왓츠앱 알림이 있습니다", "instagram": "새로운 인스타 DM이 있습니다"}
WHERE = {"whatsapp": "왓츠앱", "instagram": "인스타그램"}
FOLDER_LABEL = {"primary": "Primary", "general": "General", "requests": "요청"}
IN_FLIGHT = "in_flight"
OFFLINE = ("gaierror", "ConnectionRefusedError")
MAX_LINES = 10
PREVIEW_MAX = 300


@dataclass(frozen=True)
class Row:
    name: str
    preview: str | None = None  # shown in Slack
    cursor: str | None = None  # change detection; defaults to preview. Must not contain volatile text.
    unread: int = 0  # unread count on the row (0/1 when the source only has a flag)
    eligible: bool = True  # may this row raise a notice at all
    recent: bool = True  # for rows never seen before: the message is new, not an old row scrolling in
    # False = the row shows something that is not a message (typing indicator, draft). Its stored
    # cursor is left alone; only a growing unread badge can raise a notice.
    stable: bool = True
    time_label: str | None = None


NOTIFY_FOLDERS = ("primary", "general", "chats")  # lists that alert and count towards the unread total


def unread_known_key(channel: str, account: str) -> str:
    return f"notice_unread_known:{channel}:{account}"


def observe(conn: sqlite3.Connection, channel: str, account: str, folder: str, rows: list[Row],
            client_id: int | None, *, settle_sec: float = 0) -> list[int]:
    """Record one list snapshot. Returns ids of the notices it created.

    The first snapshot of a list, and everything within ``settle_sec`` after it (a page that is
    still loading its rows), is a silent baseline.
    """
    now = utcnow()
    stamp = datetime.now(timezone.utc).isoformat(timespec="microseconds")  # identifies this snapshot
    deliverable = client_id is not None and conn.execute(
        "SELECT 1 FROM clients WHERE id=? AND active=1 AND slack_channel_id IS NOT NULL AND slack_token_ref IS NOT NULL",
        (client_id,),
    ).fetchone() is not None
    new_ids: list[int] = []
    with Tx(conn):
        known = conn.execute(
            "SELECT created_at FROM notice_folders WHERE channel=? AND account=? AND folder=?", (channel, account, folder)
        ).fetchone()
        baseline = known is None or (
            datetime.now(timezone.utc) - datetime.fromisoformat(known["created_at"])).total_seconds() < settle_sec
        notify = folder in NOTIFY_FOLDERS and not baseline
        seen: set[str] = set()
        for r in rows:
            if not r.name or r.name in seen:
                continue
            seen.add(r.name)
            cursor = r.cursor if r.cursor is not None else r.preview
            prev = conn.execute(
                "SELECT last_preview, unread FROM notice_threads WHERE channel=? AND account=? AND folder=? AND thread_name=?",
                (channel, account, folder, r.name),
            ).fetchone()
            if prev is None:
                if not r.stable:
                    continue  # nothing reliable to remember yet
                fresh = r.eligible and r.recent
                grew = r.unread
            else:
                grew = r.unread - prev["unread"]
                if r.stable:
                    fresh = r.eligible and (prev["last_preview"] != cursor or grew > 0)
                else:
                    fresh, cursor = r.eligible and grew > 0, prev["last_preview"]
            if fresh and notify:
                cur = conn.execute(
                    """INSERT INTO notices(channel, account, folder, thread_name, preview, time_label, client_id,
                       slack_status, new_count, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)""",
                    (channel, account, folder, r.name, r.preview if r.stable else None, r.time_label, client_id,
                     "pending" if deliverable else "skipped", max(grew, 1), now),
                )
                new_ids.append(cur.lastrowid)
            conn.execute(
                """INSERT INTO notice_threads(channel, account, folder, thread_name, last_preview, unread, updated_at, seen_at)
                   VALUES (?,?,?,?,?,?,?,?)
                   ON CONFLICT(channel, account, folder, thread_name) DO UPDATE SET last_preview=excluded.last_preview,
                     unread=excluded.unread, updated_at=excluded.updated_at, seen_at=excluded.seen_at""",
                (channel, account, folder, r.name, cursor, r.unread, now, stamp),
            )
        conn.execute(
            """INSERT INTO notice_folders(channel, account, folder, created_at, snapshot_at) VALUES (?,?,?,?,?)
               ON CONFLICT(channel, account, folder) DO UPDATE SET snapshot_at=excluded.snapshot_at""",
            (channel, account, folder, stamp, stamp),
        )
        conn.execute(
            """INSERT INTO notice_accounts(channel, account, unread_total, updated_at) VALUES (?,?,?,?)
               ON CONFLICT(channel, account) DO UPDATE SET unread_total=excluded.unread_total, updated_at=excluded.updated_at""",
            (channel, account, unread_total(conn, channel, account), now),
        )
        if any(r.unread > 0 for r in rows) and meta_get(conn, unread_known_key(channel, account)) is None:
            meta_set(conn, unread_known_key(channel, account), now)
    return new_ids


def unread_total(conn: sqlite3.Connection, channel: str, account: str) -> int:
    """Unread over the rows present in the latest snapshot of each alerting list."""
    marks = ",".join("?" * len(NOTIFY_FOLDERS))
    return conn.execute(
        f"""SELECT COALESCE(SUM(t.unread), 0) FROM notice_threads t
            JOIN notice_folders f ON f.channel=t.channel AND f.account=t.account AND f.folder=t.folder
            WHERE t.channel=? AND t.account=? AND t.seen_at = f.snapshot_at AND t.folder IN ({marks})""",
        (channel, account, *NOTIFY_FOLDERS),
    ).fetchone()[0]


def unread_known(conn: sqlite3.Connection, channel: str, account: str) -> bool:
    """Instagram rows always say read/unread. WhatsApp: only once an unread badge was actually read
    from a row -- until then "0" could just mean we cannot see the badge, so we do not claim a total."""
    return channel == "instagram" or meta_get(conn, unread_known_key(channel, account)) is not None


def account_label(conn: sqlite3.Connection, channel: str, account: str) -> str:
    if channel == "whatsapp":
        row = conn.execute("SELECT label FROM accounts WHERE key=?", (account,)).fetchone()
        return row["label"] if row else account
    return f"@{account}"


def _one_line(text: str | None) -> str:
    t = " ".join((text or "").split())
    return t[:PREVIEW_MAX] + ("…" if len(t) > PREVIEW_MAX else "")


def render(conn: sqlite3.Connection, channel: str, account: str, group: list[sqlite3.Row]) -> str:
    if channel == "instagram":  # no per-chat numbers on Instagram: both lines count conversations
        new = len({(n["folder"], n["thread_name"]) for n in group})
    else:
        new = sum(n["new_count"] for n in group)
    lines = [f"*{TITLE.get(channel, '새로운 알림이 있습니다')}* · {escape(account_label(conn, channel, account))}",
             f"• 새로운 알림: {new}건"]
    if unread_known(conn, channel, account):
        # same unit on both lines, and "확인하지 않은" always includes the new ones
        lines.append(f"• 확인하지 않은 알림: {max(unread_total(conn, channel, account), new)}건")
    latest: dict[tuple, sqlite3.Row] = {}
    for n in group:  # several notices for one conversation -> show its newest preview once
        key = (n["folder"], n["thread_name"])
        latest.pop(key, None)
        latest[key] = n
    shown = list(latest.values())[:MAX_LINES]
    for n in shown:
        folder = FOLDER_LABEL.get(n["folder"] or "")
        name = escape(n["thread_name"]) + (f" ({folder})" if channel == "instagram" and folder else "")
        lines.append(f"> *{name}*: {escape(_one_line(n['preview'])) or '(미리보기 없음)'}")
    if len(latest) > len(shown):
        lines.append(f"> … 외 {len(latest) - len(shown)}개 대화")
    lines.append(f"_{WHERE.get(channel, '앱')}에서 확인해 주세요_")
    return "\n".join(lines)


class NoticeSender:
    def __init__(self, conn: sqlite3.Connection, poster, *, tokens: dict[str, str] | None = None, max_attempts: int = 5):
        self.conn, self.poster = conn, poster
        self.tokens = tokens
        self.max_attempts = max_attempts

    def _token(self, ref: str | None) -> str | None:
        if not ref:
            return None
        return (self.tokens if self.tokens is not None else os.environ).get(ref)

    async def tick(self) -> int:
        rows = self.conn.execute(
            """SELECT n.*, c.slack_channel_id, c.slack_token_ref FROM notices n JOIN clients c ON c.id = n.client_id
               WHERE n.slack_status IN ('pending','retry') AND (n.next_attempt_at IS NULL OR n.next_attempt_at <= ?)
               ORDER BY n.id LIMIT 200""",
            (utcnow(),),
        ).fetchall()
        groups: dict[tuple, list[sqlite3.Row]] = {}
        for n in rows:
            groups.setdefault((n["channel"], n["account"], n["client_id"]), []).append(n)
        for (channel, account, _), group in groups.items():
            await self._send(channel, account, group)
        return len(groups)

    def recover(self) -> int:
        """A post that was in flight when the process died may or may not have reached Slack: leave
        it unconfirmed (never auto-resent) and tell the operator once."""
        rows = self.conn.execute("SELECT id FROM notices WHERE slack_status='unconfirmed' AND last_error=?", (IN_FLIGHT,)).fetchall()
        if rows:
            ids = [r["id"] for r in rows]
            self._set(ids, last_error="interrupted")
            ops_event(self.conn, "warning", "slack_unconfirmed", f"notice {ids[0]}..{ids[-1]}: 전송 중 종료됨 (Slack 확인 후 notices resend)")
        return len(rows)

    async def _send(self, channel: str, account: str, group: list[sqlite3.Row]) -> None:
        ids = [n["id"] for n in group]
        head = group[0]
        token = self._token(head["slack_token_ref"])
        try:
            if not token or not head["slack_channel_id"]:
                raise Definite("missing_token_or_channel")
            text = render(self.conn, channel, account, group)
            self._set(ids, slack_status="unconfirmed", last_error=IN_FLIGHT)  # crash-safe: see recover()
            ts = await asyncio.to_thread(self.poster.post, token, head["slack_channel_id"], text)
        except RateLimited as e:
            self._set(ids, slack_status="retry", last_error=None, next_attempt_at=self._later(e.retry_after))
            return
        except Definite as e:
            if str(e) in OFFLINE:  # no network: keep waiting, this is not the notice's fault
                self._set(ids, slack_status="retry", last_error=str(e), next_attempt_at=self._later(60))
                return
            lost = []
            for n in group:  # each notice has its own budget; a new one may join an old failing burst
                attempts = n["attempts"] + 1
                final = attempts >= self.max_attempts
                self._set([n["id"]], slack_status="failed" if final else "retry", attempts=attempts, last_error=str(e)[:300],
                          next_attempt_at=None if final else self._later(min(10 * 2 ** attempts, 900)))
                if final:
                    lost.append(n["id"])
            if lost:
                ops_event(self.conn, "error", "slack_failed", f"{channel} notice {lost[0]}..{lost[-1]}: {e}")
            return
        except Uncertain as e:  # may have been posted: never resend automatically
            self._set(ids, slack_status="unconfirmed", last_error=str(e)[:300])
            ops_event(self.conn, "warning", "slack_unconfirmed", f"{channel} notice {ids[0]}..{ids[-1]}: {e}")
            return
        self._set(ids, slack_status="sent", slack_ts=ts, last_error=None, next_attempt_at=None)

    @staticmethod
    def _later(seconds: float) -> str:
        return iso(datetime.now(timezone.utc) + timedelta(seconds=seconds))

    def _set(self, ids: list[int], **fields) -> None:
        cols = ", ".join(f"{k}=?" for k in fields)
        marks = ",".join("?" * len(ids))
        self.conn.execute(f"UPDATE notices SET {cols} WHERE id IN ({marks})", (*fields.values(), *ids))


async def run_notice_sender(sender: NoticeSender, interval: float = 2.0) -> None:
    sender.recover()
    while True:
        try:
            await sender.tick()
        except Exception:
            log.exception("notice sender tick failed")
        await asyncio.sleep(interval)
