# Claude Code Local Storage

Claude Code stores session data, logs, and configuration in `~/.claude/` on macOS.

## Directory Structure

```
~/.claude/
├── projects/                    # Session logs per project
├── debug/                       # Debug logs
├── todos/                       # Todo lists from sessions
├── file-history/                # File backup history
├── session-env/                 # Session environment snapshots
├── shell-snapshots/             # Shell configuration snapshots
├── cache/                       # Cached data
├── plugins/                     # Installed plugins
├── statsig/                     # Feature flags / experiments
├── telemetry/                   # Usage telemetry
├── ide/                         # IDE integration data
├── local/                       # Local configuration
├── plans/                       # Plan mode artifacts
├── paste-cache/                 # Clipboard paste cache
├── downloads/                   # Downloaded files
├── history.jsonl                # Command history
├── settings.json                # User settings
├── settings.local.json          # Local settings overrides
├── stats-cache.json             # Usage statistics cache
├── .credentials.json            # Authentication credentials
└── statusline-command.sh        # Custom statusline script
```

## Key Directories

### `projects/`

Contains session logs organized by project path. Directory names are derived from the absolute path with slashes replaced by dashes.

**Structure:**
```
projects/
└── -Users-username-src-myproject/
    ├── 49d6e4a2-5d0f-4b4d-bf72-1e03272501db.jsonl   # Session log
    ├── agent-42dad721.jsonl                          # Agent subprocess log
    └── agent-7227b3fb.jsonl                          # Agent subprocess log
```

**Session log format (JSONL):**
Each line is a JSON object representing a message or event:

```json
{
  "type": "user",
  "uuid": "21813254-00a1-4846-8d47-ed6e63e56cac",
  "parentUuid": null,
  "sessionId": "49d6e4a2-5d0f-4b4d-bf72-1e03272501db",
  "version": "2.0.54",
  "cwd": "/Users/username/src/myproject",
  "gitBranch": "main",
  "timestamp": "2026-03-04T22:25:45.093Z",
  "message": {
    "role": "user",
    "content": "Hello, Claude!"
  },
  "todos": []
}
```

Other message types include:
- `file-history-snapshot` - File state snapshots for undo functionality
- `assistant` - Claude's responses
- `tool_use` / `tool_result` - Tool invocations and results

### `debug/`

Contains debug logs for troubleshooting. Each session has a `.txt` file named by session UUID.

**Format:** Timestamped log entries
```
2026-01-07T01:55:10.501Z [DEBUG] [SLOW OPERATION DETECTED] execSyncWithDefaults_DEPRECATED (26.8ms): ...
2026-01-07T01:55:10.569Z [DEBUG] [LSP MANAGER] initializeLspServerManager() called
```

### `todos/`

Stores todo lists from sessions as JSON files.

**Structure:**
```
todos/
└── {session-uuid}-agent-{session-uuid}.json
```

**Format:**
```json
[
  {
    "content": "Fix the bug",
    "status": "completed",
    "activeForm": "Fixing the bug"
  }
]
```

### `file-history/`

Stores file backups for undo functionality, organized by session UUID.

**Structure:**
```
file-history/
└── {session-uuid}/
    ├── {hash}@v2
    └── {hash}@v3
```

### `session-env/`

Stores environment variable snapshots for sessions.

**Structure:**
```
session-env/
└── {session-uuid}/
    └── ...
```

### `shell-snapshots/`

Captures shell configuration at session start for environment reproducibility.

**Naming:** `snapshot-{shell}-{timestamp}-{random}.sh`

### `history.jsonl`

Global command history across all projects.

**Format (JSONL):**
```json
{
  "display": "Read the @PLAN.md",
  "pastedContents": {},
  "timestamp": 1759496236990,
  "project": "/Users/username/src/myproject"
}
```

## Configuration Files

### `settings.json`

User preferences and configuration.

**Example:**
```json
{
  "$schema": "https://json.schemastore.org/claude-code-settings.json",
  "model": "opus",
  "statusLine": {
    "type": "command",
    "command": "/bin/bash ~/.claude/statusline-command.sh"
  },
  "enabledPlugins": {
    "ralph-loop@claude-plugins-official": true
  },
  "alwaysThinkingEnabled": false,
  "autoUpdatesChannel": "latest"
}
```

### `settings.local.json`

Local overrides that take precedence over `settings.json`.

### `.credentials.json`

Authentication tokens (restricted permissions: `600`).

## Notes

- Session UUIDs are v4 UUIDs (e.g., `49d6e4a2-5d0f-4b4d-bf72-1e03272501db`)
- JSONL files use newline-delimited JSON for streaming append operations
- Debug and credential files have restricted permissions for security
- The `projects/` directory naming scheme allows quick lookup by project path
