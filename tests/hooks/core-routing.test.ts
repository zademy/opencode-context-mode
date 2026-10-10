import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync, unlinkSync, existsSync, readdirSync, readFileSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { sentinelDir, sentinelPathForPid, isMCPReady } from "../../hooks/core/mcp-ready.mjs";

// Dynamic import for .mjs module
let routePreToolUse: (
  toolName: string,
  toolInput: Record<string, unknown>,
  projectDir?: string,
  platform?: string,
  sessionId?: string,
  options?: { mcpToolsAvailable?: boolean; isSubagentContext?: boolean },
) => {
  action: string;
  reason?: string;
  updatedInput?: Record<string, unknown>;
  additionalContext?: string;
  redirectMeta?: { tool: string; type: string; bytesAvoided: number; commandSummary: string };
} | null;

let resetGuidanceThrottle: (sessionId?: string) => void;
let initSecurity: (buildDir: string) => Promise<boolean>;
let ROUTING_BLOCK: string;
let createRoutingBlock: (t: any, options?: { includeCommands?: boolean; toolSearchBootstrap?: boolean }) => string;
let READ_GUIDANCE: string;
let GREP_GUIDANCE: string;

beforeAll(async () => {
  const mod = await import("../../hooks/core/routing.mjs");
  routePreToolUse = mod.routePreToolUse;
  resetGuidanceThrottle = mod.resetGuidanceThrottle;
  initSecurity = mod.initSecurity;

  const constants = await import("../../hooks/routing-block.mjs");
  ROUTING_BLOCK = constants.ROUTING_BLOCK;
  createRoutingBlock = constants.createRoutingBlock;
  READ_GUIDANCE = constants.READ_GUIDANCE;
  GREP_GUIDANCE = constants.GREP_GUIDANCE;
});

// MCP readiness sentinel — most tests expect MCP to be ready (deny behavior).
// Tests for graceful degradation (#230) remove sentinel explicitly.
//
// Use an isolated temp dir for sentinels so the directory scan in isMCPReady()
// is not polluted by leftover sentinels from real MCP servers running on the
// developer's machine. The hook honors OPEN_CONTEXT_MODE_MCP_SENTINEL_DIR.
const _sentinelDir = mkdtempSync(join(tmpdir(), "open_ctx-test-sentinels-"));
process.env.OPEN_CONTEXT_MODE_MCP_SENTINEL_DIR = _sentinelDir;
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

afterAll(() => {
  try {
    rmSync(_sentinelDir, { recursive: true, force: true });
  } catch {}
  delete process.env.OPEN_CONTEXT_MODE_MCP_SENTINEL_DIR;
});

