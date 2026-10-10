/**
 * open-context-mode — OpenCode 2.x plugin entry (discovery template).
 *
 * Copy this file into a directory OpenCode discovers plugins from, then fix the
 * specifier below to point at your open-context-mode install:
 *
 *   global:   ~/.config/opencode/plugins/opencode-context-mode.ts
 *   project:  <project>/.opencode/plugins/opencode-context-mode.ts
 *
 * Why a file and not a `plugin` config entry: OpenCode 2.0.22 resolves the
 * `plugin` key in opencode.json as an npm specifier ONLY. A filesystem path
 * there is accepted by the schema and then ignored silently — no warning, no
 * error, the plugin just never loads. Local plugins are found by directory
 * discovery instead, which is what this file relies on.
 *
 * Do NOT also add `mcp.open-context-mode`. The plugin registers the 11 `open_ctx_*` tools
 * in-process; a second MCP entry makes the loader register zero of them.
 */

export { default } from "open-context-mode/build/platforms/opencode/plugin.js";
