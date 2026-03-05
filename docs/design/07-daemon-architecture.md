# Daemon Architecture

## Overview

A lightweight background process that watches for completed sessions and processes them automatically.

**Design Decision:** No external libraries (PM2, forever, etc.). Use native OS process management (launchd on macOS, systemd on Linux) for reliability and zero overhead.

```
┌─────────────────────────────────────────────────────────┐
│                      Daemon                              │
│                                                          │
│  ┌──────────┐    ┌──────────┐    ┌──────────────────┐  │
│  │  Poller  │───►│ Detector │───►│    Processor     │  │
│  │ (60s loop)│    │(closed?) │    │ (parse+summarize)│  │
│  └──────────┘    └──────────┘    └──────────────────┘  │
│                                           │              │
│                                           ▼              │
│                                    ┌──────────┐         │
│                                    │  Writer  │         │
│                                    │   (md)   │         │
│                                    └──────────┘         │
└─────────────────────────────────────────────────────────┘
```

## Why No External Libraries?

We considered PM2, forever, and other process managers but decided against them:

| Approach | Pros | Cons |
|----------|------|------|
| **PM2** | Feature-rich, clustering, monitoring | Heavy (~50MB), overkill for single process |
| **forever** | Simple | Less maintained, still adds deps |
| **Native OS** | Zero deps, reliable, OS-managed restarts | Platform-specific code |

**Chosen approach:** Native OS integration with simple polling loop.

- The daemon is simple (poll every 60s, process closed sessions)
- launchd/systemd handle restarts, boot startup, and logging
- Zero additional memory overhead
- Bun can run indefinitely without issues

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

### Polling Strategy (Chosen)

Simple polling is preferred over file watching because:
- More reliable across platforms
- No edge cases with recursive watchers
- Predictable resource usage
- Easy to debug

```typescript
// Poll every 60 seconds
async function runDaemon() {
  log("Daemon started");

  while (true) {
    try {
      const sessions = await discoverSessions();
      const unprocessed = sessions.filter(s => !isProcessed(s));

      for (const session of unprocessed) {
        if (isSessionClosed(session)) {
          log(`Processing: ${session.sessionId}`);
          await processSession(session);
          markProcessed(session);
        }
      }
    } catch (error) {
      log(`Error in daemon loop: ${error.message}`);
    }

    await sleep(60_000);
  }
}
```

## Process Management Modes

### Mode 1: Foreground (for testing)

```bash
cc-worklog daemon run
```

Runs in foreground with logs to stdout. Ctrl+C to stop.

### Mode 2: Background (manual)

```bash
cc-worklog daemon start   # Spawns detached process
cc-worklog daemon stop    # Kills process via PID file
cc-worklog daemon status  # Shows if running
cc-worklog daemon logs    # Tails log file
```

Uses PID file and nohup for basic process management.

### Mode 3: OS Service (recommended for production)

```bash
cc-worklog daemon install   # Installs launchd/systemd service
cc-worklog daemon uninstall # Removes service
```

#### launchd (macOS)

```xml
<!-- ~/Library/LaunchAgents/com.cc-worklog.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.cc-worklog</string>
  <key>ProgramArguments</key>
  <array>
    <string>${BUN_PATH}</string>
    <string>${SCRIPT_PATH}</string>
    <string>daemon</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${HOME}/.cc-worklog/daemon.log</string>
  <key>StandardErrorPath</key>
  <string>${HOME}/.cc-worklog/daemon.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin</string>
    <key>OPENAI_API_KEY</key>
    <string>${OPENAI_API_KEY}</string>
  </dict>
</dict>
</plist>
```

#### systemd (Linux)

```ini
# ~/.config/systemd/user/cc-worklog.service
[Unit]
Description=cc-worklog - Claude Code session summarizer
After=network.target

[Service]
Type=simple
ExecStart=${BUN_PATH} ${SCRIPT_PATH} daemon run
Restart=always
RestartSec=10
Environment=PATH=/usr/local/bin:/usr/bin:/bin
Environment=OPENAI_API_KEY=${OPENAI_API_KEY}

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
# Daemon management
cc-worklog daemon run       # Run in foreground (for testing)
cc-worklog daemon start     # Start background daemon
cc-worklog daemon stop      # Stop daemon
cc-worklog daemon status    # Show daemon status
cc-worklog daemon logs      # Tail daemon logs
cc-worklog daemon install   # Install as OS service (launchd/systemd)
cc-worklog daemon uninstall # Remove OS service

# Manual processing (existing)
cc-worklog process          # Manual one-time processing
cc-worklog list             # List recent sessions
```

## Resource Usage

Target: Minimal footprint

- **Memory:** < 50MB (Bun is lightweight)
- **CPU:** Near-zero when idle, brief spikes during processing
- **Disk:** Only writes when processing sessions
- **Network:** Only during OpenAI API calls

## Failure Handling & Resilience

| Failure | Response |
|---------|----------|
| Daemon crashes | launchd/systemd restarts automatically |
| Processing fails | Retry up to 3x with exponential backoff, then mark failed |
| OpenAI API error | Circuit breaker opens after 5 failures, cooldown 1-30min |
| Network unavailable | Sessions queue up, circuit breaker prevents hammering |
| Disk full | Log error, pause processing |
| Rate limited | Exponential backoff with jitter prevents thundering herd |

### Resilience Patterns

1. **Exponential Backoff + Jitter**: API failures trigger increasing delays (1s → 2s → 4s... up to 5min) with ±30% randomness to prevent synchronized retries.

2. **Circuit Breaker**: After 5 consecutive API failures, stop trying for 1 minute. If still failing, double cooldown up to 30 minutes. Prevents wasting API calls when service is down.

3. **Per-Session Retry Limits**: Each session gets 3 attempts. After that, marked as `failed` in state.json and skipped until manually reset.

4. **Health Check File**: `~/.cc-worklog/daemon.health` updated every cycle with timestamp, PID, and circuit state. External monitors can detect stale daemons.

5. **Graceful Degradation**: When API is unavailable, daemon keeps running. Sessions queue up naturally (stay unprocessed). When API recovers, backlog clears.

6. **Stale Lock Detection**: On startup, check if PID file points to dead process. Clean up and continue.

## Logging

All logs go to `~/.cc-worklog/daemon.log` with format:

```
[2026-03-05T10:30:00Z] INFO  Daemon started
[2026-03-05T10:30:01Z] INFO  Found 3 unprocessed sessions
[2026-03-05T10:30:01Z] INFO  Processing: 49d6e4a2-5d0f-4b4d-bf72-1e03272501db
[2026-03-05T10:30:15Z] INFO  Wrote: myapp/2026-03-05_49d6_fix-auth.md
[2026-03-05T10:30:15Z] ERROR Failed to process a1b2c3d4: API rate limit
[2026-03-05T10:31:01Z] INFO  Sleeping for 60s...
```

Log rotation: Keep last 10MB, rotate daily (handled by OS or manual truncation).
