#!/bin/zsh
# Manual / cron-style backup using sqlite3's online .backup (the app also does this daily in-process).
#   scripts/backup.sh [DB] [DEST_DIR]
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
DB="${1:-$REPO/data/whatsapp.db}"
DEST_DIR="${2:-$HOME/WhatsAppBackups}"
mkdir -p "$DEST_DIR"; chmod 700 "$DEST_DIR"
OUT="$DEST_DIR/whatsapp-$(date +%Y%m%d-%H%M%S).db"
/usr/bin/sqlite3 "$DB" ".backup '$OUT'"
chmod 600 "$OUT"
/usr/bin/sqlite3 "$OUT" "PRAGMA integrity_check;" | grep -qx ok && echo "ok: $OUT"
