# Output Format

## File Naming

```
worklog/
├── {project-slug}/
│   └── {date}_{session-id-short}_{title-slug}.md
```

Example:
```
worklog/
├── myapp/
│   ├── 2026-03-04_a1b2c3_fix-auth-token-expiry.md
│   ├── 2026-03-04_d4e5f6_add-user-settings-page.md
│   └── 2026-03-05_g7h8i9_refactor-database-layer.md
```

**Why this structure:**
- Project grouping for easy browsing
- Date prefix for chronological sorting
- Short session ID for uniqueness
- Title slug for human readability

## Session Summary Format

```markdown
# Fix auth token expiry bug

**Date:** 2026-03-04
**Project:** /Users/jane/src/myapp
**Session:** a1b2c3d4-e5f6-...
**Duration:** ~15 minutes

## Summary

Fixed a bug where JWT tokens weren't being refreshed before expiry,
causing users to be logged out unexpectedly.

## What Was Done

- Investigated token refresh logic in `src/auth/token.ts`
- Found that refresh was triggered at expiry instead of before
- Changed refresh threshold from 0 to 5 minutes before expiry
- Added tests for token refresh timing

## Files Changed

- `src/auth/token.ts` - Added early refresh logic
- `src/auth/token.test.ts` - Added refresh timing tests

## Key Decisions

- **Refresh 5 minutes early**: Chose 5 minutes as buffer to account for
  clock skew and network latency. Could be configurable later.

## Errors Encountered

- Initially tried to use `Date.now()` but tokens use seconds not milliseconds

## Commands Run

```bash
npm test -- --grep "token"
npm run build
```

---
*Generated from Claude Code session*
```

## Why This Format

1. **Human-readable** - Can be read without any tools
2. **Searchable** - grep-friendly, full-text searchable
3. **Portable** - Just markdown, works anywhere
4. **Complete** - Contains enough context to understand later
5. **Skimmable** - Clear sections for quick scanning

## Frontmatter (Optional)

For tools that support it:

```yaml
---
date: 2026-03-04
project: myapp
session: a1b2c3d4-e5f6-...
tags: [auth, bugfix, jwt]
files: [src/auth/token.ts, src/auth/token.test.ts]
---
```

## Index File (Optional)

```markdown
# Work Log Index

## myapp

| Date | Session | Summary |
|------|---------|---------|
| 2026-03-05 | g7h8i9 | Refactor database layer |
| 2026-03-04 | d4e5f6 | Add user settings page |
| 2026-03-04 | a1b2c3 | Fix auth token expiry bug |

## other-project

| Date | Session | Summary |
|------|---------|---------|
| ... | ... | ... |
```
