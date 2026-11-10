"""DB-side outbox rules. Only inbound, newly observed, high-confidence messages ever reach Slack."""
from __future__ import annotations

import sqlite3

from ..db.repo import iso, utcnow

ELIGIBLE = """
  m.direction = 'inbound' AND m.collect_mode IN ('live','catchup') AND m.confidence = 'high'
  AND c.active = 1 AND c.slack_channel_id IS NOT NULL AND c.slack_token_ref IS NOT NULL
"""


def enqueue(conn: sqlite3.Connection, message_id: int) -> bool:
    """Insert an outbox row if the message qualifies. Idempotent (UNIQUE message_id)."""
    cur = conn.execute(
        f"""INSERT OR IGNORE INTO slack_outbox(message_id, client_id, channel_id, token_ref, status, created_at)
            SELECT m.id, c.id, c.slack_channel_id, c.slack_token_ref, 'pending', ?
            FROM messages m JOIN clients c ON c.id = m.client_id
            WHERE m.id = ? AND {ELIGIBLE}""",
        (utcnow(), message_id),
    )
    return cur.rowcount > 0


def on_translation_final(conn: sqlite3.Connection, message_id: int, status: str) -> None:
    """Called inside the translation's transaction once it reaches done/not_needed/failed."""
    row = conn.execute(
        "SELECT status, translation_included FROM slack_outbox WHERE message_id=?", (message_id,)
    ).fetchone()
    if row is None:
        enqueue(conn, message_id)
    elif row["status"] == "sent" and not row["translation_included"] and status == "done":
        conn.execute("UPDATE slack_outbox SET update_status='pending' WHERE message_id=?", (message_id,))


def enqueue_stale(conn: sqlite3.Connection, older_than_iso: str) -> int:
    """Translation still not finished after the wait window: post 원문 first, update later."""
    cur = conn.execute(
        f"""INSERT OR IGNORE INTO slack_outbox(message_id, client_id, channel_id, token_ref, status, created_at)
            SELECT m.id, c.id, c.slack_channel_id, c.slack_token_ref, 'pending', ?
            FROM messages m JOIN clients c ON c.id = m.client_id JOIN translations t ON t.message_id = m.id
            WHERE t.status IN ('pending','retry') AND m.created_at <= ? AND {ELIGIBLE}
              AND NOT EXISTS (SELECT 1 FROM slack_outbox o WHERE o.message_id = m.id)""",
        (utcnow(), older_than_iso),
    )
    return cur.rowcount


__all__ = ["enqueue", "on_translation_final", "enqueue_stale", "iso"]
