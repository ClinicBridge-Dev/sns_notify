"""WhatsApp (native Mac app) reader over Accessibility.

All AX calls go through an ``AXBackend`` (in production: the 「WhatsApp 수집기」 app, which holds the
permission). This module only interprets snapshot trees.

STATUS: Phase 0 gate. Permission / running / screen-lock checks are real; the WhatsApp tree mapping
(``WhatsAppRules``) is written from a real dump (``scripts/ax_dump.py dump``, or the app menu
「화면 구조 기록」) — see docs/etc/ax-notes.md. Until then the reader reports
``unknown / ax_rules_pending_phase0`` and the collector stores nothing.
"""
from __future__ import annotations

import logging
import threading
import time
from typing import Callable, Protocol

from .ax_backend import AXBackend, AXCallError, get_backend
from .contract import MessageWindow, ObservedConversation, ReaderStatus

log = logging.getLogger(__name__)


def screen_locked() -> bool | None:
    try:
        from Quartz import CGSessionCopyCurrentDictionary

        d = CGSessionCopyCurrentDictionary() or {}
        return bool(d.get("CGSSessionScreenIsLocked", False))
    except Exception:
        return None


class Rules(Protocol):
    """WhatsApp-specific interpretation. Works on snapshot dicts; acts only via ``backend.perform/set``."""

    implemented: bool

    def connection_state(self, backend: AXBackend) -> ReaderStatus: ...
    def list_conversations(self, backend: AXBackend) -> list[ObservedConversation]: ...
    def read_messages(self, backend: AXBackend, conv: ObservedConversation, limit: int) -> MessageWindow: ...


class PendingRules:
    """Placeholder until Phase 0 maps the tree. Never fabricates data."""

    implemented = False

    def connection_state(self, backend) -> ReaderStatus:
        return ReaderStatus("unknown", "ax_rules_pending_phase0")

    def list_conversations(self, backend):
        raise NotImplementedError("Phase 0: implement from an AX dump (docs/etc/ax-notes.md)")

    def read_messages(self, backend, conv, limit):
        raise NotImplementedError("Phase 0: implement from an AX dump (docs/etc/ax-notes.md)")


class AXReader:
    def __init__(self, backend: AXBackend | None = None, rules: Rules | None = None):
        self.backend = backend or get_backend()
        if rules is None:
            from .wa_rules import WhatsAppRules

            rules = WhatsAppRules()
        self.rules = rules
        self._lock = threading.Lock()  # one conversation walk at a time (opening a chat changes UI state)

    def status(self) -> ReaderStatus:
        try:
            if not self.backend.trusted():
                return ReaderStatus("unknown", "ax_not_trusted")
            if screen_locked():
                return ReaderStatus("locked", "screen_locked")
            if not self.backend.pid():
                return ReaderStatus("disconnected", "whatsapp_not_running")
        except AXCallError as e:
            return ReaderStatus("unknown", f"ax_bridge: {e.message}")
        return self.rules.connection_state(self.backend)

    def list_conversations(self) -> list[ObservedConversation]:
        with self._lock:
            return self.rules.list_conversations(self.backend)

    def read_messages(self, conv: ObservedConversation, limit: int) -> MessageWindow:
        with self._lock:
            return self.rules.read_messages(self.backend, conv, limit)


def start_wake_observer(backend: AXBackend, wake: Callable[[], None], debounce_sec: float = 0.5) -> bool:
    """Any AX notification from WhatsApp triggers ``wake`` (debounced). Polling stays the source of truth."""
    last = [0.0]

    def on_event(_ev: dict) -> None:
        now = time.monotonic()
        if now - last[0] >= debounce_sec:
            last[0] = now
            wake()

    try:
        backend.subscribe(on_event)
        return True
    except AXCallError as e:
        log.warning("AX notifications unavailable (%s); polling only", e.message)
        return False
