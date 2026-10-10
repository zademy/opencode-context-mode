import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

let getToolName: (platform: string, bareTool: string) => string;
let createToolNamer: (platform: string) => (bareTool: string) => string;
let KNOWN_PLATFORMS: string[];
let routePreToolUse: (
  toolName: string,
  toolInput: Record<string, unknown>,
  projectDir?: string,
  platform?: string,
) => {
  action: string;
  reason?: string;
  updatedInput?: Record<string, unknown>;
  additionalContext?: string;
} | null;
let resetGuidanceThrottle: () => void;
let createRoutingBlock: (t: (tool: string) => string) => string;
let createReadGuidance: (t: (tool: string) => string) => string;
let createGrepGuidance: (t: (tool: string) => string) => string;
let createBashGuidance: (t: (tool: string) => string) => string;
let createExternalMcpGuidance: (t: (tool: string) => string) => string;
let ROUTING_BLOCK: string;
let READ_GUIDANCE: string;
let GREP_GUIDANCE: string;
let BASH_GUIDANCE: string;
let EXTERNAL_MCP_GUIDANCE: string;

beforeAll(async () => {
  const naming = await import("../../hooks/core/tool-naming.mjs");
  getToolName = naming.getToolName;
  createToolNamer = naming.createToolNamer;
  KNOWN_PLATFORMS = naming.KNOWN_PLATFORMS;

  const routing = await import("../../hooks/core/routing.mjs");
  routePreToolUse = routing.routePreToolUse;
  resetGuidanceThrottle = routing.resetGuidanceThrottle;

  const block = await import("../../hooks/routing-block.mjs");
  createRoutingBlock = block.createRoutingBlock;
  createReadGuidance = block.createReadGuidance;
  createGrepGuidance = block.createGrepGuidance;
  createBashGuidance = block.createBashGuidance;
  createExternalMcpGuidance = block.createExternalMcpGuidance;
  ROUTING_BLOCK = block.ROUTING_BLOCK;
  READ_GUIDANCE = block.READ_GUIDANCE;
  GREP_GUIDANCE = block.GREP_GUIDANCE;
  BASH_GUIDANCE = block.BASH_GUIDANCE;
  EXTERNAL_MCP_GUIDANCE = block.EXTERNAL_MCP_GUIDANCE;
});

// MCP readiness sentinel — routing.mjs checks process.ppid in-process
const _sentinelDir = process.platform === "win32" ? tmpdir() : "/tmp";
const mcpSentinel = resolve(_sentinelDir, `open-context-mode-mcp-ready-${process.pid}`);

beforeEach(() => {
  if (typeof resetGuidanceThrottle === "function") resetGuidanceThrottle();
  writeFileSync(mcpSentinel, String(process.pid));
});

afterEach(() => {
  try {
    unlinkSync(mcpSentinel);
  } catch {}
});

// ═══════════════════════════════════════════════════════════════════
// Tool Naming — getToolName and createToolNamer
// ═══════════════════════════════════════════════════════════════════

