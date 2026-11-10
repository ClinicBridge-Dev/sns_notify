"""WhatsApp for Mac (26.x, Korean UI) — how its Accessibility tree maps to conversations and messages.

Derived from a real dump (2026-11-09, WhatsApp 26.43.77). Everything WhatsApp-specific lives here,
so an app update that changes the tree means editing this file only.

Observed structure (identifiers are stable UIKit accessibility ids):
  ChatListView_TableView            chat list; each row: AXDescription = chat name (phone numbers
                                    spelled for speech: "+ 1,5 5 5,1 4 1,0 7 4 0"), AXValue = last
                                    message summary in the bubble format below. The selected row
                                    appears twice (AXGenericElement + AXStaticText).
  NavigationBar_HeaderViewButton    name of the open chat ("‪+1 (555) 141‑0740‬")
  ChatMessagesTableView             open chat; children = visible cells only (table is virtualized)
    WAMessageBubbleTableViewCell    AXDescription is a full sentence:
        "‎메시지, <body>, 년 10월 27일 오후 8:20, ‎<who>님께 받았습니다"            (inbound)
        "‎내 메시지, <body>, 년 10월 27일 오후 6:52, ‎<who>님께 보냈습니다., ‎전송됨" (outbound)
      cells without the prefix are system notices. The year is blank in this locale ("년 10월").
    AXHeading                       date separators; carry no text (each bubble has its own date).
"""
from __future__ import annotations

import re
import time
from datetime import date, timedelta
from typing import Callable

from .ax_backend import AXBackend, AXCallError, walk
from .contract import MessageWindow, ObservedConversation, ObservedMessage, ReaderStatus

MARKS = re.compile(r"[‎‏‪-‮⁦-⁩]")
# Date part: "년 10월 27일 " (older), "어제 " / "금요일 " (this week), or nothing at all (today).
BUBBLE = re.compile(
    r"^(?P<prefix>내 메시지|메시지), (?P<body>.*), "
    r"(?:(?:(?P<y>\d{4}))?년 (?P<mo>\d{1,2})월 (?P<d>\d{1,2})일 |(?P<rel>어제|오늘) |(?P<wd>[월화수목금토일])요일 )?"
    r"(?P<ampm>오전|오후) (?P<h>\d{1,2}):(?P<mi>\d{2}), (?P<who>.*?)님께 (?P<verb>보냈습니다|받았습니다)\.?"
    r"(?:, (?P<status>.*))?$",
    re.S,
)
WEEKDAYS = "월화수목금토일"
PREFIX = re.compile(r"^(내 메시지|메시지), ")
ROW_HELP = "대화를 열려면"

ID_CHAT_LIST = "ChatListView_TableView"
ID_HEADER = "NavigationBar_HeaderViewButton"
ID_MESSAGES = "ChatMessagesTableView"
ID_BUBBLE = "WAMessageBubbleTableViewCell"


def clean(s: str | None) -> str:
    return MARKS.sub("", s or "").replace(" ", " ").strip()


def normalize_name(s: str | None) -> str:
    """Same chat, same name: list rows spell numbers for speech, the header formats them."""
    t = clean(s)
    compact = re.sub(r"[\s,()\-‑.]", "", t)
    if re.fullmatch(r"\+?\d{7,15}", compact):
        return compact if compact.startswith("+") else compact
    return t


def _year(month: int, day: int, explicit: str | None, today: date) -> int:
    if explicit:
        return int(explicit)
    y = today.year
    try:
        if date(y, month, day) > today + timedelta(days=1):
            y -= 1
    except ValueError:
        pass
    return y


def parse_bubble(desc: str | None, today: date) -> ObservedMessage:
    text = MARKS.sub("", desc or "").strip()
    m = BUBBLE.match(text)
    if not m:
        if PREFIX.match(text):
            return ObservedMessage("unknown", "text", text, time_precision="unknown", flags=("unparsed_bubble",))
        return ObservedMessage("system", "text", text, time_precision="unknown")
    by_prefix = "outbound" if m["prefix"] == "내 메시지" else "inbound"
    by_verb = "outbound" if m["verb"] == "보냈습니다" else "inbound"
    direction = by_prefix if by_prefix == by_verb else "unknown"
    hour = int(m["h"]) % 12 + (12 if m["ampm"] == "오후" else 0)
    day: str | None
    if m["mo"]:
        mo, d = int(m["mo"]), int(m["d"])
        try:
            day = date(_year(mo, d, m["y"], today), mo, d).isoformat()
        except ValueError:
            day = None
    elif m["rel"] == "어제":
        day = (today - timedelta(days=1)).isoformat()
    elif m["wd"]:
        back = (today.weekday() - WEEKDAYS.index(m["wd"])) % 7 or 7
        day = (today - timedelta(days=back)).isoformat()
    else:  # no date shown = today
        day = today.isoformat()
    return ObservedMessage(
        direction=direction,
        kind="text",
        body=m["body"],
        shown_time=f"{hour:02d}:{m['mi']}",
        shown_date_hint=day,
        time_precision="minute" if day else "unknown",
        sender_hint=normalize_name(m["who"]),
        flags=() if direction != "unknown" else ("direction_conflict",),
    )


