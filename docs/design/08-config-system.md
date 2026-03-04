# Configuration System Design

## Goals

1. **Stay general-purpose** - cc-worklog should work standalone without Obsidian
2. **Integrate nicely with Obsidian** - Users can point output to their vault
3. **Simple CLI-based configuration** - `cc-worklog config` commands
4. **Sensible defaults** - Works out of the box with zero config

## Configuration Options

| Key | Default | Description |
|-----|---------|-------------|
| `output.directory` | `~/.cc-worklog/output` | Where markdown worklogs are written |
| `output.template` | `default` | Output template (future: custom templates) |
| `state.directory` | `~/.cc-worklog` | Where state.json is stored |
| `openai.model` | `gpt-4o-mini` | Model for summarization |
| `openai.apiKey` | `$OPENAI_API_KEY` | API key (env var fallback) |

### Obsidian Integration Example

```bash
# Point worklogs directly into an Obsidian vault
cc-worklog config set output.directory ~/Documents/Obsidian/MyVault/Worklogs

# Now all worklogs appear in Obsidian, searchable via Obsidian's search
```

The tool remains Obsidian-agnostic - it just writes markdown files. Obsidian (or any other tool) can consume them.

## Config File Location

```
~/.cc-worklog/config.json
```

Simple JSON format:

```json
{
  "output": {
    "directory": "/Users/jane/Documents/Obsidian/Vault/Worklogs"
  },
  "openai": {
    "model": "gpt-4o-mini"
  }
}
```

Only non-default values need to be stored.

## CLI Commands

### View Configuration

```bash
# Show all config (with defaults and overrides)
cc-worklog config

# Output:
# output.directory: ~/Documents/Obsidian/Vault/Worklogs (config.json)
# output.template:  default
# state.directory:  ~/.cc-worklog
# openai.model:     gpt-4o-mini
# openai.apiKey:    sk-...redacted... (env)
```

### Get Single Value

```bash
cc-worklog config get output.directory
# /Users/jane/Documents/Obsidian/Vault/Worklogs
```

### Set Value

```bash
cc-worklog config set output.directory ~/Documents/Obsidian/Vault/Worklogs
# ✓ output.directory set to /Users/jane/Documents/Obsidian/Vault/Worklogs

cc-worklog config set openai.model gpt-4o
# ✓ openai.model set to gpt-4o
```

### Unset (Reset to Default)

```bash
cc-worklog config unset output.directory
# ✓ output.directory reset to default (~/.cc-worklog/output)
```

### Show Config File Path

```bash
cc-worklog config path
# /Users/jane/.cc-worklog/config.json
```

## Resolution Order

Configuration values are resolved in this order (later wins):

1. **Built-in defaults** - Hardcoded in the tool
2. **Config file** - `~/.cc-worklog/config.json`
3. **Environment variables** - `CC_WORKLOG_OUTPUT_DIR`, `OPENAI_API_KEY`, etc.
4. **CLI flags** - `--output-dir`, `--model`, etc.

### Environment Variable Mapping

| Config Key | Environment Variable |
|------------|---------------------|
| `output.directory` | `CC_WORKLOG_OUTPUT_DIR` |
| `state.directory` | `CC_WORKLOG_STATE_DIR` |
| `openai.model` | `CC_WORKLOG_MODEL` |
| `openai.apiKey` | `OPENAI_API_KEY` |

### CLI Flag Overrides

```bash
# One-off override without changing config
cc-worklog process --output-dir ./local-worklogs

# Useful for testing or different output targets
cc-worklog process --model gpt-4o
```

## Implementation

### New File: `src/config.ts`

```typescript
interface Config {
  output: {
    directory: string;
    template: string;
  };
  state: {
    directory: string;
  };
  openai: {
    model: string;
    apiKey: string;
  };
}

const DEFAULTS: Config = {
  output: {
    directory: join(homedir(), ".cc-worklog", "output"),
    template: "default",
  },
  state: {
    directory: join(homedir(), ".cc-worklog"),
  },
  openai: {
    model: "gpt-4o-mini",
    apiKey: "",
  },
};

function loadConfig(): Config
function saveConfig(config: Partial<Config>): void
function getConfigValue(key: string): string
function setConfigValue(key: string, value: string): void
function unsetConfigValue(key: string): void
```

### Changes to Existing Files

**`src/writer.ts`:**
```typescript
// Before
const OUTPUT_DIR = join(homedir(), ".cc-worklog", "output");

// After
import { getConfig } from "./config";
const OUTPUT_DIR = getConfig().output.directory;
```

**`src/cli.ts`:**
- Add `config` command with subcommands: `get`, `set`, `unset`, (no subcommand = show all)
- Add `--output-dir` and `--model` flags to `process` command

## Search Integration

The `search` command (Phase 3) will use the configured output directory:

```bash
# Searches within the configured output.directory
cc-worklog search "auth bug"

# With Obsidian integration, this searches your vault's worklog folder
```

For users with Obsidian, they might prefer Obsidian's native search. That's fine - the worklogs are just markdown files.

## Migration

When first running with a config system:

1. Check if `~/.cc-worklog/output` exists with worklogs
2. If yes and no config set, assume default location
3. No automatic migration of existing files when changing `output.directory`
4. User must manually move files if they change the output location

## Directory Structure After Config

```
~/.cc-worklog/
├── config.json          # User configuration
├── state.json           # Processed session tracking
└── output/              # Default output (if not overridden)
    └── {project}/
        └── *.md

# Or with Obsidian integration:
~/Documents/Obsidian/Vault/
└── Worklogs/            # Configured via output.directory
    └── {project}/
        └── *.md
```

## Future Considerations

### Custom Output Templates

```bash
cc-worklog config set output.template minimal
cc-worklog config set output.template detailed
cc-worklog config set output.template ~/my-template.md
```

### Multiple Profiles

```bash
cc-worklog --profile work process    # Uses ~/.cc-worklog/profiles/work.json
cc-worklog --profile personal process
```

### Obsidian-Specific Features (Optional Plugin)

If deeper Obsidian integration is wanted later, it could be a separate layer:

```bash
# Hypothetical obsidian-specific wrapper
cc-worklog-obsidian sync  # Runs process + updates Obsidian indexes
```

But the core tool stays Obsidian-agnostic.

## Summary

The config system enables Obsidian integration without coupling to Obsidian:

1. **Default behavior unchanged** - Works out of the box
2. **Simple config command** - `cc-worklog config set output.directory ~/Vault/Worklogs`
3. **Multiple override layers** - Defaults → config file → env vars → CLI flags
4. **Search uses configured directory** - Worklogs are searchable wherever they live
5. **No Obsidian dependency** - Just markdown files in a configurable location
