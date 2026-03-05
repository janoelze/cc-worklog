#!/usr/bin/env bun

import { parseArgs } from "util";
import {
  discoverSessions,
  getUnprocessedSessions,
  isSessionClosed,
} from "./discovery.js";
import { parseSession } from "./parser.js";
import { summarizeSession } from "./summarizer.js";
import {
  writeSessionMarkdown,
  generateMarkdown,
  loadState,
  markProcessed,
} from "./writer.js";
import {
  getConfig,
  getConfigValue,
  setConfigValue,
  unsetConfigValue,
  getConfigPath,
  getConfigWithSources,
  setRuntimeOverrides,
} from "./config.js";
import {
  runDaemon,
  startDaemon,
  stopDaemon,
  getDaemonStatus,
  tailLogs,
  getFailedSessions,
  resetFailedSession,
  resetAllFailedSessions,
} from "./daemon.js";
import {
  installService,
  uninstallService,
  isServiceInstalled,
  getPlatform,
} from "./daemon-service.js";

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    help: { type: "boolean", short: "h" },
    all: { type: "boolean", short: "a" },
    project: { type: "string", short: "p" },
    force: { type: "boolean", short: "f" },
    session: { type: "string", short: "s" },
    dry: { type: "boolean", short: "d" },
    "output-dir": { type: "string", short: "o" },
    model: { type: "string", short: "m" },
    lines: { type: "string", short: "n" },
  },
  allowPositionals: true,
});

// Apply runtime overrides from CLI flags
setRuntimeOverrides({
  outputDirectory: values["output-dir"],
  model: values.model,
});

const command = positionals[0] || "help";

async function main() {
  switch (command) {
    case "process":
      await processCommand();
      break;
    case "list":
      await listCommand();
      break;
    case "test":
      await testCommand();
      break;
    case "config":
      await configCommand();
      break;
    case "daemon":
      await daemonCommand();
      break;
    case "failed":
      await failedCommand();
      break;
    case "retry":
      await retryCommand();
      break;
    case "help":
    default:
      showHelp();
  }
}

function showHelp() {
  console.log(`
cc-worklog - Generate work logs from Claude Code sessions

Usage:
  cc-worklog process [options]    Process sessions and generate summaries
  cc-worklog list                 List unprocessed sessions
  cc-worklog test -s <id>         Test summarization for a specific session
  cc-worklog config [cmd] [args]  View or modify configuration
  cc-worklog daemon <action>      Manage background daemon
  cc-worklog failed               List failed sessions
  cc-worklog retry [id]           Retry failed sessions
  cc-worklog help                 Show this help

Options:
  -a, --all              Process all sessions (including already processed)
  -p, --project <name>   Filter by project name
  -f, --force            Process sessions even if still active
  -s, --session <id>     Specify session ID (full or partial)
  -d, --dry              Dry run - print output without saving
  -o, --output-dir <dir> Override output directory for this run
  -m, --model <model>    Override OpenAI model for this run
  -n, --lines <n>        Number of log lines to show (default: 50)
  -h, --help             Show help

Daemon Commands:
  cc-worklog daemon run         Run daemon in foreground (for testing)
  cc-worklog daemon start       Start daemon in background
  cc-worklog daemon stop        Stop running daemon
  cc-worklog daemon status      Show daemon status
  cc-worklog daemon logs        Tail daemon logs
  cc-worklog daemon install     Install as OS service (launchd/systemd)
  cc-worklog daemon uninstall   Remove OS service

Config Commands:
  cc-worklog config                      Show all configuration
  cc-worklog config get <key>            Get a config value
  cc-worklog config set <key> <value>    Set a config value
  cc-worklog config unset <key>          Reset a config value to default
  cc-worklog config path                 Show config file path

Config Keys:
  output.directory    Where worklogs are saved (default: ~/.cc-worklog/output)
  state.directory     Where state is stored (default: ~/.cc-worklog)
  openai.model        Model for summarization (default: gpt-4o-mini)
  openai.apiKey       OpenAI API key (default: $OPENAI_API_KEY)

Examples:
  cc-worklog process                     # Process all closed, unprocessed sessions
  cc-worklog daemon start                # Start background processing
  cc-worklog daemon install              # Install as system service
  cc-worklog failed                      # Show sessions that failed to process
  cc-worklog retry --all                 # Retry all failed sessions
  cc-worklog config set output.directory ~/Obsidian/Vault/Worklogs
`);
}

