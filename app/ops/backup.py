"""Daily online backup with SQLite's backup API (safe while the app writes)."""
from __future__ import annotations

import asyncio
import logging
import sqlite3
from datetime import datetime, timedelta
from pathlib import Path

log = logging.getLogger(__name__)


def backup_once(db_path: Path, backup_dir: Path, keep_days: int = 14, now: datetime | None = None) -> Path:
    now = now or datetime.now()
    backup_dir.mkdir(parents=True, exist_ok=True)
    backup_dir.chmod(0o700)
    dest = backup_dir / f"whatsapp-{now:%Y%m%d}.db"
    tmp = dest.with_suffix(".db.tmp")
    src = sqlite3.connect(str(db_path))
    try:
        dst = sqlite3.connect(str(tmp))
        with dst:
            src.backup(dst)
        dst.close()
    finally:
        src.close()
    tmp.chmod(0o600)
    tmp.replace(dest)
    cutoff = now - timedelta(days=keep_days)
    for f in backup_dir.glob("whatsapp-*.db"):
        try:
            if datetime.strptime(f.stem.split("-", 1)[1], "%Y%m%d") < cutoff:
                f.unlink()
        except ValueError:
            continue
    return dest


async def run_backup(db_path: Path, backup_dir: Path | None, keep_days: int, hour_local: int, on_error) -> None:
    if not backup_dir:
        log.warning("ops.backup_dir not set: in-app daily backup disabled")
        return
    while True:
        now = datetime.now()
        today = backup_dir / f"whatsapp-{now:%Y%m%d}.db"
        if now.hour >= hour_local and not today.exists():
            try:
                await asyncio.to_thread(backup_once, db_path, backup_dir, keep_days)
                log.info("backup written: %s", today)
            except Exception as e:
                log.exception("backup failed")
                on_error(f"{type(e).__name__}: {e}")
        await asyncio.sleep(600)
