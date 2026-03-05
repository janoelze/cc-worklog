import { spawn } from "child_process";
import { appendFileSync, existsSync, watch } from "fs";
import { mkdir, readFile, unlink, writeFile, stat } from "fs/promises";
import { dirname, join } from "path";
import { homedir } from "os";
import type {
  DaemonConfig,
  DaemonState,
  CircuitBreakerState,
  State,
} from "./types.js";
import { discoverSessions, isSessionClosed } from "./discovery.js";
import { parseSession } from "./parser.js";
import { summarizeSession } from "./summarizer.js";
import { writeSessionMarkdown, loadState, saveState } from "./writer.js";
import { getConfig } from "./config.js";

// Default daemon configuration
const DEFAULT_CONFIG: DaemonConfig = {
  pollInterval: 60_000, // 1 minute
  sessionTimeout: 3_600_000, // 1 hour
  logFile: join(homedir(), ".cc-worklog", "daemon.log"),
  pidFile: join(homedir(), ".cc-worklog", "daemon.pid"),
  healthFile: join(homedir(), ".cc-worklog", "daemon.health"),
  maxRetries: 3,
  circuitBreaker: {
    failureThreshold: 5,
    cooldownInitial: 60_000, // 1 minute
    cooldownMax: 1_800_000, // 30 minutes
  },
  backoff: {
    initialDelay: 1_000, // 1 second
    maxDelay: 300_000, // 5 minutes
    multiplier: 2,
    jitter: 0.3,
  },
};

// In-memory circuit breaker (persisted to state.json periodically)
let circuitBreaker: CircuitBreakerState = {
  state: "closed",
  failures: 0,
};

let cycleCount = 0;
let totalProcessed = 0;
let totalErrors = 0;
let daemonStartTime: string;
let currentConfig: DaemonConfig;

/**
 * Calculate backoff delay with jitter
 */
function calculateBackoff(attempt: number): number {
  const { initialDelay, maxDelay, multiplier, jitter } = currentConfig.backoff;
  const delay = Math.min(initialDelay * Math.pow(multiplier, attempt), maxDelay);
  const jitterAmount = delay * jitter * (Math.random() * 2 - 1);
  return Math.floor(delay + jitterAmount);
}

/**
 * Check if circuit breaker allows requests
 */
function canMakeRequest(): boolean {
  if (circuitBreaker.state === "closed") {
    return true;
  }

  if (circuitBreaker.state === "open") {
    // Check if cooldown has passed
    if (
      circuitBreaker.cooldownUntil &&
      new Date().toISOString() >= circuitBreaker.cooldownUntil
    ) {
      circuitBreaker.state = "half-open";
      log("INFO", "Circuit breaker entering half-open state");
      return true;
    }
    return false;
  }

  // half-open: allow one request to test
  return true;
}

/**
 * Record API success
 */
function recordSuccess(): void {
  if (circuitBreaker.state === "half-open") {
    log("INFO", "Circuit breaker closing (API recovered)");
  }
  circuitBreaker.state = "closed";
  circuitBreaker.failures = 0;
  circuitBreaker.cooldownUntil = undefined;
}

/**
 * Record API failure
 */
function recordFailure(): void {
  circuitBreaker.failures++;
  circuitBreaker.lastFailure = new Date().toISOString();

  if (circuitBreaker.state === "half-open") {
    // Failed during test, re-open with longer cooldown
    openCircuit(true);
  } else if (
    circuitBreaker.failures >= currentConfig.circuitBreaker.failureThreshold
  ) {
    openCircuit(false);
  }
}

/**
 * Open the circuit breaker
 */
function openCircuit(wasHalfOpen: boolean): void {
  circuitBreaker.state = "open";

  // Calculate cooldown (double if reopening from half-open)
  let cooldown = currentConfig.circuitBreaker.cooldownInitial;
  if (wasHalfOpen && circuitBreaker.cooldownUntil) {
    // Double previous cooldown
    const prevCooldown =
      new Date(circuitBreaker.cooldownUntil).getTime() -
      new Date(circuitBreaker.lastFailure!).getTime();
    cooldown = Math.min(prevCooldown * 2, currentConfig.circuitBreaker.cooldownMax);
  }

  const cooldownUntil = new Date(Date.now() + cooldown).toISOString();
  circuitBreaker.cooldownUntil = cooldownUntil;

  log(
    "WARN",
    `Circuit breaker OPEN - ${circuitBreaker.failures} failures. Cooldown until ${cooldownUntil}`
  );
}

