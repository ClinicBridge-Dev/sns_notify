#!/bin/zsh
# Install "WhatsApp 수집기" for the logged-in user:
#   - ~/Applications/WhatsAppCollector.app       (the app you enable in 손쉬운 사용)
#   - ~/Library/Application Support/WhatsAppCollector/launcher.json  (where the Python code lives)
#   - LaunchAgent com.clinicbridge.whatsapp      (start at login, relaunch on crash)
#
#   scripts/install_app.sh            install / update
#   scripts/install_app.sh --dev      same, plus wacollector:// diagnostic URLs (development Mac only)
#   scripts/install_app.sh uninstall  stop and remove (keeps data/, logs/, config)
#
# Tip: keep the repository outside ~/Documents, ~/Desktop, ~/Downloads on the Mac mini, otherwise
# macOS will additionally ask to let the app access that folder.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
LABEL=com.clinicbridge.whatsapp
BUNDLE_ID=com.clinicbridge.whatsapp-collector
DEST_APP="$HOME/Applications/WhatsAppCollector.app"
SUPPORT="$HOME/Library/Application Support/WhatsAppCollector"
AGENT="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
# Copies opened by hand (Finder/open) are not managed by launchd; stop them too, or the new
# instance exits on its single-instance check.
pkill -f "WhatsAppCollector.app/Contents/MacOS/WhatsAppCollector" 2>/dev/null || true
sleep 1
if [[ "${1:-}" == "uninstall" ]]; then
  rm -f "$AGENT"; rm -rf "$DEST_APP" "$SUPPORT"
  tccutil reset Accessibility "$BUNDLE_ID" >/dev/null 2>&1 || true
  tccutil reset SystemPolicyDocumentsFolder "$BUNDLE_ID" >/dev/null 2>&1 || true
  echo "removed: app, LaunchAgent, launcher settings, 손쉬운 사용 entry"
  echo "kept:    $REPO (config.yaml, .env, data/, logs/, ax_dumps/) and any backups"; exit 0
fi

[[ -f "$REPO/config.yaml" ]] || { echo "config.yaml missing (copy config.example.yaml)"; exit 1; }
[[ -f "$REPO/.env" ]] || { echo ".env missing (copy .env.example)"; exit 1; }
[[ -x "$REPO/.venv/bin/python" ]] || (cd "$REPO" && uv sync --no-dev)
chmod 600 "$REPO/.env"
mkdir -p "$REPO/logs" "$REPO/data" && chmod 700 "$REPO/logs" "$REPO/data"

"$REPO/scripts/build_app.sh"
NEW_HASH=$(cat "$REPO/dist/WhatsAppCollector.app/Contents/Resources/source-hash")
OLD_HASH=$(cat "$DEST_APP/Contents/Resources/source-hash" 2>/dev/null || echo none)
mkdir -p "$HOME/Applications"
if [[ "$NEW_HASH" != "$OLD_HASH" ]]; then
  rm -rf "$DEST_APP"
  ditto "$REPO/dist/WhatsAppCollector.app" "$DEST_APP"
  # The old grant pointed at the previous build; clear it so the list shows one clean entry.
  tccutil reset Accessibility "$BUNDLE_ID" >/dev/null 2>&1 || true
  REGRANT=1
else
  REGRANT=0
fi

PORT=$("$REPO/.venv/bin/python" -c "import yaml;print((yaml.safe_load(open('$REPO/config.yaml')) or {}).get('server',{}).get('port',8787))")
mkdir -p "$SUPPORT" && chmod 700 "$SUPPORT"
DEV=$([[ "${1:-}" == "--dev" ]] && echo 1 || echo 0)
"$REPO/.venv/bin/python" - "$SUPPORT/launcher.json" "$REPO" "$PORT" "$DEV" <<'PY'
import json, sys
path, repo, port, dev = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4] == "1"
json.dump({"repo": repo, "viewer_url": f"http://localhost:{port}", "debug_actions": dev},
          open(path, "w"), ensure_ascii=False, indent=2)
PY

mkdir -p "$HOME/Library/LaunchAgents"
sed -e "s#__APP__#$DEST_APP#g" -e "s#__LOGS__#$REPO/logs#g" "$REPO/launchd/$LABEL.plist" > "$AGENT"
plutil -lint "$AGENT" >/dev/null
launchctl bootstrap "$DOMAIN" "$AGENT"
launchctl enable "$DOMAIN/$LABEL"

echo "installed: $DEST_APP"
echo "menu bar:  말풍선 아이콘 → '손쉬운 사용 권한' 상태 확인"
if [[ "$REGRANT" == 1 ]]; then
  echo
  echo "▶ 시스템 설정 → 개인정보 보호 및 보안 → 손쉬운 사용 → 'WhatsApp 수집기'를 켜 주세요."
  echo "  (앱이 새로 설치/갱신되어 이전 허용은 초기화되었습니다)"
fi
