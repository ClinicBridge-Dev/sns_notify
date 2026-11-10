import pytest

from app import config


def write(tmp_path, body):
    p = tmp_path / "config.yaml"
    p.write_text(body)
    return p


BASE = """
server: {host: 127.0.0.1, auth: none}
clients:
  - key: a
    name: A
    slack_channel_id: CA
    slack_token_ref: TOK
    accounts: [{key: a1, label: A1, exclude: [skip me]}]
"""


def test_load_and_sync(tmp_path, db):
    cfg = config.load(write(tmp_path, BASE), env_path=None)
    cfg.validate()
    assert cfg.clients[0].accounts[0].exclude == ["skip me"]
    ids = config.sync_to_db(cfg, db)
    assert set(ids) == {"a1"}
    config.sync_to_db(cfg, db)  # idempotent
    assert db.execute("SELECT count(*) FROM accounts").fetchone()[0] == 1


def test_auth_none_requires_localhost(tmp_path):
    cfg = config.load(write(tmp_path, BASE.replace("127.0.0.1", "0.0.0.0")), env_path=None)
    with pytest.raises(ValueError):
        cfg.validate()


def test_password_auth_needs_secrets(tmp_path, monkeypatch):
    monkeypatch.delenv("VIEWER_PASSWORD", raising=False)
    cfg = config.load(write(tmp_path, BASE.replace("auth: none", "auth: password")), env_path=None)
    with pytest.raises(ValueError):
        cfg.validate()


def test_account_cannot_move_between_clients(tmp_path, db):
    cfg = config.load(write(tmp_path, BASE), env_path=None)
    config.sync_to_db(cfg, db)
    moved = BASE.replace("key: a\n", "key: b\n")
    cfg2 = config.load(write(tmp_path, moved), env_path=None)
    with pytest.raises(ValueError):
        config.sync_to_db(cfg2, db)
