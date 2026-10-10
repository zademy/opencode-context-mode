/**
 * Platform-aware MCP tool naming.
 * Each platform has its own convention for how MCP tool names appear to the LLM.
 *
 * Evidence-based naming conventions (from official docs):
 * | Platform           | Pattern                                                    |
 * |--------------------|------------------------------------------------------------|
 * | Claude Code (plugin) | mcp__plugin_open-context-mode_open-context-mode__<tool>             |
 * | Claude Code (standalone / MacPorts) | mcp__open-context-mode__<tool>              |
 * | Gemini CLI         | mcp__open-context-mode__<tool>                                  |
 * | Antigravity        | mcp__open-context-mode__<tool>                                  |
 * | Antigravity CLI    | open-context-mode/<tool>                                        |
 * | OpenCode / KiloCode | native open_ctx_* (plugin tools)                                |
 * | VS Code Copilot    | open-context-mode_<tool>                                        |
 * | Kiro               | @open-context-mode/<tool>                                       |
 * | Zed                | mcp:open-context-mode:<tool>                                    |
 * | Cursor / Codex / OpenClaw / Pi | bare <tool>                                    |
 */

const TOOL_PREFIXES = {
  // CLAUDE_PLUGIN_ROOT is set only when Claude Code manages hooks via its plugin system.
  // Standalone installs (MacPorts, npm global) write absolute-path hooks to settings.json
  // and register the MCP server as "open-context-mode" → prefix is mcp__open-context-mode__.
  "claude-code": (tool) =>
    process.env.CLAUDE_PLUGIN_ROOT ? `mcp__plugin_open-context-mode_open-context-mode__${tool}` : `mcp__open-context-mode__${tool}`,
  "gemini-cli": (tool) => `mcp__open-context-mode__${tool}`,
  antigravity: (tool) => `mcp__open-context-mode__${tool}`,
  "antigravity-cli": (tool) => `open-context-mode/${tool}`,
  opencode: (tool) => tool,
  kilo: (tool) => tool,
  "vscode-copilot": (tool) => `open-context-mode_${tool}`,
  "jetbrains-copilot": (tool) => `open-context-mode_${tool}`,
  "copilot-cli": (tool) => `open-context-mode_${tool}`,
  kiro: (tool) => `@open-context-mode/${tool}`,
  zed: (tool) => `mcp:open-context-mode:${tool}`,
  cursor: (tool) => tool,
  codex: (tool) => tool,
  kimi: (tool) => `mcp__open-context-mode__${tool}`,
  openclaw: (tool) => tool,
  pi: (tool) => tool,
  "qwen-code": (tool) => `mcp__open-context-mode__${tool}`,
};

/**
 * Get the platform-specific MCP tool name for a bare tool name.
 * Falls back to claude-code convention if platform is unknown.
 */
export function getToolName(platform, bareTool) {
  const fn = TOOL_PREFIXES[platform] || TOOL_PREFIXES["claude-code"];
  return fn(bareTool);
}

/**
 * Create a namer function bound to a specific platform.
 * Returns (bareTool) => platformSpecificToolName.
 */
export function createToolNamer(platform) {
  // Carries its platform so the guidance factories can name the HOST's own tools
  // without every call site threading a second argument.
  return Object.assign((bareTool) => getToolName(platform, bareTool), { platform });
}

/**
 * Host tools the guidance text talks about. These are NOT the plugin's tools —
 * they are the ones the agent already has — so a wrong name makes the agent call a
 * tool that does not exist ("Unknown tool"). Claude Code capitalizes them and
 * ships a dedicated WebFetch; OpenCode exposes lowercase bash/read/edit/write and
 * has no WebFetch at all. `webFetch: null` means the host has no such tool, so the
 * guidance names the intent rather than a tool that isn't there.
 */
const HOST_TOOLS = {
  "claude-code": { shell: "Bash", read: "Read", edit: "Edit", write: "Write", grep: "Grep", webFetch: "WebFetch" },
  opencode: { shell: "bash", read: "read", edit: "edit", write: "write", grep: "grep", webFetch: null },
  kilo: { shell: "bash", read: "read", edit: "edit", write: "write", grep: "grep", webFetch: null },
};

/**
 * Create a namer for the host's own tools: (kind) => name | null.
 * Unknown platforms fall back to the claude-code convention, same as getToolName().
 */
export function createHostNamer(platform) {
  const table = HOST_TOOLS[platform] ?? HOST_TOOLS["claude-code"];
  return (kind) => table[kind] ?? null;
}

/** List of all known platform IDs. */
export const KNOWN_PLATFORMS = Object.keys(TOOL_PREFIXES);
