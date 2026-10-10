---
name: open_ctx-stats
description: |
  Show how much context window open-context-mode saved this session.
  Displays token consumption, context savings ratio, and per-tool breakdown.
  Read-only — shows stats only, no reset capability.
  To wipe the knowledge base entirely, use open_ctx_purge instead.
  Trigger: /open-context-mode:open_ctx-stats
user-invocable: true
---

# Open Context Mode Stats

Show context savings for the current session.

## Instructions

1. Call the `mcp__open-context-mode__open_ctx_stats` MCP tool (no parameters needed).
2. **CRITICAL**: You MUST copy-paste the ENTIRE tool output as markdown text directly into your response message. Do NOT summarize, do NOT collapse, do NOT paraphrase. The user must see the full tables without pressing ctrl+o. Copy every line exactly as returned by the tool.
3. After the full output, add ONE sentence highlighting the key savings metric, e.g.:
   - "open-context-mode saved **12.4x** — 92% of data stayed in sandbox."
   - If no data yet: "No open-context-mode calls yet this session."

## Purge

- **`open_ctx_purge(confirm: true)`** — Permanently deletes all indexed content from the knowledge base. Use `/open-context-mode:open_ctx-purge` for this.
