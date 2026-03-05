# Daemon Implementation Guide

Detailed implementation plan for the cc-worklog daemon feature.

## Resilience Patterns

The daemon needs to handle failures gracefully since it runs unattended. We implement these patterns:

### 1. Exponential Backoff with Jitter

When OpenAI API fails, don't hammer it. Back off exponentially with randomness to avoid thundering herd:

```typescript
const BACKOFF_CONFIG = {
  initialDelay: 1000,      // 1 second
  maxDelay: 300_000,       // 5 minutes max
  multiplier: 2,
  jitter: 0.3,             // ±30% randomness
};

function calculateBackoff(attempt: number): number {
  const delay = Math.min(
    BACKOFF_CONFIG.initialDelay * Math.pow(BACKOFF_CONFIG.multiplier, attempt),
    BACKOFF_CONFIG.maxDelay
  );
  const jitter = delay * BACKOFF_CONFIG.jitter * (Math.random() * 2 - 1);
  return Math.floor(delay + jitter);
}
```

### 2. Per-Session Retry with Limits

Each session gets up to 3 retry attempts before being marked as failed:

```typescript
interface RetryState {
  [sessionId: string]: {
    attempts: number;
    lastAttempt: string;
    lastError: string;
  };
}
```

After 3 failures, the session is marked as `failed` in state.json and skipped until manually reset.

### 3. Circuit Breaker for API Calls

If OpenAI API fails repeatedly, stop trying for a cooldown period:

```typescript
interface CircuitBreaker {
  state: "closed" | "open" | "half-open";
  failures: number;
  lastFailure: number;
  cooldown: number;  // ms until retry (starts at 60s, doubles up to 30min)
}

const CIRCUIT_CONFIG = {
  failureThreshold: 5,     // Open after 5 consecutive failures
  cooldownInitial: 60_000, // 1 minute initial cooldown
  cooldownMax: 1_800_000,  // 30 minutes max cooldown
};
```

State transitions:
- **Closed** → Normal operation, requests go through
- **Open** → After N failures, reject all requests immediately
- **Half-open** → After cooldown, allow one request to test

### 4. Health Check File

Write a heartbeat file that external monitors can check:

```typescript
// Write every poll cycle
await writeFile(
  `${homedir()}/.cc-worklog/daemon.health`,
  JSON.stringify({
    pid: process.pid,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    lastCycleOk: true,
    sessionsProcessed: totalProcessed,
    circuitState: circuitBreaker.state,
  })
);
```

### 5. No Silent Fallbacks

The summarizer does NOT use fallbacks when API calls fail. Errors are propagated so that:
- The daemon's circuit breaker can detect failures
- Retry logic can properly track attempts
- Sessions aren't marked as "processed" with garbage data

If API is unavailable, daemon continues running and queues sessions:
- Sessions stay unprocessed (not marked as failed until max retries)
- Circuit breaker prevents wasted API calls
- When API recovers, backlog is processed

### 6. Memory Leak Prevention

For long-running daemons:
- Don't accumulate data in memory between cycles
- Clear any caches periodically
- Log memory usage for monitoring:

```typescript
if (cycleCount % 100 === 0) {
  const mem = process.memoryUsage();
  log("INFO", `Memory: ${Math.round(mem.heapUsed / 1024 / 1024)}MB heap`);
}
```

### 7. Stale Lock Detection

If daemon crashes without cleanup, detect and recover:

```typescript
async function isStaleProcess(pidFile: string): Promise<boolean> {
  try {
    const pid = parseInt(await readFile(pidFile, "utf-8"), 10);
    process.kill(pid, 0); // Check if alive
    return false;
  } catch (e) {
    if (e.code === "ESRCH") return true;  // Process doesn't exist
    if (e.code === "ENOENT") return false; // No PID file
    throw e;
  }
}
```

## File Structure

```
src/
├── daemon.ts          # NEW: Daemon core logic
├── daemon-service.ts  # NEW: OS service generation (launchd/systemd)
├── cli.ts             # MODIFY: Add daemon subcommands
└── ...
```

## 1. Core Daemon Module (`src/daemon.ts`)

### Interface

