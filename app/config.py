"""config.yaml (non-secret structure) + .env (secrets). Secrets are referenced by env key name."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

import yaml
from dotenv import load_dotenv

from .db.repo import utcnow


@dataclass
class AccountCfg:
    key: str
    label: str
    collect_method: str = "ax"
    session_key: str | None = None
    exclude: list[str] = field(default_factory=list)
    # notify: watch the chat list only, never open a chat (unread badges stay). MVP default.
    # collect: open chats and store full transcripts -- this marks messages as read on the account.
    mode: str = "notify"


@dataclass
class ClientCfg:
    key: str
    name: str
    slack_channel_id: str | None
    slack_token_ref: str | None
    accounts: list[AccountCfg]
    active: bool = True


@dataclass
class Config:
    db_path: Path = Path("data/whatsapp.db")
    host: str = "0.0.0.0"
    port: int = 8787
    auth: str = "password"  # password | none
    session_hours: int = 12
    poll_interval_sec: float = 5
    full_sweep_interval_sec: float = 300
    recent_window: int = 30
    baseline_max: int = 200
    catchup_after_sec: float = 120
    include_groups: bool = False
    stall_timeout_sec: float = 600
    translate_model: str = "gpt-4o-mini"
    translate_wait_sec: float = 60
    translate_max_attempts: int = 5
    openai_key_ref: str = "OPENAI_API_KEY"
    slack_timeout_sec: float = 10
    slack_max_attempts: int = 5
    ops_channel_id: str | None = None
    ops_token_ref: str | None = None
    heartbeat_interval_sec: float = 600
    backup_dir: Path | None = None
    backup_keep_days: int = 14
    backup_hour_local: int = 4
    clients: list[ClientCfg] = field(default_factory=list)
    instagram: dict[str, str] = field(default_factory=dict)  # instagram username -> client key (Slack routing)

    def secret(self, ref: str | None) -> str | None:
        return os.environ.get(ref) if ref else None

    def validate(self) -> None:
        if self.auth not in ("password", "none"):
            raise ValueError("server.auth must be 'password' or 'none'")
        if self.auth == "none" and self.host not in ("127.0.0.1", "localhost", "::1"):
            raise ValueError("server.auth=none is only allowed with a localhost bind")
        if self.auth == "password":
            if not os.environ.get("VIEWER_PASSWORD"):
                raise ValueError("VIEWER_PASSWORD missing in .env")
            if len(os.environ.get("SESSION_SECRET", "")) < 32:
                raise ValueError("SESSION_SECRET missing or shorter than 32 chars in .env")
        keys = [a.key for c in self.clients for a in c.accounts]
        for c in self.clients:
            for a in c.accounts:
                if a.mode not in ("notify", "collect"):
                    raise ValueError(f"account {a.key}: mode must be 'notify' or 'collect'")
                if a.mode == "notify" and a.collect_method != "ax":
                    raise ValueError(f"account {a.key}: mode 'notify' needs collect_method 'ax' (use mode: collect for {a.collect_method})")
        if len(keys) != len(set(keys)):
            raise ValueError("account keys must be unique")


def load(path: str | Path = "config.yaml", env_path: str | Path | None = ".env") -> Config:
    if env_path and Path(env_path).exists():
        _check_env_perms(Path(env_path))
        load_dotenv(env_path, override=False)
    raw = yaml.safe_load(Path(path).read_text()) or {}
    s, col, tr, sl, ops = (raw.get(k) or {} for k in ("server", "collector", "translator", "slack", "ops"))
    cfg = Config(
        db_path=Path(raw.get("db_path", "data/whatsapp.db")).expanduser(),
        host=s.get("host", "0.0.0.0"),
        port=int(s.get("port", 8787)),
        auth=s.get("auth", "password"),
        session_hours=int(s.get("session_hours", 12)),
        poll_interval_sec=float(col.get("poll_interval_sec", 5)),
        full_sweep_interval_sec=float(col.get("full_sweep_interval_sec", 300)),
        recent_window=int(col.get("recent_window", 30)),
        baseline_max=int(col.get("baseline_max", 200)),
        catchup_after_sec=float(col.get("catchup_after_sec", 120)),
        include_groups=bool(col.get("include_groups", False)),
        stall_timeout_sec=float(col.get("stall_timeout_sec", 600)),
        translate_model=tr.get("model", "gpt-4o-mini"),
        translate_wait_sec=float(tr.get("wait_before_slack_sec", 60)),
        translate_max_attempts=int(tr.get("max_attempts", 5)),
        openai_key_ref=tr.get("api_key_ref", "OPENAI_API_KEY"),
        slack_timeout_sec=float(sl.get("timeout_sec", 10)),
        slack_max_attempts=int(sl.get("max_attempts", 5)),
        ops_channel_id=ops.get("slack_channel_id"),
        ops_token_ref=ops.get("slack_token_ref"),
        heartbeat_interval_sec=float(ops.get("heartbeat_interval_sec", 600)),
        backup_dir=Path(ops["backup_dir"]).expanduser() if ops.get("backup_dir") else None,
        backup_keep_days=int(ops.get("backup_keep_days", 14)),
        backup_hour_local=int(ops.get("backup_hour_local", 4)),
        clients=[
            ClientCfg(
                key=c["key"],
                name=c["name"],
                slack_channel_id=c.get("slack_channel_id"),
                slack_token_ref=c.get("slack_token_ref"),
                active=bool(c.get("active", True)),
                accounts=[
                    AccountCfg(
                        key=a["key"],
                        label=a.get("label", a["key"]),
                        collect_method=a.get("collect_method", "ax"),
                        session_key=a.get("session_key"),
                        exclude=list(a.get("exclude") or []),
                        mode=a.get("mode") or ("notify" if a.get("collect_method", "ax") == "ax" else "collect"),
                    )
                    for a in c.get("accounts") or []
                ],
            )
            for c in raw.get("clients") or []
        ],
        instagram={str(i["account"]).lstrip("@"): str(i["client"]) for i in raw.get("instagram") or []},
    )
    return cfg


def _check_env_perms(p: Path) -> None:
    mode = p.stat().st_mode & 0o777
    if mode & 0o077:
        import logging

        logging.getLogger(__name__).warning(".env permissions are %o; run: chmod 600 %s", mode, p)


def sync_to_db(cfg: Config, conn) -> dict[str, int]:
    """Upsert clients/accounts from config. Returns account key -> account id."""
    now = utcnow()
    ids: dict[str, int] = {}
    conn.execute("BEGIN IMMEDIATE")
    try:
        for c in cfg.clients:
            conn.execute(
                """INSERT INTO clients(key, name, slack_channel_id, slack_token_ref, active, created_at)
                   VALUES (?,?,?,?,?,?)
                   ON CONFLICT(key) DO UPDATE SET name=excluded.name, slack_channel_id=excluded.slack_channel_id,
                     slack_token_ref=excluded.slack_token_ref, active=excluded.active""",
                (c.key, c.name, c.slack_channel_id, c.slack_token_ref, int(c.active), now),
            )
            cid = conn.execute("SELECT id FROM clients WHERE key=?", (c.key,)).fetchone()[0]
            for a in c.accounts:
                row = conn.execute("SELECT id, client_id FROM accounts WHERE key=?", (a.key,)).fetchone()
                if row and row["client_id"] != cid:
                    raise ValueError(f"account {a.key} already belongs to another client; refusing to move its history")
                conn.execute(
                    """INSERT INTO accounts(client_id, key, label, collect_method, session_key)
                       VALUES (?,?,?,?,?)
                       ON CONFLICT(key) DO UPDATE SET label=excluded.label, collect_method=excluded.collect_method,
                         session_key=excluded.session_key""",
                    (cid, a.key, a.label, a.collect_method, a.session_key),
                )
                ids[a.key] = conn.execute("SELECT id FROM accounts WHERE key=?", (a.key,)).fetchone()[0]
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise
    return ids
