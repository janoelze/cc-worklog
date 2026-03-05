#!/bin/sh
set -e

REPO="janoelze/cc-worklog"
INSTALL_DIR="${CC_WORKLOG_INSTALL_DIR:-$HOME/.local/bin}"

# Detect platform
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)

case "$OS" in
  darwin) OS="darwin" ;;
  linux) OS="linux" ;;
  *) echo "Unsupported OS: $OS"; exit 1 ;;
esac

case "$ARCH" in
  x86_64) ARCH="x64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *) echo "Unsupported architecture: $ARCH"; exit 1 ;;
esac

TARGET="${OS}-${ARCH}"
URL="https://raw.githubusercontent.com/$REPO/master/releases/cc-worklog-${TARGET}.gz"

echo "Installing cc-worklog (${TARGET})..."

# Create install directory
mkdir -p "$INSTALL_DIR"

# Download and extract
curl -fsSL "$URL" | gunzip > "$INSTALL_DIR/cc-worklog"
chmod +x "$INSTALL_DIR/cc-worklog"

# Verify
if "$INSTALL_DIR/cc-worklog" --help > /dev/null 2>&1; then
  echo "Installed to $INSTALL_DIR/cc-worklog"
else
  echo "Installation failed"
  exit 1
fi

# Check if in PATH
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    echo ""
    echo "Add to your PATH:"
    echo "  export PATH=\"$INSTALL_DIR:\$PATH\""
    ;;
esac

echo ""
echo "Run 'cc-worklog help' to get started."