/**
 * Log a message to file and optionally stdout
 */
function log(level: "INFO" | "WARN" | "ERROR", message: string): void {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${level.padEnd(5)} ${message}\n`;

  // Write to log file
  try {
    appendFileSync(currentConfig.logFile, line);
  } catch {
    // Ignore log write errors
  }

  // Also write to stdout if running in foreground (TTY)
  if (process.stdout.isTTY) {
    process.stdout.write(line);
  }
}

/**
 * Write PID file
 */
async function writePidFile(): Promise<void> {
  await mkdir(dirname(currentConfig.pidFile), { recursive: true });
  await writeFile(currentConfig.pidFile, process.pid.toString(), "utf-8");
}

/**
 * Write health check file
 */
async function writeHealthFile(lastCycleOk: boolean): Promise<void> {
  const health = {
    pid: process.pid,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    lastCycleOk,
    sessionsProcessed: totalProcessed,
    errors: totalErrors,
    circuitState: circuitBreaker.state,
    cycleCount,
  };

  await writeFile(currentConfig.healthFile, JSON.stringify(health, null, 2), "utf-8");
}

/**
 * Update daemon state in state.json
 */
async function updateDaemonState(): Promise<void> {
  const state = await loadState();
  state.daemon = {
    startedAt: daemonStartTime,
    lastCheck: new Date().toISOString(),
    sessionsProcessed: totalProcessed,
    errors: totalErrors,
    circuitBreaker: { ...circuitBreaker },
  };
  await saveState(state);
}

/**
 * Clean up on shutdown
 */
async function shutdown(): Promise<void> {
  log("INFO", "Shutting down...");
  await unlink(currentConfig.pidFile).catch(() => {});
  await unlink(currentConfig.healthFile).catch(() => {});
  await updateDaemonState();
  process.exit(0);
}

/**
 * Sleep for specified milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Process a single session with retry logic
 */
async function processSessionWithRetry(
  session: { sessionId: string; projectSlug: string; logFile: string },
  state: State,
  appConfig: Awaited<ReturnType<typeof getConfig>>
): Promise<boolean> {
  // Check if already failed too many times
  const failed = state.failed?.[session.sessionId];
  if (failed && failed.attempts >= currentConfig.maxRetries) {
    return false; // Skip permanently failed sessions
  }

  // Check if in retry backoff period
  const retrying = state.retrying?.[session.sessionId];
  if (retrying && new Date().toISOString() < retrying.nextAttempt) {
    return false; // Not time to retry yet
  }

  const attempt = (retrying?.attempts ?? failed?.attempts ?? 0) + 1;

  try {
    log("INFO", `Processing: ${session.sessionId.slice(0, 8)} (${session.projectSlug})`);

    const parsed = await parseSession({
      sessionId: session.sessionId,
      project: "",
      projectName: "",
      projectSlug: session.projectSlug,
      projectNameSource: "directory",
      logFile: session.logFile,
      startTime: new Date(),
    });

    // Skip very short sessions
    if (parsed.prompts.length < 2) {
      log("INFO", `Skipped ${session.sessionId.slice(0, 8)} (too short)`);
      return false;
    }

    const summary = await summarizeSession(parsed);
    const outputFile = await writeSessionMarkdown(parsed, summary);

    // Mark as processed
    state.processed[session.sessionId] = {
      processedAt: new Date().toISOString(),
      outputFile,
    };

    // Remove from retrying/failed if present
    if (state.retrying) delete state.retrying[session.sessionId];
    if (state.failed) delete state.failed[session.sessionId];

    await saveState(state);

    recordSuccess();
    log("INFO", `Wrote: ${outputFile}`);
    totalProcessed++;
    return true;
  } catch (error) {
    const errorMessage = (error as Error).message;
    totalErrors++;
    recordFailure();

    log("ERROR", `Failed to process ${session.sessionId.slice(0, 8)}: ${errorMessage}`);

    // Update retry state
    if (attempt >= currentConfig.maxRetries) {
      // Move to failed
      if (!state.failed) state.failed = {};
      state.failed[session.sessionId] = {
        attempts: attempt,
        lastAttempt: new Date().toISOString(),
        lastError: errorMessage,
        canRetryAfter: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // 24h
      };
      if (state.retrying) delete state.retrying[session.sessionId];
      log("WARN", `Session ${session.sessionId.slice(0, 8)} marked as failed after ${attempt} attempts`);
    } else {
      // Schedule retry
      const backoffDelay = calculateBackoff(attempt);
      if (!state.retrying) state.retrying = {};
      state.retrying[session.sessionId] = {
        attempts: attempt,
        lastAttempt: new Date().toISOString(),
        lastError: errorMessage,
        nextAttempt: new Date(Date.now() + backoffDelay).toISOString(),
      };
      log("INFO", `Will retry ${session.sessionId.slice(0, 8)} in ${Math.round(backoffDelay / 1000)}s`);
    }

    await saveState(state);
    return false;
  }
}

/**
 * Run a single daemon cycle
 */
async function runCycle(): Promise<boolean> {
  cycleCount++;

  try {
    const sessions = await discoverSessions();
    const state = await loadState();
    const appConfig = await getConfig();

    let processed = 0;
    let skipped = 0;

    for (const session of sessions) {
      // Skip if already processed
      if (state.processed[session.sessionId]) {
        continue;
      }

      // Check circuit breaker
      if (!canMakeRequest()) {
        log("WARN", "Circuit breaker open, skipping API calls");
        break;
      }

      // Check if session is closed
      const closed = await isSessionClosed(session.logFile);
      if (!closed) {
        skipped++;
        continue;
      }

      const success = await processSessionWithRetry(
        session,
        state,
        appConfig
      );
      if (success) processed++;
    }

    // Log cycle summary
    if (processed > 0 || skipped > 0) {
      log(
        "INFO",
        `Cycle ${cycleCount} complete: ${processed} processed, ${skipped} still active`
      );
    }

    // Log memory usage every 100 cycles
    if (cycleCount % 100 === 0) {
      const mem = process.memoryUsage();
      log("INFO", `Memory: ${Math.round(mem.heapUsed / 1024 / 1024)}MB heap`);
    }

    // Update health and state
    await writeHealthFile(true);
    await updateDaemonState();

    return true;
  } catch (error) {
    log("ERROR", `Cycle failed: ${(error as Error).message}`);
    await writeHealthFile(false);
    return false;
  }
}

/**
 * Run daemon in foreground (blocking)
 */
export async function runDaemon(
  config?: Partial<DaemonConfig>
): Promise<never> {
  currentConfig = { ...DEFAULT_CONFIG, ...config };
  daemonStartTime = new Date().toISOString();

  // Ensure directories exist
  await mkdir(dirname(currentConfig.logFile), { recursive: true });

  log("INFO", "Daemon started");
  log("INFO", `Poll interval: ${currentConfig.pollInterval / 1000}s`);
  log("INFO", `Session timeout: ${currentConfig.sessionTimeout / 3600000}h`);
  log("INFO", `PID: ${process.pid}`);

  // Write PID file
  await writePidFile();

  // Handle graceful shutdown
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // Load existing circuit breaker state
  const state = await loadState();
  if (state.daemon?.circuitBreaker) {
    circuitBreaker = state.daemon.circuitBreaker;
    log("INFO", `Restored circuit breaker state: ${circuitBreaker.state}`);
  }

  // Main loop
  while (true) {
    await runCycle();
    log("INFO", `Sleeping for ${currentConfig.pollInterval / 1000}s...`);
    await sleep(currentConfig.pollInterval);
  }
}

/**
 * Start daemon as background process
 */
export async function startDaemon(): Promise<{ pid: number }> {
  const status = await getDaemonStatus();
  if (status.running) {
    throw new Error(`Daemon already running (PID ${status.pid})`);
  }

  const bunPath = process.execPath;
  const scriptPath = process.argv[1];
  const logDir = dirname(DEFAULT_CONFIG.logFile);

  // Ensure log directory exists
  await mkdir(logDir, { recursive: true });

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
  await sleep(1000);
  const newStatus = await getDaemonStatus();

  if (!newStatus.running) {
    throw new Error("Daemon failed to start. Check logs with: cc-worklog daemon logs");
  }

  return { pid: child.pid! };
}

/**
 * Stop running daemon
 */
export async function stopDaemon(): Promise<{ stopped: boolean }> {
  const status = await getDaemonStatus();

  if (!status.running || !status.pid) {
    return { stopped: false };
  }

  try {
    process.kill(status.pid, "SIGTERM");

    // Wait for process to exit
    for (let i = 0; i < 20; i++) {
      await sleep(250);
      const check = await getDaemonStatus();
      if (!check.running) {
        return { stopped: true };
      }
    }

    // Force kill if still running
    process.kill(status.pid, "SIGKILL");
    await sleep(500);
    return { stopped: true };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ESRCH") {
      // Process doesn't exist, clean up PID file
      await unlink(DEFAULT_CONFIG.pidFile).catch(() => {});
      return { stopped: true };
    }
    throw error;
  }
}

/**
 * Get daemon status
 */
export async function getDaemonStatus(): Promise<{
  running: boolean;
  pid?: number;
  state?: DaemonState;
}> {
  try {
    const pidStr = await readFile(DEFAULT_CONFIG.pidFile, "utf-8");
    const pid = parseInt(pidStr.trim(), 10);

    // Check if process is running
    try {
      process.kill(pid, 0); // Signal 0 = just check existence

      // Read daemon state
      const state = await loadState();

      return { running: true, pid, state: state.daemon };
    } catch {
      // Process not running, clean up stale PID file
      await unlink(DEFAULT_CONFIG.pidFile).catch(() => {});
      return { running: false };
    }
  } catch {
    return { running: false };
  }
}

/**
 * Tail daemon logs
 */
export async function tailLogs(lines = 50): Promise<void> {
  const logFile = DEFAULT_CONFIG.logFile;

  try {
    const content = await readFile(logFile, "utf-8");
    const allLines = content.trim().split("\n");
    const lastLines = allLines.slice(-lines);

    console.log(lastLines.join("\n"));

    // If running interactively, watch for new lines
    if (process.stdout.isTTY) {
      console.log("\n--- Watching for new logs (Ctrl+C to stop) ---\n");

      let lineCount = allLines.length;

      const watcher = watch(logFile, async () => {
        try {
          const newContent = await readFile(logFile, "utf-8");
          const newLines = newContent.trim().split("\n");
          if (newLines.length > lineCount) {
            const diff = newLines.slice(lineCount);
            console.log(diff.join("\n"));
            lineCount = newLines.length;
          }
        } catch {
          // Ignore read errors during watch
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
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      console.log("No logs yet.");
    } else {
      throw error;
    }
  }
}

/**
 * Get failed sessions
 */
export async function getFailedSessions(): Promise<
  Array<{ sessionId: string; attempts: number; lastError: string; lastAttempt: string }>
> {
  const state = await loadState();
  if (!state.failed) return [];

  return Object.entries(state.failed).map(([sessionId, info]) => ({
    sessionId,
    attempts: info.attempts,
    lastError: info.lastError,
    lastAttempt: info.lastAttempt,
  }));
}

/**
 * Reset a failed session for retry
 */
export async function resetFailedSession(sessionId: string): Promise<boolean> {
  const state = await loadState();

  // Find by full or partial ID
  const matchingId = Object.keys(state.failed || {}).find(
    (id) => id === sessionId || id.startsWith(sessionId)
  );

  if (!matchingId || !state.failed?.[matchingId]) {
    return false;
  }

  delete state.failed[matchingId];
  await saveState(state);
  return true;
}

/**
 * Reset all failed sessions for retry
 */
export async function resetAllFailedSessions(): Promise<number> {
  const state = await loadState();
  const count = Object.keys(state.failed || {}).length;
  state.failed = {};
  await saveState(state);
  return count;
}