```typescript
export interface DaemonConfig {
  pollInterval: number;      // ms, default 60000
  sessionTimeout: number;    // ms, default 3600000 (1 hour)
  logFile: string;           // default ~/.cc-worklog/daemon.log
  pidFile: string;           // default ~/.cc-worklog/daemon.pid
}

export interface DaemonState {
  startedAt: string;
  lastCheck: string;
  sessionsProcessed: number;
  errors: number;
}
```

### Functions

```typescript
// Run daemon in foreground (blocking)
export async function runDaemon(config?: Partial<DaemonConfig>): Promise<never>;

// Start daemon as background process
export async function startDaemon(): Promise<{ pid: number }>;

// Stop running daemon
export async function stopDaemon(): Promise<{ stopped: boolean }>;

// Get daemon status
export async function getDaemonStatus(): Promise<{
  running: boolean;
  pid?: number;
  state?: DaemonState;
}>;

// Tail daemon logs
export async function tailLogs(lines?: number): Promise<void>;
```

### Implementation Details

```typescript
import { discoverSessions } from "./discovery";
import { parseSession } from "./parser";
import { summarizeSession } from "./summarizer";
import { writeSessionMarkdown, isProcessed, markProcessed } from "./writer";
import { getConfig } from "./config";

const DEFAULT_CONFIG: DaemonConfig = {
  pollInterval: 60_000,        // 1 minute
  sessionTimeout: 3_600_000,   // 1 hour
  logFile: `${homedir()}/.cc-worklog/daemon.log`,
  pidFile: `${homedir()}/.cc-worklog/daemon.pid`,
};

export async function runDaemon(config?: Partial<DaemonConfig>): Promise<never> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const appConfig = getConfig();

  log("INFO", "Daemon started");
  log("INFO", `Poll interval: ${cfg.pollInterval / 1000}s`);
  log("INFO", `Session timeout: ${cfg.sessionTimeout / 3600000}h`);

  // Write PID file for status checks
  await writePidFile(cfg.pidFile);

  // Handle graceful shutdown
  process.on("SIGTERM", () => shutdown(cfg));
  process.on("SIGINT", () => shutdown(cfg));

  while (true) {
    await runCycle(cfg, appConfig);
    log("INFO", `Sleeping for ${cfg.pollInterval / 1000}s...`);
    await sleep(cfg.pollInterval);
  }
}

async function runCycle(cfg: DaemonConfig, appConfig: AppConfig): Promise<void> {
  try {
    const sessions = await discoverSessions();
    const now = Date.now();

    let processed = 0;
    let skipped = 0;

    for (const session of sessions) {
      // Skip if already processed
      if (await isProcessed(session.sessionId)) {
        continue;
      }

      // Check if session is closed (no modifications for 1 hour)
      const mtime = (await stat(session.logFile)).mtimeMs;
      if (now - mtime < cfg.sessionTimeout) {
        skipped++;
        continue;
      }

      try {
        log("INFO", `Processing: ${session.sessionId} (${session.projectSlug})`);

        const parsed = await parseSession(session.logFile);
        const summary = await summarizeSession(parsed, appConfig.openai.model);
        const outputFile = await writeSessionMarkdown(session, summary);

        log("INFO", `Wrote: ${outputFile}`);
        processed++;
      } catch (error) {
        log("ERROR", `Failed to process ${session.sessionId}: ${error.message}`);
        // Continue with other sessions
      }
    }

    if (processed > 0 || skipped > 0) {
      log("INFO", `Cycle complete: ${processed} processed, ${skipped} still active`);
    }

    // Update daemon state
    await updateDaemonState({ sessionsProcessed: processed });

  } catch (error) {
    log("ERROR", `Cycle failed: ${error.message}`);
  }
}

function log(level: "INFO" | "ERROR" | "WARN", message: string): void {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${level.padEnd(5)} ${message}\n`;

  // Write to log file
  appendFileSync(cfg.logFile, line);

  // Also write to stdout if running in foreground
  if (process.stdout.isTTY) {
    process.stdout.write(line);
  }
}

async function shutdown(cfg: DaemonConfig): Promise<void> {
  log("INFO", "Shutting down...");
  await unlink(cfg.pidFile).catch(() => {});
  process.exit(0);
}
```

### Background Start/Stop

```typescript
import { spawn } from "child_process";

