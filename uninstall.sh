#!/bin/sh
set -e

INSTALL_DIR="${CC_WORKLOG_INSTALL_DIR:-$HOME/.local/bin}"

rm -f "$INSTALL_DIR/cc-worklog"
echo "Uninstalled cc-worklog"

# Optionally remove config
if [ "$1" = "--purge" ]; then
  rm -rf "$HOME/.cc-worklog"
  echo "Removed ~/.cc-worklog"
fi