async function listCommand() {
  const sessions = await discoverSessions();
  const state = await loadState();
  const unprocessed = getUnprocessedSessions(sessions, state);

  if (unprocessed.length === 0) {
    console.log("No unprocessed sessions found.");
    return;
  }

  console.log(`Found ${unprocessed.length} unprocessed session(s):\n`);

  for (const session of unprocessed.slice(0, 20)) {
    const closed = await isSessionClosed(session.logFile);
    const status = closed ? "closed" : "active";
    const date = session.startTime.toISOString().split("T")[0];
    const projectDisplay = session.projectName.padEnd(25).slice(0, 25);
    console.log(
      `  ${session.sessionId.slice(0, 8)}  ${date}  ${projectDisplay}  [${status}]`
    );
  }

  if (unprocessed.length > 20) {
    console.log(`\n  ... and ${unprocessed.length - 20} more`);
  }
}

async function processCommand() {
  const sessions = await discoverSessions();
  const state = await loadState();

  let toProcess = values.all ? sessions : getUnprocessedSessions(sessions, state);

  // Filter by project if specified
  if (values.project) {
    toProcess = toProcess.filter((s) =>
      s.projectSlug.includes(values.project!)
    );
  }

  // Filter to closed sessions only (unless --force)
  if (!values.force) {
    const closedSessions = [];
    for (const session of toProcess) {
      if (await isSessionClosed(session.logFile)) {
        closedSessions.push(session);
      }
    }
    toProcess = closedSessions;
  }

  if (toProcess.length === 0) {
    console.log("No sessions to process.");
    return;
  }

  console.log(`Processing ${toProcess.length} session(s)...\n`);

  let processed = 0;
  let failed = 0;

  for (const session of toProcess) {
    try {
      process.stdout.write(
        `  ${session.sessionId.slice(0, 8)} (${session.projectSlug})... `
      );

      // Parse session
      const parsed = await parseSession(session);

      // Skip very short sessions
      if (parsed.prompts.length < 2) {
        console.log("skipped (too short)");
        continue;
      }

      // Summarize
      const summary = await summarizeSession(parsed);

      // Write output
      const outputFile = await writeSessionMarkdown(parsed, summary);

      // Mark as processed
      await markProcessed(session.sessionId, outputFile);

      console.log(`done -> ${outputFile}`);
      processed++;
    } catch (error) {
      console.log(`failed: ${(error as Error).message}`);
      failed++;
    }
  }

  console.log(`\nProcessed: ${processed}, Failed: ${failed}`);
}

/**
 * Test command - process a single session by ID and output the result
 */