export async function startDaemon(): Promise<{ pid: number }> {
  const status = await getDaemonStatus();
  if (status.running) {
    throw new Error(`Daemon already running (PID ${status.pid})`);
  }

  // Get paths
  const bunPath = process.execPath;
  const scriptPath = process.argv[1];
  const logFile = `${homedir()}/.cc-worklog/daemon.log`;

  // Ensure log directory exists
  await mkdir(dirname(logFile), { recursive: true });

  // Spawn detached process
  const child = spawn(bunPath, [scriptPath, "daemon", "run"], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
    env: {
      ...process.env,
      CC_WORKLOG_DAEMON: "1",
    },
  });

  child.unref();

  // Wait a moment and verify it started
  await sleep(500);
  const newStatus = await getDaemonStatus();

  if (!newStatus.running) {
    throw new Error("Daemon failed to start. Check logs.");
  }

  return { pid: child.pid! };
}

export async function stopDaemon(): Promise<{ stopped: boolean }> {
  const status = await getDaemonStatus();

  if (!status.running || !status.pid) {
    return { stopped: false };
  }

  try {
    process.kill(status.pid, "SIGTERM");

    // Wait for process to exit
    for (let i = 0; i < 10; i++) {
      await sleep(200);
      const check = await getDaemonStatus();
      if (!check.running) {
        return { stopped: true };
      }
    }

    // Force kill if still running
    process.kill(status.pid, "SIGKILL");
    return { stopped: true };

  } catch (error) {
    if (error.code === "ESRCH") {
      // Process doesn't exist, clean up PID file
      await unlink(pidFile).catch(() => {});
      return { stopped: true };
    }
    throw error;
  }
}

export async function getDaemonStatus(): Promise<{
  running: boolean;
  pid?: number;
  state?: DaemonState;
}> {
  const pidFile = `${homedir()}/.cc-worklog/daemon.pid`;

  try {
    const pidStr = await readFile(pidFile, "utf-8");
    const pid = parseInt(pidStr.trim(), 10);

    // Check if process is running
    try {
      process.kill(pid, 0); // Signal 0 = just check existence

      // Read daemon state
      const stateFile = `${homedir()}/.cc-worklog/state.json`;
      const state = JSON.parse(await readFile(stateFile, "utf-8"));

      return { running: true, pid, state: state.daemon };
    } catch {
      // Process not running, clean up stale PID file
      await unlink(pidFile).catch(() => {});
      return { running: false };
    }
  } catch {
    return { running: false };
  }
}

export async function tailLogs(lines = 50): Promise<void> {
  const logFile = `${homedir()}/.cc-worklog/daemon.log`;

  try {
    const content = await readFile(logFile, "utf-8");
    const allLines = content.trim().split("\n");
    const lastLines = allLines.slice(-lines);

    console.log(lastLines.join("\n"));

    // If running interactively, watch for new lines
    if (process.stdout.isTTY) {
      console.log("\n--- Watching for new logs (Ctrl+C to stop) ---\n");

      const watcher = watch(logFile, async () => {
        const newContent = await readFile(logFile, "utf-8");
        const newLines = newContent.trim().split("\n");
        const diff = newLines.slice(allLines.length);
        if (diff.length > 0) {
          console.log(diff.join("\n"));
          allLines.push(...diff);
        }
      });

      process.on("SIGINT", () => {
        watcher.close();
        process.exit(0);
      });

      // Keep process alive
      await new Promise(() => {});
    }
  } catch (error) {
    if (error.code === "ENOENT") {
      console.log("No logs yet.");
    } else {
      throw error;
    }
  }
}
```

## 2. OS Service Module (`src/daemon-service.ts`)

### Functions

```typescript
export function getPlatform(): "macos" | "linux" | "unsupported";
export async function installService(): Promise<void>;
export async function uninstallService(): Promise<void>;
export function getServiceStatus(): Promise<"running" | "stopped" | "not-installed">;
```

### launchd Implementation (macOS)

```typescript
const PLIST_PATH = `${homedir()}/Library/LaunchAgents/com.cc-worklog.plist`;