describe("getToolName", () => {
  it("returns plugin-namespaced name for claude-code when CLAUDE_PLUGIN_ROOT is set", () => {
    const prev = process.env.CLAUDE_PLUGIN_ROOT;
    process.env.CLAUDE_PLUGIN_ROOT = "/tmp/fake-plugin-root";
    try {
      expect(getToolName("claude-code", "open_ctx_fetch_and_index")).toBe(
        "mcp__plugin_open-context-mode_open-context-mode__open_ctx_fetch_and_index",
      );
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
      else process.env.CLAUDE_PLUGIN_ROOT = prev;
    }
  });

  it("returns standalone-namespaced name for claude-code when CLAUDE_PLUGIN_ROOT is absent", () => {
    const prev = process.env.CLAUDE_PLUGIN_ROOT;
    delete process.env.CLAUDE_PLUGIN_ROOT;
    try {
      expect(getToolName("claude-code", "open_ctx_fetch_and_index")).toBe("mcp__open-context-mode__open_ctx_fetch_and_index");
    } finally {
      if (prev !== undefined) process.env.CLAUDE_PLUGIN_ROOT = prev;
    }
  });

  it("returns correct name for gemini-cli", () => {
    expect(getToolName("gemini-cli", "open_ctx_fetch_and_index")).toBe("mcp__open-context-mode__open_ctx_fetch_and_index");
  });

  it("returns correct name for antigravity", () => {
    expect(getToolName("antigravity", "open_ctx_execute")).toBe("mcp__open-context-mode__open_ctx_execute");
  });

  it("returns correct name for antigravity-cli", () => {
    expect(getToolName("antigravity-cli", "open_ctx_execute_file")).toBe("open-context-mode/open_ctx_execute_file");
  });

  it("returns correct name for opencode (plugin-native)", () => {
    expect(getToolName("opencode", "open_ctx_search")).toBe("open_ctx_search");
  });

  it("returns correct name for kilo (plugin-native)", () => {
    expect(getToolName("kilo", "open_ctx_search")).toBe("open_ctx_search");
  });

  it("returns correct name for vscode-copilot", () => {
    expect(getToolName("vscode-copilot", "open_ctx_batch_execute")).toBe("open-context-mode_open_ctx_batch_execute");
  });

  it("returns correct name for kiro", () => {
    expect(getToolName("kiro", "open_ctx_execute_file")).toBe("@open-context-mode/open_ctx_execute_file");
  });

  it("returns correct name for zed", () => {
    expect(getToolName("zed", "open_ctx_index")).toBe("mcp:open-context-mode:open_ctx_index");
  });

  it("returns bare name for cursor", () => {
    expect(getToolName("cursor", "open_ctx_fetch_and_index")).toBe("open_ctx_fetch_and_index");
  });

  it("returns bare name for codex", () => {
    expect(getToolName("codex", "open_ctx_execute")).toBe("open_ctx_execute");
  });

  it("returns bare name for openclaw", () => {
    expect(getToolName("openclaw", "open_ctx_search")).toBe("open_ctx_search");
  });

  it("returns bare name for pi", () => {
    expect(getToolName("pi", "open_ctx_batch_execute")).toBe("open_ctx_batch_execute");
  });

  it("falls back to claude-code for unknown platforms (standalone)", () => {
    const prev = process.env.CLAUDE_PLUGIN_ROOT;
    delete process.env.CLAUDE_PLUGIN_ROOT;
    try {
      expect(getToolName("unknown-platform", "open_ctx_search")).toBe("mcp__open-context-mode__open_ctx_search");
    } finally {
      if (prev !== undefined) process.env.CLAUDE_PLUGIN_ROOT = prev;
    }
  });
});

describe("createToolNamer", () => {
  it("returns a function that produces correct names", () => {
    const t = createToolNamer("gemini-cli");
    expect(t("open_ctx_execute")).toBe("mcp__open-context-mode__open_ctx_execute");
    expect(t("open_ctx_search")).toBe("mcp__open-context-mode__open_ctx_search");
  });
});