describe("routePreToolUse", () => {
  // ─── Bash routing ──────────────────────────────────────

  describe("Bash tool", () => {
    it("denies curl commands with modify action", () => {
      const result = routePreToolUse("Bash", {
        command: "curl https://example.com",
      });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("modify");
      expect(result!.updatedInput).toBeDefined();
      const cmd = (result!.updatedInput as Record<string, string>).command;
      expect(cmd).toContain("curl/wget redirected");
      expect(cmd).not.toContain("curl/wget blocked");
      expect(cmd).toMatch(/retry/i);
    });

    it("denies Codex exec_command cmd payloads like Bash command payloads", () => {
      const result = routePreToolUse("exec_command", { cmd: "curl https://example.com" }, undefined, "codex", "codex-cmd-curl");
      expect(result).not.toBeNull();
      expect(result!.action).toBe("modify");
      expect((result!.updatedInput as Record<string, string>).command).toContain("curl/wget redirected");
    });

    it("denies agy run_command CommandLine payloads like Bash command payloads", () => {
      const result = routePreToolUse(
        "run_command",
        { CommandLine: "curl https://example.com" },
        undefined,
        "antigravity-cli",
        "agy-commandline-curl",
      );
      expect(result).not.toBeNull();
      expect(result!.action).toBe("modify");
      expect((result!.updatedInput as Record<string, string>).command).toContain("curl/wget redirected");
    });

    it("routes PowerShell command payloads like Bash command payloads", () => {
      const result = routePreToolUse("PowerShell", { command: "curl https://example.com" }, undefined, "claude-code", "powershell-curl");
      expect(result).not.toBeNull();
      expect(result!.action).toBe("modify");
      expect((result!.updatedInput as Record<string, string>).command).toContain("curl/wget redirected");
    });
    it("denies wget commands with modify action", () => {
      const result = routePreToolUse("Bash", {
        command: "wget https://example.com/file.tar.gz",
      });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("modify");
      expect((result!.updatedInput as Record<string, string>).command).toContain("curl/wget redirected");
    });

    // ─── quote scanning: an apostrophe must not desynchronise the stripper ────────────
    // stripQuotedContent ran two independent global replaces -- every '...' pair first,
    // then every "..." pair. That is only correct when the two kinds never interleave.
    // An apostrophe inside a double-quoted string pairs with the next unrelated ' in a
    // later argument, and collapsing that span eats both the closing " of the message and
    // the opening " of the following string. The message's own opening " is then left
    // unpaired, so its body survives into the gate as if it were bare shell -- and when
    // the prose happens to mention curl or wget, the command is redirected and never runs.
    //
    // Same class as #63, which those two replaces were added to fix; they just do not
    // survive interleaving. Prose apostrophes ("don't", "it's", "the linter's") make
    // commit and tag messages hit this routinely.

    it("does not treat a tag message containing an apostrophe and curl as a curl call", () => {
      // Fails against the two-replace implementation: it leaves
      //   ... -m "the client -- curl for the header, the linter''v1''%H'
      // with curl space-preceded and outside any quote.
      const result = routePreToolUse("Bash", {
        command:
          `git tag -a v1 -m "the client -- curl for the header, the linter's fixtures" ` +
          `&& echo "x $(git tag -l 'v1')" && git show --format='%H'`,
      });
      expect(JSON.stringify(result ?? {})).not.toContain("curl/wget redirected");
    });

    it("still redirects a genuine curl that follows an unterminated apostrophe", () => {
      // Guards the new scanner rather than the old bug: an apostrophe that never closes
      // is prose, not a string, so it must not swallow the rest of the line -- otherwise
      // a real invocation after it would go unseen.
      const result = routePreToolUse("Bash", {
        command: "echo it's fine && curl -sS https://example.com",
      });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("modify");
    });

    // ─── curl/wget file-output allow-list (#166) ────────────

    it("allows curl -sLo file (silent + file output)", () => {
      const result = routePreToolUse("Bash", {
        command: "curl -sL https://example.com/file.tar.gz -o /tmp/file.tar.gz",
      });
      expect(result).toBeNull(); // null = allow through
    });

    it("allows curl -s --output file", () => {
      const result = routePreToolUse("Bash", {
        command: "curl -s --output /tmp/stripe.tar.gz https://github.com/stripe/stripe-cli/releases/download/v1.38.1/stripe.tar.gz",
      });
      expect(result).toBeNull();
    });

    it("allows wget -q -O file (quiet + file output)", () => {
      const result = routePreToolUse("Bash", {
        command: "wget -q -O /tmp/terraform.zip https://releases.hashicorp.com/terraform/1.0.0/terraform_1.0.0_linux_amd64.zip",
      });
      expect(result).toBeNull();
    });
    it("allows Codex home search when MCP tools are unavailable", () => {
      try {
        unlinkSync(mcpSentinel);
      } catch {}
      const result = routePreToolUse(
        "exec_command",
        { cmd: "rg -n model ~/.codex -g '*.json*'" },
        "/workspace",
        "codex",
        "codex-home-search-no-mcp",
      );
      // Fork adaptation: without a sentinel the redirect is suppressed, but
      // the generic Bash guidance still fires (upstream expected null because
      // its fall-through emits nothing for this shape). The contract pinned
      // here is the #1084 one: no deny redirect without open_ctx_* availability.
      expect(result?.action).not.toBe("deny");
    });

    it("allows curl -s > file (silent + shell redirect)", () => {
      const result = routePreToolUse("Bash", {
        command: "curl -s https://example.com/data.json > /tmp/data.json",
      });
      expect(result).toBeNull();
    });

    it("blocks curl -o - (stdout alias)", () => {
      const result = routePreToolUse("Bash", {
        command: "curl -s -o - https://example.com",
      });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("modify");
    });

    it("blocks curl -o file WITHOUT silent flag", () => {
      const result = routePreToolUse("Bash", {
        command: "curl -L -o /tmp/file.tar.gz https://example.com/file.tar.gz",
      });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("modify");
    });

    it("blocks curl -o file with --verbose", () => {
      const result = routePreToolUse("Bash", {
        command: "curl -s --verbose -o /tmp/file.tar.gz https://example.com/file.tar.gz",
      });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("modify");
    });

    it("blocks chained: curl -sLo file && curl url (second floods)", () => {
      const result = routePreToolUse("Bash", {
        command: "curl -sL -o /tmp/file.tar.gz https://example.com/a.tar.gz && curl https://example.com/api",
      });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("modify");
    });

    it("allows chained: curl -sLo file && tar xzf file (both safe)", () => {
      const result = routePreToolUse("Bash", {
        command: "curl -sL -o /tmp/file.tar.gz https://example.com/a.tar.gz && tar xzf /tmp/file.tar.gz -C /tmp",
      });
      expect(result).toBeNull();
    });

    // ─── curl/wget command-position guard (#679) ────────────
    // "curl"/"wget" mentioned as someone else's argument, or inside a
    // comment, is not an invocation and must pass through untouched.

    it("allows curl mentioned as a grep pattern, not invoked", () => {
      const result = routePreToolUse("Bash", {
        command: "grep -rn curl ./scripts",
      });
      expect(result).toBeNull();
    });

    it("allows curl mentioned inside a trailing shell comment", () => {
      const result = routePreToolUse("Bash", {
        command: "cat notes.md # notes.md talks about curl usage",
      });
      expect(result).toBeNull();
    });

    it("allows curl mentioned on a comment-only line", () => {
      const result = routePreToolUse("Bash", {
        command: "# uses curl internally\nls",
      });
      expect(result).toBeNull();
    });

    it("allows curl --version (metadata probe, no fetch)", () => {
      const result = routePreToolUse("Bash", {
        command: "curl --version",
      });
      expect(result).toBeNull();
    });

    it("allows wget --version (metadata probe, no fetch)", () => {
      const result = routePreToolUse("Bash", {
        command: "wget --version",
      });
      expect(result).toBeNull();
    });

    it("still blocks a real curl invocation on the command line", () => {
      const result = routePreToolUse("Bash", {
        command: "curl https://example.com",
      });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("modify");
    });

    it("still blocks curl wrapped in sudo", () => {
      const result = routePreToolUse("Bash", {
        command: "sudo curl https://evil.example.com",
      });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("modify");
    });

    it("still blocks a chained real wget invocation after `;`", () => {
      const result = routePreToolUse("Bash", {
        command: "true; wget https://evil.example.com",
      });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("modify");
    });

    it("denies inline fetch() with modify action", () => {
      const result = routePreToolUse("Bash", {
        command: "node -e \"fetch('https://api.example.com/data')\"",
      });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("modify");
      const cmd = (result!.updatedInput as Record<string, string>).command;
      expect(cmd).toContain("Inline HTTP redirected");
      expect(cmd).not.toContain("Inline HTTP blocked");
      expect(cmd).toMatch(/retry/i);
    });

    it("denies requests.get() with modify action", () => {
      const result = routePreToolUse("Bash", {
        command: "python -c \"import requests; requests.get('https://example.com')\"",
      });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("modify");
      expect((result!.updatedInput as Record<string, string>).command).toContain("Inline HTTP redirected");
    });

    it("git status — bypassed by structurally-bounded allowlist (#463)", () => {
      // Pre-#463: this returned BASH_GUIDANCE context. The #463 allowlist
      // now short-circuits the nudge for read-only git subcommands so the
      // guidance reads as signal, not noise.
      const result = routePreToolUse("Bash", { command: "git status" });
      expect(result).toBeNull();
    });

    it("mkdir — bypassed by structurally-bounded allowlist (#463)", () => {
      const result = routePreToolUse("Bash", {
        command: "mkdir -p /tmp/test-dir",
      });
      expect(result).toBeNull();
    });

    it("allows npm install with BASH_GUIDANCE context", () => {
      const result = routePreToolUse("Bash", { command: "npm install" });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("context");
    });

    it("redirects ./gradlew build to execute sandbox", () => {
      const result = routePreToolUse("Bash", {
        command: "./gradlew build",
      });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("modify");
      expect((result!.updatedInput as Record<string, string>).command).toContain("Build tool redirected");
    });

    it("redirects gradle test to execute sandbox", () => {
      const result = routePreToolUse("Bash", {
        command: "gradle test --info",
      });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("modify");
    });

    it("redirects mvn package to execute sandbox", () => {
      const result = routePreToolUse("Bash", {
        command: "mvn clean package -DskipTests",
      });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("modify");
    });

    it("redirects ./mvnw verify to execute sandbox", () => {
      const result = routePreToolUse("Bash", {
        command: "./mvnw verify",
      });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("modify");
    });

    it("does not false-positive on gradle in quoted text", () => {
      // Use a command whose first word is NOT in the #463 structurally-bounded
      // allowlist (`echo` is allowlisted), so we still exercise the
      // strip-quotes-then-match-gradle path. The intent is to prove the
      // gradle build-tool redirect doesn't fire on quoted occurrences.
      const result = routePreToolUse("Bash", {
        command: 'find . -name "run gradle build to compile"',
      });
      expect(result).not.toBeNull();
      // stripped version removes quoted content → no gradle match → context
      expect(result!.action).toBe("context");
    });

    // Issue #406 — sbt added alongside gradle/maven
    it("redirects sbt compile to execute sandbox (Issue #406)", () => {
      const result = routePreToolUse("Bash", {
        command: "sbt compile",
      });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("modify");
      expect((result!.updatedInput as Record<string, string>).command).toContain("Build tool redirected");
    });

    it("redirects ./sbt test to execute sandbox", () => {
      const result = routePreToolUse("Bash", {
        command: "./sbt test",
      });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("modify");
    });

    it("does not false-positive on substrings like gradle-wrapper-config or mvnDocker", () => {
      // Word-boundary guard — these are NOT gradle/mvn invocations.
      const r1 = routePreToolUse("Bash", { command: "ls gradle-wrapper-config" });
      expect(r1?.action).not.toBe("modify");
      const r2 = routePreToolUse("Bash", { command: "echo mvnDocker-image" });
      // Quoted/echo passes context, not modify
      expect(r2?.action).not.toBe("modify");
    });
  });

  describe("Codex home search routing", () => {
    beforeAll(async () => {
      expect(await initSecurity(resolve(process.cwd(), "build"))).toBe(true);
    });

    it("redirects the recursive root search from the reported incident", () => {
      const result = routePreToolUse(
        "exec_command",
        { cmd: "rg -n model ~/.codex -g '*.json*'" },
        "/workspace",
        "codex",
        "codex-home-search-root",
      );

      expect(result?.action).toBe("deny");
      expect(result?.reason?.startsWith("open-context-mode: redirected to open_ctx_execute for a bounded Codex home search.")).toBe(true);
      expect(result?.reason?.endsWith("Retry the same search on a transient filesystem error (EBUSY, EMFILE, ENFILE).")).toBe(true);
    });

    it.each([
      "grep -R model ~/.codex",
      "find ~/.codex -name '*.json*'",
      "/usr/bin/rg -n model ~/.codex/",
      "/usr/bin/env rg -n model ~/.codex",
      "time -f %E rg -n model ~/.codex",
      'command rg -n model "$HOME/.codex"',
      "LC_ALL=C rg -n model ${CODEX_HOME}",
      "find -L ~/.codex -name '*.json*'",
      "find -O3 ~/.codex -name '*.json*'",
      "find -- ~/.codex -name '*.json*'",
      "rg --files ~/.codex",
      "rg -f patterns.txt ~/.codex",
    ])("redirects a broad Codex home search: %s", (command) => {
      const result = routePreToolUse("exec_command", { cmd: command }, "/workspace", "codex", "codex-home-search-reader");
      expect(result?.action).toBe("deny");
    });

    it("uses the effective relocated CODEX_HOME", () => {
      const previous = process.env.CODEX_HOME;
      const relocatedHome = join(tmpdir(), "custom-codex-home");
      process.env.CODEX_HOME = relocatedHome;
      try {
        const relocated = routePreToolUse(
          "exec_command",
          { cmd: `rg -n model "${relocatedHome}"` },
          "/workspace",
          "codex",
          "codex-home-search-relocated",
        );
        const inactiveDefault = routePreToolUse(
          "exec_command",
          { cmd: "rg -n model ~/.codex" },
          "/workspace",
          "codex",
          "codex-home-search-inactive-default",
        );
        expect(relocated?.action).toBe("deny");
        expect(inactiveDefault?.action).not.toBe("deny");
      } finally {
        if (previous == null) delete process.env.CODEX_HOME;
        else process.env.CODEX_HOME = previous;
      }
    });

    it("normalizes Windows CODEX_HOME identity case-insensitively", () => {
      const previous = process.env.CODEX_HOME;
      process.env.CODEX_HOME = "C:\\Users\\Tester\\.codex";
      try {
        const result = routePreToolUse(
          "exec_command",
          { cmd: "rg -n model c:\\users\\tester\\.codex" },
          "C:\\workspace",
          "codex",
          "codex-home-search-windows",
        );
        expect(result?.action).toBe("deny");
      } finally {
        if (previous == null) delete process.env.CODEX_HOME;
        else process.env.CODEX_HOME = previous;
      }
    });

    it("preserves non-root paths, other platforms, and child contexts", () => {
      const cases = [
        routePreToolUse("exec_command", { cmd: "rg -n model ~/.codex/config.toml" }, "/workspace", "codex", "codex-home-search-config"),
        routePreToolUse(
          "exec_command",
          { cmd: "rg -n model ~/.codex -g '*.json*'" },
          "/workspace",
          "claude-code",
          "codex-home-search-other-platform",
        ),
        routePreToolUse("exec_command", { cmd: "rg -n model ~/.codex -g '*.json*'" }, "/workspace", "codex", "codex-home-search-child", {
          isSubagentContext: true,
        }),
        routePreToolUse(
          "exec_command",
          {
            cmd: "gh issue create --body " + "\"Repro: rg -n model ~/.codex -g '*.json*'\"",
          },
          "/workspace",
          "codex",
          "codex-home-search-evidence",
        ),
      ];

      for (const result of cases) expect(result?.action).not.toBe("deny");
    });
  });

  // ─── Read routing ──────────────────────────────────────

  describe("Read tool", () => {
    it("returns context action with READ_GUIDANCE", () => {
      const result = routePreToolUse("Read", {
        file_path: "/some/file.ts",
      });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("context");
      expect(result!.additionalContext).toBe(READ_GUIDANCE);
    });

    it("treats agy view_file AbsolutePath payloads as Read", () => {
      resetGuidanceThrottle("agy-view-file");
      const result = routePreToolUse("view_file", { AbsolutePath: "/some/file.ts" }, undefined, "antigravity-cli", "agy-view-file");
      expect(result).not.toBeNull();
      expect(result!.action).toBe("context");
      expect(result!.additionalContext).toContain("open_ctx_execute_file");
    });
  });

  // ─── Grep routing ──────────────────────────────────────

  describe("Grep tool", () => {
    it("returns context action with GREP_GUIDANCE", () => {
      const result = routePreToolUse("Grep", {
        pattern: "TODO",
        path: "/some/dir",
      });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("context");
      expect(result!.additionalContext).toBe(GREP_GUIDANCE);
    });
  });

  // ─── WebFetch routing ──────────────────────────────────

  describe("WebFetch tool", () => {
    it("returns deny action with redirect message", () => {
      const result = routePreToolUse("WebFetch", {
        url: "https://docs.example.com",
        prompt: "Get the docs",
      });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("deny");
      // PR #654 substitute: imperative-positive framing, no "blocked" wording,
      // explicit retry hint to keep Haiku-tier agents from capitulating to
      // training data on transient DNS errors (audit Probe 3).
      expect(result!.reason).toContain("WebFetch redirected");
      expect(result!.reason).not.toContain("WebFetch blocked");
      expect(result!.reason).toContain("fetch_and_index");
      expect(result!.reason).toMatch(/retry/i);
    });

    it("includes the URL in deny reason", () => {
      const url = "https://api.github.com/repos/test";
      const result = routePreToolUse("WebFetch", { url });
      expect(result).not.toBeNull();
      expect(result!.reason).toContain(url);
    });

    it("passes claude.ai Artifact URLs through untouched (#938)", () => {
      const url = "https://claude.ai/code/artifact/51de1b8d-61cb-488e-a964-547ef217f5e9";
      const result = routePreToolUse("WebFetch", { url });
      // Native WebFetch fetches these using the caller's authenticated
      // claude.ai session; open_ctx_fetch_and_index cannot (no session cookies)
      // and would only ever get back the empty SPA shell.
      expect(result).toBeNull();
    });

    it("passes preview.claude.ai Artifact URLs through untouched (#938)", () => {
      const url = "https://preview.claude.ai/code/artifact/51de1b8d-61cb-488e-a964-547ef217f5e9";
      const result = routePreToolUse("WebFetch", { url });
      expect(result).toBeNull();
    });

    it("still redirects non-artifact claude.ai URLs (#938)", () => {
      const result = routePreToolUse("WebFetch", { url: "https://claude.ai/settings" });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("deny");
    });

    it("still redirects a lookalike host, not just a substring match (#938)", () => {
      const result = routePreToolUse("WebFetch", {
        url: "https://claude.ai.evil.com/code/artifact/51de1b8d-61cb-488e-a964-547ef217f5e9",
      });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("deny");
    });

    it("still redirects a plain-http claude.ai Artifact URL (#938)", () => {
      const result = routePreToolUse("WebFetch", {
        url: "http://claude.ai/code/artifact/51de1b8d-61cb-488e-a964-547ef217f5e9",
      });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("deny");
    });

    it("treats agy read_url_content URL payloads as WebFetch", () => {
      const url = "https://example.com/docs";
      const result = routePreToolUse("read_url_content", { URL: url }, undefined, "antigravity-cli", "agy-read-url");
      expect(result).not.toBeNull();
      expect(result!.action).toBe("deny");
      expect(result!.reason).toContain(url);
      // agy's call surface is open-context-mode/<tool> (see hooks/core/tool-naming.mjs),
      // not Claude's mcp__open-context-mode__<tool> form.
      expect(result!.reason).toContain("open-context-mode/open_ctx_fetch_and_index");
    });

    it("treats mcp_web_fetch as WebFetch and blocks it", () => {
      const url = "https://example.com";
      const result = routePreToolUse("mcp_web_fetch", { url });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("deny");
      expect(result!.reason).toContain("WebFetch redirected");
      expect(result!.reason).toContain("fetch_and_index");
      expect(result!.reason).toContain("open_ctx_search");
    });

    it("treats mcp_fetch_tool as WebFetch and blocks it", () => {
      const url = "https://example.com";
      const result = routePreToolUse("mcp_fetch_tool", { url });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("deny");
      expect(result!.reason).toContain("WebFetch redirected");
      expect(result!.reason).toContain("fetch_and_index");
      expect(result!.reason).toContain("open_ctx_search");
    });

    it("allows WebFetch when MCP server not ready (#230)", () => {
      // Remove sentinel to simulate MCP not started
      try {
        unlinkSync(mcpSentinel);
      } catch {}
      const result = routePreToolUse("WebFetch", { url: "https://example.com" });
      expect(result).toBeNull();
    });

    it("allows mcp_web_fetch alias when MCP server not ready (#230)", () => {
      try {
        unlinkSync(mcpSentinel);
      } catch {}
      const result = routePreToolUse("mcp_web_fetch", { url: "https://example.com" });
      expect(result).toBeNull();
    });

    it("passes WebFetch through when the caller context cannot invoke open_ctx_* tools (#794)", () => {
      const result = routePreToolUse("WebFetch", { url: "https://example.com" }, undefined, "claude-code", "subagent-webfetch", {
        mcpToolsAvailable: false,
      });
      expect(result).toBeNull();
    });

    it("keeps WebFetch redirected when options are omitted", () => {
      const result = routePreToolUse("WebFetch", { url: "https://example.com" }, undefined, "claude-code", "main-webfetch-default-options");
      expect(result).not.toBeNull();
      expect(result!.action).toBe("deny");
      expect(result!.reason).toContain("open_ctx_fetch_and_index");
    });

    it("treats opencode webfetch as WebFetch and blocks it (#1052)", () => {
      const url = "https://example.com";
      const result = routePreToolUse("webfetch", { url }, undefined, "opencode", "opencode-webfetch");
      expect(result).not.toBeNull();
      expect(result!.action).toBe("deny");
      expect(result!.reason).toContain("WebFetch redirected");
      expect(result!.reason).toContain("fetch_and_index");
      expect(result!.reason).toContain("open_ctx_search");
    });
  });

  // ─── MCP readiness: all redirects degrade gracefully (#230) ───

  describe("MCP readiness graceful degradation (#230)", () => {
    it("allows curl when MCP server not ready", () => {
      try {
        unlinkSync(mcpSentinel);
      } catch {}
      const result = routePreToolUse("Bash", { command: "curl https://example.com" });
      expect(result).toBeNull();
    });

    it("allows inline HTTP when MCP server not ready", () => {
      try {
        unlinkSync(mcpSentinel);
      } catch {}
      const result = routePreToolUse("Bash", { command: "node -e \"fetch('https://example.com')\"" });
      expect(result).toBeNull();
    });

    it("allows build tools when MCP server not ready", () => {
      try {
        unlinkSync(mcpSentinel);
      } catch {}
      const result = routePreToolUse("Bash", { command: "./gradlew build" });
      expect(result).toBeNull();
    });

    it("allows MCP-backed redirects when the caller context cannot invoke open_ctx_* tools", () => {
      const cases = [
        ["Bash", { command: "curl https://example.com" }],
        ["Bash", { command: "node -e \"fetch('https://example.com')\"" }],
        ["Bash", { command: "./gradlew build" }],
        ["WebFetch", { url: "https://example.com" }],
      ] as const;

      for (const [tool, input] of cases) {
        const result = routePreToolUse(tool, input, undefined, "claude-code", `subagent-${tool}`, { mcpToolsAvailable: false });
        expect(result).toBeNull();
      }
    });
  });

  // ─── Subagent open_ctx_commands omission (#233) ──────────────

  describe("Subagent open_ctx_commands omission (#233)", () => {
    let prevSubagentRouting: string | undefined;
    beforeEach(() => {
      prevSubagentRouting = process.env.OPEN_CONTEXT_MODE_SUBAGENT_ROUTING;
      delete process.env.OPEN_CONTEXT_MODE_SUBAGENT_ROUTING;
    });
    afterEach(() => {
      if (prevSubagentRouting === undefined) delete process.env.OPEN_CONTEXT_MODE_SUBAGENT_ROUTING;
      else process.env.OPEN_CONTEXT_MODE_SUBAGENT_ROUTING = prevSubagentRouting;
    });

    it("Agent subagent prompt omits open_ctx_commands", () => {
      const result = routePreToolUse("Agent", {
        prompt: "Search the codebase",
        subagent_type: "general-purpose",
      });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("modify");
      const prompt = (result!.updatedInput as Record<string, string>).prompt;
      expect(prompt).not.toContain("<open_ctx_commands>");
      expect(prompt).toContain("<tool_selection_hierarchy>");
    });

    it("injects Claude Code Agent routing and ToolSearch bootstrap by default", () => {
      const result = routePreToolUse("Agent", {
        prompt: "Research this repository",
        subagent_type: "general-purpose",
      });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("modify");
      const prompt = (result!.updatedInput as Record<string, string>).prompt;
      expect(prompt).toContain("<context_window_protection>");
      expect(prompt).toContain("ToolSearch");
      expect(prompt).not.toContain("<open_ctx_commands>");
    });

    it("subagent block self-identifies as locally installed plugin (#967)", () => {
      const result = routePreToolUse("Agent", {
        prompt: "Research this repository",
        subagent_type: "general-purpose",
      });
      const prompt = (result!.updatedInput as Record<string, string>).prompt;
      expect(prompt).toContain("<provenance>");
      expect(prompt).toContain("user installed and enabled locally");
    });

    it("OPEN_CONTEXT_MODE_SUBAGENT_ROUTING=0 skips Agent prompt injection (#967)", () => {
      const prev = process.env.OPEN_CONTEXT_MODE_SUBAGENT_ROUTING;
      process.env.OPEN_CONTEXT_MODE_SUBAGENT_ROUTING = "0";
      try {
        const result = routePreToolUse("Agent", {
          prompt: "Research this repository",
          subagent_type: "general-purpose",
        });
        expect(result).toBeNull();
      } finally {
        if (prev === undefined) delete process.env.OPEN_CONTEXT_MODE_SUBAGENT_ROUTING;
        else process.env.OPEN_CONTEXT_MODE_SUBAGENT_ROUTING = prev;
      }
    });

    it.each(["false", "off", "no", "FALSE", " 0 "])(
      "OPEN_CONTEXT_MODE_SUBAGENT_ROUTING=%s also skips Agent prompt injection (#967)",
      (value) => {
        process.env.OPEN_CONTEXT_MODE_SUBAGENT_ROUTING = value;
        const result = routePreToolUse("Agent", {
          prompt: "Research this repository",
          subagent_type: "general-purpose",
        });
        expect(result).toBeNull();
      },
    );

    it("subagent block includes provenance but main-session ROUTING_BLOCK does not (#967)", () => {
      const result = routePreToolUse("Agent", {
        prompt: "Research this repository",
        subagent_type: "general-purpose",
      });
      const prompt = (result!.updatedInput as Record<string, string>).prompt;
      expect(prompt).toContain("<provenance>");
      expect(ROUTING_BLOCK).not.toContain("<provenance>");
    });

    it("ROUTING_BLOCK constant includes open_ctx_commands for main session", () => {
      expect(ROUTING_BLOCK).toContain("<open_ctx_commands>");
      expect(ROUTING_BLOCK).toContain("open-context-mode stats");
    });

    it("createRoutingBlock with includeCommands: false omits section", () => {
      const t = (name: string) => `mcp__test__${name}`;
      const block = createRoutingBlock(t, { includeCommands: false });
      expect(block).not.toContain("<open_ctx_commands>");
      expect(block).toContain("<tool_selection_hierarchy>");
    });

    // The open_ctx_upgrade tool and the `upgrade` command were removed in f086c3e.
    // The <open_ctx_commands> table outlived them and kept telling the model to
    // invoke a tool that no longer exists — dead instructions injected into
    // every main session. Nothing in the block may name it.
    it("never instructs the model to call the removed open_ctx_upgrade tool", () => {
      expect(ROUTING_BLOCK).not.toMatch(/ctx[ _-]?upgrade/i);
      const t = (name: string) => `mcp__test__${name}`;
      expect(createRoutingBlock(t)).not.toMatch(/ctx[ _-]?upgrade/i);
      expect(createRoutingBlock(t, { includeCommands: false })).not.toMatch(/ctx[ _-]?upgrade/i);
    });

    it("createRoutingBlock default includes open_ctx_commands", () => {
      const t = (name: string) => `mcp__test__${name}`;
      const block = createRoutingBlock(t);
      expect(block).toContain("<open_ctx_commands>");
    });
  });

  // ─── Task routing (#241: removed — substring matching catches TaskCreate etc.) ──

  describe("Task tool (#241)", () => {
    it("returns null (passthrough) — no longer intercepted", () => {
      const result = routePreToolUse("Task", {
        prompt: "Analyze the codebase",
        subagent_type: "general-purpose",
      });
      expect(result).toBeNull();
    });

    it("TaskCreate returns null (passthrough)", () => {
      const result = routePreToolUse("TaskCreate", {
        title: "my task",
      });
      expect(result).toBeNull();
    });

    it("TaskUpdate returns null (passthrough)", () => {
      const result = routePreToolUse("TaskUpdate", {
        id: "123",
        status: "done",
      });
      expect(result).toBeNull();
    });
  });

  // ─── MCP tools ─────────────────────────────────────────

  describe("MCP execute tools", () => {
    it("passes through non-shell execute", () => {
      const result = routePreToolUse("mcp__plugin_open-context-mode_open-context-mode__open_ctx_execute", {
        language: "javascript",
        code: "console.log('hello')",
      });
      expect(result).toBeNull();
    });

    it("passes through execute_file without security", () => {
      const result = routePreToolUse("mcp__plugin_open-context-mode_open-context-mode__open_ctx_execute_file", {
        path: "/some/file.log",
        language: "python",
        code: "print(len(FILE_CONTENT))",
      });
      expect(result).toBeNull();
    });

    it("passes through batch_execute without security", () => {
      const result = routePreToolUse("mcp__plugin_open-context-mode_open-context-mode__open_ctx_batch_execute", {
        commands: [{ label: "test", command: "ls -la" }],
        queries: ["file list"],
      });
      expect(result).toBeNull();
    });

    it("pins Claude Code open_ctx_execute shell cwd from hook projectDir (#756)", () => {
      const result = routePreToolUse(
        "mcp__plugin_open-context-mode_open-context-mode__open_ctx_execute",
        { language: "shell", code: "pwd" },
        "/worktree/repo",
        "claude-code",
      );
      expect(result?.action).toBe("modify");
      expect(result?.updatedInput).toEqual({
        language: "shell",
        code: "pwd",
        cwd: "/worktree/repo",
      });
    });

    it("pins Claude Code open_ctx_batch_execute cwd from hook projectDir (#756)", () => {
      const result = routePreToolUse(
        "mcp__plugin_open-context-mode_open-context-mode__open_ctx_batch_execute",
        { commands: [{ label: "branch", command: "git rev-parse --abbrev-ref HEAD" }] },
        "/worktree/repo",
        "claude-code",
      );
      expect(result?.action).toBe("modify");
      expect(result?.updatedInput).toEqual({
        commands: [{ label: "branch", command: "git rev-parse --abbrev-ref HEAD" }],
        cwd: "/worktree/repo",
      });
    });

    it("does not overwrite explicit open_ctx_execute cwd", () => {
      const result = routePreToolUse(
        "mcp__plugin_open-context-mode_open-context-mode__open_ctx_execute",
        { language: "shell", code: "pwd", cwd: "/explicit" },
        "/worktree/repo",
        "claude-code",
      );
      expect(result).toBeNull();
    });
  });

  describe("Codex open-context-mode MCP execute security", () => {
    let projectDir: string;

    beforeAll(async () => {
      await initSecurity(resolve(process.cwd(), "build"));
    });

    beforeEach(() => {
      projectDir = mkdtempSync(join(tmpdir(), "open_ctx-codex-routing-"));
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(join(projectDir, "opencode.json"), JSON.stringify({ permission: { bash: { "sudo *": "deny" } } }), "utf-8");
    });

    afterEach(() => {
      try {
        rmSync(projectDir, { recursive: true, force: true });
      } catch {}
    });

    it.each([
      ["open_ctx_execute", { language: "shell", code: "sudo whoami" }],
      ["mcp__other__open_ctx_execute", { language: "shell", code: "sudo whoami" }],
      ["open_ctx_execute_file", { path: "script.sh", language: "shell", code: "sudo whoami" }],
      ["mcp__other__open_ctx_execute_file", { path: "script.sh", language: "shell", code: "sudo whoami" }],
      ["open_ctx_batch_execute", { commands: [{ label: "bad", command: "sudo whoami" }] }],
      ["mcp__other__open_ctx_batch_execute", { commands: [{ label: "bad", command: "sudo whoami" }] }],
    ])("denies shell policy matches for %s", (toolName, toolInput) => {
      const result = routePreToolUse(toolName, toolInput, projectDir);
      expect(result?.action).toBe("deny");
      expect(result?.reason).toContain("deny pattern");
    });
  });

  // ─── Routing block content ──────────────────────────────

  describe("routing block content", () => {
    // Wording rewritten per ADR-0002 (PR #683 follow-up): the original tests
    // asserted negative framings (`NEVER use`, `NO …`, `NEVER inline`) that
    // failed the cross-LLM safety-bias rubric (#9) and the prompt-surface
    // forbidden-token contract in tests/core/server.test.ts. The new
    // assertions cover the same semantic intent expressed positively:
    //   - file writes go through the native Write/Edit tool
    //   - open_ctx_execute / open_ctx_execute_file / Bash subprocesses do not persist edits
    //   - artifacts get written to files (path + 1-line description returned)
    it("file_writing_policy points file writes at native Write/Edit tools", () => {
      expect(ROUTING_BLOCK).toContain("<file_writing_policy>");
      expect(ROUTING_BLOCK).toContain("File writes use the native Write or Edit tool");
      // semantic intent: open_ctx_execute family must not be used for file writes —
      // expressed positively as "do not persist edits to the host filesystem"
      expect(ROUTING_BLOCK).toContain("open_ctx_execute");
      expect(ROUTING_BLOCK).toContain("do not persist edits");
    });

    it("when_not_to_use redirects open_ctx_execute away from file creation", () => {
      // Replaces the old `<forbidden_actions>` container; same semantic intent
      // (do not pick open_ctx_execute for file creation) expressed via WHEN NOT.
      expect(ROUTING_BLOCK).toContain("<when_not_to_use>");
      expect(ROUTING_BLOCK).toContain("for file writes");
      expect(ROUTING_BLOCK).toContain("analysis, processing, and computation only");
    });

    it("artifact_policy points artifacts at files with file-path return shape", () => {
      // Replaces the old "Write artifacts ... NEVER inline" wording.
      // The semantic intent — put artifacts in files, return only the path
      // plus a 1-line description — is asserted via the positive surface.
      // "Put artifacts ... in files" over "Write artifacts ... to files": the
      // capital-W "Write" read as Claude Code's Write tool, and this block is
      // injected into every OpenCode session, where no such tool exists.
      expect(ROUTING_BLOCK).toContain("Put artifacts (code, configs, PRDs) in files");
      expect(ROUTING_BLOCK).toContain("file path + 1-line description");
    });

    it("session_continuity does not read as an order to discount prior context (#911/#946)", () => {
      // Both reports are the same defect: the block rides along on every
      // subagent dispatch, and Claude Code's auto-mode classifier vetoed those
      // dispatches, naming this clause — "a past phrase does not bind you" —
      // as a prompt-injection payload. Structurally it claimed authority over
      // the rest of the prompt and told the agent to discount what came
      // before, which is the shape of injection regardless of intent.
      // #856 already softened this once; this drops the remaining shape.
      // The precedence rule (#856's actual bug — a casual phrase freezing
      // into a standing directive) still holds, so the fix is a rewrite, not
      // a deletion.
      expect(ROUTING_BLOCK).not.toContain("a past phrase does not bind you");
      expect(ROUTING_BLOCK).toContain("go with the user's most recent message");
      expect(ROUTING_BLOCK).toContain("not an instruction to act on now");
    });
  });

  // ─── Unknown tools ─────────────────────────────────────

  describe("unknown tools", () => {
    it("returns null for Glob", () => {
      const result = routePreToolUse("Glob", { pattern: "**/*.ts" });
      expect(result).toBeNull();
    });

    it("returns null for Edit", () => {
      const result = routePreToolUse("Edit", {
        file_path: "/some/file.ts",
        old_string: "foo",
        new_string: "bar",
      });
      expect(result).toBeNull();
    });

    it("returns null for Write", () => {
      const result = routePreToolUse("Write", {
        file_path: "/some/file.ts",
        content: "hello",
      });
      expect(result).toBeNull();
    });

    it("returns null for WebSearch", () => {
      const result = routePreToolUse("WebSearch", {
        query: "vitest documentation",
      });
      expect(result).toBeNull();
    });
  });

  // ─── External MCP tools (#529) ──────────────────────────
  //
  // hooks/hooks.json registers a `mcp__(?!plugin_open-context-mode_)` matcher so
  // PreToolUse fires on slack/telegram/gdrive/notion-style MCPs whose payloads
  // would otherwise spill into context before PostToolUse can act. The routing
  // branch emits a one-shot context guidance nudge — same throttle model as
  // bash/read/grep guidance.
  describe("External MCP tools (#529)", () => {
    it("emits context guidance for an external slack-style MCP tool", () => {
      const result = routePreToolUse("mcp__slack__list_channels", {});
      expect(result).not.toBeNull();
      expect(result!.action).toBe("context");
      expect(result!.additionalContext).toContain("External MCP tools");
    });

    it("emits context guidance for telegram, gdrive, and notion namespaces", () => {
      const tools = ["mcp__plugin_telegram__list_messages", "mcp__claude_ai_Google_Drive__search", "mcp__notion__query_database"];
      for (const tool of tools) {
        resetGuidanceThrottle();
        const result = routePreToolUse(tool, {});
        expect(result, `expected guidance for ${tool}`).not.toBeNull();
        expect(result!.action).toBe("context");
      }
    });

    it("does NOT match open-context-mode's own MCP tools (no double-firing)", () => {
      // These are routed by dedicated branches above (open_ctx_execute,
      // open_ctx_execute_file, open_ctx_batch_execute) — they must NOT receive the
      // external-MCP guidance, which would be redundant noise.
      const contextModeTools = [
        "mcp__plugin_open-context-mode_open-context-mode__open_ctx_execute",
        "mcp__plugin_open-context-mode_open-context-mode__open_ctx_execute_file",
        "mcp__plugin_open-context-mode_open-context-mode__open_ctx_batch_execute",
        "mcp__open-context-mode__open_ctx_execute",
      ];
      for (const tool of contextModeTools) {
        resetGuidanceThrottle();
        const result = routePreToolUse(tool, { language: "javascript", code: "1+1" });
        // open_ctx_execute returns null (no security violation, no guidance).
        // The external-MCP branch must NOT have run for these.
        if (result !== null) {
          expect(result.additionalContext ?? "").not.toContain("External MCP tools");
        }
      }
    });

    // #567 follow-up — the external-MCP nudge is intentionally periodic, not
    // one-shot. A single nudge gets lost in MCP-heavy sessions (50+ Jira
    // calls) once context compaction kicks in, so we re-fire every N calls to
    // keep the guidance in the model's recent window.
    it("re-fires guidance every N calls (default cadence = 10)", () => {
      const calls = Array.from({ length: 22 }, (_, i) => routePreToolUse(`mcp__slack__tool_${i}`, {}));

      // Fires on the 1st, 11th, 21st calls — null in between.
      const fired = calls.map((c) => c?.action === "context");
      const expected = calls.map((_, i) => i % 10 === 0);
      expect(fired).toEqual(expected);
    });

    it("honors OPEN_CONTEXT_MODE_EXTERNAL_MCP_NUDGE_EVERY to tune cadence", () => {
      const prev = process.env.OPEN_CONTEXT_MODE_EXTERNAL_MCP_NUDGE_EVERY;
      try {
        process.env.OPEN_CONTEXT_MODE_EXTERNAL_MCP_NUDGE_EVERY = "3";
        const calls = Array.from({ length: 7 }, (_, i) => routePreToolUse(`mcp__notion__tool_${i}`, {}));
        const fired = calls.map((c) => c?.action === "context");
        // period=3 → fires on calls 1, 4, 7 (indices 0, 3, 6).
        expect(fired).toEqual([true, false, false, true, false, false, true]);
      } finally {
        if (prev === undefined) delete process.env.OPEN_CONTEXT_MODE_EXTERNAL_MCP_NUDGE_EVERY;
        else process.env.OPEN_CONTEXT_MODE_EXTERNAL_MCP_NUDGE_EVERY = prev;
      }
    });

    it("falls back to default cadence on invalid env values", () => {
      const prev = process.env.OPEN_CONTEXT_MODE_EXTERNAL_MCP_NUDGE_EVERY;
      try {
        // Out-of-range, NaN, negative — all coerce to the default (10).
        for (const v of ["0", "-1", "9999", "not-a-number", ""]) {
          process.env.OPEN_CONTEXT_MODE_EXTERNAL_MCP_NUDGE_EVERY = v;
          resetGuidanceThrottle();
          const first = routePreToolUse("mcp__slack__a", {});
          const second = routePreToolUse("mcp__slack__b", {});
          expect(first?.action, `value=${JSON.stringify(v)}`).toBe("context");
          // With default=10, the 2nd call must NOT fire.
          expect(second, `value=${JSON.stringify(v)}`).toBeNull();
        }
      } finally {
        if (prev === undefined) delete process.env.OPEN_CONTEXT_MODE_EXTERNAL_MCP_NUDGE_EVERY;
        else process.env.OPEN_CONTEXT_MODE_EXTERNAL_MCP_NUDGE_EVERY = prev;
      }
    });

    it("resetGuidanceThrottle resets the periodic counter", () => {
      // Burn one call to advance the counter.
      const first = routePreToolUse("mcp__slack__post_message", {});
      expect(first?.action).toBe("context");
      const second = routePreToolUse("mcp__slack__list_users", {});
      expect(second).toBeNull();

      // Reset clears both the in-memory throttle and the periodic counter so
      // the next call re-fires from tick 1 (e.g. start of a fresh session).
      resetGuidanceThrottle();
      const afterReset = routePreToolUse("mcp__slack__list_users", {});
      expect(afterReset?.action).toBe("context");
    });

    it("does NOT match plain Bash/Read/etc as external MCP", () => {
      // Sanity: tools without the mcp__ prefix should not hit this branch.
      // Use a tool name the routing branches don't otherwise handle (Bash
      // would return a guidance from its own branch).
      const result = routePreToolUse("Glob", { pattern: "**/*.ts" });
      expect(result).toBeNull();
    });

    it("treats external MCP tools whose tool part contains 'open-context-mode' as external", () => {
      // Guards against the substring-on-full-name false negative: only the
      // server segment (first chunk after the mcp__ prefix) is checked, so a
      // notion / slack / etc tool that happens to mention open-context-mode in its
      // tool name still receives the external-MCP guidance.
      const externals = ["mcp__notion__search_open-context-mode_notes", "mcp__slack__post_to_open-context-mode_channel"];
      for (const tool of externals) {
        resetGuidanceThrottle();
        const result = routePreToolUse(tool, {});
        expect(result, `expected guidance for ${tool}`).not.toBeNull();
        expect(result!.action).toBe("context");
        expect(result!.additionalContext).toContain("External MCP tools");
      }
    });

    it("does NOT trip on degenerate tool names (empty / bare prefix / null)", () => {
      // String() coerces these to non-MCP names — must pass through silently.
      for (const tool of ["", "mcp__", null as unknown as string, undefined as unknown as string]) {
        resetGuidanceThrottle();
        const result = routePreToolUse(tool, {});
        // Either null (passthrough) or NOT external-MCP guidance — never the
        // external-MCP branch.
        if (result !== null) {
          expect(result.additionalContext ?? "").not.toContain("External MCP tools");
        }
      }
    });
  });
});

