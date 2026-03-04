# Daemon Architecture

## Overview

A lightweight background process that watches for completed sessions and processes them automatically.

```
┌─────────────────────────────────────────────────────────┐
│                      Daemon                              │
│                                                          │
│  ┌──────────┐    ┌──────────┐    ┌──────────────────┐  │
│  │  Watcher │───►│ Detector │───►│    Processor     │  │
│  │  (fswatch)│    │(closed?) │    │ (parse+summarize)│  │
│  └──────────┘    └──────────┘    └──────────────────┘  │
│                                           │              │
│                                           ▼              │
│                                    ┌──────────┐         │
│                                    │  Writer  │         │
│                                    │   (md)   │         │
│                                    └──────────┘         │
└─────────────────────────────────────────────────────────┘
```

## Detecting Closed Sessions

Simple rule: **A session is closed if the file hasn't been modified for 1 hour.**

```typescript
function isSessionClosed(logFile: string): boolean {
  const stats = fs.statSync(logFile);
  const mtime = stats.mtimeMs;
  const oneHourAgo = Date.now() - (60 * 60 * 1000);
  return mtime < oneHourAgo;
}
```

**Why 1 hour:**
- Long enough to handle breaks, lunch, meetings
- Short enough to process sessions same-day
- Simple to understand and debug

## Daemon Implementation

### Simple Polling Daemon

```typescript
// Poll every 60 seconds
while (true) {
  const sessions = discoverSessions();

  for (const session of sessions) {
    if (isSessionClosed(session) && !isProcessed(session)) {
      await processSession(session);
      markProcessed(session);
    }
  }

  await sleep(60_000);
}
```

### File System Watcher

```typescript
import { watch } from "fs";

watch(CLAUDE_PROJECTS_DIR, { recursive: true }, (event, filename) => {
  if (filename?.endsWith(".jsonl")) {
    debounce(() => checkAndProcess(filename), 120_000);
  }
});
```

## Process Management

### Option A: Simple Background Process

```bash
# Start
nohup cc-worklog daemon &> ~/.cc-worklog/daemon.log &
echo $! > ~/.cc-worklog/daemon.pid

# Stop
kill $(cat ~/.cc-worklog/daemon.pid)
```

### Option B: launchd (macOS)

```xml
<!-- ~/Library/LaunchAgents/com.cc-worklog.daemon.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "...">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.cc-worklog.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/cc-worklog</string>
    <string>daemon</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>~/.cc-worklog/daemon.log</string>
</dict>
</plist>
```

### Option C: systemd (Linux)

```ini
# ~/.config/systemd/user/cc-worklog.service
[Unit]
Description=cc-worklog Daemon

[Service]
ExecStart=/usr/local/bin/cc-worklog daemon
Restart=always

[Install]
WantedBy=default.target
```

## State Management

```
~/.cc-worklog/
├── daemon.pid           # Process ID
├── daemon.log           # Logs
├── state.json           # Processed sessions, last run, etc.
└── output/              # Generated markdown files
    └── {project}/
        └── *.md
```

### state.json

```json
{
  "processed": {
    "49d6e4a2-...": {
      "processedAt": "2026-03-04T10:00:00Z",
      "outputFile": "myapp/2026-03-04_49d6_fix-auth.md"
    }
  },
  "daemon": {
    "startedAt": "2026-03-04T08:00:00Z",
    "lastCheck": "2026-03-04T10:00:00Z",
    "sessionsProcessed": 15
  }
}
```

## CLI Commands

```bash
cc-worklog daemon start     # Start background daemon
cc-worklog daemon stop      # Stop daemon
cc-worklog daemon status    # Show daemon status
cc-worklog daemon logs      # Tail daemon logs

cc-worklog process          # Manual one-time processing
cc-worklog list             # List recent sessions
cc-worklog search "query"   # Search summaries
```

## Resource Usage

Target: Minimal footprint

- **Memory:** < 50MB
- **CPU:** Near-zero when idle, brief spikes during processing
- **Disk:** Only writes when processing sessions
- **Network:** Only during AI summarization calls

## Failure Handling

1. **Daemon crashes:** launchd/systemd restarts it
2. **Processing fails:** Log error, skip session, retry next cycle
3. **Claude CLI unavailable:** Queue session, retry later
4. **Disk full:** Log error, pause processing