describe("KNOWN_PLATFORMS", () => {
  it("contains all platforms", () => {
    expect(KNOWN_PLATFORMS).toContain("claude-code");
    expect(KNOWN_PLATFORMS).toContain("gemini-cli");
    expect(KNOWN_PLATFORMS).toContain("antigravity");
    expect(KNOWN_PLATFORMS).toContain("opencode");
    expect(KNOWN_PLATFORMS).toContain("kilo");
    expect(KNOWN_PLATFORMS).toContain("vscode-copilot");
    expect(KNOWN_PLATFORMS).toContain("jetbrains-copilot");
    expect(KNOWN_PLATFORMS).toContain("kiro");
    expect(KNOWN_PLATFORMS).toContain("zed");
    expect(KNOWN_PLATFORMS).toContain("cursor");
    expect(KNOWN_PLATFORMS).toContain("codex");
    expect(KNOWN_PLATFORMS).toContain("openclaw");
    expect(KNOWN_PLATFORMS).toContain("pi");
    expect(KNOWN_PLATFORMS).toContain("qwen-code");
    expect(KNOWN_PLATFORMS.length).toBeGreaterThanOrEqual(14);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Routing Block Factory Functions
// ═══════════════════════════════════════════════════════════════════

describe("createRoutingBlock", () => {
  it("produces block with platform-specific tool names for gemini-cli", () => {
    const t = createToolNamer("gemini-cli");
    const block = createRoutingBlock(t);
    expect(block).toContain("mcp__open-context-mode__open_ctx_batch_execute");
    expect(block).toContain("mcp__open-context-mode__open_ctx_search");
    expect(block).toContain("mcp__open-context-mode__open_ctx_execute");
    expect(block).toContain("mcp__open-context-mode__open_ctx_fetch_and_index");
    // Must NOT contain claude-code prefix
    expect(block).not.toContain("mcp__plugin_open-context-mode_open-context-mode__");
  });

  it("produces block with bare names for cursor", () => {
    const t = createToolNamer("cursor");
    const block = createRoutingBlock(t);
    expect(block).toContain("open_ctx_batch_execute(commands, queries)");
    expect(block).toContain("open_ctx_search(queries:");
    expect(block).not.toContain("mcp__");
  });
});

describe("createReadGuidance", () => {
  it("uses kiro-style tool names for kiro platform", () => {
    const t = createToolNamer("kiro");
    const guidance = createReadGuidance(t);
    expect(guidance).toContain("@open-context-mode/open_ctx_execute_file");
  });
});

describe("createGrepGuidance", () => {
  it("uses native open_ctx_* tool names for opencode platform", () => {
    const t = createToolNamer("opencode");
    const guidance = createGrepGuidance(t);
    expect(guidance).toContain("open_ctx_execute");
  });
});

describe("createBashGuidance", () => {
  it("uses zed-style tool names for zed platform", () => {
    const t = createToolNamer("zed");
    const guidance = createBashGuidance(t);
    expect(guidance).toContain("mcp:open-context-mode:open_ctx_batch_execute");
    expect(guidance).toContain("mcp:open-context-mode:open_ctx_execute");
  });
});

describe("createExternalMcpGuidance (#529)", () => {
  it("uses kiro-style tool names for kiro platform", () => {
    const t = createToolNamer("kiro");
    const guidance = createExternalMcpGuidance(t);
    expect(guidance).toContain("@open-context-mode/open_ctx_execute");
    expect(guidance).toContain("@open-context-mode/open_ctx_fetch_and_index");
    expect(guidance).toContain("@open-context-mode/open_ctx_search");
  });

  it("uses native open_ctx_* tool names for opencode platform", () => {
    const t = createToolNamer("opencode");
    const guidance = createExternalMcpGuidance(t);
    expect(guidance).toContain("open_ctx_execute");
    expect(guidance).toContain("open_ctx_fetch_and_index");
    expect(guidance).toContain("open_ctx_search");
  });

  it("uses zed-style tool names for zed platform", () => {
    const t = createToolNamer("zed");
    const guidance = createExternalMcpGuidance(t);
    expect(guidance).toContain("mcp:open-context-mode:open_ctx_execute");
    expect(guidance).toContain("mcp:open-context-mode:open_ctx_fetch_and_index");
    expect(guidance).toContain("mcp:open-context-mode:open_ctx_search");
  });

  it("mentions the routing intent so the model knows what to do", () => {
    const t = createToolNamer("claude-code");
    const guidance = createExternalMcpGuidance(t);
    // Identifies the situation
    expect(guidance).toContain("External MCP tools");
    // Points to the right tools — losing any of these defeats the guidance
    expect(guidance).toMatch(/open_ctx_execute/);
    expect(guidance).toMatch(/open_ctx_fetch_and_index/);
    expect(guidance).toMatch(/open_ctx_search/);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Backward Compat — Static Exports
// ═══════════════════════════════════════════════════════════════════

// Static exports default to claude-code naming. The exact prefix depends on
// CLAUDE_PLUGIN_ROOT at module load time: set → plugin prefix, absent → standalone prefix.
// Tests run without CLAUDE_PLUGIN_ROOT so they assert the standalone prefix.
describe("backward compat static exports", () => {
  it("ROUTING_BLOCK uses claude-code standalone naming", () => {
    expect(ROUTING_BLOCK).toContain("mcp__open-context-mode__open_ctx_batch_execute");
    expect(ROUTING_BLOCK).toContain("mcp__open-context-mode__open_ctx_search");
    expect(ROUTING_BLOCK).not.toContain("mcp__plugin_open-context-mode_open-context-mode__");
  });

  it("READ_GUIDANCE uses claude-code standalone naming", () => {
    expect(READ_GUIDANCE).toContain("mcp__open-context-mode__open_ctx_execute_file");
  });

  it("GREP_GUIDANCE uses claude-code standalone naming", () => {
    expect(GREP_GUIDANCE).toContain("mcp__open-context-mode__open_ctx_execute");
  });

  it("BASH_GUIDANCE uses claude-code standalone naming", () => {
    expect(BASH_GUIDANCE).toContain("mcp__open-context-mode__open_ctx_batch_execute");
  });

  it("EXTERNAL_MCP_GUIDANCE uses claude-code standalone naming and matches the factory (#529)", () => {
    expect(EXTERNAL_MCP_GUIDANCE).toContain("mcp__open-context-mode__open_ctx_execute");
    expect(EXTERNAL_MCP_GUIDANCE).toContain("mcp__open-context-mode__open_ctx_fetch_and_index");
    expect(EXTERNAL_MCP_GUIDANCE).toContain("mcp__open-context-mode__open_ctx_search");
    // Drift guard: static export must equal factory output with default (claude-code) namer.
    const claudeCodeT = createToolNamer("claude-code");
    expect(EXTERNAL_MCP_GUIDANCE).toBe(createExternalMcpGuidance(claudeCodeT));
  });
});

// ═══════════════════════════════════════════════════════════════════
// routePreToolUse with Platform Parameter
// ═══════════════════════════════════════════════════════════════════

describe("routePreToolUse with platform parameter", () => {
  it("curl block message uses gemini-cli tool names when platform=gemini-cli", () => {
    const result = routePreToolUse("Bash", { command: "curl https://example.com" }, "/tmp", "gemini-cli");
    expect(result).not.toBeNull();
    expect(result!.action).toBe("modify");
    const cmd = (result!.updatedInput as Record<string, string>).command;
    expect(cmd).toContain("mcp__open-context-mode__open_ctx_fetch_and_index");
    expect(cmd).toContain("mcp__open-context-mode__open_ctx_execute");
    expect(cmd).not.toContain("mcp__plugin_open-context-mode_open-context-mode__");
  });

  it("curl block message uses claude-code standalone tool names when platform is omitted", () => {
    // No CLAUDE_PLUGIN_ROOT in test env → standalone prefix mcp__open-context-mode__.
    const result = routePreToolUse("Bash", { command: "curl https://example.com" }, "/tmp");
    expect(result).not.toBeNull();
    const cmd = (result!.updatedInput as Record<string, string>).command;
    expect(cmd).toContain("mcp__open-context-mode__open_ctx_fetch_and_index");
    expect(cmd).not.toContain("mcp__plugin_open-context-mode_open-context-mode__");
  });

  it("inline HTTP block uses cursor bare names when platform=cursor", () => {
    const result = routePreToolUse(
      "Bash",
      {
        command: "python -c \"requests.get('http://example.com')\"",
      },
      "/tmp",
      "cursor",
    );
    expect(result).not.toBeNull();
    const cmd = (result!.updatedInput as Record<string, string>).command;
    expect(cmd).toContain("open_ctx_execute");
    // PR #683 follow-up (ADR-0003 amendment): "Think in Code" voice-of-trainer
    // marker was folded into the imperative call instruction. The deny reason
    // now opens with the affirmative redirect frame; assert on the explicit
    // open_ctx_execute call instruction that survived the rewrite.
    expect(cmd).toContain("Call open_ctx_execute");
    expect(cmd).not.toContain("mcp__");
  });

  it("WebFetch deny uses kiro tool names when platform=kiro", () => {
    const result = routePreToolUse("WebFetch", { url: "https://example.com" }, "/tmp", "kiro");
    expect(result).not.toBeNull();
    expect(result!.action).toBe("deny");
    expect(result!.reason).toContain("@open-context-mode/open_ctx_fetch_and_index");
    expect(result!.reason).toContain("@open-context-mode/open_ctx_search");
  });

  it("Task is no longer routed — returns null (#241)", () => {
    const result = routePreToolUse(
      "Task",
      {
        prompt: "Analyze the code",
      },
      "/tmp",
      "opencode",
    );
    expect(result).toBeNull();
  });

  it("Read guidance uses vscode-copilot tool names when platform=vscode-copilot", () => {
    const result = routePreToolUse("Read", { file_path: "/tmp/a.ts" }, "/tmp", "vscode-copilot");
    expect(result).not.toBeNull();
    expect(result!.action).toBe("context");
    expect(result!.additionalContext).toContain("open-context-mode_open_ctx_execute_file");
    expect(result!.additionalContext).not.toContain("mcp__plugin_open-context-mode_open-context-mode__");
  });

  it("Grep guidance uses zed tool names when platform=zed", () => {
    const result = routePreToolUse("Grep", { pattern: "TODO" }, "/tmp", "zed");
    expect(result).not.toBeNull();
    expect(result!.action).toBe("context");
    expect(result!.additionalContext).toContain("mcp:open-context-mode:open_ctx_execute");
  });

  it("Bash guidance uses openclaw bare names when platform=openclaw", () => {
    // Use an unbounded command so the #463 structurally-bounded allowlist
    // does not short-circuit the guidance — this test is about platform
    // tool-naming inside the guidance, not allowlist behavior.
    const result = routePreToolUse("Bash", { command: "npm install" }, "/tmp", "openclaw");
    expect(result).not.toBeNull();
    expect(result!.action).toBe("context");
    expect(result!.additionalContext).toContain("open_ctx_batch_execute");
    expect(result!.additionalContext).toContain("open_ctx_execute");
    expect(result!.additionalContext).not.toContain("mcp__");
  });

  it("OpenClaw lowercase native tools route through canonical aliases", () => {
    const exec = routePreToolUse("exec", { command: "npm install" }, "/tmp", "openclaw");
    expect(exec).not.toBeNull();
    expect(exec!.action).toBe("context");
    expect(exec!.additionalContext).toContain("open_ctx_batch_execute");

    const read = routePreToolUse("read", { file_path: "/tmp/a.ts" }, "/tmp", "openclaw");
    expect(read).not.toBeNull();
    expect(read!.action).toBe("context");
    expect(read!.additionalContext).toContain("open_ctx_execute_file");

    const search = routePreToolUse("search", { pattern: "TODO" }, "/tmp", "openclaw");
    expect(search).not.toBeNull();
    expect(search!.action).toBe("context");
    expect(search!.additionalContext).toContain("open_ctx_execute");
  });

  it("Read guidance uses agy open-context-mode/<tool> names when platform=antigravity-cli", () => {
    resetGuidanceThrottle();
    const result = routePreToolUse("view_file", { AbsolutePath: "/tmp/a.ts" }, "/tmp", "antigravity-cli");
    expect(result).not.toBeNull();
    expect(result!.action).toBe("context");
    expect(result!.additionalContext).toContain("open-context-mode/open_ctx_execute_file");
    expect(result!.additionalContext).not.toContain("mcp__open-context-mode__open_ctx_execute_file");
  });

  it("build tool redirect uses platform tool names when platform=gemini-cli", () => {
    const result = routePreToolUse("Bash", { command: "./gradlew build" }, "/tmp", "gemini-cli");
    expect(result).not.toBeNull();
    expect(result!.action).toBe("modify");
    const cmd = (result!.updatedInput as Record<string, string>).command;
    expect(cmd).toContain("mcp__open-context-mode__open_ctx_execute");
    expect(cmd).not.toContain("mcp__plugin_open-context-mode_open-context-mode__");
  });

  // ─── SLICE Qwen-3: routing.mjs Qwen native names ───
  describe("Qwen Code native tool names route through canonical aliases", () => {
    it("run_shell_command + curl routes as Bash → modify (curl block)", () => {
      const result = routePreToolUse("run_shell_command", { command: "curl https://example.com" }, "/tmp", "qwen-code");
      expect(result).not.toBeNull();
      expect(result!.action).toBe("modify");
      expect((result!.updatedInput as Record<string, string>).command).toContain("curl/wget redirected");
    });

    it("web_fetch routes as WebFetch → deny", () => {
      const result = routePreToolUse("web_fetch", { url: "https://example.com" }, "/tmp", "qwen-code");
      expect(result).not.toBeNull();
      expect(result!.action).toBe("deny");
      expect(result!.reason).toContain("WebFetch redirected");
    });

    it("read_file routes as Read → context guidance", () => {
      const result = routePreToolUse("read_file", { file_path: "/tmp/a.ts" }, "/tmp", "qwen-code");
      expect(result).not.toBeNull();
      expect(result!.action).toBe("context");
      expect(result!.additionalContext).toContain("open_ctx_execute_file");
    });

    it("grep_search routes as Grep → context guidance", () => {
      const result = routePreToolUse("grep_search", { pattern: "TODO" }, "/tmp", "qwen-code");
      expect(result).not.toBeNull();
      expect(result!.action).toBe("context");
    });
  });
});
