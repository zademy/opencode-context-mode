import "../setup-home";
/**
 * SPEC hook-resilience (docs/specs/SPEC-hook-resilience.md)
 *
 * Two invariants under test:
 *   1. failSafe — an internal hook error NEVER reaches the host turn loop;
 *      it degrades to passthrough with one safeLog line. Deliberate
 *      RoutingDenyError rethrows (a deny is a decision, not a failure).
 *   2. initState — a failed capability degrades that capability instead of
 *      rejecting and killing the whole plugin.
 */

import { describe, it, expect, beforeEach } from "vite-plus/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { failSafe, RoutingDenyError, initState, resetHookHealthForTests } from "../../src/platforms/opencode/plugin.js";

const noopLog = async () => {};

beforeEach(() => {
  resetHookHealthForTests();
});

describe("failSafe", () => {
  it("degrades a throwing hook to passthrough and never rethrows", async () => {
    const logs: string[] = [];
    const safeLog = async (message?: string) => {
      logs.push(message ?? "");
    };
    const wrapped = failSafe("test.after", safeLog, async () => {
      throw new Error("boom");
    });

    await expect(wrapped()).resolves.toBeUndefined();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("test.after");
    expect(logs[0]).toContain("boom");
  });

  it("rethrows deliberate RoutingDenyError without logging or counting it", async () => {
    const logs: string[] = [];
    const safeLog = async (message?: string) => {
      logs.push(message ?? "");
    };
    const wrapped = failSafe("test.before", safeLog, async () => {
      throw new RoutingDenyError("Blocked by open-context-mode");
    });

    await expect(wrapped()).rejects.toThrow("Blocked by open-context-mode");
    expect(logs).toHaveLength(0);
  });

  it("disables a hook after 3 consecutive failures and stops invoking it", async () => {
    const logs: string[] = [];
    const safeLog = async (message?: string) => {
      logs.push(message ?? "");
    };
    let calls = 0;
    const wrapped = failSafe("test.breaker", safeLog, async () => {
      calls += 1;
      throw new Error("systematic");
    });

    await wrapped();
    await wrapped();
    await wrapped();
    expect(calls).toBe(3);

    const disableLines = logs.filter((l) => l.includes("disabled"));
    expect(disableLines).toHaveLength(1);
    expect(disableLines[0]).toContain("test.breaker");

    // 4th call: breaker open — fn no longer invoked, no new logs.
    await expect(wrapped()).resolves.toBeUndefined();
    expect(calls).toBe(3);
    expect(logs.filter((l) => l.includes("disabled"))).toHaveLength(1);
  });

  it("resets the failure counter after a success", async () => {
    let calls = 0;
    let shouldThrow = true;
    const wrapped = failSafe("test.reset", noopLog, async () => {
      calls += 1;
      if (shouldThrow) throw new Error("flaky");
      return "ok";
    });

    await wrapped(); // fail 1
    await wrapped(); // fail 2
    shouldThrow = false;
    await expect(wrapped()).resolves.toBe("ok"); // success resets the counter
    shouldThrow = true;
    await wrapped(); // fail 1 (post-reset)
    await wrapped(); // fail 2 (post-reset)
    await wrapped(); // fail 3 (post-reset) → disabled
    expect(calls).toBe(6);
    await wrapped(); // breaker open — not invoked
    expect(calls).toBe(6);
  });

  it("preserves the wrapped hook's return value on success", async () => {
    const wrapped = failSafe("test.value", noopLog, async () => "snapshot");
    await expect(wrapped()).resolves.toBe("snapshot");
  });
});

describe("initState degradation (SPEC hook-resilience)", () => {
  it("degrades to unrouted passthrough when routing.mjs fails to import", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "hook-resilience-"));
    try {
      const logs: string[] = [];
      const state = await initState(
        tempDir,
        async (message?: string) => {
          logs.push(message ?? "");
        },
        { routingPath: join(tempDir, "does-not-exist.mjs") },
      );

      expect(state.degraded).toContain("routing");
      // before() must resolve (passthrough) instead of throwing.
      await expect(
        state.handlers.before({ tool: "bash", sessionID: "s1", callID: "c1" } as never, { args: { command: "ls" } } as never),
      ).resolves.toBeUndefined();
      expect(logs.some((l) => l.includes("routing"))).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("degrades event capture when the session DB cannot open", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "hook-resilience-"));
    try {
      // A FILE where a directory is needed → SQLite cannot open the DB path.
      const blocker = join(tempDir, "blocker");
      writeFileSync(blocker, "not a directory");

      const state = await initState(tempDir, noopLog, { dbPath: join(blocker, "sub", "session.db") });

      expect(state.degraded).toContain("session-db");
      // after() must resolve even though the DB is a no-op stub.
      await expect(
        state.handlers.after(
          { tool: "bash", sessionID: "s1", callID: "c1", args: {} } as never,
          { title: "", output: "hello", metadata: undefined } as never,
        ),
      ).resolves.toBeUndefined();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("loads with an empty routing block when routing-block.mjs fails to import", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "hook-resilience-"));
    try {
      const state = await initState(tempDir, noopLog, {
        routingBlockPath: join(tempDir, "nope.mjs"),
      });

      expect(state.degraded).toContain("routing-block");
      expect(state.routingBlock).toBe("");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