function generatePlist(): string {
  const bunPath = process.execPath;
  const scriptPath = resolve(process.argv[1]);
  const home = homedir();
  const apiKey = process.env.OPENAI_API_KEY || "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.cc-worklog</string>
  <key>ProgramArguments</key>
  <array>
    <string>${bunPath}</string>
    <string>${scriptPath}</string>
    <string>daemon</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${home}/.cc-worklog/daemon.log</string>
  <key>StandardErrorPath</key>
  <string>${home}/.cc-worklog/daemon.log</string>
  <key>WorkingDirectory</key>
  <string>${home}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
    <key>HOME</key>
    <string>${home}</string>
    <key>OPENAI_API_KEY</key>
    <string>${apiKey}</string>
  </dict>
</dict>
</plist>`;
}

export async function installServiceMacOS(): Promise<void> {
  // Check if already installed
  if (existsSync(PLIST_PATH)) {
    console.log("Service already installed. Uninstall first to reinstall.");
    return;
  }

  // Validate API key
  if (!process.env.OPENAI_API_KEY) {
    console.warn("Warning: OPENAI_API_KEY not set. Set it before starting the service.");
  }

  // Write plist
  const plist = generatePlist();
  await writeFile(PLIST_PATH, plist);
  console.log(`Created: ${PLIST_PATH}`);

  // Load the service
  const { execSync } = await import("child_process");
  execSync(`launchctl load ${PLIST_PATH}`);
  console.log("Service installed and started.");
  console.log("\nCommands:");
  console.log("  launchctl stop com.cc-worklog   # Stop");
  console.log("  launchctl start com.cc-worklog  # Start");
  console.log("  cc-worklog daemon logs          # View logs");
}

export async function uninstallServiceMacOS(): Promise<void> {
  if (!existsSync(PLIST_PATH)) {
    console.log("Service not installed.");
    return;
  }

  const { execSync } = await import("child_process");

  try {
    execSync(`launchctl unload ${PLIST_PATH}`);
  } catch {
    // May fail if not loaded, that's OK
  }

  await unlink(PLIST_PATH);
  console.log("Service uninstalled.");
}
```

### systemd Implementation (Linux)

```typescript
const SERVICE_PATH = `${homedir()}/.config/systemd/user/cc-worklog.service`;

function generateSystemdUnit(): string {
  const bunPath = process.execPath;
  const scriptPath = resolve(process.argv[1]);
  const apiKey = process.env.OPENAI_API_KEY || "";

  return `[Unit]
Description=cc-worklog - Claude Code session summarizer
After=network.target

[Service]
Type=simple
ExecStart=${bunPath} ${scriptPath} daemon run
Restart=always
RestartSec=10
Environment=PATH=/usr/local/bin:/usr/bin:/bin
Environment=OPENAI_API_KEY=${apiKey}

[Install]
WantedBy=default.target
`;
}

export async function installServiceLinux(): Promise<void> {
  // Ensure directory exists
  await mkdir(dirname(SERVICE_PATH), { recursive: true });

  // Write unit file
  const unit = generateSystemdUnit();
  await writeFile(SERVICE_PATH, unit);
  console.log(`Created: ${SERVICE_PATH}`);

  // Reload and enable
  const { execSync } = await import("child_process");
  execSync("systemctl --user daemon-reload");
  execSync("systemctl --user enable cc-worklog");
  execSync("systemctl --user start cc-worklog");

  console.log("Service installed and started.");
  console.log("\nCommands:");
  console.log("  systemctl --user stop cc-worklog    # Stop");
  console.log("  systemctl --user start cc-worklog   # Start");
  console.log("  systemctl --user status cc-worklog  # Status");
  console.log("  cc-worklog daemon logs              # View logs");
}

export async function uninstallServiceLinux(): Promise<void> {
  const { execSync } = await import("child_process");

  try {
    execSync("systemctl --user stop cc-worklog");
    execSync("systemctl --user disable cc-worklog");
  } catch {
    // May fail if not running
  }

  await unlink(SERVICE_PATH).catch(() => {});
  execSync("systemctl --user daemon-reload");

  console.log("Service uninstalled.");
}
```

## 3. CLI Integration (`src/cli.ts`)

Add daemon subcommand with nested commands:

```typescript
import {
  runDaemon,
  startDaemon,
  stopDaemon,
  getDaemonStatus,
  tailLogs,
} from "./daemon";
import { installService, uninstallService, getPlatform } from "./daemon-service";

// Add to existing CLI parser
program
  .command("daemon")
  .description("Manage the background daemon")
  .argument("[action]", "run|start|stop|status|logs|install|uninstall")
  .option("-n, --lines <n>", "Number of log lines to show", "50")
  .action(async (action, options) => {
    switch (action) {
      case "run":
        await runDaemon();
        break;

      case "start":
        const { pid } = await startDaemon();
        console.log(`Daemon started (PID ${pid})`);
        break;

      case "stop":
        const { stopped } = await stopDaemon();
        console.log(stopped ? "Daemon stopped" : "Daemon was not running");
        break;

      case "status":
        const status = await getDaemonStatus();
        if (status.running) {
          console.log(`Daemon running (PID ${status.pid})`);
          if (status.state) {
            console.log(`  Started: ${status.state.startedAt}`);
            console.log(`  Last check: ${status.state.lastCheck}`);
            console.log(`  Sessions processed: ${status.state.sessionsProcessed}`);
          }
        } else {
          console.log("Daemon not running");
        }
        break;

      case "logs":
        await tailLogs(parseInt(options.lines, 10));
        break;

      case "install":
        const platform = getPlatform();
        if (platform === "unsupported") {
          console.error("OS service install not supported on this platform");
          process.exit(1);
        }
        await installService();
        break;

      case "uninstall":
        await uninstallService();
        break;

      default:
        console.log("Usage: cc-worklog daemon <run|start|stop|status|logs|install|uninstall>");
        process.exit(1);
    }
  });
```

## 4. State File Updates

Update `state.json` to include daemon state, retries, and failed sessions:

```json
{
  "processed": {
    "49d6e4a2-...": {
      "processedAt": "2026-03-05T10:00:00Z",
      "outputFile": "myapp/2026-03-05_49d6_fix-auth.md"
    }
  },
  "failed": {
    "a1b2c3d4-...": {
      "attempts": 3,
      "lastAttempt": "2026-03-05T11:00:00Z",
      "lastError": "OpenAI API: rate limit exceeded",
      "canRetryAfter": "2026-03-06T00:00:00Z"
    }
  },
  "retrying": {
    "deadbeef-...": {
      "attempts": 1,
      "lastAttempt": "2026-03-05T10:45:00Z",
      "lastError": "OpenAI API: timeout",
      "nextAttempt": "2026-03-05T10:47:00Z"
    }
  },
  "daemon": {
    "startedAt": "2026-03-05T08:00:00Z",
    "lastCheck": "2026-03-05T10:30:00Z",
    "sessionsProcessed": 15,
    "errors": 2,
    "circuitBreaker": {
      "state": "closed",
      "failures": 0,
      "cooldownUntil": null
    }
  }
}
```

### CLI Commands for Failed Sessions

```bash
cc-worklog failed           # List failed sessions
cc-worklog retry <id>       # Retry a specific failed session
cc-worklog retry --all      # Retry all failed sessions
```

## 5. Testing Plan

### Manual Testing

```bash
# Test foreground mode
cc-worklog daemon run
# Ctrl+C to stop

# Test background mode
cc-worklog daemon start
cc-worklog daemon status
cc-worklog daemon logs
cc-worklog daemon stop

# Test OS service (macOS)
cc-worklog daemon install
launchctl list | grep cc-worklog
cc-worklog daemon logs
cc-worklog daemon uninstall
```

### Edge Cases to Test

1. Start daemon when already running → should error
2. Stop daemon when not running → should handle gracefully
3. Kill daemon forcefully → PID file cleanup on next status check
4. No sessions to process → should log and sleep
5. API key missing → should log error but continue polling
6. Network failure → should log error and retry next cycle
7. Very long session → map-reduce should handle it

## 6. Implementation Order

1. Create `src/daemon.ts` with `runDaemon()` only
2. Add `daemon run` command to CLI
3. Test foreground mode works
4. Add `startDaemon()`, `stopDaemon()`, `getDaemonStatus()`
5. Add remaining CLI commands
6. Create `src/daemon-service.ts`
7. Add `install`/`uninstall` commands
8. Test on macOS with launchd
9. Test on Linux with systemd (if available)
