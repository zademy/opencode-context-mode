---
name: open-ctx-purge
description: |
  Delete open-context-mode data. Irreversible.
  Trigger: /open-context-mode:open-ctx-purge
user-invocable: true
---

# Open Context Mode Purge

Permanently deletes open-context-mode data. This cannot be undone, so confirm the scope
with the user before calling anything.

## Scope

- **Project** — `open_ctx_purge(confirm: true, scope: "project")`. Wipes the knowledge
  base, every session's DB rows, events markdown and stats.
- **Session** — `open_ctx_purge(confirm: true, scope: "session", sessionId: "<id>")`.
  Wipes only that session's rows and FTS5 chunks; sibling sessions, project stats and the
  store file survive.

## Instructions

1. Ask which scope, unless the user already said. If they want an overview first,
   `open_ctx_stats` is read-only and safe to run.
2. Call the MCP tool with `confirm: true` and the agreed scope.
3. Report what was deleted, and what survived if the scope was narrower than project.

## CLI Fallback

```bash
open-context-mode purge --confirm --scope project
```