// ─── mcp-ready.mjs regression matrix (#347 guard) ──────────────────────────
//
// PR #347 replaced the PPID-keyed sentinel lookup with a directory-scan over
// `<sentinelDir()>/open-context-mode-mcp-ready-*` files. These tests lock in the
// directory-scan contract so a future refactor cannot silently regress to a
// PPID-coupled lookup. The test runner's own sentinel (written by the
// file-level beforeEach above) is removed inside cleanup tests where its
// presence would mask dead-PID cleanup.

const SENTINEL_PREFIX = "open-context-mode-mcp-ready-";
const DEAD_PID = 2_147_483_647; // INT32_MAX — never a live PID on any platform

const fixtures = new Set<string>();
function createSentinel(pidOrLabel: number | string, content?: string): string {
  const path = join(sentinelDir(), `${SENTINEL_PREFIX}${pidOrLabel}`);
  writeFileSync(path, content ?? String(pidOrLabel));
  fixtures.add(path);
  return path;
}

// #844: isMCPReady() only cleans up a dead-PID sentinel once it is OLDER than
// the freshness window (a recently-refreshed sentinel may belong to a live
// server in another PID namespace). Age a sentinel past that window so the
// stale-cleanup path is exercised deterministically.
function ageSentinel(path: string): void {
  const tenMinAgoSec = Date.now() / 1000 - 600;
  utimesSync(path, tenMinAgoSec, tenMinAgoSec);
}