async function testCommand() {
  if (!values.session) {
    console.error("Error: --session (-s) is required for test command");
    console.error("Usage: cc-worklog test -s <session-id>");
    process.exit(1);
  }

  const sessionIdQuery = values.session;
  const sessions = await discoverSessions();

  // Find session by ID (supports partial match)
  const matchingSessions = sessions.filter(
    (s) =>
      s.sessionId === sessionIdQuery ||
      s.sessionId.startsWith(sessionIdQuery)
  );

  if (matchingSessions.length === 0) {
    console.error(`Error: No session found matching "${sessionIdQuery}"`);
    console.error("\nAvailable sessions (most recent first):");
    for (const s of sessions.slice(0, 10)) {
      console.error(`  ${s.sessionId.slice(0, 8)}  ${s.projectSlug}`);
    }
    process.exit(1);
  }

  if (matchingSessions.length > 1) {
    console.error(`Error: Multiple sessions match "${sessionIdQuery}":`);
    for (const s of matchingSessions) {
      console.error(`  ${s.sessionId}  ${s.projectSlug}`);
    }
    console.error("\nPlease provide a more specific session ID.");
    process.exit(1);
  }

  const session = matchingSessions[0];
  console.log(`\nProcessing session: ${session.sessionId}`);
  console.log(`Project: ${session.project}`);
  console.log(`Log file: ${session.logFile}`);
  console.log("");

  // Parse session
  console.log("Parsing session...");
  const parsed = await parseSession(session);
  console.log(`  Prompts: ${parsed.prompts.length}`);
  console.log(`  Files read: ${parsed.filesRead.length}`);
  console.log(`  Files edited: ${parsed.filesEdited.length}`);
  console.log(`  Commands: ${parsed.commandsRun.length}`);
  console.log(`  Errors: ${parsed.errors.length}`);
  console.log("");

  // Summarize
  console.log("Summarizing with OpenAI...");
  const summary = await summarizeSession(parsed);
  console.log("");

  // Generate markdown
  const markdown = generateMarkdown(parsed, summary);

  console.log("=".repeat(60));
  console.log("GENERATED WORKLOG:");
  console.log("=".repeat(60));
  console.log(markdown);
  console.log("=".repeat(60));

  // Write file unless --dry
  if (!values.dry) {
    const outputFile = await writeSessionMarkdown(parsed, summary);
    console.log(`\nWritten to: ${outputFile}`);
  } else {
    console.log("\n(dry run - no file written)");
  }
}

/**
 * Config command - view and modify configuration
 */
async function configCommand() {
  const subcommand = positionals[1];
  const key = positionals[2];
  const value = positionals[3];

  switch (subcommand) {
    case "get": {
      if (!key) {
        console.error("Error: config get requires a key");
        console.error("Usage: cc-worklog config get <key>");
        process.exit(1);
      }
      const configValue = await getConfigValue(key);
      if (configValue === undefined) {
        console.error(`Error: Unknown config key: ${key}`);
        process.exit(1);
      }
      console.log(configValue);
      break;
    }

    case "set": {
      if (!key || !value) {
        console.error("Error: config set requires a key and value");
        console.error("Usage: cc-worklog config set <key> <value>");
        process.exit(1);
      }
      try {
        await setConfigValue(key, value);
        const newValue = await getConfigValue(key);
        console.log(`✓ ${key} set to ${newValue}`);
      } catch (error) {
        console.error(`Error: ${(error as Error).message}`);
        process.exit(1);
      }
      break;
    }

    case "unset": {
      if (!key) {
        console.error("Error: config unset requires a key");
        console.error("Usage: cc-worklog config unset <key>");
        process.exit(1);
      }
      try {
        await unsetConfigValue(key);
        const defaultValue = await getConfigValue(key);
        console.log(`✓ ${key} reset to default (${defaultValue})`);
      } catch (error) {
        console.error(`Error: ${(error as Error).message}`);
        process.exit(1);
      }
      break;
    }

    case "path": {
      console.log(getConfigPath());
      break;
    }

    default: {
      // Show all config
      const entries = await getConfigWithSources();
      console.log("Configuration:\n");
      for (const entry of entries) {
        const sourceLabel = entry.source === "default" ? "" : ` (${entry.source})`;
        const valueDisplay = entry.value || "(not set)";
        console.log(`  ${entry.key.padEnd(20)} ${valueDisplay}${sourceLabel}`);
      }
      console.log(`\nConfig file: ${getConfigPath()}`);
    }
  }
}

/**
 * Daemon command - manage background daemon
 */
