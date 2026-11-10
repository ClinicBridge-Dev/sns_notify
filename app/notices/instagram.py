"""Instagram DM: only "a message arrived" (from the inbox list), never the conversation itself.

A Chrome extension on instagram.com reads the Primary/General thread lists (rows carry name,
preview, relative time and an "Unread" marker) and posts snapshots here. Threads are never
opened, so nothing is marked as read. A notice is created when a thread becomes unread, or its
preview changes while unread. Counts are conversations (Instagram shows no per-thread number).
"""
from __future__ import annotations

import sqlite3

from pydantic import BaseModel, Field

from .core import NoticeSender, Row, observe, run_notice_sender  # noqa: F401  (re-exported)

CHANNEL = "instagram"
SETTLE_SEC = 20  # the page may report a half-loaded list right after it opens


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


def ingest(conn: sqlite3.Connection, data: dict | Snapshot, routes: dict[str, int], settle_sec: float = 0) -> list[int]:
    """Primary/General alert; other folders (requests) are only recorded (see core.NOTIFY_FOLDERS)."""
    snap = data if isinstance(data, Snapshot) else Snapshot.model_validate(data)
    rows = [Row(name=t.name, preview=t.preview, unread=int(t.unread), eligible=t.unread, time_label=t.time_label)
            for t in snap.threads]
    return observe(conn, CHANNEL, snap.account, snap.folder, rows, routes.get(snap.account), settle_sec=settle_sec)