function hasUnrelatedLiveSentinel(): boolean {
  try {
    const dir = sentinelDir();
    for (const f of readdirSync(dir).filter((f) => f.startsWith(SENTINEL_PREFIX))) {
      try {
        const pid = parseInt(readFileSync(join(dir, f), "utf8"), 10);
        if (!Number.isNaN(pid) && pid !== process.pid) {
          process.kill(pid, 0);
          return true;
        }
      } catch {
        /* dead — ignore */
      }
    }
    return false;
  } catch {
    return false;
  }
}
const POLLUTED = hasUnrelatedLiveSentinel();

describe("mcp-ready: contract", () => {
  afterEach(() => {
    for (const p of fixtures) {
      try {
        unlinkSync(p);
      } catch {
        /* already gone */
      }
    }
    fixtures.clear();
  });

  it("sentinelPathForPid joins sentinelDir + prefix + pid", () => {
    expect(sentinelPathForPid(12345)).toBe(join(sentinelDir(), `${SENTINEL_PREFIX}12345`));
  });

  describe("sentinelDir platform branch", () => {
    let originalPlatform: NodeJS.Platform;
    let originalEnv: string | undefined;
    beforeEach(() => {
      originalPlatform = process.platform;
      originalEnv = process.env.OPEN_CONTEXT_MODE_MCP_SENTINEL_DIR;
      delete process.env.OPEN_CONTEXT_MODE_MCP_SENTINEL_DIR;
    });
    afterEach(() => {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
      if (originalEnv !== undefined) {
        process.env.OPEN_CONTEXT_MODE_MCP_SENTINEL_DIR = originalEnv;
      }
    });

    it("returns os.tmpdir() on win32", () => {
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      expect(sentinelDir()).toBe(tmpdir());
    });

    it("returns /tmp on non-win32", () => {
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });
      expect(sentinelDir()).toBe("/tmp");
    });
  });

  it("isMCPReady returns true when a sentinel with a live PID exists", () => {
    createSentinel(process.pid);
    expect(isMCPReady()).toBe(true);
  });

  it.each([
    ["empty payload", "test-empty-9991", ""],
    ["non-numeric payload", "test-garbage-9992", "abc"],
  ])("isMCPReady does not throw on %s sentinels", (_label, pid, content) => {
    createSentinel(pid, content);
    expect(() => isMCPReady()).not.toThrow();
  });
});

