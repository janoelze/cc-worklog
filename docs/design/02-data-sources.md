# Data Sources

## Claude Code Already Captures Everything

Unlike cc-obsidian-mem which uses hooks to duplicate capture, we can read directly from Claude Code's existing session logs.

### Session Logs Location

```
~/.claude/projects/{project-path}/
├── {session-uuid}.jsonl          # Main session transcript
├── agent-{id}.jsonl              # Subagent transcripts
└── ...
```

Project paths are encoded: `/Users/jane/src/myapp` → `-Users-jane-src-myapp`

### JSONL Format

Each line is a JSON object. Key message types:

**User messages:**
```json
{
  "type": "user",
  "uuid": "...",
  "sessionId": "...",
  "cwd": "/path/to/project",
  "message": { "role": "user", "content": "Fix the auth bug" },
  "timestamp": "2026-03-04T10:00:00.000Z"
}
```

**Assistant messages:**
```json
{
  "type": "assistant",
  "message": { "role": "assistant", "content": "I'll fix that..." }
}
```

**Tool use:**
```json
{
  "type": "tool_use",
  "tool": "Edit",
  "input": { "file_path": "...", "old_string": "...", "new_string": "..." }
}
```

**Tool results:**
```json
{
  "type": "tool_result",
  "content": "File edited successfully"
}
```

### What We Can Extract

From session logs:
- User prompts (what was asked)
- Files read/edited (what was touched)
- Commands run (what was executed)
- Errors encountered (what failed)
- Assistant explanations (reasoning and decisions)

### Other Useful Files

```
~/.claude/
├── history.jsonl                 # Global command history
├── projects/{path}/
│   └── CLAUDE.md                 # Project-specific instructions (if exists)
```

## Advantages Over Hooks

1. **No runtime overhead** - Nothing runs during sessions
2. **No version coupling** - Works with any Claude Code version
3. **Complete data** - Access to full conversation, not just tool events
4. **Retroactive** - Can process old sessions that already exist
5. **Simpler** - No plugin installation, no configuration
