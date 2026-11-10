#!/bin/zsh
# Build dist/WhatsAppCollector.app ("WhatsApp 수집기") — the menu bar app that holds the
# 손쉬운 사용 permission and runs the Python collector as its child.
# Skips the build when the launcher source is unchanged, because every rebuild of an ad-hoc
# signed app invalidates the Accessibility grant.
#   scripts/build_app.sh [--force]
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$REPO/mac/WhatsAppCollector"
APP="$REPO/dist/WhatsAppCollector.app"
BUNDLE_ID=com.clinicbridge.whatsapp-collector
HASH=$(cat "$SRC"/*.swift "$SRC/Info.plist" | shasum -a 256 | cut -c1-16)

if [[ "${1:-}" != "--force" && -f "$APP/Contents/Resources/source-hash" && "$(cat "$APP/Contents/Resources/source-hash")" == "$HASH" ]]; then
  echo "up to date: $APP ($HASH)"; exit 0
fi
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$SRC/Info.plist" "$APP/Contents/Info.plist"
echo "$HASH" > "$APP/Contents/Resources/source-hash"
swiftc -O -target arm64-apple-macos13.0 "$SRC"/*.swift -o "$APP/Contents/MacOS/WhatsAppCollector"
# Ad-hoc signature, stable identifier. No sandbox (Accessibility does not work sandboxed).
codesign --force --sign - --identifier "$BUNDLE_ID" "$APP"
codesign --verify --strict "$APP"
echo "built: $APP ($HASH)"