describe.skipIf(POLLUTED)("mcp-ready: stale-cleanup self-healing", () => {
  // The file-level beforeEach above writes a live sentinel at process.pid,
  // which would mask the cleanup we want to verify. Remove it here.
  beforeEach(() => {
    try {
      unlinkSync(mcpSentinel);
    } catch {}
  });

  afterEach(() => {
    for (const p of fixtures) {
      try {
        unlinkSync(p);
      } catch {
        /* already gone */
      }
    }
    fixtures.clear();
  });

  it("unlinks a STALE sentinel whose PID is dead", () => {
    const path = createSentinel(DEAD_PID);
    ageSentinel(path);
    isMCPReady();
    expect(existsSync(path)).toBe(false);
    fixtures.delete(path);
  });

  it("unlinks two STALE dead sentinels in a single scan", () => {
    const a = createSentinel(DEAD_PID);
    const b = createSentinel(DEAD_PID - 1);
    ageSentinel(a);
    ageSentinel(b);
    expect(isMCPReady()).toBe(false);
    expect(existsSync(a)).toBe(false);
    expect(existsSync(b)).toBe(false);
    fixtures.delete(a);
    fixtures.delete(b);
  });

  // #844: a recently-refreshed sentinel must NOT be cleaned up even when its
  // PID is invisible from this namespace (shared /tmp across PID namespaces).
  it("keeps a FRESH dead/invisible-PID sentinel (#844 cross-namespace guard)", () => {
    const path = createSentinel(DEAD_PID); // mtime = now → fresh
    expect(isMCPReady()).toBe(true);
    expect(existsSync(path)).toBe(true);
    fixtures.delete(path);
    try {
      unlinkSync(path);
    } catch {
      /* cleanup */
    }
  });

  it("in one scan: keeps the FRESH sentinel and cleans the STALE one (#844)", () => {
    const fresh = createSentinel(DEAD_PID);
    const stale = createSentinel(DEAD_PID - 1);
    ageSentinel(stale);
    expect(isMCPReady()).toBe(true);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(stale)).toBe(false);
    fixtures.delete(fresh);
    try {
      unlinkSync(fresh);
    } catch {
      /* cleanup */
    }
  });
});

