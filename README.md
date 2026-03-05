# cc-worklog

Turn Claude Code sessions into permanent, searchable markdown worklogs.

Claude Code sessions are ephemeral. When you close a session, the context is gone. cc-worklog watches your `~/.claude/projects/` directory, detects closed sessions, and generates AI-summarized markdown files capturing what you did, why you did it, and what changed.

## Install

```sh
bun install
```

Requires `OPENAI_API_KEY` in your environment.

## Usage

Process all closed sessions:

```sh
bun run src/cli.ts process
```

List unprocessed sessions:

```sh
bun run src/cli.ts list
```

Run as a background daemon:

```sh
bun run src/cli.ts daemon start
```

## Output

Generates markdown files organized by project:

```
~/.cc-worklog/output/
  myapp/
    2024-03-04_49d6e4_fix-auth-bug.md
    2024-03-04_a1b2c3_add-user-api.md
  another-project/
    2024-03-03_deadbe_refactor-db.md
```

Each file contains:

```markdown
# Fix Authentication Bug

**Date:** 2024-03-04
**Project:** myapp

## Summary
Fixed JWT token validation that was causing 401 errors...

## What Was Done
- Identified expired token handling issue
- Updated token refresh logic
- Added unit tests

## Files Changed
- `src/auth.ts` - Fixed token validation
- `src/auth.test.ts` - Added test cases

## Key Decisions
- **Use refresh tokens**: To avoid forcing re-login...
```

## Daemon

The daemon polls for closed sessions every 60 seconds:

```sh
cc-worklog daemon start     # Background
cc-worklog daemon stop
cc-worklog daemon status
cc-worklog daemon logs
```

Install as a system service (survives reboot):

```sh
cc-worklog daemon install   # launchd on macOS, systemd on Linux
cc-worklog daemon uninstall
```

The daemon includes:
- Circuit breaker (stops API calls after repeated failures)
- Exponential backoff with jitter
- Per-session retry tracking (3 attempts before marking failed)
- Health check file for external monitoring

## Configuration

```sh
cc-worklog config                           # Show all
cc-worklog config set output.directory ~/Obsidian/Vault/Worklogs
cc-worklog config set openai.model gpt-4o
```

Override per-run:

```sh
cc-worklog process -o ~/Desktop -m gpt-4-turbo
```

## How It Works

1. Scans `~/.claude/projects/` for session JSONL files
2. Detects "closed" sessions (no writes for 1 hour)
3. Parses prompts, file edits, commands, errors
4. Sends transcript to OpenAI for summarization
5. Writes structured markdown to output directory
6. Tracks processed sessions in `~/.cc-worklog/state.json`

## Options

```
-a, --all              Reprocess all sessions
-p, --project <name>   Filter by project
-f, --force            Process active sessions
-o, --output-dir       Override output directory
-m, --model            Override OpenAI model
```

## Failed Sessions

```sh
cc-worklog failed           # List failed sessions
cc-worklog retry <id>       # Retry specific session
cc-worklog retry --all      # Retry all
```

## License

MIT
