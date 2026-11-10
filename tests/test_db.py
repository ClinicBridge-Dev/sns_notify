from app.db.repo import connect, migrate


def test_migrate_idempotent(tmp_path):
    c = connect(tmp_path / "x.db")
    assert migrate(c) == 3
    assert migrate(c) == 3
    assert c.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
    names = {r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert {"clients", "accounts", "conversations", "messages", "translations", "slack_outbox", "ops_events"} <= names
