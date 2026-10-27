---
name: open-ctx-doctor
description: Diagnose an open-context-mode install — runtimes, hooks, FTS5, npm version.
  Trigger: /open-context-mode:open-ctx-doctor
user-invocable: true
---

# Open Context Mode Doctor

## Instructions

1. Call the `open_ctx_doctor` MCP tool. It runs every check server-side and returns a
   plain-text report.
2. Reproduce it verbatim. The status prefixes are already renderer-safe across clients:
   `[OK]` PASS, `[FAIL]` FAIL, `[WARN]` WARN.
3. **Fallback**, only when the MCP tool call fails: resolve the plugin root by dropping
   `/skills/open-ctx-doctor` from this skill's directory, then run
   ```bash
   CLI="<PLUGIN_ROOT>/cli.bundle.mjs"; [ ! -f "$CLI" ] && CLI="<PLUGIN_ROOT>/build/cli.js"
   node "$CLI" doctor
   ```
   and reproduce the same output with the same prefixes.

