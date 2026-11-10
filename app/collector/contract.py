"""Reader contract: the only boundary between screen reading (AX / Web) and the rest.

Everything downstream (DB, translator, Slack, viewer) consumes these normalized
shapes, so swapping the AX reader for a WhatsApp Web or official-API adapter
only means writing a new ``Reader``.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal, Protocol

Direction = Literal["inbound", "outbound", "unknown", "system"]
Kind = Literal["text", "caption", "attachment", "voice", "sticker", "other"]
TimePrecision = Literal["exact", "minute", "date_only", "unknown"]
AccountState = Literal["ok", "disconnected", "locked", "unknown"]


@dataclass(frozen=True)
class ObservedMessage:
    direction: Direction
    kind: Kind
    body: str | None
    shown_time: str | None = None  # "HH:MM" as displayed
    shown_date_hint: str | None = None  # "YYYY-MM-DD" when the reader could resolve it
    time_precision: TimePrecision = "minute"
    sender_hint: str | None = None
    external_id: str | None = None  # only when the source exposes a stable id
    # Reader-side doubts (e.g. "quote_suspect", "direction_guess"). Any flag => confidence 'review'.
    flags: tuple[str, ...] = ()
    attachment_label: str | None = None  # e.g. "사진", "PDF"


@dataclass(frozen=True)
class ObservedConversation:
    display_name: str
    external_key: str | None = None
    is_group: bool = False
    participant_hint: str | None = None
    # Changes whenever the chat-list row changes (last preview/time/unread). Used to
    # decide which conversations need to be opened this pass.
    list_cursor: str | None = None


@dataclass(frozen=True)
class MessageWindow:
    messages: list[ObservedMessage]  # oldest -> newest
    at_start: bool = False  # window begins at the very first message available on this device


@dataclass(frozen=True)
class ReaderStatus:
    state: AccountState
    detail: str | None = None


class Reader(Protocol):
    """Synchronous; the collector calls it from a worker thread."""

    def status(self) -> ReaderStatus: ...

    def list_conversations(self) -> list[ObservedConversation]: ...

    def read_messages(self, conv: ObservedConversation, limit: int) -> MessageWindow:
        """Return up to ``limit`` most recent messages, scrolling back as needed."""
        ...


@dataclass
class FakeReader:
    """In-memory reader for tests and offline demos (fixtures in normalized shape)."""

    conversations: dict[str, list[ObservedMessage]] = field(default_factory=dict)
    meta: dict[str, ObservedConversation] = field(default_factory=dict)
    state: ReaderStatus = field(default_factory=lambda: ReaderStatus("ok"))
    reads: list[tuple[str, int]] = field(default_factory=list)

    def add(self, name: str, *msgs: ObservedMessage, is_group: bool = False, key: str | None = None) -> None:
        self.conversations.setdefault(name, []).extend(msgs)
        self.meta[name] = ObservedConversation(display_name=name, external_key=key, is_group=is_group)

    def status(self) -> ReaderStatus:
        return self.state

    def list_conversations(self) -> list[ObservedConversation]:
        out = []
        for name, conv in self.meta.items():
            msgs = self.conversations.get(name, [])
            cursor = f"{len(msgs)}:{msgs[-1].body if msgs else ''}"
            out.append(ObservedConversation(conv.display_name, conv.external_key, conv.is_group, conv.participant_hint, cursor))
        return out

    def read_messages(self, conv: ObservedConversation, limit: int) -> MessageWindow:
        self.reads.append((conv.display_name, limit))
        msgs = self.conversations.get(conv.display_name, [])
        window = msgs[-limit:] if limit else []
        return MessageWindow(list(window), at_start=len(window) == len(msgs))

    @classmethod
    def from_json(cls, data: dict) -> "FakeReader":
        r = cls()
        for c in data["conversations"]:
            msgs = [ObservedMessage(**{**m, "flags": tuple(m.get("flags", ()))}) for m in c["messages"]]
            r.add(c["display_name"], *msgs, is_group=c.get("is_group", False), key=c.get("external_key"))
        return r
