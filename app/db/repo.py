"""SQLite access. One connection per task/request; WAL so readers never block the collector."""
from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from pathlib import Path

MIGRATIONS = Path(__file__).parent / "migrations"


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat(timespec="seconds")


def connect(path: str | Path) -> sqlite3.Connection:
    p = Path(path)
    if str(p) != ":memory:":
        p.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(p), timeout=30, isolation_level=None, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=30000")
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn


def migrate(conn: sqlite3.Connection) -> int:
    current = conn.execute("PRAGMA user_version").fetchone()[0]
    files = sorted(MIGRATIONS.glob("*.sql"))
    for f in files:
        version = int(f.name.split("_", 1)[0])
        if version <= current:
            continue
        conn.execute("BEGIN IMMEDIATE")
        try:
            for stmt in _split_sql(f.read_text()):
                conn.execute(stmt)
            conn.execute(f"PRAGMA user_version={version}")
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise
        current = version
    return current


def _split_sql(sql: str) -> list[str]:
    lines = [ln for ln in sql.splitlines() if not ln.strip().startswith("--")]
    out, buf = [], []
    for ln in lines:
        buf.append(ln)
        joined = "\n".join(buf)
        if joined.rstrip().endswith(";") and sqlite3.complete_statement(joined):
            out.append(joined.strip())
            buf = []
    if "".join(buf).strip():
        out.append("\n".join(buf).strip())
    return out


class Tx:
    """``with Tx(conn):`` -> BEGIN IMMEDIATE / COMMIT, ROLLBACK on error."""

    def __init__(self, conn: sqlite3.Connection):
        self.conn = conn

    def __enter__(self):
        self.conn.execute("BEGIN IMMEDIATE")
        return self.conn

    def __exit__(self, exc_type, exc, tb):
        self.conn.execute("ROLLBACK" if exc_type else "COMMIT")
        return False


def ops_event(conn: sqlite3.Connection, level: str, kind: str, detail: str | None = None, account_id: int | None = None) -> int:
    cur = conn.execute(
        "INSERT INTO ops_events(level, kind, detail, account_id, created_at) VALUES (?,?,?,?,?)",
        (level, kind, detail, account_id, utcnow()),
    )
    return cur.lastrowid


def meta_get(conn: sqlite3.Connection, k: str) -> str | None:
    row = conn.execute("SELECT v FROM meta WHERE k=?", (k,)).fetchone()
    return row[0] if row else None


def meta_set(conn: sqlite3.Connection, k: str, v: str) -> None:
    conn.execute("INSERT INTO meta(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", (k, v))
