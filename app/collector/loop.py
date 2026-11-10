"""Collector: reader -> messages (+ pending translations) in one transaction per conversation.

Sync by design: AX calls block, so the whole pass runs in a worker thread with its
own SQLite connection. ``on_new`` is called with inserted message ids after commit.
"""
from __future__ import annotations

import asyncio
import logging
import os
import sqlite3
import time
from collections import Counter
from datetime import datetime, timezone
from typing import Callable

from ..db.repo import Tx, ops_event, utcnow
from .contract import ObservedConversation, ObservedMessage, Reader
from .fingerprint import Alignment, align_new, content_key, fingerprint

log = logging.getLogger(__name__)


class AccountCollector:
    def __init__(
        self,
        conn: sqlite3.Connection,
        reader: Reader,
        *,
        account_id: int,
        client_id: int,
        recent_window: int = 30,
        baseline_max: int = 200,
        catchup_after_sec: float = 120,
        full_sweep_interval_sec: float = 300,
        include_groups: bool = False,
        exclude: list[str] | None = None,
        on_new: Callable[[list[int]], None] | None = None,
    ):
        self.conn = conn
        self.reader = reader
        self.account_id = account_id
        self.client_id = client_id
        self.recent_window = recent_window
        self.baseline_max = baseline_max
        self.catchup_after_sec = catchup_after_sec
        self.full_sweep_interval_sec = full_sweep_interval_sec
        self.include_groups = include_groups
        self.exclude = set(exclude or [])
        self.on_new = on_new
        self._last_full_sweep: float | None = None
        self._failing: set[str] = set()  # conversations whose last read failed (alerted once per streak)
        self.progress_at = time.monotonic()  # watchdog: bumped at pass start and after each conversation

    # ---------------------------------------------------------------- pass
    def run_pass(self) -> list[int]:
        self.progress_at = time.monotonic()
        acc = self.conn.execute("SELECT * FROM accounts WHERE id=?", (self.account_id,)).fetchone()
        try:
            st = self.reader.status()
        except Exception as e:  # reader itself broken (e.g. AX permission revoked)
            log.exception("reader.status failed")
            st_state, st_detail = "unknown", f"status_error: {type(e).__name__}"
        else:
            st_state, st_detail = st.state, st.detail
        self._record_status(acc, st_state, st_detail)
        if st_state != "ok":
            return []

        recovering = acc["status"] in ("disconnected", "locked") or self._stale(acc["last_ok_at"])
        now_mono = time.monotonic()
        full_sweep = self._last_full_sweep is None or now_mono - self._last_full_sweep >= self.full_sweep_interval_sec

        try:
            convs = self.reader.list_conversations()
        except Exception as e:
            log.exception("list_conversations failed")
            self._fail_once("__list__", f"list_conversations: {type(e).__name__}")
            return []
        self._recover("__list__", "list_conversations")

        # Without a stable key, two visible chats with the same name are indistinguishable:
        # reading either would interleave both histories. Skip both and tell ops.
        name_counts = Counter(o.display_name for o in convs if not o.external_key)
        listed = {o.display_name for o in convs}

        inserted: list[int] = []
        for obs in convs:
            self.progress_at = time.monotonic()
            if obs.is_group and not self.include_groups:
                self._note_group(obs)
                continue
            if obs.display_name in self.exclude:
                continue
            if not obs.external_key and name_counts[obs.display_name] > 1:
                self._note_once("duplicate_display_name", obs.display_name, "warning")
                continue
            key = obs.external_key or f"name:{obs.display_name}"
            try:
                late = recovering or key in self._failing
                inserted += self._process(obs, full_sweep, late, bool(acc["initial_sync_done"]), listed)
            except Exception as e:
                log.exception("conversation pass failed")
                self._fail_once(key, f"{type(e).__name__} reading a conversation")
            else:
                self._recover(key, "conversation")

        # Status + list succeeded and every conversation was attempted: the account is synced and
        # alive even if a single conversation keeps failing (that one is tracked on its own).
        self.conn.execute("UPDATE accounts SET last_ok_at=?, initial_sync_done=1 WHERE id=?", (utcnow(), self.account_id))
        if full_sweep:
            self._last_full_sweep = now_mono
        if inserted and self.on_new:
            self.on_new(inserted)
        return inserted

    def _fail_once(self, key: str, detail: str) -> None:
        if key not in self._failing:
            self._failing.add(key)
            ops_event(self.conn, "warning", "read_failed", detail, self.account_id)

    def _recover(self, key: str, what: str) -> None:
        if key in self._failing:
            self._failing.discard(key)
            ops_event(self.conn, "info", "read_recovered", what, self.account_id)

    def _note_once(self, kind: str, subject: str, level: str = "info") -> None:
        mk = f"{kind}:{self.account_id}:{subject}"
        if self.conn.execute("SELECT 1 FROM meta WHERE k=?", (mk,)).fetchone():
            return
        with Tx(self.conn):
            self.conn.execute("INSERT INTO meta(k, v) VALUES (?, ?)", (mk, utcnow()))
            ops_event(self.conn, level, kind, subject, self.account_id)

    # ------------------------------------------------------------ helpers
    def _stale(self, last_ok_at: str | None) -> bool:
        if not last_ok_at:
            return False  # first ever run is baseline, not catch-up
        age = (datetime.now(timezone.utc) - datetime.fromisoformat(last_ok_at)).total_seconds()
        return age > self.catchup_after_sec

    def _record_status(self, acc: sqlite3.Row, state: str, detail: str | None) -> None:
        prev = acc["status"]
        self.conn.execute("UPDATE accounts SET status=?, status_detail=? WHERE id=?", (state, detail, self.account_id))
        if state != "ok" and prev != state:
            ops_event(self.conn, "error", "account_status", f"{prev} -> {state}: {detail or ''}", self.account_id)
        elif state == "ok" and prev in ("disconnected", "locked"):
            ops_event(self.conn, "info", "account_recovered", f"{prev} -> ok", self.account_id)

    def _note_group(self, obs: ObservedConversation) -> None:
        self._note_once("group_skipped", obs.external_key or obs.display_name)

    def _resolve(self, obs: ObservedConversation) -> sqlite3.Row:
        c = self.conn
        if obs.external_key:
            row = c.execute(
                "SELECT * FROM conversations WHERE account_id=? AND external_key=?", (self.account_id, obs.external_key)
            ).fetchone()
        else:
            # No stable id exposed: the display name is the only identity we have (documented limitation).
            row = c.execute(
                "SELECT * FROM conversations WHERE account_id=? AND external_key IS NULL AND display_name=?",
                (self.account_id, obs.display_name),
            ).fetchone()
        now = utcnow()
        if row is None:
            with Tx(c):
                cur = c.execute(
                    """INSERT INTO conversations(client_id, account_id, external_key, display_name, participant_hint,
                       created_at, updated_at) VALUES (?,?,?,?,?,?,?)""",
                    (self.client_id, self.account_id, obs.external_key, obs.display_name, obs.participant_hint, now, now),
                )
            return c.execute("SELECT * FROM conversations WHERE id=?", (cur.lastrowid,)).fetchone()
        if row["display_name"] != obs.display_name:
            with Tx(c):
                c.execute(
                    "INSERT INTO conversation_name_history(conversation_id, old_name, new_name, changed_at) VALUES (?,?,?,?)",
                    (row["id"], row["display_name"], obs.display_name, now),
                )
                c.execute("UPDATE conversations SET display_name=?, updated_at=? WHERE id=?", (obs.display_name, now, row["id"]))
            row = c.execute("SELECT * FROM conversations WHERE id=?", (row["id"],)).fetchone()
        return row

    def _tail(self, conv_id: int, n: int) -> tuple[list[str], set[str], bool, str | None]:
        rows = self.conn.execute(
            "SELECT content_key, external_id, fingerprint FROM messages WHERE conversation_id=? ORDER BY conv_seq DESC LIMIT ?",
            (conv_id, n),
        ).fetchall()
        rows.reverse()
        total = self.conn.execute("SELECT count(*) FROM messages WHERE conversation_id=?", (conv_id,)).fetchone()[0]
        ext = {r[0] for r in self.conn.execute(
            "SELECT external_id FROM messages WHERE conversation_id=? AND external_id IS NOT NULL", (conv_id,)
        )}
        return [r["content_key"] for r in rows], ext, total == len(rows), (rows[-1]["fingerprint"] if rows else None)

    def _align(self, conv: sqlite3.Row, msgs: list[ObservedMessage], at_start: bool, limit: int) -> Alignment:
        keys, ext, complete, _ = self._tail(conv["id"], max(2 * limit, 100))
        return align_new(
            keys,
            msgs,
            stored_external_ids=ext,
            stored_is_complete=bool(conv["history_complete"]) and complete,
            window_at_start=at_start,
        )

    def _process(self, obs: ObservedConversation, full_sweep: bool, late: bool, account_synced: bool,
                 listed: set[str] | frozenset = frozenset()) -> list[int]:
        conv = self._resolve(obs)
        baseline = not conv["baseline_done"]
        if (
            not baseline
            and not full_sweep
            and obs.list_cursor is not None
            and obs.list_cursor == conv["last_seen_cursor"]
        ):
            return []

        limit = self.baseline_max if baseline else self.recent_window
        win = self.reader.read_messages(obs, limit)

        if baseline and account_synced and not obs.external_key:
            renamed = self._match_renamed(conv, win, listed)
            if renamed is not None:
                conv, baseline = renamed, False

        al = self._align(conv, win.messages, win.at_start, len(win.messages) or limit)
        scrolled = False
        if al.gap and not baseline:
            scrolled = True
            win = self.reader.read_messages(obs, self.baseline_max)
            al = self._align(conv, win.messages, win.at_start, self.baseline_max)
            if al.gap:
                # Nothing on screen matches what we stored (history cleared, chat swapped, reader drift).
                # Keep only the most recent part, for review; never alert, never re-insert everything.
                al.new = al.new[-self.recent_window :]
                al.review = set(range(len(al.new)))
                ops_event(
                    self.conn, "warning", "possible_gap",
                    f"conversation {conv['id']}: no overlap within {self.baseline_max} messages", self.account_id,
                )
        if al.review and not al.gap:
            ops_event(self.conn, "info", "alignment_review", f"conversation {conv['id']}: {','.join(al.notes)}", self.account_id)

        modes = self._modes(al.new, baseline, account_synced, late or scrolled)
        return self._insert(conv, obs, win.at_start and baseline, al, modes)

    def _match_renamed(self, fresh: sqlite3.Row, win, listed: set[str]) -> sqlite3.Row | None:
        """A key-less chat that appears under a new name (e.g. number saved as a contact) is the same
        conversation if its window lines up with a stored chat that is no longer listed."""
        if not win.messages:
            return None
        cands = self.conn.execute(
            """SELECT * FROM conversations WHERE account_id=? AND external_key IS NULL AND baseline_done=1 AND id<>?
               ORDER BY last_activity_at DESC LIMIT 50""",
            (self.account_id, fresh["id"]),
        ).fetchall()
        for cand in cands:
            if cand["display_name"] in listed:
                continue
            keys, ext, _, _ = self._tail(cand["id"], max(2 * len(win.messages), 100))
            if not keys:
                continue
            al = align_new(keys, win.messages, stored_external_ids=ext)
            if not al.gap and not al.review and al.overlap >= min(3, len(keys)):
                now = utcnow()
                with Tx(self.conn):
                    self.conn.execute("DELETE FROM conversations WHERE id=?", (fresh["id"],))
                    self.conn.execute(
                        "INSERT INTO conversation_name_history(conversation_id, old_name, new_name, changed_at) VALUES (?,?,?,?)",
                        (cand["id"], cand["display_name"], fresh["display_name"], now),
                    )
                    self.conn.execute(
                        "UPDATE conversations SET display_name=?, updated_at=? WHERE id=?", (fresh["display_name"], now, cand["id"])
                    )
                ops_event(self.conn, "info", "conversation_renamed", f"conversation {cand['id']}", self.account_id)
                return self.conn.execute("SELECT * FROM conversations WHERE id=?", (cand["id"],)).fetchone()
        return None

    def _modes(self, new: list[ObservedMessage], baseline: bool, account_synced: bool, late: bool) -> list[str]:
        live = "catchup" if late else "live"
        if not baseline:
            return [live] * len(new)
        if not account_synced:
            return ["baseline"] * len(new)
        # Conversation first seen after the account's initial sync: a brand-new customer, or an
        # old chat that resurfaced because of a new message. Only the trailing unanswered inbound
        # run is treated as new; everything before it is history.
        modes = ["baseline"] * len(new)
        i = len(new) - 1
        while i >= 0 and new[i].direction == "inbound":
            modes[i] = live
            i -= 1
        return modes

    def _insert(self, conv: sqlite3.Row, obs: ObservedConversation, history_complete: bool, al: Alignment, modes: list[str]) -> list[int]:
        c = self.conn
        now = utcnow()
        ids: list[int] = []
        with Tx(c):
            row = c.execute(
                "SELECT fingerprint FROM messages WHERE conversation_id=? ORDER BY conv_seq DESC LIMIT 1", (conv["id"],)
            ).fetchone()
            prev_fp = row[0] if row else None
            seq = c.execute("SELECT last_seq FROM conversations WHERE id=?", (conv["id"],)).fetchone()[0]
            for i, (m, mode) in enumerate(zip(al.new, modes)):
                seq += 1
                reasons = list(m.flags)
                if m.direction == "unknown":
                    reasons.append("direction_unknown")
                if m.time_precision == "unknown":
                    reasons.append("time_unknown")
                if i in al.review:
                    reasons.append("gap" if al.gap else "alignment")
                fp = fingerprint(conv["id"], m, m.shown_date_hint, prev_fp)
                cur = c.execute(
                    """INSERT INTO messages(client_id, account_id, conversation_id, conv_seq, external_id, direction, kind,
                       body, attachment_label, sender_hint, shown_time, shown_date_hint, time_precision, observed_at,
                       collect_mode, confidence, review_reason, content_key, fingerprint, seq_in_batch, created_at)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (
                        self.client_id, self.account_id, conv["id"], seq, m.external_id, m.direction, m.kind,
                        m.body, m.attachment_label, m.sender_hint, m.shown_time, m.shown_date_hint, m.time_precision,
                        now, mode, "review" if reasons else "high", ",".join(reasons) or None,
                        content_key(m), fp, i, now,
                    ),
                )
                c.execute(
                    "INSERT INTO translations(message_id, status, updated_at) VALUES (?, 'pending', ?)", (cur.lastrowid, now)
                )
                ids.append(cur.lastrowid)
                prev_fp = fp
            c.execute(
                """UPDATE conversations SET last_seen_cursor=?, baseline_done=1, last_seq=?,
                   history_complete=CASE WHEN baseline_done=0 THEN ? ELSE history_complete END,
                   last_activity_at=CASE WHEN ? THEN ? ELSE last_activity_at END, updated_at=? WHERE id=?""",
                (obs.list_cursor, seq, int(history_complete), bool(ids), now, now, conv["id"]),
            )
        return ids


def _die(reason: str) -> None:
    log.critical("watchdog: %s -- exiting so launchd restarts the process", reason)
    logging.shutdown()
    os._exit(70)  # a hung AX call cannot be cancelled; a clean exit would wait on that thread forever


async def run_collector(collector: AccountCollector, poll_interval_sec: float, wake: asyncio.Event, *,
                        stall_timeout_sec: float = 600, fatal: Callable[[str], None] = _die,
                        check_interval_sec: float = 15) -> None:
    while True:
        fut = asyncio.ensure_future(asyncio.to_thread(collector.run_pass))
        while not fut.done():
            await asyncio.wait({fut}, timeout=check_interval_sec)
            stalled = time.monotonic() - collector.progress_at
            if not fut.done() and stalled > stall_timeout_sec:
                try:
                    ops_event(collector.conn, "error", "collector_stalled", f"no progress for {int(stalled)}s",
                              collector.account_id)
                except Exception:
                    pass
                fatal(f"collector for account {collector.account_id} stalled {int(stalled)}s")
                return
        fut.result()
        try:
            await asyncio.wait_for(wake.wait(), timeout=poll_interval_sec)
        except TimeoutError:
            pass
        wake.clear()
