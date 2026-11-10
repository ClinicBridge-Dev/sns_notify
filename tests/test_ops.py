from datetime import datetime

from app.ops.backup import backup_once
from app.ops.notify import OpsNotifier, heartbeat_text
from app.db.repo import connect, ops_event
from tests.test_slack import FakePoster
from tests.test_translator import seed


def test_heartbeat_text_summarizes(db):
    seed(db, "Hello")
    t = heartbeat_text(db)
    assert "번역 대기 1" in t and "A / A1" in t


def test_alerts_flush_once(db, monkeypatch):
    monkeypatch.setenv("OPS_TOK", "xoxb")
    ops_event(db, "info", "group_skipped", "x")
    ops_event(db, "error", "account_status", "ok -> disconnected <@here>")
    p = FakePoster()
    n = OpsNotifier(db, p, channel="COPS", token_ref="OPS_TOK")
    assert n.flush_alerts() == 1
    assert n.flush_alerts() == 0
    assert len(p.posts) == 1 and "&lt;@here&gt;" in p.posts[0][2] and p.posts[0][1] == "COPS"


def test_ax_permission_loss_recorded_once(db):
    n = OpsNotifier(db, FakePoster(), channel=None, token_ref=None, ax_check=lambda: False)
    n.heartbeat()
    n.heartbeat()
    assert db.execute("SELECT count(*) FROM ops_events WHERE kind='ax_permission_missing'").fetchone()[0] == 1


def test_backup_and_rotation(db_path, tmp_path):
    c = connect(db_path)
    seed(c, "Hello")
    c.close()
    bdir = tmp_path / "bk"
    old = backup_once(db_path, bdir, keep_days=3, now=datetime(2026, 1, 1))
    new = backup_once(db_path, bdir, keep_days=3, now=datetime(2026, 1, 10))
    assert not old.exists() and new.exists()
    b = connect(new)
    assert b.execute("SELECT count(*) FROM messages").fetchone()[0] == 1
    assert (new.stat().st_mode & 0o777) == 0o600
