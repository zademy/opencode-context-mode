---
name: open-ctx-search
description: Recall indexed content or past sessions instead of re-reading sources.
  Trigger: /open-context-mode:open-ctx-search
user-invocable: true
---

# Open Context Mode Search

Query the knowledge base without putting raw sources back into context.

## Instructions

1. Ask every question in one `queries` array — one call, one round trip.
2. Two to four technical terms per query. Synonyms dilute the ranking; scope them instead.
3. Pass `source` when you know which indexed source to read: a partial match is fine
   (`"issue-683"`, `"react"`, `"project"`).

```javascript
open_ctx_search({
  queries: ["authentication middleware", "token refresh"],
  source: "project",
  limit: 5
})
```

4. Past-session memory needs no source. It carries its own labels — `decision`, `error`,
   `blocker`, `plan`, `user-prompt`, `compaction`. Add `sort: "timeline"` for a
   cross-session view in chronological order.

5. When `open_ctx_execute` or `open_ctx_batch_execute` returned section titles instead of
   content, that output is already indexed — search it here instead of re-running the
   command.

6. Fall back to the CLI when the MCP tool is unavailable:

```bash
open-context-mode search "auth middleware" --source project --limit 5
```

Report the matched source labels and snippets as returned.

