"""WhatsApp: watch the chat LIST only and raise "new message" notices.

Never opens a chat (no AXPress, no typing, no scrolling), so the unread badge stays exactly as the
staff left it and WhatsApp sees nothing but its own official app sitting idle. Everything comes
from the list row: chat name, last-message summary (the preview) and, when present, the unread count.

What is verified on a real device (2026-11-09/10, WhatsApp 26.43.77, Korean UI): row name and the
last-message summary incl. direction. NOT yet captured: a row that actually has an unread badge, so
``parse_unread`` accepts the wordings VoiceOver is known to use and the watcher does not depend on
it -- a new customer message is detected from the summary changing. Until a badge has been read at
least once, Slack messages omit the "확인하지 않은 알림" line instead of guessing (see docs/OPERATIONS.md).
"""
from __future__ import annotations

import asyncio
import logging
import re
import sqlite3
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Callable

from ..collector.ax_backend import walk
from ..collector.ax_reader import AXReader
from ..collector.wa_rules import BUBBLE, MARKS, clean, normalize_name, parse_bubble
from ..db.repo import ops_event, utcnow
from .core import Row, observe

log = logging.getLogger(__name__)
CHANNEL = "whatsapp"
FOLDER = "chats"

UNREAD_COUNT = [
    re.compile(r"읽지 않은 (?:메시지|대화|채팅)\s*(\d+)\s*개"),
    re.compile(r"(\d+)\s*개의 읽지 않은 (?:메시지|대화|채팅)"),
    re.compile(r"안 읽은 (?:메시지|대화)\s*(\d+)\s*개"),
    re.compile(r"(\d+)\s*unread (?:messages?|chats?)", re.I),
]
UNREAD_FLAG = re.compile(r"읽지 않음|읽지 않은 (?:메시지|대화)|\bunread\b", re.I)
UNREAD_WORDING = re.compile(
    r",?\s*(?:읽지 않은 (?:메시지|대화|채팅)\s*\d+\s*개|\d+\s*개의 읽지 않은 (?:메시지|대화|채팅)|안 읽은 (?:메시지|대화)\s*\d+\s*개"
    r"|\d+\s*unread (?:messages?|chats?))\s*$", re.I)
SENTENCE = re.compile(r"(?:^|, )(?:내 메시지|메시지), ")
# date wording changes by itself at midnight ("오후 3:05" -> "어제 오후 3:05" -> "년 11월 9일 오후 3:05")
DATE_PART = re.compile(r"(?:\d{4})?년 \d{1,2}월 \d{1,2}일 |어제 |오늘 |[월화수목금토일]요일 ")
TEXT_ATTRS = ("AXValue", "AXDescription", "AXTitle", "AXLabel")


@dataclass(frozen=True)
class ChatRow:
    name: str
    preview: str
    direction: str  # inbound | outbound
    unread: int
    sent_at: datetime | None  # local time of the last message, minute precision
    cursor: str  # identifies the last message; free of dates, delivery status and badge wording
    stable: bool = True  # False: the row shows no message sentence right now (typing…, draft)


def parse_unread_count(texts: list[str]) -> int:
    return max((int(m.group(1)) for t in texts for pat in UNREAD_COUNT for m in pat.finditer(t)), default=0)


def parse_unread(texts: list[str]) -> int:
    """Unread count from wording around a row; a bare "읽지 않음" marker counts as 1."""
    return parse_unread_count(texts) or int(any(UNREAD_FLAG.search(t) for t in texts))


def parse_row(node: dict, today: date) -> ChatRow | None:
    a = node.get("attrs", {})
    name = normalize_name(a.get("AXDescription"))
    if not name:
        return None
    value = clean(a.get("AXValue"))
    # Unread wording is looked for AROUND the message sentence, never inside the customer's text.
    start = SENTENCE.search(value)
    head, summary = (value[: start.start()], value[start.start():].lstrip(", ")) if start else ("", value)
    around = [head] + [clean(a.get(k)) for k in ("AXTitle", "AXLabel") if isinstance(a.get(k), str)]
    around += [clean(n.get("attrs", {}).get(k)) for n in walk(node) if n is not node for k in TEXT_ATTRS
               if isinstance(n.get("attrs", {}).get(k), str)]
    m = BUBBLE.match(MARKS.sub("", summary))
    msg = parse_bubble(summary, today) if m else None
    if msg is not None and msg.direction in ("inbound", "outbound"):
        sent_at = None
        if msg.shown_date_hint and msg.shown_time:
            sent_at = datetime.fromisoformat(f"{msg.shown_date_hint}T{msg.shown_time}")
        cursor = f"{msg.direction}|{msg.body}|{msg.shown_time}|{msg.sender_hint}"
        return ChatRow(name, msg.body or "", msg.direction, parse_unread(around + [m["status"] or ""]), sent_at, cursor)
    if start is None:
        # No message sentence at all: a typing indicator or a draft is showing instead of the last
        # message. Not a new message by itself; only a growing badge may say otherwise.
        return ChatRow(name, "", "inbound", parse_unread(around) or parse_unread_count([value]), None, "", stable=False)
    # A message sentence in a wording we do not know yet (new app version, group, attachment).
    # Ours only when it clearly says so; otherwise treat it as the customer's.
    outbound = summary.startswith("내 메시지") or bool(re.search(r"보냈습니다\.?(?:, [^,]*)?$", summary))
    direction = "outbound" if outbound else "inbound"
    core = UNREAD_WORDING.sub("", DATE_PART.sub("", summary)).strip(" ,")
    return ChatRow(name, core, direction, parse_unread(around) or parse_unread_count([summary]), None, f"{direction}|{core}")


