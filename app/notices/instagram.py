"""Instagram DM: only "a message arrived" (from the inbox list), never the conversation itself.

A Chrome extension on instagram.com reads the Primary/General/Requests thread lists (rows carry name,
preview, relative time and an "Unread" marker) and posts snapshots here. Threads are never
opened, so nothing is marked as read. A notice is created when a thread becomes unread, or its
preview changes while unread. Counts are conversations (Instagram shows no per-thread number).
"""
from __future__ import annotations

import re
import sqlite3

from pydantic import BaseModel, Field

from .core import NoticeSender, Row, observe, run_notice_sender  # noqa: F401  (re-exported)

CHANNEL = "instagram"
SETTLE_SEC = 20  # the page may report a half-loaded list right after it opens
PRESENCE = re.compile(r"(?:활동 중|지금 활동 중|Active now|Active today|온라인|Online)", re.IGNORECASE)


TYPING = re.compile(r"(?:typing|입력 중|입력중|작성 중|작성중|入力中)\s*[.…]*", re.IGNORECASE)


class ThreadRow(BaseModel):
    name: str = Field(max_length=300)
    preview: str | None = Field(default=None, max_length=2000)
    time_label: str | None = Field(default=None, max_length=40)
    unread: bool = False


class Snapshot(BaseModel):
    account: str = Field(min_length=1, max_length=100)
    folder: str = Field(default="unknown", max_length=20)
    unread_total: int = Field(default=0, ge=0, le=100000)
    threads: list[ThreadRow] = Field(default_factory=list, max_length=200)


def normalize_thread(t: ThreadRow) -> ThreadRow | None:
    """Compatibility for already-running extensions that mistake avatar presence for a name.

    Korean list rows put the actual name (ending in 님) at the start of the preview.
    Ambiguous rows are ignored rather than mixing unrelated customers into one cursor.
    """
    if not PRESENCE.fullmatch(t.name.strip()):
        return t
    match = re.match(r"^(.+?)님(?:\s+|$)(.*)$", (t.preview or "").strip(), re.DOTALL)
    if not match:
        return None
    return t.model_copy(update={"name": match[1].strip(), "preview": match[2].strip() or None})


def ingest(conn: sqlite3.Connection, data: dict | Snapshot, routes: dict[str, int], settle_sec: float = 0) -> list[int]:
    """Alert for unread conversations in Primary, General, and Requests."""
    snap = data if isinstance(data, Snapshot) else Snapshot.model_validate(data)
    rows = []
    for raw in snap.threads:
        t = normalize_thread(raw)
        if t is None:
            continue
        if TYPING.fullmatch((t.preview or "").strip()):
            # Typing temporarily replaces the preview, even on an unread conversation.
            # Preserve both the cursor and unread flag until a real preview returns.
            prev = conn.execute(
                "SELECT last_preview, unread FROM notice_threads WHERE channel=? AND account=? AND folder=? AND thread_name=?",
                (CHANNEL, snap.account, snap.folder, t.name),
            ).fetchone()
            if prev is not None:
                rows.append(Row(name=t.name, preview=prev["last_preview"], unread=prev["unread"],
                                eligible=False, stable=False))
            continue
        rows.append(Row(name=t.name, preview=t.preview, unread=int(t.unread),
                        eligible=t.unread, time_label=t.time_label))
    return observe(conn, CHANNEL, snap.account, snap.folder, rows, routes.get(snap.account), settle_sec=settle_sec)
