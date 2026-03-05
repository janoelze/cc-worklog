# Distribution

Standalone binary distribution via `releases/` folder in the repo, built on every push.

## Overview

```
User runs:
  curl -fsSL https://raw.githubusercontent.com/janoelze/cc-worklog/master/install.sh | sh

What happens:
  1. Detect OS and architecture (darwin-arm64, darwin-x64, linux-x64)
  2. Download binary from releases/ folder in repo
  3. Install to ~/.local/bin/cc-worklog
  4. Verify it works
```

## GitHub Actions Build

### Trigger

Build on every push to `master`.

### Build Matrix

```yaml
strategy:
  matrix:
    include:
      - os: macos-latest
        target: darwin-arm64
      - os: macos-13
        target: darwin-x64
      - os: ubuntu-latest
        target: linux-x64
```

### Workflow File

`.github/workflows/build.yml`:

```yaml
name: Build

on:
  push:
    branches:
      - master

jobs:
  build:
    strategy:
      matrix:
        include:
          - os: macos-latest
            target: darwin-arm64
          - os: macos-13
            target: darwin-x64
          - os: ubuntu-latest
            target: linux-x64

    runs-on: ${{ matrix.os }}

    steps:
      - uses: actions/checkout@v4

      - uses: oven-sh/setup-bun@v1
        with:
          bun-version: latest

      - run: bun install

      - name: Build binary
        run: |
          bun build --compile src/cli.ts --outfile cc-worklog
          chmod +x cc-worklog
          gzip -c cc-worklog > cc-worklog-${{ matrix.target }}.gz

      - name: Upload artifact
        uses: actions/upload-artifact@v4
        with:
          name: cc-worklog-${{ matrix.target }}
          path: cc-worklog-${{ matrix.target }}.gz

  commit:
    needs: build
    runs-on: ubuntu-latest
    permissions:
      contents: write

    steps:
      - uses: actions/checkout@v4

      - uses: actions/download-artifact@v4
        with:
          path: releases
          merge-multiple: true

      - name: Commit binaries
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add releases/
          git commit -m "Build binaries [skip ci]" || exit 0
          git push
```

## Install Script

`install.sh`:

```bash
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
```

## Uninstall Script

`uninstall.sh`:

```bash
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
```

## Usage

### Install

```sh
curl -fsSL https://raw.githubusercontent.com/janoelze/cc-worklog/master/install.sh | sh
```

### Custom install directory

```sh
CC_WORKLOG_INSTALL_DIR=/usr/local/bin curl -fsSL https://raw.githubusercontent.com/janoelze/cc-worklog/master/install.sh | sudo sh
```

### Update

Same as install - overwrites existing binary.

### Uninstall

```sh
curl -fsSL https://raw.githubusercontent.com/janoelze/cc-worklog/master/uninstall.sh | sh
```

Or with config removal:

```sh
curl -fsSL https://raw.githubusercontent.com/janoelze/cc-worklog/master/uninstall.sh | sh -s -- --purge
```

## File Structure

```
cc-worklog/
├── .github/
│   └── workflows/
│       └── build.yml
├── releases/
│   ├── cc-worklog-darwin-arm64.gz
│   ├── cc-worklog-darwin-x64.gz
│   └── cc-worklog-linux-x64.gz
├── install.sh
├── uninstall.sh
└── ...
```

## Notes

- Binaries are built and committed on every push to `master`
- `[skip ci]` in commit message prevents infinite build loops
- Binaries are gzipped to reduce size (~50% smaller)
- Install directory defaults to `~/.local/bin` (XDG standard)
- No root required for default install
- Works offline after install (standalone binary)
- ~50MB binary size (includes Bun runtime)
