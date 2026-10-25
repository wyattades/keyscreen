#!/usr/bin/env bash
# Installs the screen server as a user service (starts at login), the top-bar indicator, and the
# keyscreen-pointer GNOME Shell extension (gives Sand mode the exact mouse position).
#   desktop/install.sh            install / update
#   desktop/install.sh --remove   uninstall
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUN="$(command -v bun || echo "$HOME/.bun/bin/bun")"
UNIT="$HOME/.config/systemd/user/keyscreen.service"
AUTOSTART="$HOME/.config/autostart/keyscreen-indicator.desktop"
EXT_UUID="keyscreen-pointer@keyscreen"
EXT_DIR="$HOME/.local/share/gnome-shell/extensions/$EXT_UUID"

if [[ "${1:-}" == "--remove" ]]; then
  systemctl --user disable --now keyscreen.service 2>/dev/null || true
  pkill -f "$ROOT/desktop/indicator.py" || true
  rm -f "$UNIT" "$AUTOSTART"
  gnome-extensions disable "$EXT_UUID" 2>/dev/null || true
  rm -rf "$EXT_DIR"
  systemctl --user daemon-reload
  echo "removed"
  exit 0
fi

# Remove the pre-rename install (qk108.service), if any.
if [[ -f "$HOME/.config/systemd/user/qk108.service" ]]; then
  systemctl --user disable --now qk108.service 2>/dev/null || true
  rm -f "$HOME/.config/systemd/user/qk108.service" "$HOME/.config/autostart/qk108-indicator.desktop"
fi

mkdir -p "$(dirname "$UNIT")" "$(dirname "$AUTOSTART")"
sed -e "s|@ROOT@|$ROOT|g" -e "s|@BUN@|$BUN|g" "$ROOT/desktop/keyscreen.service" > "$UNIT"
sed -e "s|@ROOT@|$ROOT|g" "$ROOT/desktop/keyscreen-indicator.desktop" > "$AUTOSTART"
systemctl --user daemon-reload
systemctl --user enable keyscreen.service
systemctl --user restart keyscreen.service

pkill -f "$ROOT/desktop/indicator.py" || true
setsid -f /usr/bin/python3 "$ROOT/desktop/indicator.py" >/dev/null 2>&1 < /dev/null

# GNOME Shell extension. A new one is only picked up after logging out and back in (Wayland).
mkdir -p "$EXT_DIR"
cp "$ROOT/desktop/gnome-extension/metadata.json" "$ROOT/desktop/gnome-extension/extension.js" "$EXT_DIR/"
if gnome-extensions enable "$EXT_UUID" 2>/dev/null; then
  ext_note="pointer extension enabled"
else
  # Not loaded yet: queue it in the enabled list so it starts with the next login.
  current=$(gsettings get org.gnome.shell enabled-extensions)
  if [[ "$current" != *"$EXT_UUID"* ]]; then
    gsettings set org.gnome.shell enabled-extensions "$(echo "$current" | sed -e "s/@as \[\]/[]/" -e "s/]\$/, '$EXT_UUID']/" -e "s/\[, /[/")"
  fi
  ext_note="pointer extension installed: log out and back in once to turn it on"
fi

echo "installed: server runs at login (systemctl --user status keyscreen), indicator in the top bar, $ext_note"
if ! gnome-extensions list --enabled 2>/dev/null | grep -q appindicator; then
  echo "note: turn on top-bar indicators with: gnome-extensions enable ubuntu-appindicators@ubuntu.com"
fi
