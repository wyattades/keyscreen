#!/usr/bin/env bash
# Installs the screen server as a user service (starts at login) and the top-bar indicator.
#   desktop/install.sh            install / update
#   desktop/install.sh --remove   uninstall
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUN="$(command -v bun || echo "$HOME/.bun/bin/bun")"
UNIT="$HOME/.config/systemd/user/qk108.service"
AUTOSTART="$HOME/.config/autostart/qk108-indicator.desktop"

if [[ "${1:-}" == "--remove" ]]; then
  systemctl --user disable --now qk108.service 2>/dev/null || true
  pkill -f "$ROOT/desktop/indicator.py" || true
  rm -f "$UNIT" "$AUTOSTART"
  systemctl --user daemon-reload
  echo "removed"
  exit 0
fi

mkdir -p "$(dirname "$UNIT")" "$(dirname "$AUTOSTART")"
sed -e "s|@ROOT@|$ROOT|g" -e "s|@BUN@|$BUN|g" "$ROOT/desktop/qk108.service" > "$UNIT"
sed -e "s|@ROOT@|$ROOT|g" "$ROOT/desktop/qk108-indicator.desktop" > "$AUTOSTART"
systemctl --user daemon-reload
systemctl --user enable qk108.service
systemctl --user restart qk108.service

pkill -f "$ROOT/desktop/indicator.py" || true
setsid -f /usr/bin/python3 "$ROOT/desktop/indicator.py" >/dev/null 2>&1 < /dev/null

echo "installed: server runs at login (systemctl --user status qk108), indicator in the top bar"
if ! gnome-extensions list --enabled 2>/dev/null | grep -q appindicator; then
  echo "note: turn on top-bar indicators with: gnome-extensions enable ubuntu-appindicators@ubuntu.com"
fi
