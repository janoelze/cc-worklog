import { execSync } from "child_process";
import { existsSync } from "fs";
import { mkdir, unlink, writeFile } from "fs/promises";
import { dirname, resolve } from "path";
import { homedir, platform } from "os";

const LAUNCHD_PLIST_PATH = `${homedir()}/Library/LaunchAgents/com.cc-worklog.plist`;
const SYSTEMD_SERVICE_PATH = `${homedir()}/.config/systemd/user/cc-worklog.service`;

/**
 * Detect platform
 */
export function getPlatform(): "macos" | "linux" | "unsupported" {
  const os = platform();
  if (os === "darwin") return "macos";
  if (os === "linux") return "linux";
  return "unsupported";
}

/**
 * Generate launchd plist content
 */
function generatePlist(): string {
  const bunPath = process.execPath;
  const scriptPath = resolve(process.argv[1]);
  const home = homedir();
  const apiKey = process.env.OPENAI_API_KEY || "";

  // Warn if no API key
  if (!apiKey) {
    console.warn(
      "Warning: OPENAI_API_KEY not set. The daemon will fail to summarize sessions."
    );
    console.warn(
      "Set it in your shell config and re-run install, or edit the plist manually.\n"
    );
  }

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

  <key>ProcessType</key>
  <string>Background</string>

  <key>LowPriorityIO</key>
  <true/>

  <key>Nice</key>
  <integer>10</integer>
</dict>
</plist>`;
}

/**
 * Generate systemd unit content
 */
function generateSystemdUnit(): string {
  const bunPath = process.execPath;
  const scriptPath = resolve(process.argv[1]);
  const home = homedir();
  const apiKey = process.env.OPENAI_API_KEY || "";

  // Warn if no API key
  if (!apiKey) {
    console.warn(
      "Warning: OPENAI_API_KEY not set. The daemon will fail to summarize sessions."
    );
    console.warn(
      "Set it in your shell config and re-run install, or edit the service file manually.\n"
    );
  }

  return `[Unit]
Description=cc-worklog - Claude Code session summarizer
Documentation=https://github.com/yourname/cc-worklog
After=network.target

[Service]
Type=simple
ExecStart=${bunPath} ${scriptPath} daemon run
Restart=always
RestartSec=10

# Environment
Environment=PATH=/usr/local/bin:/usr/bin:/bin
Environment=HOME=${home}
Environment=OPENAI_API_KEY=${apiKey}

# Resource limits
Nice=10
IOSchedulingClass=idle

# Logging
StandardOutput=append:${home}/.cc-worklog/daemon.log
StandardError=append:${home}/.cc-worklog/daemon.log

[Install]
WantedBy=default.target
`;
}

/**
 * Install service on macOS (launchd)
 */
async function installServiceMacOS(): Promise<void> {
  // Check if already installed
  if (existsSync(LAUNCHD_PLIST_PATH)) {
    console.log("Service already installed.");
    console.log("To reinstall, run: cc-worklog daemon uninstall && cc-worklog daemon install\n");
    return;
  }

  // Ensure directory exists
  await mkdir(dirname(LAUNCHD_PLIST_PATH), { recursive: true });

  // Write plist
  const plist = generatePlist();
  await writeFile(LAUNCHD_PLIST_PATH, plist, "utf-8");
  console.log(`Created: ${LAUNCHD_PLIST_PATH}`);

  // Load the service
  try {
    execSync(`launchctl load "${LAUNCHD_PLIST_PATH}"`, { stdio: "inherit" });
    console.log("\nService installed and started.");
  } catch {
    console.log("\nService file created but failed to load.");
    console.log("You can manually load it with:");
    console.log(`  launchctl load "${LAUNCHD_PLIST_PATH}"`);
  }

  console.log("\nManagement commands:");
  console.log("  launchctl stop com.cc-worklog     # Stop the daemon");
  console.log("  launchctl start com.cc-worklog    # Start the daemon");
  console.log("  cc-worklog daemon status          # Check status");
  console.log("  cc-worklog daemon logs            # View logs");
}

/**
 * Uninstall service on macOS (launchd)
 */
async function uninstallServiceMacOS(): Promise<void> {
  if (!existsSync(LAUNCHD_PLIST_PATH)) {
    console.log("Service not installed.");
    return;
  }

  // Unload the service
  try {
    execSync(`launchctl unload "${LAUNCHD_PLIST_PATH}"`, { stdio: "inherit" });
  } catch {
    // May fail if not loaded, that's OK
  }

  // Remove the plist
  await unlink(LAUNCHD_PLIST_PATH);
  console.log("Service uninstalled.");
}

/**
 * Install service on Linux (systemd)
 */
async function installServiceLinux(): Promise<void> {
  // Check if already installed
  if (existsSync(SYSTEMD_SERVICE_PATH)) {
    console.log("Service already installed.");
    console.log("To reinstall, run: cc-worklog daemon uninstall && cc-worklog daemon install\n");
    return;
  }

  // Ensure directory exists
  await mkdir(dirname(SYSTEMD_SERVICE_PATH), { recursive: true });

  // Write unit file
  const unit = generateSystemdUnit();
  await writeFile(SYSTEMD_SERVICE_PATH, unit, "utf-8");
  console.log(`Created: ${SYSTEMD_SERVICE_PATH}`);

  // Reload and enable
  try {
    execSync("systemctl --user daemon-reload", { stdio: "inherit" });
    execSync("systemctl --user enable cc-worklog", { stdio: "inherit" });
    execSync("systemctl --user start cc-worklog", { stdio: "inherit" });
    console.log("\nService installed and started.");
  } catch {
    console.log("\nService file created but failed to enable/start.");
    console.log("You can manually enable it with:");
    console.log("  systemctl --user daemon-reload");
    console.log("  systemctl --user enable cc-worklog");
    console.log("  systemctl --user start cc-worklog");
  }

  console.log("\nManagement commands:");
  console.log("  systemctl --user stop cc-worklog    # Stop the daemon");
  console.log("  systemctl --user start cc-worklog   # Start the daemon");
  console.log("  systemctl --user status cc-worklog  # Check status");
  console.log("  cc-worklog daemon logs              # View logs");
}

/**
 * Uninstall service on Linux (systemd)
 */
async function uninstallServiceLinux(): Promise<void> {
  if (!existsSync(SYSTEMD_SERVICE_PATH)) {
    console.log("Service not installed.");
    return;
  }

  // Stop and disable
  try {
    execSync("systemctl --user stop cc-worklog", { stdio: "pipe" });
  } catch {
    // May fail if not running
  }

  try {
    execSync("systemctl --user disable cc-worklog", { stdio: "pipe" });
  } catch {
    // May fail if not enabled
  }

  // Remove unit file
  await unlink(SYSTEMD_SERVICE_PATH);

  // Reload daemon
  try {
    execSync("systemctl --user daemon-reload", { stdio: "pipe" });
  } catch {
    // Ignore
  }

  console.log("Service uninstalled.");
}

/**
 * Install service for current platform
 */
export async function installService(): Promise<void> {
  const os = getPlatform();

  switch (os) {
    case "macos":
      await installServiceMacOS();
      break;
    case "linux":
      await installServiceLinux();
      break;
    default:
      console.error("OS service installation not supported on this platform.");
      console.error("You can manually run the daemon with: cc-worklog daemon start");
      process.exit(1);
  }
}

/**
 * Uninstall service for current platform
 */
export async function uninstallService(): Promise<void> {
  const os = getPlatform();

  switch (os) {
    case "macos":
      await uninstallServiceMacOS();
      break;
    case "linux":
      await uninstallServiceLinux();
      break;
    default:
      console.error("OS service uninstallation not supported on this platform.");
      process.exit(1);
  }
}

/**
 * Check if OS service is installed
 */
export function isServiceInstalled(): boolean {
  const os = getPlatform();

  switch (os) {
    case "macos":
      return existsSync(LAUNCHD_PLIST_PATH);
    case "linux":
      return existsSync(SYSTEMD_SERVICE_PATH);
    default:
      return false;
  }
}