describe("mcp-ready: PPID-independence (regression for #347)", () => {
  it("returns true when the only live sentinel is at a child PID outside the runner's process tree", async () => {
    // Pass the resolved sentinel directory in via env var so the child does not
    // re-derive it — keeps mcp-ready.mjs as the single source of truth for the
    // path shape, and avoids node-CLI argv ambiguity with `-e`.
    const childScript = `
      const { writeFileSync, unlinkSync } = require("node:fs");
      const { join } = require("node:path");
      const dir = process.env.MCP_SENTINEL_DIR;
      const path = join(dir, "open-context-mode-mcp-ready-" + process.pid);
      writeFileSync(path, String(process.pid));
      const cleanup = () => { try { unlinkSync(path); } catch {} process.exit(0); };
      process.on("SIGTERM", cleanup);
      process.on("SIGINT", cleanup);
      setInterval(() => {}, 1000);
    `;
    const resolvedDir = sentinelDir();
    const child = spawn(process.execPath, ["-e", childScript], {
      stdio: "ignore",
      env: { ...process.env, MCP_SENTINEL_DIR: resolvedDir },
    });
    const childPid = child.pid!;
    const childSentinel = join(resolvedDir, `${SENTINEL_PREFIX}${childPid}`);

    try {
      // Wait up to 2s for child to write its sentinel.
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline && !existsSync(childSentinel)) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(existsSync(childSentinel)).toBe(true);

      // The regression-defining assertion: the sentinel's PID is not in the
      // test runner's process tree. A PPID-keyed lookup would return false here.
      expect(childPid).not.toBe(process.pid);
      expect(childPid).not.toBe(process.ppid);

      // Directory-scan finds the child's sentinel regardless of PPID.
      expect(isMCPReady()).toBe(true);
    } finally {
      child.kill("SIGTERM");
      await new Promise<void>((r) => child.on("exit", () => r()));
      try {
        unlinkSync(childSentinel);
      } catch {
        /* child cleaned up */
      }
    }
  });
});

// #1055: MCP tools are registered per session. With several Claude Code
// sessions on one machine, a sibling session's live server used to satisfy
// isMCPReady(), so a session without its own server got WebFetch denied with a
// redirect to open_ctx_* tools it cannot call. The server now writes its host PID
// on the sentinel's second line; the scoped check requires that host to be an
// ancestor of the hook process.
describe.skipIf(POLLUTED || process.platform === "win32")("mcp-ready: session scoping (#1055)", () => {
  let sibling: ReturnType<typeof spawn>;

  beforeAll(() => {
    // Stands in for a sibling session's MCP client: alive, not our ancestor.
    sibling = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  });

  afterAll(async () => {
    sibling.kill("SIGTERM");
    await new Promise<void>((r) => sibling.on("exit", () => r()));
  });

  beforeEach(() => {
    // The file-level legacy sentinel would answer every scan; remove it.
    try {
      unlinkSync(mcpSentinel);
    } catch {}
  });

  afterEach(() => {
    for (const p of fixtures) {
      try {
        unlinkSync(p);
      } catch {
        /* already gone */
      }
    }
    fixtures.clear();
  });

  it("counts a live server whose host is this process's ancestor", () => {
    createSentinel("own-1055", `${process.pid}\n${process.ppid}`);
    expect(isMCPReady({ sessionScoped: true })).toBe(true);
  });

  it("ignores a live server hosted by a sibling session", () => {
    createSentinel("sibling-1055", `${process.pid}\n${sibling.pid}`);
    expect(isMCPReady({ sessionScoped: true })).toBe(false);
    // Unscoped callers (non-Claude-Code hosts) keep the machine-wide answer.
    expect(isMCPReady()).toBe(true);
  });

  it("finds this session's server behind a sibling's in the same scan", () => {
    createSentinel("sibling-1055", `${process.pid}\n${sibling.pid}`);
    createSentinel("own-1055", `${process.pid}\n${process.ppid}`);
    expect(isMCPReady({ sessionScoped: true })).toBe(true);
  });

  it("trusts a legacy sentinel without a host line", () => {
    createSentinel("legacy-1055", String(process.pid));
    expect(isMCPReady({ sessionScoped: true })).toBe(true);
  });

  it("does not deny WebFetch in Claude Code when only a sibling's server is up", () => {
    createSentinel("sibling-1055", `${process.pid}\n${sibling.pid}`);
    expect(routePreToolUse("WebFetch", { url: "https://example.com" }, undefined, "claude-code")).toBeNull();
    createSentinel("own-1055", `${process.pid}\n${process.ppid}`);
    expect(routePreToolUse("WebFetch", { url: "https://example.com" }, undefined, "claude-code")?.action).toBe("deny");
  });
});

// #1261 — building the #1055 ancestor table used to run `ps -A -o pid=,ppid=`
// on every hook call that reaches a redirect decision while a server is alive.
// That is a process spawn inside a hook that is itself one process spawn:
// measured at 14.3ms of CPU on an 805-process macOS box (5-15ms elsewhere),
// for a table Linux can read out of /proc. OPEN_CONTEXT_MODE_PROC_ROOT lets the
// walk be pointed at a synthetic tree so the procfs path is asserted on every
// platform, and a PATH-shadowed `ps` proves the spawn is gone.
describe("mcp-ready: the ancestor table costs no process spawn (#1261)", () => {
  // A pid that is alive nowhere near this process tree, so the real table
  // would never call it an ancestor.
  const SYNTHETIC_HOST_PID = 999_999;
  let procDir: string;
  let fakeBinDir: string;
  let psMarker: string;
  let savedProcRoot: string | undefined;
  let savedPath: string | undefined;

  /** One /proc/<pid>/stat line: `pid (comm) state ppid …` (comm may hold spaces). */
  const statLine = (pid: number, comm: string, ppid: number) => `${pid} (${comm}) S ${ppid} 0 0 -1 4194560 0 0 0 0 0 0\n`;

  beforeEach(() => {
    procDir = mkdtempSync(join(tmpdir(), "open_ctx-1261-proc-"));
    fakeBinDir = mkdtempSync(join(tmpdir(), "open_ctx-1261-bin-"));
    psMarker = join(fakeBinDir, "ps-was-called");
    // A `ps` that records being called and answers with nothing, so the
    // fallback path cannot accidentally produce the right answer. `printf >`
    // is a shell builtin — the shadowed PATH has no coreutils to find.
    writeFileSync(join(fakeBinDir, "ps"), `#!/bin/sh\nprintf x > ${JSON.stringify(psMarker)}\n`, { mode: 0o755 });

    mkdirSync(join(procDir, String(process.pid)), { recursive: true });
    writeFileSync(join(procDir, String(process.pid), "stat"), statLine(process.pid, "node worker (x)", SYNTHETIC_HOST_PID));
    mkdirSync(join(procDir, String(SYNTHETIC_HOST_PID)), { recursive: true });
    writeFileSync(join(procDir, String(SYNTHETIC_HOST_PID), "stat"), statLine(SYNTHETIC_HOST_PID, "init", 1));

    savedProcRoot = process.env.OPEN_CONTEXT_MODE_PROC_ROOT;
    savedPath = process.env.PATH;
    process.env.OPEN_CONTEXT_MODE_PROC_ROOT = procDir;
    process.env.PATH = fakeBinDir;
  });

  afterEach(() => {
    if (savedProcRoot === undefined) delete process.env.OPEN_CONTEXT_MODE_PROC_ROOT;
    else process.env.OPEN_CONTEXT_MODE_PROC_ROOT = savedProcRoot;
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    try {
      unlinkSync(mcpSentinel);
    } catch {}
    rmSync(procDir, { recursive: true, force: true });
    rmSync(fakeBinDir, { recursive: true, force: true });
  });

  it("reads the ancestor chain out of procfs and never spawns ps", () => {
    // The sentinel's host resolves as an ancestor ONLY through the synthetic
    // procfs tree, so this can pass if and only if the procfs walk is the one
    // that ran.
    writeFileSync(mcpSentinel, `${process.pid}\n${SYNTHETIC_HOST_PID}\n`);
    expect(isMCPReady({ sessionScoped: true })).toBe(true);
    expect(existsSync(psMarker), "ownAncestorPids must not spawn ps when /proc answers").toBe(false);
  });

  it("still scopes out a host that the procfs chain does not contain", () => {
    mkdirSync(join(procDir, String(process.pid)), { recursive: true });
    writeFileSync(join(procDir, String(process.pid), "stat"), statLine(process.pid, "node", 1));
    writeFileSync(mcpSentinel, `${process.pid}\n${SYNTHETIC_HOST_PID}\n`);
    expect(isMCPReady({ sessionScoped: true })).toBe(false);
    // Unscoped callers keep the machine-wide answer.
    expect(isMCPReady()).toBe(true);
  });

  it("falls back to ps only where there is no procfs to read", () => {
    delete process.env.OPEN_CONTEXT_MODE_PROC_ROOT;
    writeFileSync(mcpSentinel, `${process.pid}\n${SYNTHETIC_HOST_PID}\n`);
    // Windows has neither /proc nor a `ps` this test can shadow (the fake is a
    // /bin/sh script), so no ancestor table can be built there at all and a
    // scoped caller keeps the machine-wide answer — the documented
    // "unknown host → do not guess" branch, not a scoping failure.
    if (process.platform === "win32") {
      expect(isMCPReady({ sessionScoped: true })).toBe(true);
      expect(existsSync(psMarker), "no table means no ps spawn").toBe(false);
      return;
    }
    // The shadowed ps answers with an empty table, so the synthetic host is
    // nobody's ancestor either way. What differs is whether it was consulted:
    // macOS has no /proc, Linux does.
    expect(isMCPReady({ sessionScoped: true })).toBe(false);
    expect(existsSync(psMarker)).toBe(process.platform !== "linux");
  });
});

// ─────────────────────────────────────────────────────────
// Slice 4 — additionalContext surfacing on security init fail (#558)
// ─────────────────────────────────────────────────────────
//
// The pre-558 silent-fail UX gap: when initSecurity() fails to load the
// security module (marketplace install missing build/security.js AND
// hooks/security.bundle.mjs), the only signal is a stderr WARNING line
// that adapters typically suppress / discard. The user has no in-band
// signal that permissions.deny is fail-open.
//
// Fix: routing.mjs exposes `buildSecurityWarningContext()` — a pure
// helper that returns a structured agent-facing block when
// isSecurityInitFailed() is true, and null otherwise. SessionStart
// hooks call initSecurity() and append the block to their
// additionalContext, so the agent sees the warning in-context (not
// just in suppressed stderr).

