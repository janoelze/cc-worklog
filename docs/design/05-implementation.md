# Implementation Plan

## Approach: cc-worklog CLI Tool

A single script that:
1. Finds unprocessed sessions
2. Parses and summarizes them
3. Writes markdown files

No plugins, no hooks, no daemons. Run it manually or via cron.

## Technology Choice

**Option A: Shell script + Claude CLI**
- Pros: Zero dependencies, works everywhere
- Cons: Complex parsing, error handling is painful

**Option B: Node.js/TypeScript**
- Pros: Good JSON handling, familiar tooling
- Cons: Requires Node.js

**Option C: Python**
- Pros: Great for scripting, good JSON/text handling
- Cons: Virtual env management

**Option D: Bun**
- Pros: Fast, TypeScript native, single binary
- Cons: Newer runtime

**Recommended: Bun**
JSON parsing is critical, and Bun has native TypeScript support.

## LLM Backend

**OpenAI API** via the official `openai` npm package.

**Why OpenAI:**
- Simple HTTP API, no CLI dependency
- Large context windows (128K tokens for GPT-4o, up to 1M for GPT-4.1)
- Cost-effective options (GPT-4o mini at $0.15/1M input tokens)
- Native JSON output mode (`response_format: { type: 'json_object' }`)

**Environment:**
- Uses `OPENAI_API_KEY` environment variable (from `~/.zshrc`)

**Recommended Model:** `gpt-4o-mini`
- 128K context window fits most sessions
- Fast and cheap ($0.15/1M input, $0.60/1M output)
- Good at structured extraction tasks

## Core Components

### 1. Session Discovery (`src/discovery.ts`)

```typescript
interface SessionInfo {
  sessionId: string;
  project: string;
  projectSlug: string;
  logFile: string;
  startTime: Date;
}

function discoverSessions(claudeDir: string): SessionInfo[]
function getUnprocessedSessions(sessions: SessionInfo[], processedIndex: string[]): SessionInfo[]
```

### 2. Session Parser (`src/parser.ts`)

```typescript
interface ParsedSession {
  sessionId: string;
  project: string;
  startTime: Date;
  endTime: Date;
  prompts: Prompt[];
  filesRead: FileRead[];
  filesEdited: FileEdit[];
  commandsRun: Command[];
  errors: ErrorInfo[];
  conversation: ConversationTurn[];
}

function parseSession(logFile: string): ParsedSession
```

### 3. Summarizer (`src/summarizer.ts`)

```typescript
interface SessionSummary {
  title: string;
  summary: string;
  whatWasDone: string[];
  filesChanged: FileChange[];
  decisions: Decision[];
  errors: string[];
  commands: string[];
}

function summarizeSession(parsed: ParsedSession): Promise<SessionSummary>
```

### 4. Output Writer (`src/writer.ts`)

```typescript
function writeSessionMarkdown(summary: SessionSummary, outputDir: string): string
function updateIndex(outputDir: string): void
```

### 5. CLI (`src/cli.ts`)

```typescript
// Usage:
// cc-worklog process              # Process all unprocessed sessions
// cc-worklog process --project X  # Process sessions for specific project
// cc-worklog list                 # List unprocessed sessions
// cc-worklog search "auth bug"    # Search past summaries
```

## State Management

Track processed sessions in a simple JSON file:

```json
// worklog/.processed.json
{
  "processed": [
    "49d6e4a2-5d0f-4b4d-bf72-1e03272501db",
    "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
  ],
  "lastRun": "2026-03-04T10:00:00Z"
}
```

## Summarization via OpenAI API

### Dependencies

```bash
bun add openai
```

### API Call Structure

```typescript
import OpenAI from 'openai';

const client = new OpenAI();  // Uses OPENAI_API_KEY env var

const completion = await client.chat.completions.create({
  model: 'gpt-4o-mini',
  messages: [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: transcript }
  ],
  response_format: { type: 'json_object' }
});

const summary = JSON.parse(completion.choices[0].message.content);
```

### System Prompt

```
You are analyzing a Claude Code session transcript. Extract a concise summary.

Output JSON:
{
  "title": "Short title (5-8 words)",
  "summary": "2-3 sentence summary of what was accomplished",
  "whatWasDone": ["List of actions taken"],
  "filesChanged": [{"path": "...", "change": "brief description"}],
  "decisions": [{"decision": "...", "reasoning": "..."}],
  "errors": ["Errors encountered and how resolved"],
  "commands": ["Notable commands run"]
}

Focus on:
- What the user wanted to accomplish
- Key decisions and their reasoning
- Problems encountered and solutions
- Outcomes and results
```

### Token Counting

