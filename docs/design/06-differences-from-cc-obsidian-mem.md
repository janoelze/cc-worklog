# Differences from cc-obsidian-mem

## Philosophical Differences

| Aspect | cc-obsidian-mem | Our Approach |
|--------|-----------------|--------------|
| **Capture** | Hooks duplicate data | Read existing logs |
| **Storage** | SQLite database | Plain files |
| **Processing** | Real-time during session | Batch after session |
| **Output** | Obsidian-specific | Plain markdown |
| **Dependencies** | Bun, MCP server, hooks | Bun + Claude CLI |
| **Complexity** | Plugin system, multiple scripts | Single CLI tool |

## What We Keep

1. **AI summarization** - Using Claude to distill knowledge
2. **Project organization** - Group by project
3. **Structured output** - Decisions, errors, patterns sections
4. **Deduplication concept** - Track what's been processed

## What We Drop

1. **Hooks system** - No runtime overhead, no version coupling
2. **SQLite** - Plain JSON file for state
3. **MCP server** - Not needed for our use case
4. **Obsidian integration** - Plain markdown works everywhere
5. **Canvas generation** - Over-engineered for most users
6. **Complex deduplication** - Simple processed list suffices
7. **Real-time context injection** - Out of scope

## What We Add

1. **Retroactive processing** - Process old sessions
2. **Simpler mental model** - Read logs → summarize → write files
3. **Zero configuration** - Works out of the box
4. **Search command** - Find past sessions quickly

## Tradeoffs

**We lose:**
- Real-time capture (but we don't need it - logs exist)
- Obsidian graph view (but markdown is portable)
- MCP tools for Claude to read memories (but we can add later)

**We gain:**
- Simplicity
- No runtime overhead
- Works with any Claude Code version
- Can process historical sessions
- Easier to understand and modify
