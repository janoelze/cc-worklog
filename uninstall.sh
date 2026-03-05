#!/bin/sh
set -e

INSTALL_DIR="${CC_WORKLOG_INSTALL_DIR:-$HOME/.local/bin}"

# Uninstall OS service if installed
if [ "$(uname -s)" = "Darwin" ]; then
  PLIST="$HOME/Library/LaunchAgents/com.cc-worklog.plist"
  if [ -f "$PLIST" ]; then
    echo "Uninstalling launchd service..."
    launchctl unload "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
    echo "Removed launchd service"
  fi
elif [ "$(uname -s)" = "Linux" ]; then
  SERVICE="$HOME/.config/systemd/user/cc-worklog.service"
  if [ -f "$SERVICE" ]; then
    echo "Uninstalling systemd service..."
    systemctl --user stop cc-worklog 2>/dev/null || true
    systemctl --user disable cc-worklog 2>/dev/null || true
    rm -f "$SERVICE"
    systemctl --user daemon-reload 2>/dev/null || true
    echo "Removed systemd service"
  fi
fi

# Remove binary
rm -f "$INSTALL_DIR/cc-worklog"
echo "Uninstalled cc-worklog"

# Optionally remove config
if [ "$1" = "--purge" ]; then
  rm -rf "$HOME/.cc-worklog"
  echo "Removed ~/.cc-worklog"
fi
