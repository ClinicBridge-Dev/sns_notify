"""Operator CLI (the viewer is read-only on purpose).

  uv run python -m app.cli outbox list [--status unconfirmed]
  uv run python -m app.cli outbox mark-sent ID [--ts 1731111111.000100]   # confirmed it is in Slack
  uv run python -m app.cli outbox resend ID                                  # confirmed it is NOT in Slack
  uv run python -m app.cli watch                 # 새 메시지 감시 상태: 목록별 마지막 확인, 안 읽음, 최근 알림
  uv run python -m app.cli notices resend ID [ID ...]   # Slack에 없는 것을 확인한 알림(미확인/실패)을 다시 보냄
  uv run python -m app.cli events [--limit 30]
  uv run python -m app.cli status
"""
from __future__ import annotations

import argparse
import json
import sys

from . import config as config_mod
from .db.repo import connect, migrate, ops_event, utcnow
from .ops.status import summary


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", default="config.yaml")
    sub = ap.add_subparsers(dest="cmd", required=True)
    ob = sub.add_parser("outbox")
    obs = ob.add_subparsers(dest="op", required=True)
    ls = obs.add_parser("list")
    ls.add_argument("--status", default="unconfirmed")
    ms = obs.add_parser("mark-sent")
    ms.add_argument("id", type=int)
    ms.add_argument("--ts")
    rs = obs.add_parser("resend")
    rs.add_argument("id", type=int)
    ev = sub.add_parser("events")
    ev.add_argument("--limit", type=int, default=30)
    sub.add_parser("status")
    sub.add_parser("watch")
    nt = sub.add_parser("notices")
    nts = nt.add_subparsers(dest="op", required=True)
    nr = nts.add_parser("resend")
    nr.add_argument("id", type=int, nargs="+")
    a = ap.parse_args(argv)

    cfg = config_mod.load(a.config, None)
    conn = connect(cfg.db_path)
    migrate(conn)

    if a.cmd == "status":
        print(json.dumps(summary(conn), ensure_ascii=False, indent=2))
    elif a.cmd == "watch":
        from .notices.core import account_label, unread_known, unread_total

        for f in conn.execute("SELECT * FROM notice_folders ORDER BY channel, account, folder"):
            ch, acct = f["channel"], f["account"]
            total = unread_total(conn, ch, acct) if unread_known(conn, ch, acct) else "뱃지 미확인"
            print(f"[{ch}] {account_label(conn, ch, acct)} / {f['folder']}: 마지막 확인 {f['snapshot_at'][:19]}Z, 계정 안 읽음 {total}")
            for t in conn.execute(
                """SELECT thread_name, unread FROM notice_threads WHERE channel=? AND account=? AND folder=?
                   AND seen_at=? AND unread>0 ORDER BY updated_at DESC""", (ch, acct, f["folder"], f["snapshot_at"])):
                print(f"    안 읽음 {t['unread']}: {t['thread_name']}")
        print("-- 최근 알림 --")
        for n in conn.execute("SELECT * FROM notices ORDER BY id DESC LIMIT 15"):
            print(f"#{n['id']} {n['created_at']} [{n['channel']}] {n['thread_name']} 새 {n['new_count']}건 slack={n['slack_status']}"
                  + (f" err={n['last_error']}" if n["last_error"] else ""))
    elif a.cmd == "notices":
        marks = ",".join("?" * len(a.id))
        ok = conn.execute(f"SELECT count(*) FROM notices WHERE id IN ({marks}) AND slack_status IN ('unconfirmed','failed')",
                          a.id).fetchone()[0]
        if ok != len(set(a.id)):
            print("only unconfirmed/failed notices can be resent", file=sys.stderr)
            return 2
        conn.execute(f"UPDATE notices SET slack_status='retry', next_attempt_at=NULL, attempts=0 WHERE id IN ({marks})", a.id)
        ops_event(conn, "info", "notice_resend", f"notice {sorted(set(a.id))} by operator")
        print("ok")
    elif a.cmd == "events":
        for r in conn.execute("SELECT * FROM ops_events ORDER BY id DESC LIMIT ?", (a.limit,)):
            print(f"{r['created_at']} {r['level']:7s} {r['kind']:22s} {r['detail'] or ''}")
    elif a.op == "list":
        rows = conn.execute(
            """SELECT o.id, o.message_id, o.status, o.channel_id, o.attempts, o.last_error, o.created_at, cv.display_name
               FROM slack_outbox o JOIN messages m ON m.id=o.message_id JOIN conversations cv ON cv.id=m.conversation_id
               WHERE o.status=? ORDER BY o.id""",
            (a.status,),
        ).fetchall()
        for r in rows:
            print(f"#{r['id']} msg#{r['message_id']} {r['display_name']} ch={r['channel_id']} tries={r['attempts']} "
                  f"err={r['last_error']} at={r['created_at']}")
        print(f"{len(rows)} row(s)")
    else:
        row = conn.execute("SELECT status FROM slack_outbox WHERE id=?", (a.id,)).fetchone()
        if not row or row["status"] not in ("unconfirmed", "failed"):
            print("only unconfirmed/failed rows can be changed", file=sys.stderr)
            return 2
        if a.op == "mark-sent":
            conn.execute("UPDATE slack_outbox SET status='sent', slack_ts=?, sent_at=? WHERE id=?", (a.ts, utcnow(), a.id))
        else:
            conn.execute("UPDATE slack_outbox SET status='retry', next_attempt_at=NULL, attempts=0 WHERE id=?", (a.id,))
        ops_event(conn, "info", f"outbox_{a.op.replace('-', '_')}", f"outbox {a.id} by operator")
        print("ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