class WhatsAppWatcher:
    def __init__(self, conn: sqlite3.Connection, reader: AXReader, *, account_id: int, account_key: str,
                 client_id: int, exclude: list[str] | None = None, recent_sec: float = 600,
                 now: Callable[[], datetime] = datetime.now):
        self.conn = conn
        self.reader = reader
        self.account_id, self.account_key, self.client_id = account_id, account_key, client_id
        self.exclude = set(exclude or [])
        self.recent_sec = recent_sec
        self.now = now
        self._list_failing = False

    def rows(self) -> list[ChatRow]:
        rules, b = self.reader.rules, self.reader.backend
        win = rules._window(b)
        today = self.now().date()
        out = []
        for n in rules._rows(win or {}):
            r = parse_row(n, today)
            if r and r.name not in self.exclude:
                out.append(r)
        return out

    def tick(self) -> list[int]:
        acc = self.conn.execute("SELECT status, last_ok_at FROM accounts WHERE id=?", (self.account_id,)).fetchone()
        try:
            st = self.reader.status()
            state, detail = st.state, st.detail
        except Exception as e:
            log.exception("whatsapp status failed")
            state, detail = "unknown", f"status_error: {type(e).__name__}"
        self._record_status(acc["status"], state, detail)
        if state != "ok":
            return []
        try:
            rows = self.rows()
        except Exception as e:
            log.exception("whatsapp chat list read failed")
            if not self._list_failing:
                self._list_failing = True
                ops_event(self.conn, "warning", "read_failed", f"chat_list: {type(e).__name__}", self.account_id)
            return []
        if self._list_failing:
            self._list_failing = False
            ops_event(self.conn, "info", "read_recovered", "chat_list", self.account_id)

        # A chat we have never seen may just be an old one scrolling into view. It only counts as new
        # when its last message is newer than our last good look (or the last few minutes).
        since = self.now() - timedelta(seconds=self.recent_sec)
        if acc["last_ok_at"]:
            last_ok = datetime.fromisoformat(acc["last_ok_at"]).astimezone().replace(tzinfo=None)
            since = min(since, last_ok - timedelta(minutes=2))
        items = [
            Row(name=r.name, preview=r.preview, cursor=r.cursor, unread=r.unread, stable=r.stable,
                eligible=r.direction == "inbound", recent=r.sent_at is not None and r.sent_at >= since)
            for r in rows
        ]
        new = observe(self.conn, CHANNEL, self.account_key, FOLDER, items, self.client_id)
        self.conn.execute("UPDATE accounts SET last_ok_at=?, initial_sync_done=1 WHERE id=?", (utcnow(), self.account_id))
        return new

    def _record_status(self, prev: str, state: str, detail: str | None) -> None:
        self.conn.execute("UPDATE accounts SET status=?, status_detail=? WHERE id=?", (state, detail, self.account_id))
        if state != "ok" and prev != state:
            ops_event(self.conn, "error", "account_status", f"{prev} -> {state}: {detail or ''}", self.account_id)
        elif state == "ok" and prev in ("disconnected", "locked"):
            ops_event(self.conn, "info", "account_recovered", f"{prev} -> ok", self.account_id)


async def run_watcher(watcher: WhatsAppWatcher, poll_interval_sec: float, wake: asyncio.Event) -> None:
    while True:
        try:
            await asyncio.to_thread(watcher.tick)
        except Exception:
            log.exception("whatsapp watcher tick failed")
        try:
            await asyncio.wait_for(wake.wait(), timeout=poll_interval_sec)
        except TimeoutError:
            pass
        wake.clear()