describe("buildSecurityWarningContext — agent-facing security warning (#558)", () => {
  it("returns null when security init has not failed (default state)", async () => {
    // Use a subprocess so the module-scoped securityInitFailed flag
    // is in its initial false state — the in-process module from
    // beforeAll() above may have been touched by other tests.
    const r = await spawnRoutingProbe(`
      import { buildSecurityWarningContext, isSecurityInitFailed } from ${routingUrl()};
      process.stdout.write(JSON.stringify({
        failed: isSecurityInitFailed(),
        warning: buildSecurityWarningContext(),
      }));
    `);
    expect(r.parsed.failed).toBe(false);
    expect(r.parsed.warning).toBeNull();
  });

  it("returns a structured warning string when security init has failed", async () => {
    const missingBundle = join(tmpdir(), `open_ctx-slice4-no-bundle-${Date.now()}.bundle.mjs`);
    const missingBuild = join(tmpdir(), `open_ctx-slice4-no-build-${Date.now()}`);
    const r = await spawnRoutingProbe(
      `
      import { initSecurity, buildSecurityWarningContext, isSecurityInitFailed } from ${routingUrl()};
      await initSecurity(${JSON.stringify(missingBuild)});
      process.stdout.write(JSON.stringify({
        failed: isSecurityInitFailed(),
        warning: buildSecurityWarningContext(),
      }));
      `,
      {
        OPEN_CONTEXT_MODE_SUPPRESS_SECURITY_WARNING: "1",
        OPEN_CONTEXT_MODE_SECURITY_BUNDLE_PATH: missingBundle,
      },
    );
    expect(r.parsed.failed).toBe(true);
    expect(r.parsed.warning).toBeTruthy();
    expect(typeof r.parsed.warning).toBe("string");
    // Must mention the security gap and the remediation, AND must use
    // a recognizable XML-ish wrapper so the agent can parse / scope it.
    expect(r.parsed.warning).toMatch(/security/i);
    expect(r.parsed.warning).toMatch(/permissions\.deny|deny pattern/i);
    expect(r.parsed.warning).toMatch(/<context_mode_security_warning>|security_warning/);
    // Must point users at the actionable fix.
    expect(r.parsed.warning).toMatch(/npm run bundle|security\.bundle\.mjs|reinstall/i);
  });
});

// #1037 — a redirect must never be the reason a caller cannot reach the
// network. mcpRedirect is the single choke point every redirect passes
// through, so the opt-out belongs there rather than at each call site.
describe("opt-out of redirects", () => {
  afterEach(() => {
    delete process.env.OPEN_CONTEXT_MODE_ALLOW_WEBFETCH;
  });

  it("a caller without open_ctx_* tools falls through even when a server is ready", () => {
    // Already the contract from #794 — kept as the regression anchor.
    expect(
      routePreToolUse("WebFetch", { url: "https://example.com" }, "/repo", "claude-code", "s1", { mcpToolsAvailable: false }),
    ).toBeNull();
  });

  it("OPEN_CONTEXT_MODE_ALLOW_WEBFETCH=1 downgrades a live-server redirect to a passthrough", () => {
    process.env.OPEN_CONTEXT_MODE_ALLOW_WEBFETCH = "1";
    expect(
      routePreToolUse("WebFetch", { url: "https://example.com" }, "/repo", "claude-code", "s1", { mcpToolsAvailable: true }),
    ).toBeNull();
  });

  it('only the exact value "1" opts out', () => {
    // Without a ready sentinel the redirect is already a passthrough, so this
    // compares the two runs rather than asserting an absolute: what it pins is
    // that a non-"1" value does not fire the opt-out.
    const call = () =>
      routePreToolUse("WebFetch", { url: "https://example.com" }, "/repo", "claude-code", "s1", { mcpToolsAvailable: true });
    process.env.OPEN_CONTEXT_MODE_ALLOW_WEBFETCH = "true";
    const withOtherValue = call();
    delete process.env.OPEN_CONTEXT_MODE_ALLOW_WEBFETCH;
    expect(withOtherValue).toEqual(call());
  });
});

// #1125 — the curl/wget rule only ever looked at redirection flags on the
// chain segment it was given, so it classified a deliberately-reduced
// pipeline as an unbounded flood and redirected it for nothing. It also
// treated a newline as ordinary text, which made a whole multi-line script
// one segment: one bare curl anywhere in it condemned commands that had
// nothing to do with the network.
describe("#1125: a bounded pipeline and a multi-line block are not context floods", () => {
  const bash = (command: string) => {
    const r = routePreToolUse("Bash", { command }, "/repo", "claude-code", "s1125", { mcpToolsAvailable: true });
    return r?.action === "modify" ? "redirected" : "passed";
  };

  it("passes a bare curl — the flood this rule exists for", () => {
    expect(bash("curl -s http://example.com/")).toBe("redirected");
  });

  it("passes a pipeline whose stages reduce the output", () => {
    for (const cmd of [
      "curl -s http://example.com/ | head -c 200",
      "curl -s http://example.com/ | jq -r .name",
      "curl -s http://example.com/ | grep -c foo",
      "curl -s http://example.com/ | wc -l",
      "wget -q -O- http://example.com/ | head -c 200",
    ]) {
      expect(bash(cmd), cmd).toBe("passed");
    }
  });

  it("still redirects a pipeline that ends in a pass-through sink", () => {
    // `| cat` re-emits the whole body, so the reduction never happened.
    expect(bash("curl -s http://example.com/ | cat")).toBe("redirected");
    expect(bash("curl -s http://example.com/ | tee /tmp/out.json")).toBe("redirected");
  });

  it("still redirects a reduced pipeline whose stderr is unbounded", () => {
    // A pipe bounds stdout only. `curl -v` traces to stderr, which reaches
    // the context window whole.
    expect(bash("curl -v http://example.com/ | head -c 200")).toBe("redirected");
  });

  it("a newline separates commands, so a file-writing curl does not condemn the block", () => {
    // Non-regression anchor rather than a bite: this shape was already
    // allowed before the fix (the anchored CURL_WGET_SEGMENT_RE never
    // matched a segment that did not start with curl). It pins that adding
    // the newline separator did not turn the block into one segment.
    expect(bash("docker ps\ncurl -s -o /tmp/out.json http://example.com/\nssh host uptime")).toBe("passed");
  });

  it("a bare curl on one line of a block still condemns the block", () => {
    // This is the direction the newline separator actually moves: without it
    // the anchored segment regex never sees a curl that is not the first
    // token of the whole block, so a real flood on line 3 of a script
    // escaped the rule entirely.
    expect(bash("docker ps\ncurl -s http://example.com/\nssh host uptime")).toBe("redirected");
  });

  it("a backslash continuation stays one command, so the pipe is still seen", () => {
    expect(bash("curl -s \\\n  http://example.com/ | head -c 200")).toBe("passed");
  });
});

// #1212 — the generic Bash nudge fires through guidanceOnce, so only the very
// first unbounded call in a session says anything. In the iterative
// edit -> run -> read error -> retry loop that is the whole session, every
// later call silently dumped raw output into the context window. The knob
// mirrors OPEN_CONTEXT_MODE_EXTERNAL_MCP_NUDGE_EVERY, which already exists.
describe("#1212: the Bash nudge can re-fire on a cadence", () => {
  // NOT a toolchain command: `npm run build:*` now gets a deterministic
  // redirect, and this suite is about the generic nudge cadence.
  const CMD = "aws s3 ls s3://my-bucket --recursive";
  const fires = (session: string, env?: string) => {
    // The throttle markers are files in tmpdir keyed by session id, so they
    // outlive the test process. Wipe them, or a re-run of this file inherits
    // the previous run's state and every call reads as already-shown.
    rmSync(resolve(tmpdir(), `open-context-mode-guidance-s-${session}`), { recursive: true, force: true });
    resetGuidanceThrottle();
    if (env === undefined) delete process.env.OPEN_CONTEXT_MODE_BASH_NUDGE_EVERY;
    else process.env.OPEN_CONTEXT_MODE_BASH_NUDGE_EVERY = env;
    return Array.from({ length: 7 }, () => routePreToolUse("Bash", { command: CMD }, "/repo", "claude-code", session)).map(
      (r) => r?.action === "context",
    );
  };

  afterEach(() => {
    delete process.env.OPEN_CONTEXT_MODE_BASH_NUDGE_EVERY;
  });

  it("re-fires every N unbounded calls when OPEN_CONTEXT_MODE_BASH_NUDGE_EVERY=N", () => {
    // period=3 → fires on calls 1, 4, 7.
    expect(fires("s1212-periodic", "3")).toEqual([true, false, false, true, false, false, true]);
  });

  // The one-shot default made the nudge useless exactly where it pays: an
  // edit -> run -> read-error -> retry loop hits the same unbounded command
  // many times and only the first one was redirected.
  it("re-fires every 4th call when the knob is unset", () => {
    // period=4 fires on calls 1, 5 — the first hit, then every 4th after.
    expect(fires("s1212-default")).toEqual([true, false, false, false, true, false, false]);
  });

  it("restores the one-shot behavior on an explicit 0", () => {
    expect(fires("s1212-explicit-zero", "0")).toEqual([true, false, false, false, false, false, false]);
  });

  it("falls back to the default cadence on out-of-range or unparseable values", () => {
    for (const v of ["-1", "9999", "not-a-number", ""]) {
      expect(fires(`s1212-invalid-${v}`, v), `value=${JSON.stringify(v)}`).toEqual([true, false, false, false, true, false, false]);
    }
  });

  it("leaves the curl/wget redirect on its own path — the cadence is advisory only", () => {
    process.env.OPEN_CONTEXT_MODE_BASH_NUDGE_EVERY = "1";
    resetGuidanceThrottle();
    for (let i = 0; i < 3; i++) {
      const r = routePreToolUse("Bash", { command: "curl https://example.com" }, "/repo", "claude-code", "s1212-curl");
      expect(r!.action).toBe("modify");
    }
  });
});

// #1003 — the WebFetch deny is the strongest thing the routing table does and
// the only redirect with no switch of its own. OPEN_CONTEXT_MODE_ALLOW_WEBFETCH is
// the off switch, but it lands in mcpRedirect, so using it also drops the
// Bash/curl redirects and the Read/Grep nudges: there was no way to keep those
// and drop the WebFetch deny. And the deny reason was written as if it were
// the only signal the model would see — which is exactly what it is not when
// the call was emitted in a parallel batch alongside a WebSearch that
// succeeded, and the model then answered from the sibling.
describe("#1003: the WebFetch deny is opt-out-able on its own and says so for batches", () => {
  afterEach(() => {
    delete process.env.OPEN_CONTEXT_MODE_DISABLE_WEBFETCH_REDIRECT;
  });

  it("OPEN_CONTEXT_MODE_DISABLE_WEBFETCH_REDIRECT=1 drops the WebFetch deny", () => {
    process.env.OPEN_CONTEXT_MODE_DISABLE_WEBFETCH_REDIRECT = "1";
    expect(
      routePreToolUse("WebFetch", { url: "https://example.com" }, "/repo", "claude-code", "s1", { mcpToolsAvailable: true }),
    ).toBeNull();
  });

  it("leaves the Bash/curl redirect in place — only the WebFetch branch opts out", () => {
    process.env.OPEN_CONTEXT_MODE_DISABLE_WEBFETCH_REDIRECT = "1";
    const bash = routePreToolUse("Bash", { command: "curl https://example.com" }, "/repo", "claude-code", "s1", {
      mcpToolsAvailable: true,
    });
    expect(bash!.action).toBe("modify");
    expect((bash!.updatedInput as Record<string, string>).command).toContain("curl/wget redirected");
  });

  it('only the exact value "1" opts out of the WebFetch deny', () => {
    const call = () =>
      routePreToolUse("WebFetch", { url: "https://example.com" }, "/repo", "claude-code", "s1", { mcpToolsAvailable: true });
    process.env.OPEN_CONTEXT_MODE_DISABLE_WEBFETCH_REDIRECT = "true";
    const withOtherValue = call();
    delete process.env.OPEN_CONTEXT_MODE_DISABLE_WEBFETCH_REDIRECT;
    expect(withOtherValue).toEqual(call());
    expect(withOtherValue).not.toBeNull();
  });

  it("tells the model a sibling tool in the same batch does not satisfy the fetch", () => {
    const result = routePreToolUse("WebFetch", { url: "https://example.com" }, "/repo", "claude-code", "s1", {
      mcpToolsAvailable: true,
    });
    expect(result!.action).toBe("deny");
    expect(result!.reason).toMatch(/parallel batch/i);
    expect(result!.reason).toMatch(/is not this page/i);
  });
});

