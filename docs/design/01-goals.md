# Goals

## Core Problem

Claude Code sessions are ephemeral. Valuable context—decisions made, problems solved, patterns discovered—is lost between sessions. Users repeatedly solve the same problems or forget why certain decisions were made.

## What We Want

1. **Automatic capture** - No manual effort to log activity
2. **Meaningful summaries** - Not raw logs, but distilled knowledge
3. **Searchable history** - Find past decisions, solutions, patterns
4. **Project context** - Understand what happened in a codebase over time
5. **Portable output** - Plain files, not locked in a proprietary format

## Non-Goals

- Real-time sync to cloud services
- Complex UI or dashboards
- Integration with specific tools (Obsidian, Notion, etc.)
- Replacing Claude Code's built-in session history

## Design Principles

1. **Simple over clever** - Plain files, minimal dependencies
2. **Read the source** - Use Claude Code's existing session logs, don't duplicate capture
3. **Batch over real-time** - Process sessions after they end, not during
4. **Human-readable output** - Markdown files anyone can read
5. **Minimal footprint** - No daemons, no databases, no background processes