Use `gpt-tokenizer` for accurate token counting before sending to the API:

```bash
bun add gpt-tokenizer
```

```typescript
import { encode } from 'gpt-tokenizer/model/gpt-4o';

function countTokens(text: string): number {
  return encode(text).length;
}
```

### Context Window Management

**GPT-4o-mini context:** 128K tokens (input + output combined)
**Target input budget:** ~100K tokens (leave room for output + system prompt)

#### Strategy 1: Aggressive Filtering (Primary)

Before sending to the API, filter the transcript to reduce token usage:

1. **Remove verbose Read outputs** - Only keep file path, not content
2. **Truncate tool outputs** - Cap at ~200 chars each
3. **Deduplicate file operations** - Mention each file once with summary
4. **Skip system messages** - Remove internal Claude Code noise
5. **Compress conversation** - Keep user prompts full, truncate assistant responses
6. **Remove redundant context** - Skip repeated tool calls on same file

**Filtering priority (keep in order):**
1. User prompts (full text) - most important
2. Files edited (path + change summary)
3. Errors encountered
4. Key assistant explanations
5. Commands run (without full output)
6. Files read (path only)

#### Strategy 2: Hierarchical Map-Reduce (For Very Long Sessions)

If filtered transcript still exceeds ~100K tokens, use map-reduce:

```
┌─────────────────────────────────────────────────────────┐
│                    Session Transcript                    │
└─────────────────────────────────────────────────────────┘
                            │
              ┌─────────────┼─────────────┐
              ▼             ▼             ▼
         ┌────────┐   ┌────────┐   ┌────────┐
         │ Chunk 1│   │ Chunk 2│   │ Chunk 3│
         └────────┘   └────────┘   └────────┘
              │             │             │
              ▼             ▼             ▼
         ┌────────┐   ┌────────┐   ┌────────┐
         │Summary1│   │Summary2│   │Summary3│   ← MAP phase
         └────────┘   └────────┘   └────────┘
              │             │             │
              └─────────────┼─────────────┘
                            ▼
                    ┌──────────────┐
                    │Final Summary │   ← REDUCE phase
                    └──────────────┘
```

**Chunking approach:**
- Split by conversation turns (semantic boundaries, not token count)
- Each chunk: ~30K tokens
- Overlap: Include last user prompt from previous chunk for context
- Preserve file edit sequences within chunks when possible

**Map phase prompt:**
```
Summarize this portion of a Claude Code session. Focus on:
- What the user asked for
- What was done
- Files changed
- Problems encountered

This is chunk {n} of {total}. Output JSON with partial findings.
```

**Reduce phase prompt:**
```
Combine these partial summaries into a final coherent summary.
Merge duplicate file changes. Resolve any contradictions.
Output the final JSON summary.
```

**Tradeoffs:**
- Pro: Handles arbitrarily long sessions
- Pro: Chunks can be processed in parallel
- Con: Multiple API calls = higher cost
- Con: May lose some cross-chunk context

#### Strategy 3: Sliding Window with Progressive Refinement

Alternative for maintaining context across chunks:

1. Process first chunk → initial summary
2. Process next chunk + previous summary → refined summary
3. Repeat until done

Less parallel but better context preservation.

### Recommended Approach

1. **Default:** Aggressive filtering (Strategy 1)
   - Should handle 95% of sessions
   - Single API call, lowest cost

2. **Fallback:** Map-reduce (Strategy 2)
   - Only if filtered transcript > 100K tokens
   - Split into ~30K token chunks
   - Warn user about longer processing time

## File Structure

```
cc-worklog/
├── src/
│   ├── cli.ts           # Entry point
│   ├── discovery.ts     # Find sessions
│   ├── parser.ts        # Parse JSONL
│   ├── summarizer.ts    # AI summarization
│   ├── writer.ts        # Write markdown
│   └── types.ts         # Shared types
├── docs/
│   └── design/          # This documentation
├── worklog/             # Output directory (gitignored?)
│   ├── .processed.json
│   └── {project}/
│       └── *.md
├── package.json
└── README.md
```

## MVP Scope

**Phase 1: Basic pipeline**
- [ ] Parse session JSONL
- [ ] Detect closed sessions (mtime + content heuristics)
- [ ] Summarize with OpenAI API (gpt-4o-mini)
- [ ] Write markdown output
- [ ] Track processed sessions

**Phase 2: Daemon**
- [ ] Background daemon with polling/watching
- [ ] launchd plist for macOS
- [ ] CLI commands: start, stop, status, logs

**Phase 3: Polish**
- [x] Better error handling
- [x] Retry failed sessions
- [x] Filter by project
- [x] Search command
