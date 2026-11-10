"""Single process: collector(s) + translator + Slack sender + ops + viewer, as asyncio tasks.

If any task dies the TaskGroup cancels the rest and the process exits non-zero; launchd
(KeepAlive) restarts it. Every worker is restart-safe by construction (DB-backed state).
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import logging.handlers
import os
import sys
import threading
import time
from pathlib import Path

from . import config as config_mod
from .api.auth import NoAuth, SessionAuth
from .api.bus import Bus
from .api.server import create_app
from .collector.contract import FakeReader, Reader
from .collector.loop import AccountCollector, run_collector
from .db.repo import connect, migrate, ops_event
from .ops.backup import run_backup
from .ops.notify import OpsNotifier, run_ops
from .slack.sender import SlackSdkPoster, SlackSender, run_sender
from .notices.core import NoticeSender, run_notice_sender
from .notices.whatsapp import WhatsAppWatcher, run_watcher
from .translator.gpt import OpenAITranslator
from .translator.worker import TranslatorWorker, run_translator

log = logging.getLogger("app")


def setup_logging(log_dir: Path) -> None:
    log_dir.mkdir(parents=True, exist_ok=True)
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s")
    fh = logging.handlers.RotatingFileHandler(log_dir / "app.log", maxBytes=10_000_000, backupCount=5)
    fh.setFormatter(fmt)
    sh = logging.StreamHandler(sys.stderr)
    sh.setFormatter(fmt)
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    root.handlers[:] = [fh, sh]
    for noisy in ("httpx", "httpx2", "httpcore", "openai", "slack_sdk"):  # request logs could carry message bodies
        logging.getLogger(noisy).setLevel(logging.WARNING)


def watch_parent(expected_ppid: int, interval: float = 2.0, exit_fn=os._exit) -> threading.Thread:
    """When started by the 「WhatsApp 수집기」 app: if the app dies (even SIGKILL), exit too, so an
    orphaned collector never keeps the port / DB and blocks the next one."""

    def run():
        while True:
            if os.getppid() != expected_ppid:
                logging.getLogger("app").warning("launcher app is gone; exiting")
                logging.shutdown()
                exit_fn(0)
                return
            time.sleep(interval)

    t = threading.Thread(target=run, name="parent-watch", daemon=True)
    t.start()
    return t


def make_reader(method: str, session_key: str | None) -> tuple[Reader, bool]:
    """Returns (reader, supports_ax_wake)."""
    if method == "ax":
        from .collector.ax_reader import AXReader

        return AXReader(), True
    if method == "fake":
        if not session_key:
            raise ValueError("collect_method=fake needs session_key = path to a fixture JSON")
        return FakeReader.from_json(json.loads(Path(session_key).read_text())), False
    raise NotImplementedError(f"collect_method={method!r} is not implemented yet (web = Phase 0 fallback)")


async def amain(cfg: config_mod.Config) -> None:
    conn = connect(cfg.db_path)
    migrate(conn)
    account_ids = config_mod.sync_to_db(cfg, conn)
    loop = asyncio.get_running_loop()

    def factory():
        return connect(cfg.db_path)

    bus = Bus(factory)

    tasks = []
    readers: list = []
    for c in cfg.clients:
        client_id = conn.execute("SELECT id FROM clients WHERE key=?", (c.key,)).fetchone()[0]
        for a in c.accounts:
            reader, ax_wake = make_reader(a.collect_method, a.session_key)
            readers.append(reader)
            wake = asyncio.Event()
            if ax_wake:
                from .collector.ax_reader import start_wake_observer

                start_wake_observer(reader.backend, lambda w=wake: loop.call_soon_threadsafe(w.set))
            if a.mode == "notify":
                # list-only: never opens a chat, so unread badges on the account are untouched
                watcher = WhatsAppWatcher(factory(), reader, account_id=account_ids[a.key], account_key=a.key,
                                          client_id=client_id, exclude=a.exclude)
                tasks.append(("whatsapp-watch:" + a.key, run_watcher(watcher, cfg.poll_interval_sec, wake)))
                continue
            log.warning("account %s runs in collect mode: chats are opened, which marks messages as read", a.key)
            collector = AccountCollector(
                factory(), reader, account_id=account_ids[a.key], client_id=client_id,
                recent_window=cfg.recent_window, baseline_max=cfg.baseline_max,
                catchup_after_sec=cfg.catchup_after_sec, full_sweep_interval_sec=cfg.full_sweep_interval_sec,
                include_groups=cfg.include_groups, exclude=a.exclude,
                on_new=lambda ids: loop.call_soon_threadsafe(bus.publish_messages, ids),
            )
            tasks.append(("collector:" + a.key, run_collector(collector, cfg.poll_interval_sec, wake,
                                                                stall_timeout_sec=cfg.stall_timeout_sec)))

    translator = TranslatorWorker(
        factory(), OpenAITranslator(cfg.secret(cfg.openai_key_ref), cfg.translate_model), model=cfg.translate_model,
        max_attempts=cfg.translate_max_attempts, wait_before_slack_sec=cfg.translate_wait_sec,
        on_change=bus.publish_translations,
    )
    sender = SlackSender(factory(), SlackSdkPoster(cfg.slack_timeout_sec), max_attempts=cfg.slack_max_attempts)

    ax_check = None
    ax_readers = [r for r in readers if hasattr(r, "backend")]
    if ax_readers:
        def ax_check(b=ax_readers[0].backend):
            try:
                return b.trusted()
            except Exception:
                return None
    notifier = OpsNotifier(factory(), SlackSdkPoster(cfg.slack_timeout_sec), channel=cfg.ops_channel_id,
                           token_ref=cfg.ops_token_ref, heartbeat_interval_sec=cfg.heartbeat_interval_sec,
                           ax_check=ax_check)
    if not notifier.enabled():
        log.warning("ops Slack channel/token not configured: heartbeat and ops alerts go to the log only")

    if cfg.auth == "password":
        auth = SessionAuth(os.environ["VIEWER_PASSWORD"], os.environ["SESSION_SECRET"], cfg.session_hours * 3600)
    else:
        auth = NoAuth()
    client_ids = {r["key"]: r["id"] for r in conn.execute("SELECT id, key FROM clients")}
    ig_routes = {acct: client_ids[ck] for acct, ck in cfg.instagram.items() if ck in client_ids}
    for acct, ck in cfg.instagram.items():
        if ck not in client_ids:
            log.warning("instagram account %s routes to unknown client %s", acct, ck)
    app = create_app(factory, auth, bus, instagram_routes=ig_routes)
    notice_sender = NoticeSender(factory(), SlackSdkPoster(cfg.slack_timeout_sec), max_attempts=cfg.slack_max_attempts)

    import uvicorn

    server = uvicorn.Server(uvicorn.Config(app, host=cfg.host, port=cfg.port, log_level="warning", access_log=False))
    tasks += [
        ("translator", run_translator(translator)),
        ("slack", run_sender(sender)),
        ("notices", run_notice_sender(notice_sender)),
        ("ops", run_ops(notifier)),
        ("backup", run_backup(cfg.db_path, cfg.backup_dir, cfg.backup_keep_days, cfg.backup_hour_local,
                              lambda err: ops_event(conn, "error", "backup_failed", err))),
        ("api", server.serve()),
    ]
    ops_event(conn, "info", "process_started", f"pid {os.getpid()}")
    log.info("started: %d task(s), viewer on http://%s:%d", len(tasks), cfg.host, cfg.port)
    async with asyncio.TaskGroup() as tg:
        for name, coro in tasks:
            tg.create_task(coro, name=name)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default="config.yaml")
    ap.add_argument("--env", default=".env")
    ap.add_argument("--log-dir", default="logs")
    a = ap.parse_args()
    setup_logging(Path(a.log_dir))
    if os.environ.get("LW_AX_BRIDGE") == "1":
        watch_parent(os.getppid())
    cfg = config_mod.load(a.config, a.env)
    cfg.validate()
    try:
        asyncio.run(amain(cfg))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
