---
name: open-ctx-stats
description: Show what the sandbox saved this session.
  Trigger: /open-context-mode:open-ctx-stats
user-invocable: true
---

# Open Context Mode Stats

Report the current session's context savings.

## Instructions

1. Call the `open_ctx_stats` MCP tool (no parameters).
2. Reproduce the tool output in full, every table and line, in your response — the user
   reads it without expanding anything. Summarizing or collapsing it defeats the command.
3. Close with one sentence naming the headline number, e.g.
   "Saved **12.4x** — 92% of the data stayed in the sandbox." When nothing has run yet:
   "No open-context-mode calls this session."

`open_ctx_stats` is read-only. To delete indexed content, use
`open_ctx_purge(confirm: true)` via `/open-context-mode:open-ctx-purge`.