async function daemonCommand() {
  const action = positionals[1];

  switch (action) {
    case "run": {
      await runDaemon();
      break;
    }

    case "start": {
      try {
        const { pid } = await startDaemon();
        console.log(`Daemon started (PID ${pid})`);
        console.log("View logs with: cc-worklog daemon logs");
      } catch (error) {
        console.error(`Error: ${(error as Error).message}`);
        process.exit(1);
      }
      break;
    }

    case "stop": {
      const { stopped } = await stopDaemon();
      if (stopped) {
        console.log("Daemon stopped");
      } else {
        console.log("Daemon was not running");
      }
      break;
    }

    case "status": {
      const status = await getDaemonStatus();
      if (status.running) {
        console.log(`Daemon running (PID ${status.pid})`);
        if (status.state) {
          console.log(`  Started: ${status.state.startedAt}`);
          console.log(`  Last check: ${status.state.lastCheck}`);
          console.log(`  Sessions processed: ${status.state.sessionsProcessed}`);
          console.log(`  Errors: ${status.state.errors}`);
          console.log(`  Circuit breaker: ${status.state.circuitBreaker.state}`);
        }
        if (isServiceInstalled()) {
          console.log(`  OS service: installed (${getPlatform()})`);
        }
      } else {
        console.log("Daemon not running");
        if (isServiceInstalled()) {
          console.log(`OS service is installed but daemon is not running.`);
          console.log(`Try: cc-worklog daemon start`);
        }
      }
      break;
    }

    case "logs": {
      const lines = values.lines ? parseInt(values.lines, 10) : 50;
      await tailLogs(lines);
      break;
    }

    case "install": {
      await installService();
      break;
    }

    case "uninstall": {
      await uninstallService();
      break;
    }

    default: {
      console.log("Usage: cc-worklog daemon <run|start|stop|status|logs|install|uninstall>");
      console.log("");
      console.log("Actions:");
      console.log("  run         Run daemon in foreground (for testing)");
      console.log("  start       Start daemon in background");
      console.log("  stop        Stop running daemon");
      console.log("  status      Show daemon status");
      console.log("  logs        Tail daemon logs (-n for line count)");
      console.log("  install     Install as OS service (launchd/systemd)");
      console.log("  uninstall   Remove OS service");
      process.exit(1);
    }
  }
}

/**
 * Failed command - list failed sessions
 */
async function failedCommand() {
  const failed = await getFailedSessions();

  if (failed.length === 0) {
    console.log("No failed sessions.");
    return;
  }

  console.log(`Found ${failed.length} failed session(s):\n`);

  for (const session of failed) {
    const date = session.lastAttempt.split("T")[0];
    console.log(`  ${session.sessionId.slice(0, 8)}  ${date}  (${session.attempts} attempts)`);
    console.log(`    Error: ${session.lastError.slice(0, 60)}${session.lastError.length > 60 ? "..." : ""}`);
  }

  console.log("");
  console.log("To retry a session:  cc-worklog retry <session-id>");
  console.log("To retry all:        cc-worklog retry --all");
}

/**
 * Retry command - retry failed sessions
 */
async function retryCommand() {
  const sessionId = positionals[1];

  if (values.all) {
    const count = await resetAllFailedSessions();
    if (count > 0) {
      console.log(`Reset ${count} failed session(s) for retry.`);
      console.log("Run 'cc-worklog process' or start the daemon to process them.");
    } else {
      console.log("No failed sessions to retry.");
    }
    return;
  }

  if (!sessionId) {
    console.log("Usage: cc-worklog retry <session-id>");
    console.log("       cc-worklog retry --all");
    process.exit(1);
  }

  const success = await resetFailedSession(sessionId);
  if (success) {
    console.log(`Session reset for retry.`);
    console.log("Run 'cc-worklog process' or start the daemon to process it.");
  } else {
    console.log(`No failed session found matching: ${sessionId}`);
  }
}

main().catch((error) => {
  console.error("Error:", error.message);
  process.exit(1);
});
