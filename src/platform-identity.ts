/**
 * platform-identity — two tables that look alike and are not.
 *
 * `PLATFORM_ENV_VAR_TABLE` is behaviour: the env vars a platform sets, used to
 * detect OpenCode and to resolve its workspace. One entry, because OpenCode is
 * the only platform here.
 *
 * `PLATFORM_TOOL_ALIASES` is data: the tool names MCP clients actually send,
 * mapped to the canonical names routing branches on. Deleting a platform
 * integration does not delete how Cursor spells `read_file`, so this table
 * outlives every adapter but one.
 */

/** What an env var proves about the running process. */
export type EnvVarRole = "identification" | "workspace";

export interface PlatformEnvEntry {
  name: string;
  role: EnvVarRole;
}

/**
 * Detection order matters: the first env var present decides. Identification
 * vars name the host outright; the workspace var is the fallback for a plain
 * `opencode` launch.
 */
export const PLATFORM_ENV_VAR_TABLE: ReadonlyArray<readonly [string, readonly PlatformEnvEntry[]]> = [
  [
    "opencode",
    [
      { name: "OPENCODE_CLIENT", role: "identification" },
      { name: "OPENCODE", role: "identification" },
      { name: "OPENCODE_PID", role: "identification" },
      { name: "OPENCODE_TERMINAL", role: "identification" },
      { name: "OPENCODE_PROJECT_DIR", role: "workspace" },
    ],
  ],
];

/**
 * Native tool name → canonical name, as observed on the wire.
 *
 * Several clients share a native name only when they mean the same canonical
 * tool (gemini-cli and qwen-code both send `read_file`); the overlap test in
 * tests/platforms/platform-identity.test.ts is what keeps that honest.
 */
export const PLATFORM_TOOL_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  // Claude Code
  PowerShell: "Bash",
  // Cursor
  Shell: "Bash",
  mcp_web_fetch: "WebFetch",
  mcp_fetch_tool: "WebFetch",
  // OpenCode
  bash: "Bash",
  view: "Read",
  read: "Read",
  grep: "Grep",
  fetch: "WebFetch",
  webfetch: "WebFetch",
  agent: "Agent",
  // Codex CLI
  shell: "Bash",
  shell_command: "Bash",
  exec_command: "Bash",
  container_exec: "Bash",
  local_shell: "Bash",
  grep_files: "Grep",
  // Gemini CLI / Qwen Code
  run_shell_command: "Bash",
  read_file: "Read",
  read_many_files: "Read",
  grep_search: "Grep",
  search_file_content: "Grep",
  web_fetch: "WebFetch",
  write_file: "Write",
  edit: "Edit",
  glob: "Glob",
  todo_write: "TodoWrite",
  ask_user_question: "AskUserQuestion",
  list_directory: "LS",
  save_memory: "Memory",
  skill: "Skill",
  exit_plan_mode: "ExitPlanMode",
  // VS Code Copilot
  run_in_terminal: "Bash",
  // Antigravity CLI
  run_command: "Bash",
  view_file: "Read",
  read_url_content: "WebFetch",
  list_dir: "LS",
  search_web: "WebSearch",
  // OpenClaw
  exec: "Bash",
  search: "Grep",
  // Kiro
  fs_read: "Read",
  fs_write: "Write",
  execute_bash: "Bash",
});