// #1267 — the Read tip is supposed to be once per session, but the >50 KB
// branch wrapped guidanceOnce in a `??` fallback that rebuilt a fresh context
// decision from readGuidance every time, so the guard never held there: one
// session logged 63 injections of the same tip. The byte accounting (which
// feeds the read-redirected event) has to survive the fix — it is a separate
// concern from whether the tip is shown.
describe("#1267: the Read tip stays once-per-session on files >50 KB", () => {
  const bigDir = mkdtempSync(join(tmpdir(), "open_ctx-1267-big-"));
  const bigFile = join(bigDir, "big.txt");
  const smallFile = join(bigDir, "small.txt");
  const BIG_SIZE = 80_000;
  let readOfBig: (session: string) => any;

  beforeAll(() => {
    writeFileSync(bigFile, "x".repeat(BIG_SIZE), "utf-8");
    writeFileSync(smallFile, "x".repeat(10), "utf-8");
    readOfBig = (session: string) => routePreToolUse("Read", { file_path: bigFile }, "/repo", "claude-code", session);
  });

  afterAll(() => {
    try {
      rmSync(bigDir, { recursive: true, force: true });
    } catch {}
  });

  it("shows the tip on the first big Read and never again in that session", () => {
    const session = "s1267-first";
    rmSync(resolve(tmpdir(), `open-context-mode-guidance-s-${session}`), { recursive: true, force: true });
    resetGuidanceThrottle();

    const first = readOfBig(session);
    expect(first.action).toBe("context");
    expect(first.additionalContext).toContain(READ_GUIDANCE);

    for (let i = 0; i < 5; i++) {
      const repeat = readOfBig(session);
      // No tip: an empty additionalContext is the meta-only decision.
      expect(repeat.additionalContext).toBe("");
    }
  });

  it("keeps the read-redirected byte accounting on every big Read", () => {
    const session = "s1267-accounting";
    rmSync(resolve(tmpdir(), `open-context-mode-guidance-s-${session}`), { recursive: true, force: true });
    resetGuidanceThrottle();

    for (const decision of [readOfBig(session), readOfBig(session)]) {
      expect(decision.redirectMeta).toMatchObject({ tool: "Read", type: "read-redirected", bytesAvoided: BIG_SIZE });
    }
  });

  it("leaves small reads on the plain once-per-session path (regression anchor)", () => {
    const session = "s1267-small";
    rmSync(resolve(tmpdir(), `open-context-mode-guidance-s-${session}`), { recursive: true, force: true });
    resetGuidanceThrottle();

    const call = () => routePreToolUse("Read", { file_path: smallFile }, "/repo", "claude-code", session);
    expect(call()!.additionalContext).toContain(READ_GUIDANCE);
    expect(call()).toBeNull();
  });

  it("still shows the tip once when the session marker cannot be written", () => {
    // The `??` the fix removed was compensating for a marker that could not be
    // persisted: guidanceOnce swallowed every errno as "already shown", so an
    // unwritable tmpdir silenced the advisory for the whole session. Now only
    // EEXIST means spent.
    const session = "s1267-unwritable";
    const notADir = join(bigDir, "not-a-dir");
    writeFileSync(notADir, "", "utf-8");
    // Clear the stale marker under the real tmpdir BEFORE hijacking TMPDIR:
    // on Linux, rmSync through a regular-file ancestor throws ENOTDIR, which
    // force does not swallow (macOS does swallow it — why this only failed on CI).
    rmSync(resolve(tmpdir(), `open-context-mode-guidance-s-${session}`), { recursive: true, force: true });
    const realTmp = process.env.TMPDIR;
    const realTmpUpper = process.env.TMP;
    process.env.TMPDIR = join(notADir, "sub");
    resetGuidanceThrottle();

    try {
      const first = readOfBig(session);
      const second = readOfBig(session);
      expect(first.additionalContext).toContain(READ_GUIDANCE);
      expect(second.additionalContext).toBe("");
    } finally {
      if (realTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = realTmp;
      if (realTmpUpper !== undefined) process.env.TMP = realTmpUpper;
    }
  });
});

// #908 — the WebFetch deny is all-or-nothing per tool: #1003 gave it a global
// off switch, and #938 hardcoded claude.ai Artifact pages as the one exception.
// Everything in between (an internal host, a session link, any auth-gated URL
// the operator fetches once) had no knob short of hand-editing hooks.json
// inside the versioned plugin cache, which open-context-mode upgrade reverts.
// OPEN_CONTEXT_MODE_WEBFETCH_NATIVE_DOMAINS names hosts that stay on the platform's
// native WebFetch / curl.
describe("#908: configured hosts keep the platform's native fetch", () => {
  const ENV = "OPEN_CONTEXT_MODE_WEBFETCH_NATIVE_DOMAINS";
  const webFetch = (url: string) => routePreToolUse("WebFetch", { url }, "/repo", "claude-code", "s908", { mcpToolsAvailable: true });
  const bash = (command: string) => routePreToolUse("Bash", { command }, "/repo", "claude-code", "s908", { mcpToolsAvailable: true });

  beforeEach(() => {
    resetGuidanceThrottle();
  });

  afterEach(() => {
    delete process.env[ENV];
  });

  it("passes an excluded host through to native WebFetch", () => {
    process.env[ENV] = "claude.ai, internal.example.com";
    expect(webFetch("https://claude.ai/code/session_abc")).toBeNull();
    expect(webFetch("https://internal.example.com/short-lived")).toBeNull();
  });

  it("matches subdomains of an excluded host, not lookalikes", () => {
    process.env[ENV] = "claude.ai";
    expect(webFetch("https://preview.claude.ai/code/session_abc")).toBeNull();
    // The URL constructor is what keeps this safe — a substring check would
    // wave claude.ai.evil.com through.
    expect(webFetch("https://claude.ai.evil.com/x")?.action).toBe("deny");
    expect(webFetch("https://notclaude.ai/x")?.action).toBe("deny");
  });

  it("leaves every other host on the redirect when the list is set", () => {
    process.env[ENV] = "claude.ai";
    expect(webFetch("https://example.com")?.action).toBe("deny");
  });

  it("keeps the redirect everywhere when the list is unset, blank or empty entries", () => {
    for (const value of [undefined, "", " , ", ",,"]) {
      if (value === undefined) delete process.env[ENV];
      else process.env[ENV] = value;
      expect(webFetch("https://claude.ai/code/session_abc"), `value=${JSON.stringify(value)}`).not.toBeNull();
      expect(bash("curl https://claude.ai/code/session_abc")?.action, `value=${JSON.stringify(value)}`).toBe("modify");
    }
  });

  it("leaves curl/wget on the platform for an excluded host", () => {
    process.env[ENV] = "claude.ai";
    expect(bash("curl https://claude.ai/code/session_abc")).toBeNull();
    expect(bash("wget https://claude.ai/code/session_abc")).toBeNull();
    // Nothing else in the batch gives up the redirect.
    expect(bash("curl https://example.com")?.action).toBe("modify");
    // A build tool in the same command keeps its own analysis — the excluded
    // segment must not swallow the sibling's redirect.
    expect(bash("gradle build && curl https://claude.ai/x")?.action).toBe("modify");
  });

  it("does not nudge a native fetch toward open_ctx_execute", () => {
    // The nudge is the opposite of what the exclusion asks for. Once per
    // session at most, so an un-nudged call has to be a null decision.
    process.env[ENV] = "claude.ai";
    expect(bash("curl https://claude.ai/code/session_abc")).toBeNull();
  });

  it("still redirects a segment that only mentions an excluded host", () => {
    // Every http(s) token must be excluded. A body or header value naming the
    // host is not the fetch destination, and redirecting it away is the whole
    // point of the rule.
    process.env[ENV] = "claude.ai";
    expect(bash(`curl -d '{"ref":"https://claude.ai/x"}' https://evil.example.com/y`)?.action).toBe("modify");
    expect(bash("curl -H 'x: https://claude.ai' https://evil.example.com/y")?.action).toBe("modify");
    expect(bash("curl https://evil.example.com/y https://claude.ai/x")?.action).toBe("modify");
  });

  it("keeps redirecting when the URL is not a literal in the command", () => {
    process.env[ENV] = "claude.ai";
    expect(bash('curl "$SESSION_URL"')?.action).toBe("modify");
  });
});

/**
 * Helper — spawn a fresh node subprocess and run a small ESM snippet
 * against routing.mjs. Returns parsed stdout JSON. Each call is
 * isolated (no shared module state) so the global securityInitFailed
 * flag starts false in every test.
 */
const SLICE4_DIRNAME = (() => {
  // ESM-safe __dirname for the slice 4 helpers (vitest's main file
  // doesn't have one). Lazily evaluated to avoid touching top-level state.
  const { fileURLToPath } = require("node:url");
  const { dirname } = require("node:path");
  return dirname(fileURLToPath(import.meta.url));
})();

function routingUrl(): string {
  const path = resolve(SLICE4_DIRNAME, "..", "..", "hooks", "core", "routing.mjs");
  // pathToFileURL handles Windows drive letters correctly.
  const { pathToFileURL } = require("node:url");
  return JSON.stringify(pathToFileURL(path).href);
}

async function spawnRoutingProbe(
  code: string,
  env: Record<string, string> = {},
): Promise<{ status: number | null; stdout: string; parsed: any }> {
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync("node", ["--input-type=module", "-e", code], {
    encoding: "utf-8",
    timeout: 15_000,
    env: { ...process.env, ...env },
  });
  const stdout = (r.stdout ?? "").trim();
  let parsed: any = null;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    /* surface raw */
  }
  return { status: r.status, stdout, parsed };
}
