"""In-process pub/sub for SSE. Publish only from the event-loop thread."""
from __future__ import annotations

import asyncio
import sqlite3

from .dto import conversation_dto, message_dto


class Bus:
    """A subscriber that falls behind (queue full) or a burst too large to stream is *closed*: the SSE
    generator ends the stream, the browser's EventSource reconnects and the viewer refetches."""

    def __init__(self, conn_factory, queue_size: int = 1000, burst_limit: int = 200):
        self._subs: set[asyncio.Queue] = set()
        self._closed: set[int] = set()
        self._conn_factory = conn_factory
        self._conn: sqlite3.Connection | None = None
        self.queue_size = queue_size
        self.burst_limit = burst_limit

    @property
    def conn(self) -> sqlite3.Connection:
        if self._conn is None:
            self._conn = self._conn_factory()
        return self._conn

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=self.queue_size)
        self._subs.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self._subs.discard(q)
        self._closed.discard(id(q))

    def is_closed(self, q: asyncio.Queue) -> bool:
        return id(q) in self._closed

    def _close(self, q: asyncio.Queue) -> None:
        self._subs.discard(q)
        self._closed.add(id(q))
        while not q.empty():
            q.get_nowait()

    def _emit(self, event: str, data: dict) -> None:
        for q in list(self._subs):
            try:
                q.put_nowait((event, data))
            except asyncio.QueueFull:
                self._close(q)

    def publish_messages(self, ids: list[int]) -> None:
        if not self._subs:
            return
        if len(ids) > self.burst_limit:  # e.g. a baseline: cheaper and safer to make clients refetch
            for q in list(self._subs):
                self._close(q)
            return
        for mid in ids:
            m = message_dto(self.conn, mid)
            if m is None:
                continue
            conv = conversation_dto(self.conn, m["conversation_id"])
            self._emit("message", {"message": m, "conversation": conv})

    def publish_translations(self, ids: list[int]) -> None:
        if not self._subs:
            return
        for mid in ids:
            m = message_dto(self.conn, mid)
            if m is not None:
                self._emit("translation", {"message_id": mid, "conversation_id": m["conversation_id"], "translation": m["translation"]})

    def publish_status(self, data: dict) -> None:
        self._emit("status", data)