def _find(root: dict, identifier: str) -> dict | None:
    return next((n for n in walk(root) if n.get("attrs", {}).get("AXIdentifier") == identifier), None)


class WhatsAppRules:
    implemented = True

    def __init__(self, today: Callable[[], date] = date.today, open_timeout: float = 3.0, poll: float = 0.15):
        self.today = today
        self.open_timeout = open_timeout
        self.poll = poll

    # ---------------------------------------------------------------- tree
    def _window(self, b: AXBackend) -> dict | None:
        top = b.snapshot([], depth=1)
        wins = [c for c in top.get("children", []) if c.get("role") == "AXWindow"]
        if not wins:
            return None
        main = next((w for w in wins if w["attrs"].get("AXIdentifier") == "SceneWindow"), wins[0])
        return b.snapshot(main["path"], depth=40, max_nodes=20000)

    def _rows(self, win: dict) -> list[dict]:
        table = _find(win, ID_CHAT_LIST)
        if not table:
            return []
        rows, seen = [], set()
        for n in table.get("children", []):
            a = n.get("attrs", {})
            if ROW_HELP not in clean(a.get("AXHelp")) and not PREFIX.match(clean(a.get("AXValue"))):
                continue
            key = (clean(a.get("AXDescription")), clean(a.get("AXValue")))
            if key in seen:  # the selected row is exposed twice
                continue
            seen.add(key)
            rows.append(n)
        return rows

    # ---------------------------------------------------------------- Rules API
    def connection_state(self, b: AXBackend) -> ReaderStatus:
        win = self._window(b)
        if win is None:
            return ReaderStatus("unknown", "whatsapp_window_not_open")
        if not _find(win, ID_CHAT_LIST):
            return ReaderStatus("unknown", "chat_list_not_found")
        return ReaderStatus("ok")

    def list_conversations(self, b: AXBackend) -> list[ObservedConversation]:
        win = self._window(b)
        out = []
        for n in self._rows(win or {}):
            a = n["attrs"]
            out.append(ObservedConversation(display_name=normalize_name(a.get("AXDescription")),
                                            list_cursor=clean(a.get("AXValue")) or None))
        return out

    def current_conversation(self, b: AXBackend, win: dict | None = None) -> ObservedConversation | None:
        win = win or self._window(b)
        if not win or not _find(win, ID_MESSAGES):
            return None
        header = _find(win, ID_HEADER)
        return ObservedConversation(normalize_name(header["attrs"].get("AXDescription"))) if header else None

    def _open(self, b: AXBackend, conv: ObservedConversation) -> dict:
        win = self._window(b)
        cur = self.current_conversation(b, win)
        if cur and cur.display_name == conv.display_name:
            return win
        row = next((n for n in self._rows(win or {}) if normalize_name(n["attrs"].get("AXDescription")) == conv.display_name), None)
        if row is None:
            raise AXCallError(f"conversation_not_in_list")
        b.perform(row["path"], "AXPress")
        deadline = time.monotonic() + self.open_timeout
        while time.monotonic() < deadline:
            time.sleep(self.poll)
            win = self._window(b)
            cur = self.current_conversation(b, win)
            if cur and cur.display_name == conv.display_name:
                return win
        raise AXCallError("conversation_did_not_open")

    def read_messages(self, b: AXBackend, conv: ObservedConversation, limit: int) -> MessageWindow:
        win = self._open(b, conv)
        table = _find(win, ID_MESSAGES)
        cells = [n for n in (table or {}).get("children", []) if n["attrs"].get("AXIdentifier") == ID_BUBBLE]
        cells.sort(key=lambda n: (n.get("frame") or [0, 0])[1])
        today = self.today()
        msgs = [parse_bubble(n["attrs"].get("AXDescription"), today) for n in cells]
        # Only the cells on screen exist (virtualized table). Scrolling back for longer history is TODO.
        return MessageWindow(msgs[-limit:], at_start=False)
