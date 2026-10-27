---
name: open-ctx-index
description: |
  Store a file or directory for later retrieval by open_ctx_search.
  Trigger: /open-context-mode:open-ctx-index
user-invocable: true
---

# Open Context Mode Index

Store local content in the FTS5 knowledge base so `open_ctx_search` can retrieve focused
snippets later.

## Instructions

1. Prefer the `open_ctx_index` MCP tool when it is available.
2. Ask for a path only when the user gave none and the project root is ambiguous.
3. Pass `path`, never a large inline `content`. The bytes stay in the sandbox; the
   conversation never carries them.
4. Give the source a descriptive label — that label is what `open_ctx_search` filters on.
   `project:<dir>` is the CLI default for directories.

```javascript
open_ctx_index({
  path: ".",
  source: "project:my-app",
  maxDepth: 5,
  maxFiles: 200,
  exclude: ["node_modules", "dist", ".git", "coverage"]
})
```

5. Fall back to the CLI when MCP tools are unavailable:

```bash
open-context-mode index . --source project:my-app --exclude node_modules --exclude dist
```

6. Report the source label, the file/section count, and the matching search call:

```javascript
open_ctx_search({ source: "project:my-app", queries: ["..."] })
```

## Bounds

- Leave `node_modules`, build output, `.git`, secrets and generated artifacts out.
- For broad repos, confirm with the user before raising `maxFiles` past 500.

