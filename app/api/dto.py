from __future__ import annotations

import sqlite3

from ..slack.format import body_text

MSG_SQL = """SELECT m.id, m.conversation_id, m.conv_seq AS seq, m.direction, m.kind, m.body, m.attachment_label, m.sender_hint,
  m.shown_time, m.shown_date_hint, m.time_precision, m.observed_at, m.collect_mode, m.confidence,
  t.lang AS t_lang, t.status AS t_status, t.ko_text AS t_ko
  FROM messages m LEFT JOIN translations t ON t.message_id = m.id"""

CONV_SQL = """SELECT cv.id, cv.client_id, c.name AS client_name, cv.display_name, cv.last_activity_at, cv.last_seq,
  m.body, m.kind, m.direction, m.shown_time, m.attachment_label
  FROM conversations cv JOIN clients c ON c.id = cv.client_id
  LEFT JOIN messages m ON m.id = (
    -- preview the latest real message; WhatsApp's system notices only when nothing else exists
    SELECT id FROM messages WHERE conversation_id = cv.id ORDER BY (direction = 'system'), conv_seq DESC LIMIT 1)"""


def _msg(r: sqlite3.Row) -> dict:
    return {
        "id": r["id"], "conversation_id": r["conversation_id"], "seq": r["seq"], "direction": r["direction"],
        "kind": r["kind"], "body": r["body"], "attachment_label": r["attachment_label"], "sender_hint": r["sender_hint"],
        "shown_time": r["shown_time"], "shown_date_hint": r["shown_date_hint"], "time_precision": r["time_precision"],
        "observed_at": r["observed_at"], "collect_mode": r["collect_mode"], "confidence": r["confidence"],
        "translation": None if r["t_status"] is None else {"lang": r["t_lang"], "status": r["t_status"], "ko_text": r["t_ko"]},
    }


def _conv(r: sqlite3.Row) -> dict:
    last = None
    if r["kind"] is not None:
        preview = body_text({"kind": r["kind"], "body": r["body"], "attachment_label": r["attachment_label"]})
        last = {"body_preview": preview[:120], "direction": r["direction"], "kind": r["kind"], "shown_time": r["shown_time"]}
    return {
        "id": r["id"], "client_id": r["client_id"], "client_name": r["client_name"], "display_name": r["display_name"],
        "last_message": last, "last_activity_at": r["last_activity_at"], "last_seq": r["last_seq"],
    }


def message_dto(conn: sqlite3.Connection, mid: int) -> dict | None:
    r = conn.execute(MSG_SQL + " WHERE m.id=?", (mid,)).fetchone()
    return _msg(r) if r else None


def conversation_dto(conn: sqlite3.Connection, cid: int) -> dict | None:
    r = conn.execute(CONV_SQL + " WHERE cv.id=?", (cid,)).fetchone()
    return _conv(r) if r else None


def list_conversations(conn: sqlite3.Connection, client_id: int | None, q: str | None, limit: int = 500) -> list[dict]:
    where, args = [], []
    if client_id is not None:
        where.append("cv.client_id = ?")
        args.append(client_id)
    if q:
        where.append("cv.display_name LIKE ? ESCAPE '\\'")
        args.append("%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%")
    sql = CONV_SQL + (" WHERE " + " AND ".join(where) if where else "")
    sql += " ORDER BY cv.last_activity_at IS NULL, cv.last_activity_at DESC, cv.id DESC LIMIT ?"
    return [_conv(r) for r in conn.execute(sql, (*args, limit))]


def list_messages(conn: sqlite3.Connection, conv_id: int, before: int | None, limit: int) -> dict:
    sql = MSG_SQL + " WHERE m.conversation_id=?"
    args: list = [conv_id]
    if before is not None:
        sql += " AND m.conv_seq < ?"
        args.append(before)
    sql += " ORDER BY m.conv_seq DESC LIMIT ?"
    rows = conn.execute(sql, (*args, limit + 1)).fetchall()
    has_more = len(rows) > limit
    rows = rows[:limit]
    rows.reverse()
    return {"messages": [_msg(r) for r in rows], "has_more": has_more}
