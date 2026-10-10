import "./setup-home";
/**
 * Orphan reaping, end to end with real processes (#1100, #1101).
 *
 * Every other check in lifecycle.test.ts injects `isParentAlive`, so nothing
 * proved the shipped behaviour: a real child running the production guard must
 * EXIT when its host process is killed. The upstream report is a bun bridge
 * child surviving its pi session at 100% CPU while its SQLite DB kept growing
 * — 18 sessions leaked ~3.6 GB.
 *
 * The chain mirrors it: a parent process (stands in for pi) spawns a child
 * (stands in for server.bundle.mjs) and is SIGKILLed, so no signal reaches the
 * child — only reparenting to init does. The child runs the REAL guard with
 * OPEN_CONTEXT_MODE_BRIDGE_DEPTH=1 (the 1 s poll mcp-bridge.ts sets), so the window
 * is as tight as production.
 *
 * Both processes are spawned as `node --import tsx` on purpose: running the
 * `node_modules/.bin/tsx` shell wrapper would leave an extra node process
 * between the test and the parent, and killing the wrapper would not orphan
 * the child at all.
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const LIFECYCLE_SRC = fileURLToPath(new URL("../src/lifecycle.ts", import.meta.url));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

let scratch: string;

beforeAll(() => {
  if (!existsSync(join(process.cwd(), "node_modules", "tsx"))) {
    throw new Error("tsx devDependency missing; this test runs the real TS module through it");
  }
  scratch = mkdtempSync(join(tmpdir(), "open_ctx-orphan-e2e-"));

  writeFileSync(
    join(scratch, "child.ts"),
    `
import { startLifecycleGuard } from ${JSON.stringify(pathToFileURL(LIFECYCLE_SRC).href)};
startLifecycleGuard({ onShutdown: () => process.exit(0) });
process.stdout.write("CHILD_READY\\n");
// Never exits on its own: only the guard may reap it.
setInterval(() => {}, 1000);
`,
  );

  writeFileSync(
    join(scratch, "parent.ts"),
    `
import { spawn } from "node:child_process";
const child = spawn(process.execPath, ["--import", "tsx", ${JSON.stringify(join(scratch, "child.ts"))}], {
  stdio: ["ignore", "inherit", "inherit"],
  env: { ...process.env, OPEN_CONTEXT_MODE_BRIDGE_DEPTH: "1" },
});
process.stdout.write("CHILD_PID " + child.pid + "\\n");
setInterval(() => {}, 1000);
`,
  );
});

afterAll(() => {
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

function pidAlive(pid: number): boolean {
  try {
    execSync(`kill -0 ${pid}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(process.platform === "win32")("orphaned MCP child reaps itself (#1100, #1101)", () => {
  test("child exits within a few seconds after its host process is SIGKILLed", async () => {
    const parent: ChildProcess = spawn(process.execPath, ["--import", "tsx", join(scratch, "parent.ts")], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    try {
      const childPid = await new Promise<number>((resolve, reject) => {
        let buf = "";
        const timer = setTimeout(() => reject(new Error("parent never reported a child pid: " + buf)), 20_000);
        parent.stdout!.on("data", (chunk) => {
          buf += String(chunk);
          const m = buf.match(/CHILD_PID (\d+)/);
          if (m) {
            clearTimeout(timer);
            resolve(Number(m[1]));
          }
        });
      });

      // Let the child arm its guard, then kill the host outright. SIGKILL
      // means no signal reaches the child: only reparenting can save it.
      await wait(2000);
      parent.kill("SIGKILL");

      for (let i = 0; i < 40 && pidAlive(childPid); i++) await wait(250);

      expect(pidAlive(childPid), `child ${childPid} survived its host process`).toBe(false);
    } finally {
      try {
        parent.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }, 30_000);
});
