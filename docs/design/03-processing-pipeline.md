# Processing Pipeline

## Overview

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Session Logs   │────►│    Parser       │────►│   Summarizer    │
│  (~/.claude/)   │     │  (Extract data) │     │  (AI distill)   │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                                                        │
                                                        ▼
                                                ┌─────────────────┐
                                                │     Output      │
                                                │  (Markdown)     │
                                                └─────────────────┘
```

## Stage 1: Discovery

Find sessions to process.

**Input:** `~/.claude/projects/`
**Output:** List of session files with metadata

```
{
  sessionId: "49d6e4a2-...",
  project: "/Users/jane/src/myapp",
  projectName: "myapp",
  logFile: "~/.claude/projects/-Users-jane-src-myapp/49d6e4a2-....jsonl",
  startTime: "2026-03-04T10:00:00Z",
  processed: false
}
```

**Logic:**
1. Scan project directories
2. Find all `.jsonl` files (exclude `agent-*.jsonl` or include them?)
3. Detect project name (see below)
4. Check against processed sessions index
5. Return unprocessed sessions

### Project Name Detection

The directory name alone (e.g., "infra") is often not descriptive enough. We detect better names by checking multiple sources in order:

**Detection strategies (in priority order):**

1. **package.json** (Node.js/npm projects)
   - Read `name` field
   - Handle scoped packages: `@org/name` → `name`
   - Confidence: high

2. **Git remote** (any git repo)
   - Parse `.git/config` for `[remote "origin"]` URL
   - Extract repo name from `github.com:user/repo.git` or `https://...`
   - Confidence: high

3. **pyproject.toml** (Python projects)
   - Read `name` field from `[project]` section
   - Confidence: high

4. **Cargo.toml** (Rust projects)
   - Read `name` field from `[package]` section
   - Confidence: high

5. **go.mod** (Go projects)
   - Extract last segment from `module` path
   - Confidence: high

6. **Path segments** (fallback)
   - Skip common directories: `Users`, `home`, `src`, `projects`, etc.
   - Skip username after `/Users/` or `/home/`
   - Join remaining meaningful segments with `-`
   - Limit to last 3 segments
   - Confidence: medium

**Examples:**
| Path | Fallback Name | Detected Name | Source |
|------|---------------|---------------|--------|
| `/Users/jane/src/company/api` | `api` | `company-api` | path-segment |
| `/Users/jane/src/myapp` | `myapp` | `myapp` | package.json |
| `/home/dev/projects/rust-tool` | `rust-tool` | `rust-tool` | Cargo.toml |
| `/Users/jane/src/org/infra` | `infra` | `org-infra` | path-segment |

## Stage 2: Parsing

Extract structured data from JSONL.

**Input:** Session JSONL file
**Output:** Structured session object

```
{
  sessionId: "...",
  project: "/Users/jane/src/myapp",
  startTime: "...",
  endTime: "...",

  prompts: [
    { text: "Fix the auth bug", timestamp: "..." }
  ],

  filesRead: [
    { path: "src/auth.ts", timestamp: "..." }
  ],

  filesEdited: [
    { path: "src/auth.ts", changes: "...", timestamp: "..." }
  ],

  commandsRun: [
    { command: "npm test", output: "...", exitCode: 0 }
  ],

  errors: [
    { message: "TypeError: ...", context: "..." }
  ],

  assistantMessages: [
    { content: "The bug was caused by...", timestamp: "..." }
  ]
}
```

**Considerations:**
- Skip very short sessions (< 2 prompts?)
- Truncate large outputs
- Redact sensitive data (API keys, passwords)

## Stage 3: Summarization

Use AI to distill knowledge from parsed session.

**Input:** Structured session object
**Output:** Knowledge items

**Approach A: Single-pass extraction**
Send full session to Claude, ask for structured JSON output.

**Approach B: Multi-pass extraction**
1. First pass: Identify what happened (facts)
2. Second pass: Extract decisions and reasoning (why)
3. Third pass: Identify reusable patterns (how)

**Approach C: Conversation-aware extraction**
Instead of treating session as a blob, walk through the conversation:
- What did the user want?
- What was tried?
- What worked / didn't work?
- What was the outcome?

**Recommended: Approach A with good prompting**
Simpler, cheaper, and good prompts can achieve similar quality.

## Stage 4: Output

Write knowledge to files.

**Input:** Knowledge items
**Output:** Markdown files

**Options:**

1. **One file per session**
   ```
   worklog/
   └── 2026-03-04_fix-auth-bug.md
   ```

2. **One file per project, append entries**
   ```
   worklog/
   └── myapp.md  # Append new entries
   ```

3. **Categorized files**
   ```
   worklog/
   └── myapp/
       ├── decisions.md
       ├── errors.md
       └── sessions/
           └── 2026-03-04.md
   ```

**Recommended: Option 1 (one file per session)**
- Simple to implement
- Easy to search with grep
- No merge conflicts
- Natural chronological ordering
