# cc-obsidian-mem Plugin Analysis

Analysis of [cc-obsidian-mem](https://github.com/Z-M-Huang/cc-obsidian-mem), an Obsidian-based persistent memory system for Claude Code.

## Overview

This plugin captures Claude Code session activity and uses AI to extract reusable knowledge, storing it in an Obsidian vault for future reference.

## Architecture

```
┌──────────────┐     ┌─────────────┐     ┌────────────────┐
│ Claude Code  │◄───►│ MCP Server  │◄───►│ Obsidian Vault │
└──────┬───────┘     └─────────────┘     └────────────────┘
       │
       ▼
┌──────────────┐     ┌─────────────┐
│    Hooks     │────►│   SQLite    │
│ (Lifecycle)  │     │  Database   │
└──────────────┘     └─────────────┘
```

## Data Capture (Hooks)

The plugin uses Claude Code hooks to intercept session activity:

| Hook | Trigger | Purpose |
|------|---------|---------|
| `UserPromptSubmit` | User sends message | Records prompt text with timestamp |
| `PostToolUse` | Any tool completes | Captures tool name, input, output, duration |
| `Stop` | Session ends | Triggers summarization and cleanup |

### Storage

All captured data goes to SQLite (`~/.cc-obsidian-mem/cc-mem.db`):

**`sessions` table:**
- `session_id`, `project`, `started_at`, `status`

**`user_prompts` table:**
- `session_id`, `prompt_number`, `prompt_text`, `created_at`

**`tool_uses` table:**
- `session_id`, `prompt_number`, `tool_name`
- `tool_input`, `tool_output` (truncated/redacted)
- `duration_ms`, `cwd`

**`file_reads` table:**
- `session_id`, `file_path`, `content_hash`, `content_snippet`
- Deduplicated by content hash

## Summarization Process

### 1. Build Session Transcript

The `buildSessionPrompt()` function creates a structured transcript:

```
=== BEGIN SESSION TRANSCRIPT ===
Project: my-project

## User Requests
### 2026-03-04T10:00:00Z
Fix the authentication bug

## Tool Uses Summary
- Read: 5 uses
- Edit: 3 uses
- Bash: 2 uses

## Key Tool Outputs
### Edit at 2026-03-04T10:05:00Z
Input: {"file_path": "src/auth.ts", ...}
Output: File edited successfully...

## Files Examined
- src/auth.ts
- src/config.ts

=== END SESSION TRANSCRIPT ===
```

### 2. AI Knowledge Extraction

Calls Claude CLI with a system prompt instructing it to extract:

```bash
claude -p --no-session-persistence --model sonnet --system-prompt "..."
```

**System prompt instructs Claude to output JSON with:**

```json
{
  "decisions": [{ "title": "...", "content": "...", "tags": ["..."] }],
  "patterns": [{ "title": "...", "content": "...", "tags": ["..."] }],
  "errors": [{ "title": "...", "content": "...", "solution": "...", "tags": ["..."] }],
  "learnings": [{ "title": "...", "content": "...", "tags": ["..."] }],
  "qa": [{ "question": "...", "answer": "...", "tags": ["..."] }]
}
```

**Knowledge categories:**
- **decisions** - Architectural/technical decisions made
- **patterns** - Reusable code patterns discovered
- **errors** - Problems encountered and solutions
- **learnings** - Tips, insights, gotchas
- **qa** - Important questions and answers

### 3. Write to Obsidian Vault

Notes are written to the vault with:
- YAML frontmatter (type, title, project, tags, status)
- Obsidian wikilinks for navigation
- Dataview-compatible metadata

**Deduplication:**
- Uses Jaccard word similarity to find existing notes on similar topics
- Threshold: 60% similarity (configurable)
- Appends to existing notes rather than creating duplicates
- Falls back to AI semantic matching if Jaccard fails

## Vault Structure

```
vault/
└── _claude-mem/
    ├── index.md                     # Dashboard with Dataview queries
    └── projects/
        └── {project-name}/
            ├── {project-name}.md    # Project overview
            ├── _index.json          # Fast search index
            ├── decisions/
            │   └── *.md
            ├── patterns/
            │   └── *.md
            ├── errors/
            │   └── *.md
            ├── research/            # learnings + qa
            │   └── *.md
            └── sessions/
                └── *.md             # Session summaries
```

## Security Features

**Redaction (`redactSensitiveData`):**
- API keys, tokens, passwords
- AWS credentials
- Environment variables with sensitive names

**Truncation:**
- Large outputs truncated to configurable max size
- SHA-256 hash stored for reference

## Key Design Decisions

1. **No separate API key** - Uses `claude -p` CLI which uses existing auth
2. **SQLite for capture** - Fast, local, supports FTS5 search
3. **Topic-based filenames** - `auth-bug.md` not `2026-01-15_auth-bug.md`
4. **Hooks are non-blocking** - Errors logged but never crash Claude Code
5. **`--no-session-persistence`** - Summarization sessions don't pollute history

## Configuration

`~/.cc-obsidian-mem/config.json`:

```json
{
  "vault": {
    "path": "/path/to/obsidian/vault",
    "memFolder": "_claude-mem"
  },
  "summarization": {
    "enabled": true,
    "model": "sonnet"
  },
  "deduplication": {
    "enabled": true,
    "threshold": 0.6
  }
}
```

## Limitations

- Archived project (no longer maintained)
- Requires Bun runtime
- Summarization adds latency to session end
- AI extraction quality depends on session content
