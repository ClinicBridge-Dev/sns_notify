"""Heartbeat + ops alerts to the ops-only Slack channel (never a client channel)."""
from __future__ import annotations

import asyncio
import logging
import os
import sqlite3
from datetime import datetime, timezone

from ..db.repo import meta_get, meta_set
from ..slack.format import escape
from .status import summary

log = logging.getLogger(__name__)

IG_STALE_SEC = 300  # the extension reports at least once a minute while its tab is alive
STATUS_KO = {"ok": "연결됨", "disconnected": "연결 끊김", "locked": "화면 잠김", "unknown": "확인 불가"}


def _ago(ts: str | None) -> str:
    if not ts:
        return "기록 없음"
    s = int((datetime.now(timezone.utc) - datetime.fromisoformat(ts)).total_seconds())
    return f"{s}초 전" if s < 120 else f"{s // 60}분 전"


def heartbeat_text(conn: sqlite3.Connection, ax_trusted: bool | None = None) -> str:
    s = summary(conn)
    lines = [":heartbeat: *WhatsApp 수집기 살아 있음*"]
    for a in s["accounts"]:
        lines.append(f"• {escape(a['client_name'])} / {escape(a['label'])}: {STATUS_KO.get(a['status'], a['status'])}, 마지막 수집 {_ago(a['last_ok_at'])}")
    for w in s["watch"]:
        if w["channel"] != "instagram":
            continue
        stale = (datetime.now(timezone.utc) - datetime.fromisoformat(w["snapshot_at"])).total_seconds() > IG_STALE_SEC
        lines.append(f"• Instagram @{escape(w['account'])} {w['folder']}: 마지막 확인 {_ago(w['snapshot_at'])}"
                     + (" :warning: Chrome 탭이 닫혔거나 로그아웃됐는지 확인" if stale else ""))
    n = s["notices"]
    lines.append(f"• 새 메시지 알림 대기 {n['pending']} / 실패 {n['failed']} / 미확인 {n['unconfirmed']}")
    lines.append(f"• 번역 대기 {s['translation_pending']} · Slack 대기 {s['slack']['pending']} / 실패 {s['slack']['failed']} / 미확인 {s['slack']['unconfirmed']}")
    if ax_trusted is False:
        lines.append("• :warning: 손쉬운 사용 권한 없음")
    return "\n".join(lines)


def check_instagram_watch(conn: sqlite3.Connection, stale_sec: float = IG_STALE_SEC) -> None:
    """The Instagram watch depends on a Chrome tab staying open. Raise one ops event when a list
    stops reporting, and one when it comes back."""
    from ..db.repo import ops_event

    now = datetime.now(timezone.utc)
    for w in conn.execute("SELECT account, folder, snapshot_at FROM notice_folders WHERE channel='instagram' AND folder IN ('primary','general','requests')"):
        key = f"ig_stale:{w['account']}:{w['folder']}"
        stale = (now - datetime.fromisoformat(w["snapshot_at"])).total_seconds() > stale_sec
        was = meta_get(conn, key) == "1"
        if stale and not was:
            ops_event(conn, "warning", "instagram_watch_stopped",
                      f"@{w['account']} {w['folder']}: 확장 프로그램이 {int(stale_sec // 60)}분 넘게 보고하지 않음 (Chrome 탭·로그인 확인)")
            meta_set(conn, key, "1")
        elif not stale and was:
            ops_event(conn, "info", "instagram_watch_resumed", f"@{w['account']} {w['folder']}")
            meta_set(conn, key, "0")


def pending_alerts(conn: sqlite3.Connection, limit: int = 20) -> tuple[list[sqlite3.Row], int]:
    last = int(meta_get(conn, "ops_notified_id") or 0)
    rows = conn.execute(
        "SELECT * FROM ops_events WHERE id > ? AND level IN ('warning','error') ORDER BY id LIMIT ?", (last, limit)
    ).fetchall()
    top = conn.execute("SELECT coalesce(max(id),0) FROM ops_events").fetchone()[0]
    return rows, top


def alert_text(rows: list[sqlite3.Row]) -> str:
    icon = {"warning": ":warning:", "error": ":rotating_light:"}
    return "\n".join(f"{icon[r['level']]} `{r['kind']}` {escape(r['detail'] or '')}" for r in rows)


class OpsNotifier:
    def __init__(self, conn: sqlite3.Connection, poster, *, channel: str | None, token_ref: str | None,
                 heartbeat_interval_sec: float = 600, ax_check=None):
        self.conn, self.poster = conn, poster
        self.channel, self.token_ref = channel, token_ref
        self.heartbeat_interval_sec = heartbeat_interval_sec
        self.ax_check = ax_check

    def _token(self) -> str | None:
        return os.environ.get(self.token_ref) if self.token_ref else None

    def enabled(self) -> bool:
        return bool(self.channel and self._token())

    def heartbeat(self) -> None:
        trusted = self.ax_check() if self.ax_check else None
        if trusted is False:
            from ..db.repo import ops_event

            if meta_get(self.conn, "ax_untrusted_reported") != "1":
                ops_event(self.conn, "error", "ax_permission_missing", "손쉬운 사용 권한이 해제됨")
                meta_set(self.conn, "ax_untrusted_reported", "1")
        elif trusted:
            meta_set(self.conn, "ax_untrusted_reported", "0")
        if self.enabled():
            self.poster.post(self._token(), self.channel, heartbeat_text(self.conn, trusted))

    def flush_alerts(self) -> int:
        check_instagram_watch(self.conn)
        rows, top = pending_alerts(self.conn)
        if rows and self.enabled():
            self.poster.post(self._token(), self.channel, alert_text(rows))
        if rows or top:
            meta_set(self.conn, "ops_notified_id", str(rows[-1]["id"] if rows and len(rows) == 20 else top))
        return len(rows)


async def run_ops(n: OpsNotifier, alert_interval: float = 30) -> None:
    loop = asyncio.get_running_loop()
    next_hb = 0.0
    while True:
        try:
            if loop.time() >= next_hb:
                await asyncio.to_thread(n.heartbeat)
                next_hb = loop.time() + n.heartbeat_interval_sec
            await asyncio.to_thread(n.flush_alerts)
        except Exception:
            log.exception("ops notifier failed (will retry)")
        await asyncio.sleep(alert_interval)
