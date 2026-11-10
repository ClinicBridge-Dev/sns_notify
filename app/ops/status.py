"""Shared status summary for the viewer status bar and the heartbeat."""
from __future__ import annotations

import sqlite3

from ..db.repo import utcnow


def summary(conn: sqlite3.Connection) -> dict:
    accounts = [
        dict(r)
        for r in conn.execute(
            """SELECT a.id, a.label, c.name AS client_name, a.status, a.status_detail, a.last_ok_at
               FROM accounts a JOIN clients c ON c.id=a.client_id ORDER BY a.id"""
        )
    ]
    tp = conn.execute("SELECT count(*) FROM translations WHERE status IN ('pending','retry')").fetchone()[0]
    counts = dict(conn.execute("SELECT status, count(*) FROM slack_outbox GROUP BY status").fetchall())
    instagram = [
        dict(r)
        for r in conn.execute(
            "SELECT account, unread_total, updated_at FROM notice_accounts WHERE channel='instagram' ORDER BY account"
        )
    ]
    watch = [
        dict(r)
        for r in conn.execute(
            """SELECT channel, account, folder, snapshot_at FROM notice_folders
               WHERE folder IN ('primary','general','chats') ORDER BY channel, account, folder"""
        )
    ]
    ncounts = dict(conn.execute("SELECT slack_status, count(*) FROM notices GROUP BY slack_status").fetchall())
    return {
        "accounts": accounts,
        "instagram": instagram,
        "watch": watch,
        "notices": {
            "pending": ncounts.get("pending", 0) + ncounts.get("retry", 0),
            "failed": ncounts.get("failed", 0),
            "unconfirmed": ncounts.get("unconfirmed", 0),
        },
        "translation_pending": tp,
        "slack": {
            "pending": counts.get("pending", 0) + counts.get("retry", 0) + counts.get("sending", 0),
            "failed": counts.get("failed", 0),
            "unconfirmed": counts.get("unconfirmed", 0),
        },
        "server_time": utcnow(),
    }
