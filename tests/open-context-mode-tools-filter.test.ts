import "./setup-home";
import { describe, test, expect } from "vitest";
import { parseContextModeToolsAllowlist, isContextModeToolEnabled } from "../src/util/tools-allowlist.js";
import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";

// OPEN_CONTEXT_MODE_TOOLS allow-list (issue #1031).
// The unit block pins the parse/enable semantics against the REAL pure
// module; the wiring block below spawns the real server and reads its
// tools/list, because the upstream PR only tested a local mirror of the
// wrapper — a broken guard in server.ts passed its suite untouched.

describe("parseContextModeToolsAllowlist", () => {
  test("unset env => empty allowlist (register everything)", () => {
    expect(parseContextModeToolsAllowlist(undefined)).toEqual([]);
  });

  test("empty string => empty allowlist", () => {
    expect(parseContextModeToolsAllowlist("")).toEqual([]);
  });

  test("whitespace-only => empty allowlist", () => {
    expect(parseContextModeToolsAllowlist("  ")).toEqual([]);
  });

  test("single tool", () => {
    expect(parseContextModeToolsAllowlist("open_ctx_execute")).toEqual(["open_ctx_execute"]);
  });

  test("comma-separated with whitespace is trimmed", () => {
    expect(parseContextModeToolsAllowlist(" open_ctx_execute , open_ctx_search ,")).toEqual(["open_ctx_execute", "open_ctx_search"]);
  });
});

describe("isContextModeToolEnabled", () => {
  test("empty allowlist enables everything (status quo)", () => {
    expect(isContextModeToolEnabled("open_ctx_execute", [])).toBe(true);
    expect(isContextModeToolEnabled("open_ctx_stats", [])).toBe(true);
  });

  test("listed tool is enabled", () => {
    const list = ["open_ctx_execute", "open_ctx_execute_file"];
    expect(isContextModeToolEnabled("open_ctx_execute", list)).toBe(true);
    expect(isContextModeToolEnabled("open_ctx_execute_file", list)).toBe(true);
  });

  test("non-listed tool is disabled", () => {
    const list = ["open_ctx_execute", "open_ctx_execute_file"];
    expect(isContextModeToolEnabled("open_ctx_search", list)).toBe(false);
    expect(isContextModeToolEnabled("open_ctx_stats", list)).toBe(false);
  });

  test("unknown tool name is disabled", () => {
    expect(isContextModeToolEnabled("open_ctx_does_not_exist", ["open_ctx_execute"])).toBe(false);
  });
});

// ── Real wiring: the spawned server honors the allowlist ──
// start.mjs resolves server.bundle.mjs, so this exercises the guard in
// src/server.ts as shipped — not a mirror.
describe("OPEN_CONTEXT_MODE_TOOLS wiring — the real server honors the allowlist", () => {
  const mcpEntry = resolve(__dirname, "..", "server.bundle.mjs");

  function start(extraEnv: Record<string, string>): ChildProcess {
    return spawn(process.execPath, [mcpEntry], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        OPEN_CONTEXT_MODE_DISABLE_VERSION_CHECK: "1",
        ...extraEnv,
      },
    });
  }

  function listToolNames(extraEnv: Record<string, string>): Promise<string[]> {
    const proc = start(extraEnv);
    return new Promise((res, rej) => {
      let buf = "";
      const timer = setTimeout(() => {
        try {
          proc.kill("SIGTERM");
        } catch {
          /* best effort */
        }
        rej(new Error("tools/list response never arrived"));
      }, 20_000);
      proc.stdout!.on("data", (d: Buffer) => {
        buf += d.toString();
        let idx: number;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          try {
            const parsed = JSON.parse(line) as {
              id?: number;
              result?: { tools?: Array<{ name: string }> };
            };
            if (parsed.id === 2) {
              clearTimeout(timer);
              try {
                proc.kill("SIGTERM");
              } catch {
                /* best effort */
              }
              res((parsed.result?.tools ?? []).map((t) => t.name));
              return;
            }
          } catch {
            /* ignore non-JSON lines */
          }
        }
      });
      proc.stdin!.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "tools-filter", version: "1" } },
        }) + "\n",
      );
      proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
    });
  }

  test("allowlist of two => exactly those two tools are registered", async () => {
    const names = await listToolNames({ OPEN_CONTEXT_MODE_TOOLS: "open_ctx_doctor,open_ctx_stats" });
    expect(names.sort()).toEqual(["open_ctx_doctor", "open_ctx_stats"]);
  }, 30_000);

  test("unset => the full toolset registers (status quo)", async () => {
    const names = await listToolNames({});
    expect(names.length).toBeGreaterThanOrEqual(10);
    expect(names).toContain("open_ctx_execute");
    expect(names).toContain("open_ctx_doctor");
  }, 30_000);
});
