/**
 * Consolidated CLI tests
 *
 * Combines:
 *   - cli-bundle.test.ts (marketplace install support)
 *   - cli-hook-path.test.ts (forward-slash hook paths)
 *   - package-exports.test.ts (public API surface)
 */
import { describe, it, test, expect, beforeEach, afterEach } from "vitest";
import { strict as assert } from "node:assert";
import {
  readFileSync,
  existsSync,
  accessSync,
  constants,
  mkdirSync,
  writeFileSync,
  rmSync,
  readdirSync,
  cpSync,
  symlinkSync,
  lstatSync,
} from "node:fs";
import { resolve, join, dirname, sep } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { execSync, spawnSync } from "node:child_process";
import { removeCacheHealHook, toUnixPath } from "../../src/cli.js";
import { findMissingLaunchFiles } from "../../src/util/plugin-cache-integrity.js";

const ROOT = resolve(import.meta.dirname, "../..");

// ── cli.bundle.mjs — marketplace install support ──────────────────────

// ── bin/analytics.bundle.mjs — statusline marketplace install support ──
//
// bin/statusline.mjs dynamically imports the compiled analytics module.
// Every other session/*.ts consumer (session-db, session-extract,
// session-snapshot) ships a co-located CI bundle with build/ as fallback —
// analytics.ts was the one left out, so a git-clone marketplace install
// (build/ is gitignored, only `tsc` produces it, only npm/CI installs run
// that) never resolved a target and bin/statusline.mjs permanently
// rendered the empty-state headline instead of real KPIs.

// ── .mcp.json — MCP server config ────────────────────────────────────

describe(".mcp.json — MCP server config", () => {
  it(".mcp.json.example carries the one universal MCP block", () => {
    // The ${CLAUDE_PLUGIN_ROOT} placeholder is gone: only Claude Code ever
    // substituted it. Every other MCP client runs the same npx invocation.
    const example = JSON.parse(readFileSync(resolve(ROOT, ".mcp.json.example"), "utf-8"));
    expect(example.mcpServers["open-context-mode"]).toEqual({ command: "npx", args: ["-y", "open-context-mode"] });
  });

  it("package.json files[] MUST NOT ship .mcp.json (architectural lock — closes #531)", () => {
    // PR #253 flip-flop: source .mcp.json kept switching between the
    // placeholder form (correct for end-users via marketplace install) and
    // the relative form (correct for contributors opening the repo as a
    // regular project). Stop shipping it in the tarball so the two roles
    // never collide again. End users get MCP via .claude-plugin/plugin.json
    // — cli.ts no longer writes `.mcp.json` to the plugin cache (#609).
    const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf-8"));
    expect(pkg.files).toBeDefined();
    expect(pkg.files).not.toContain(".mcp.json");
  });
});

// ── CLI Hook Path Tests ───────────────────────────────────────────────

// ── ABI-aware native binary caching (#148) ────────────────────────────

/**
 * Extract ensureNativeCompat from hooks/ensure-deps.mjs at test time.
 * ensure-deps.mjs is the shared bootstrap with side effects (auto-runs on import),
 * so we extract the function source via regex, wrap it as a temp ESM module,
 * and dynamically import it — tests always run against the real code.
 */
async function loadEnsureNativeCompat(): Promise<(pluginRoot: string) => void> {
  const src = readFileSync(resolve(ROOT, "hooks", "ensure-deps.mjs"), "utf-8");
  const match = src.match(/^export function ensureNativeCompat\b[\s\S]*?^}/m);
  if (!match) throw new Error("ensureNativeCompat not found in hooks/ensure-deps.mjs");

  // Also extract hasModernSqlite if ensureNativeCompat calls it (#331)
  const helperMatch = src.match(/^function hasModernSqlite\b[\s\S]*?^}/m);
  const helpers = helperMatch ? helperMatch[0] + "\n" : "";

  // Extract codesignBinary and probeNativeInChildProcess helpers if present
  const stampMatch = src.match(/^function nativeSwapStamp\b[\s\S]*?^}/m);
  const seedMatch = src.match(/^function seedAbiCacheEntry\b[\s\S]*?^}/m);
  const replaceBinaryMatch = src.match(/^function replaceActiveNativeBinaryFromCache\b[\s\S]*?^}/m);
  const codesignMatch = src.match(/^(?:export\s+)?function codesignBinary\b[\s\S]*?^}/m);
  const probeMatch = src.match(/^function probeNativeInChildProcess\b[\s\S]*?^}/m);
  const stamp = stampMatch ? stampMatch[0] + "\n" : "";
  const seed = seedMatch ? seedMatch[0] + "\n" : "";
  const replaceBinary = replaceBinaryMatch ? replaceBinaryMatch[0] + "\n" : "";
  const codesign = codesignMatch ? codesignMatch[0] + "\n" : "";
  const probe = probeMatch ? probeMatch[0] + "\n" : "";

  const tmpFile = join(tmpdir(), `abi-test-${Date.now()}.mjs`);
  writeFileSync(
    tmpFile,
    [
      'import { existsSync, copyFileSync, renameSync, unlinkSync, readFileSync, writeFileSync, statSync } from "node:fs";',
      'import { resolve } from "node:path";',
      'import { createRequire } from "node:module";',
      'import { execSync } from "node:child_process";',
      helpers,
      codesign,
      stamp,
      seed,
      replaceBinary,
      probe,
      `${match[0]}`,
    ].join("\n"),
  );

  try {
    const mod = await import(tmpFile);
    return mod.ensureNativeCompat;
  } finally {
    rmSync(tmpFile, { force: true });
  }
}

describe("ABI-aware native binary caching (#148)", () => {
  let tempDir: string;
  let releaseDir: string;
  let binaryPath: string;

  const currentAbi = process.versions.modules;

  function abiCachePath(abi: string = currentAbi): string {
    return join(releaseDir, `better_sqlite3.abi${abi}.node`);
  }

  function createFakeBinary(path: string, content: string = "fake-binary"): void {
    writeFileSync(path, content);
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "abi-test-"));
    releaseDir = join(tempDir, "node_modules", "better-sqlite3", "build", "Release");
    binaryPath = join(releaseDir, "better_sqlite3.node");
    mkdirSync(releaseDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("ensure-deps.mjs contains ensureNativeCompat function", () => {
    const src = readFileSync(resolve(ROOT, "hooks", "ensure-deps.mjs"), "utf-8");
    expect(src).toContain("function ensureNativeCompat");
    // ensure-deps.mjs auto-runs the function with root on import
    expect(src).toContain("ensureNativeCompat(root)");
  });

  test("cache hit: copies cached ABI binary to active path", async () => {
    const ensureNativeCompat = await loadEnsureNativeCompat();
    createFakeBinary(abiCachePath(), "abi-cached-binary");
    createFakeBinary(binaryPath, "old-binary");

    ensureNativeCompat(tempDir);

    expect(readFileSync(binaryPath, "utf-8")).toBe("abi-cached-binary");
  });

  test("missing release directory: does not throw", async () => {
    const ensureNativeCompat = await loadEnsureNativeCompat();
    rmSync(releaseDir, { recursive: true });

    expect(() => ensureNativeCompat(tempDir)).not.toThrow();
  });

  test("missing binary + no cache: does not throw", async () => {
    const ensureNativeCompat = await loadEnsureNativeCompat();
    expect(() => ensureNativeCompat(tempDir)).not.toThrow();
  });

  test("cache hit does not trigger rebuild", async () => {
    const ensureNativeCompat = await loadEnsureNativeCompat();
    createFakeBinary(abiCachePath(), "cached");
    createFakeBinary(binaryPath, "old");

    ensureNativeCompat(tempDir);

    expect(readFileSync(binaryPath, "utf-8")).toBe("cached");
  });

  test("cross-platform: ABI cache filename uses correct format", async () => {
    const ensureNativeCompat = await loadEnsureNativeCompat();
    createFakeBinary(binaryPath, "binary");

    // Trigger probe — will fail (fake binary) but outer catch swallows it
    ensureNativeCompat(tempDir);

    const files = readdirSync(releaseDir);
    const cacheFiles = files.filter((f) => f.match(/^better_sqlite3\.abi\d+\.node$/));
    // Probe fails on fake binary, so no cache file is created — that's correct behavior
    expect(cacheFiles.length).toBeLessThanOrEqual(1);
  });

  test("multiple ABI caches coexist without interference", async () => {
    const ensureNativeCompat = await loadEnsureNativeCompat();
    createFakeBinary(join(releaseDir, "better_sqlite3.abi115.node"), "node20-binary");
    createFakeBinary(join(releaseDir, "better_sqlite3.abi137.node"), "node24-binary");
    createFakeBinary(binaryPath, "old");

    ensureNativeCompat(tempDir);

    const expected = currentAbi === "115" ? "node20-binary" : currentAbi === "137" ? "node24-binary" : undefined;
    if (expected) {
      expect(readFileSync(binaryPath, "utf-8")).toBe(expected);
    }

    expect(existsSync(join(releaseDir, "better_sqlite3.abi115.node"))).toBe(true);
    expect(existsSync(join(releaseDir, "better_sqlite3.abi137.node"))).toBe(true);
  });

  // ── Bun must not write an ABI cache entry (#543 fixed, #1193) ─────
  //
  // #543 seeded `better_sqlite3.abi${N}.node` under Bun because
  // /open_ctx-upgrade used that file's existence as its "native addons OK"
  // marker, and Bun never got far enough to create it. The seed was wrong:
  // the name came from `process.versions.modules`, which Bun SPOOFS, while
  // the bytes came from whatever the last `npm rebuild` produced — an entry
  // whose name claimed one ABI and whose contents were another. Nothing
  // validated the claim and the cache-hit fast path swaps the entry into the
  // live slot on a name match alone, so a Node booting at the spoofed ABI
  // installed ABI-mismatched bytes as `better_sqlite3.node` (#1193).
  //
  // The correct resolution: under Bun there is nothing to write and nothing
  // to prove. better-sqlite3 is never dlopened (bun:sqlite, src/db-base.ts),
  // so the next real Node boot writes the entry from a binary IT probed.
  // /open_ctx-upgrade no longer demands the marker under Bun (src/cli.ts).
  //
  // @see https://github.com/mksglu/open-context-mode/issues/543
  // @see https://github.com/mksglu/open-context-mode/issues/1193

  describe("Bun does not write an ABI cache entry (#1193)", () => {
    let bunBackup: unknown;
    const hadBun = "Bun" in globalThis;

    beforeEach(() => {
      bunBackup = (globalThis as any).Bun;
      // Simulate Bun runtime without actually running under Bun.
      (globalThis as any).Bun = { version: "test-shim" };
    });

    afterEach(() => {
      if (hadBun) {
        (globalThis as any).Bun = bunBackup;
      } else {
        delete (globalThis as any).Bun;
      }
    });

    test("under Bun, with active .node but no abi cache: no entry is invented", async () => {
      // Load AFTER the Bun shim is installed so the function captures it.
      const ensureNativeCompat = await loadEnsureNativeCompat();
      createFakeBinary(binaryPath, "active-binary-from-postinstall");
      // Cache file is intentionally absent — this is the #543 scenario.
      expect(existsSync(abiCachePath())).toBe(false);

      ensureNativeCompat(tempDir);

      // #1193: writing `abi<spoofed>.node` here is what produced a cache entry
      // whose name claimed one ABI and whose bytes were another. The next
      // real Node boot writes it from a binary it probed.
      expect(existsSync(abiCachePath())).toBe(false);
      // Active binary remains untouched.
      expect(readFileSync(binaryPath, "utf-8")).toBe("active-binary-from-postinstall");
    });

    test("under Bun, without active .node source: does not throw and does not create cache", async () => {
      const ensureNativeCompat = await loadEnsureNativeCompat();
      // No active binary present — Bun-only install or pre-postinstall state.
      expect(existsSync(binaryPath)).toBe(false);

      expect(() => ensureNativeCompat(tempDir)).not.toThrow();

      // No cache should be invented out of thin air.
      expect(existsSync(abiCachePath())).toBe(false);
    });

    test("under Bun, when abi cache already exists: does not overwrite", async () => {
      const ensureNativeCompat = await loadEnsureNativeCompat();
      createFakeBinary(binaryPath, "fresh-active");
      createFakeBinary(abiCachePath(), "preexisting-cache");

      ensureNativeCompat(tempDir);

      // Idempotent: existing cache must be preserved untouched.
      expect(readFileSync(abiCachePath(), "utf-8")).toBe("preexisting-cache");
    });

    test("under Bun, when nativeDir is missing entirely: does not throw and does not create cache", async () => {
      const ensureNativeCompat = await loadEnsureNativeCompat();
      // Remove the release directory before invocation.
      rmSync(releaseDir, { recursive: true, force: true });
      expect(existsSync(releaseDir)).toBe(false);

      expect(() => ensureNativeCompat(tempDir)).not.toThrow();

      // Cache MUST NOT be created because the source dir doesn't exist —
      // creating files inside a deleted directory would either throw or
      // re-materialize state the user explicitly removed.
      expect(existsSync(abiCachePath())).toBe(false);
    });

    test("under Bun, cache filename uses cross-platform resolve() (no hard-coded separators)", () => {
      // Source-contract guard: the path construction (nativeDir / binaryPath /
      // abiCachePath) is resolve()'d at the top of ensureNativeCompat, and the
      // Bun gate must not build any path of its own. A future maintainer
      // re-adding a copy under the Bun branch with a hard-coded "/" or "\\"
      // would break Windows AND resurrect #1193.
      const src = readFileSync(resolve(ROOT, "hooks", "ensure-deps.mjs"), "utf-8");
      const fnMatch = src.match(/^export function ensureNativeCompat\b[\s\S]*?^}/m);
      expect(fnMatch).not.toBeNull();
      const body = fnMatch![0];
      // The pre-computed paths must still be referenced by the function.
      expect(body).toMatch(/binaryPath/);
      expect(body).toMatch(/abiCachePath/);
      // Cross-platform safety: no path string built with "\\" or "/" literals
      // inside the Bun gate region. We anchor on the Bun gate comment and
      // scan the surrounding region for forbidden hard-coded separators.
      const bunGateIdx = body.indexOf("Bun ships bun:sqlite");
      expect(bunGateIdx).toBeGreaterThan(-1);
      const bunRegion = body.slice(Math.max(0, bunGateIdx - 200), bunGateIdx + 600);
      // No string concatenation with hard-coded path separators in the Bun region.
      expect(bunRegion).not.toMatch(/["'][^"']*\\\\better_sqlite3/);
      expect(bunRegion).not.toMatch(/["']\/[^"']*better_sqlite3\.node["']/);
    });

    test("the Bun branch writes nothing at all (#1193 — a name Bun cannot back)", () => {
      const src = readFileSync(resolve(ROOT, "hooks", "ensure-deps.mjs"), "utf-8");
      const fnMatch = src.match(/^export function ensureNativeCompat\b[\s\S]*?^}/m);
      const body = fnMatch![0];
      const bunGateIdx = body.indexOf('if (typeof globalThis.Bun !== "undefined")');
      expect(bunGateIdx).toBeGreaterThan(-1);
      // The gate must be a bare early return: no copy, no rename, no mkdir.
      expect(body.slice(bunGateIdx)).toMatch(/if \(typeof globalThis\.Bun !== "undefined"\) return;/);
      // And no write to the ABI cache may exist anywhere before it.
      const beforeGate = body.slice(0, bunGateIdx);
      expect(beforeGate).not.toMatch(/copyFileSync|renameSync|writeFileSync|mkdirSync/);
    });
  });
});

// ── bun:sqlite adapter (#45) ──────────────────────────────────────────

describe("bun:sqlite adapter (#45)", () => {
  /**
   * Helper: create an in-memory SQLite db that behaves like bun:sqlite.
   * Uses better-sqlite3 as engine but strips/alters methods to match bun:sqlite API:
   * - NO .pragma() method
   * - .get() returns null instead of undefined
   * - .exec() is alias for single-statement .run()
   */
  async function createBunLikeFake(dbPath?: string) {
    const { loadDatabase } = await import("../../src/db-base.js");
    const Database = loadDatabase();
    const real = new Database(dbPath ?? ":memory:");

    const wrapStatement = (stmt: any) => ({
      run: (...args: any[]) => stmt.run(...args),
      get: (...args: any[]) => {
        const r = stmt.get(...args);
        return r === undefined ? null : r; // bun returns null
      },
      all: (...args: any[]) => stmt.all(...args),
      iterate: (...args: any[]) => stmt.iterate(...args),
      columns: () => stmt.columns(),
    });

    return {
      prepare: (sql: string) => wrapStatement(real.prepare(sql)),
      exec: (sql: string) => real.exec(sql),
      transaction: (fn: any) => real.transaction(fn),
      close: () => real.close(),
      // NO .pragma() — bun:sqlite doesn't have it
    };
  }

  test("pragma: adapter.pragma() returns scalar for assignment", async () => {
    const { BunSQLiteAdapter } = await import("../../src/db-base.js");
    const dbFile = join(mkdtempSync(join(tmpdir(), "bun-adapter-")), "test.db");
    const fake = await createBunLikeFake(dbFile);
    const db = new BunSQLiteAdapter(fake);
    const result = db.pragma("journal_mode = WAL");
    expect(result).toBe("wal");
    db.close();
    rmSync(dbFile, { force: true });
  });

  test("pragma: adapter.pragma() returns rows for table_xinfo", async () => {
    const { BunSQLiteAdapter } = await import("../../src/db-base.js");
    const fake = await createBunLikeFake();
    const db = new BunSQLiteAdapter(fake);
    fake.exec("CREATE TABLE test_tbl (id INTEGER PRIMARY KEY, name TEXT)");
    const rows = db.pragma("table_xinfo(test_tbl)");
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBe(2);
    expect(rows[0].name).toBe("id");
    expect(rows[1].name).toBe("name");
    db.close();
  });

  test("exec: adapter.exec() handles multi-statement SQL", async () => {
    const { BunSQLiteAdapter } = await import("../../src/db-base.js");
    const fake = await createBunLikeFake();
    const db = new BunSQLiteAdapter(fake);
    db.exec(`
      CREATE TABLE t1 (id INTEGER PRIMARY KEY);
      CREATE TABLE t2 (id INTEGER PRIMARY KEY);
      INSERT INTO t1 VALUES (1);
      INSERT INTO t2 VALUES (2);
    `);
    const r1 = db.prepare("SELECT * FROM t1").all();
    const r2 = db.prepare("SELECT * FROM t2").all();
    expect(r1).toHaveLength(1);
    expect(r2).toHaveLength(1);
    db.close();
  });

  test("exec: adapter.exec() handles semicolons inside string literals", async () => {
    const { BunSQLiteAdapter } = await import("../../src/db-base.js");
    const fake = await createBunLikeFake();
    const db = new BunSQLiteAdapter(fake);
    db.exec(`
      CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT);
      INSERT INTO t VALUES (1, 'hello; world');
      INSERT INTO t VALUES (2, 'foo "bar; baz" qux');
    `);
    const rows = db.prepare("SELECT * FROM t ORDER BY id").all() as any[];
    expect(rows).toHaveLength(2);
    expect(rows[0].val).toBe("hello; world");
    expect(rows[1].val).toBe('foo "bar; baz" qux');
    db.close();
  });

  test("exec: adapter.exec() ignores ; and quotes inside SQL comments", async () => {
    const { BunSQLiteAdapter } = await import("../../src/db-base.js");
    const fake = await createBunLikeFake();
    const db = new BunSQLiteAdapter(fake);
    db.exec(`
      CREATE TABLE t1 (id INTEGER PRIMARY KEY);
      -- don't add the index yet; revisit later
      CREATE TABLE t2 (id INTEGER PRIMARY KEY);
      /* it's staged; ship next release */
      CREATE TABLE t3 (id INTEGER PRIMARY KEY);
    `);
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
    expect(rows.map((r) => r.name)).toEqual(["t1", "t2", "t3"]);
    db.close();
  });

  test("exec: adapter.exec() skips comment-only statements", async () => {
    const { BunSQLiteAdapter } = await import("../../src/db-base.js");
    const fake = await createBunLikeFake();
    const db = new BunSQLiteAdapter(fake);
    expect(() => db.exec("-- migration header\n/* nothing to do */;")).not.toThrow();
    db.close();
  });

  test("get: adapter.prepare().get() returns undefined not null for missing row", async () => {
    const { BunSQLiteAdapter } = await import("../../src/db-base.js");
    const fake = await createBunLikeFake();
    const db = new BunSQLiteAdapter(fake);
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    const result = db.prepare("SELECT * FROM t WHERE id = 999").get();
    expect(result).toBeUndefined(); // not null
    expect(result).not.toBeNull();
    db.close();
  });

  test("run: adapter.prepare().run() returns {changes, lastInsertRowid}", async () => {
    const { BunSQLiteAdapter } = await import("../../src/db-base.js");
    const fake = await createBunLikeFake();
    const db = new BunSQLiteAdapter(fake);
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)");
    const info = db.prepare("INSERT INTO t (name) VALUES (?)").run("test");
    expect(info.changes).toBe(1);
    expect(info.lastInsertRowid).toBe(1);
    db.close();
  });

  test("transaction: adapter.transaction() works", async () => {
    const { BunSQLiteAdapter } = await import("../../src/db-base.js");
    const fake = await createBunLikeFake();
    const db = new BunSQLiteAdapter(fake);
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)");
    const insertMany = db.transaction((items: string[]) => {
      for (const item of items) {
        db.prepare("INSERT INTO t (val) VALUES (?)").run(item);
      }
    });
    insertMany(["a", "b", "c"]);
    const rows = db.prepare("SELECT * FROM t").all();
    expect(rows).toHaveLength(3);
    db.close();
  });

  test("loadDatabase: checks globalThis.Bun before choosing driver (#163)", () => {
    // Bun's require("better-sqlite3") returns a non-functional stub.
    // loadDatabase() must check globalThis.Bun FIRST and use bun:sqlite directly.
    const src = readFileSync(resolve(ROOT, "src", "db-base.ts"), "utf-8");
    const loadDbSection = src.slice(src.indexOf("function loadDatabase"), src.indexOf("return _Database"));
    // Must check Bun runtime before loading any driver
    expect(loadDbSection).toContain("globalThis");
    expect(loadDbSection).toContain("Bun");
    // Bun path must use bun:sqlite via BunSQLiteAdapter
    expect(loadDbSection).toContain("BunSQLiteAdapter");
    // Node path uses better-sqlite3
    expect(loadDbSection).toContain("better-sqlite3");
  });

  test("loadDatabase: falls back to BunSQLiteAdapter when better-sqlite3 unavailable", async () => {
    const { BunSQLiteAdapter } = await import("../../src/db-base.js");
    // BunSQLiteAdapter should be a class/constructor
    expect(typeof BunSQLiteAdapter).toBe("function");
    // Verify it provides the full better-sqlite3 interface
    const fake = await createBunLikeFake();
    const db = new BunSQLiteAdapter(fake);
    expect(typeof db.pragma).toBe("function");
    expect(typeof db.exec).toBe("function");
    expect(typeof db.prepare).toBe("function");
    expect(typeof db.transaction).toBe("function");
    expect(typeof db.close).toBe("function");
    db.close();
  });
});

// ── node:sqlite adapter (#228) ──────────────────────────────────────────

describe("node:sqlite adapter (#228)", () => {
  /**
   * Helper: create an in-memory SQLite db that behaves like node:sqlite's DatabaseSync.
   * Uses better-sqlite3 as engine but strips/alters methods to match node:sqlite API:
   * - NO .pragma() method
   * - NO .transaction() method
   * - .exec() supports multi-statement natively (better-sqlite3 already does)
   * - .get() returns undefined (same as better-sqlite3)
   * - .prepare() returns StatementSync-like objects
   */
  async function createNodeSQLiteFake(dbPath?: string) {
    const { loadDatabase } = await import("../../src/db-base.js");
    // Reset cached _Database to get fresh better-sqlite3
    const Database = loadDatabase();
    const real = new Database(dbPath ?? ":memory:");

    return {
      prepare: (sql: string) => {
        const stmt = real.prepare(sql);
        return {
          run: (...args: any[]) => stmt.run(...args),
          get: (...args: any[]) => stmt.get(...args),
          all: (...args: any[]) => stmt.all(...args),
          // node:sqlite doesn't have iterate() — has Symbol.iterator
          [Symbol.iterator]: (...args: any[]) => stmt.iterate(...args),
        };
      },
      exec: (sql: string) => real.exec(sql),
      // NO .pragma() — node:sqlite doesn't have it
      // NO .transaction() — node:sqlite doesn't have it
      close: () => real.close(),
    };
  }

  test("pragma: adapter.pragma() returns scalar for assignment", async () => {
    const { NodeSQLiteAdapter } = await import("../../src/db-base.js");
    const dbFile = join(mkdtempSync(join(tmpdir(), "node-adapter-")), "test.db");
    const fake = await createNodeSQLiteFake(dbFile);
    const db = new NodeSQLiteAdapter(fake);
    const result = db.pragma("journal_mode = WAL");
    expect(result).toBe("wal");
    db.close();
    rmSync(dbFile, { force: true });
  });

  test("pragma: adapter.pragma() returns rows for table_xinfo", async () => {
    const { NodeSQLiteAdapter } = await import("../../src/db-base.js");
    const fake = await createNodeSQLiteFake();
    const db = new NodeSQLiteAdapter(fake);
    fake.exec("CREATE TABLE test_tbl (id INTEGER PRIMARY KEY, name TEXT)");
    const rows = db.pragma("table_xinfo(test_tbl)");
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBe(2);
    expect(rows[0].name).toBe("id");
    expect(rows[1].name).toBe("name");
    db.close();
  });

  test("exec: adapter.exec() handles multi-statement SQL", async () => {
    const { NodeSQLiteAdapter } = await import("../../src/db-base.js");
    const fake = await createNodeSQLiteFake();
    const db = new NodeSQLiteAdapter(fake);
    db.exec(`
      CREATE TABLE t1 (id INTEGER PRIMARY KEY);
      CREATE TABLE t2 (id INTEGER PRIMARY KEY);
      INSERT INTO t1 VALUES (1);
      INSERT INTO t2 VALUES (2);
    `);
    const r1 = db.prepare("SELECT * FROM t1").all();
    const r2 = db.prepare("SELECT * FROM t2").all();
    expect(r1).toHaveLength(1);
    expect(r2).toHaveLength(1);
    db.close();
  });

  test("get: adapter.prepare().get() returns undefined for missing row", async () => {
    const { NodeSQLiteAdapter } = await import("../../src/db-base.js");
    const fake = await createNodeSQLiteFake();
    const db = new NodeSQLiteAdapter(fake);
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    const result = db.prepare("SELECT * FROM t WHERE id = 999").get();
    expect(result).toBeUndefined();
    db.close();
  });

  test("run: adapter.prepare().run() returns {changes, lastInsertRowid}", async () => {
    const { NodeSQLiteAdapter } = await import("../../src/db-base.js");
    const fake = await createNodeSQLiteFake();
    const db = new NodeSQLiteAdapter(fake);
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)");
    const info = db.prepare("INSERT INTO t (name) VALUES (?)").run("test");
    expect(info.changes).toBe(1);
    expect(info.lastInsertRowid).toBe(1);
    db.close();
  });

  test("transaction: adapter.transaction() commits on success", async () => {
    const { NodeSQLiteAdapter } = await import("../../src/db-base.js");
    const fake = await createNodeSQLiteFake();
    const db = new NodeSQLiteAdapter(fake);
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)");
    const insertMany = db.transaction((items: string[]) => {
      for (const item of items) {
        db.prepare("INSERT INTO t (val) VALUES (?)").run(item);
      }
    });
    insertMany(["a", "b", "c"]);
    const rows = db.prepare("SELECT * FROM t").all();
    expect(rows).toHaveLength(3);
    db.close();
  });

  test("transaction: adapter.transaction() rolls back on error", async () => {
    const { NodeSQLiteAdapter } = await import("../../src/db-base.js");
    const fake = await createNodeSQLiteFake();
    const db = new NodeSQLiteAdapter(fake);
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)");
    const failingTx = db.transaction(() => {
      db.prepare("INSERT INTO t (val) VALUES (?)").run("should-rollback");
      throw new Error("intentional");
    });
    expect(() => failingTx()).toThrow("intentional");
    const rows = db.prepare("SELECT * FROM t").all();
    expect(rows).toHaveLength(0); // rolled back
    db.close();
  });

  test("loadDatabase: source uses hasModernSqlite() before choosing node:sqlite (#228, #551)", () => {
    const src = readFileSync(resolve(ROOT, "src", "db-base.ts"), "utf-8");
    const loadDbSection = src.slice(src.indexOf("function loadDatabase"), src.indexOf("return _Database"));
    // #551: gate widened from `process.platform === "linux"` to
    // hasModernSqlite() — Node 26 broke better-sqlite3 native compile on
    // macOS arm64, so we prefer node:sqlite on every platform that has it.
    expect(loadDbSection).toContain("hasModernSqlite()");
    expect(loadDbSection).not.toMatch(/process\.platform\s*===\s*"linux"/);
    // Must reference NodeSQLiteAdapter
    expect(loadDbSection).toContain("NodeSQLiteAdapter");
    // Must still have better-sqlite3 fallback
    expect(loadDbSection).toContain("better-sqlite3");
  });

  test("NodeSQLiteAdapter provides full better-sqlite3 interface", async () => {
    const { NodeSQLiteAdapter } = await import("../../src/db-base.js");
    const fake = await createNodeSQLiteFake();
    const db = new NodeSQLiteAdapter(fake);
    expect(typeof db.pragma).toBe("function");
    expect(typeof db.exec).toBe("function");
    expect(typeof db.prepare).toBe("function");
    expect(typeof db.transaction).toBe("function");
    expect(typeof db.close).toBe("function");
    db.close();
  });
});

// ── Shared dep bootstrap (#172) ──────────────────────────────────────

describe("hooks/ensure-deps.mjs — shared bootstrap", () => {
  it("ensure-deps.mjs exists and exports ensureDeps function", async () => {
    expect(existsSync(resolve(ROOT, "hooks", "ensure-deps.mjs"))).toBe(true);
    const mod = await import("../../hooks/ensure-deps.mjs");
    expect(typeof mod.ensureDeps).toBe("function");
  });

  it("start.mjs uses ensure-deps.mjs for native deps", () => {
    const src = readFileSync(resolve(ROOT, "start.mjs"), "utf-8");
    expect(src).toContain("ensure-deps.mjs");
    // better-sqlite3 should NOT be in start.mjs inline loop (handled by ensure-deps)
    expect(src).not.toMatch(/for.*\[.*"better-sqlite3"/s);
  });

  it("all session hooks bootstrap ensure-deps via runHook wrapper (#414)", () => {
    // After #414 fix: top-level static `import "./ensure-deps.mjs"` was a
    // parse-time crash vector on Windows (loader:1479 bypassed try/catch).
    // ensure-deps is now dynamic-imported inside hooks/run-hook.mjs.
    const runHookSrc = readFileSync(resolve(ROOT, "hooks", "run-hook.mjs"), "utf-8");
    expect(runHookSrc).toContain("ensure-deps.mjs");

    const sessionHooks = [
      "hooks/sessionstart.mjs",
      "hooks/posttooluse.mjs",
      "hooks/precompact.mjs",
      "hooks/userpromptsubmit.mjs",
      "hooks/pretooluse.mjs",
    ];
    for (const hook of sessionHooks) {
      const src = readFileSync(resolve(ROOT, hook), "utf-8");
      expect(src).toContain("run-hook.mjs");
      // Top-level static side-effect import must NOT remain (would bypass uncaughtException).
      expect(src).not.toMatch(/^import\s+["']\.\/ensure-deps\.mjs["'];?$/m);
    }
  });
});

// ── Cross-OS compatibility ────────────────────────────────────────────

describe("Cross-OS compatibility", () => {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf-8"));
  const src = readFileSync(resolve(ROOT, "src", "cli.ts"), "utf-8");

  it("build script does not shell out to POSIX chmod command", () => {
    // Shell `chmod +x` is not available on Windows cmd.exe
    // Node.js fs.chmodSync is cross-platform and acceptable
    expect(pkg.scripts.build).not.toMatch(/\bchmod\s+\+x\b/);
  });

  it("postinstall script uses node for cross-platform compatibility", () => {
    // POSIX [ -n ... ] && printf || true fails on Windows cmd.exe
    expect(pkg.scripts.postinstall).not.toMatch(/\[ -n/);
    expect(pkg.scripts.postinstall).not.toContain("printf");
    expect(pkg.scripts.postinstall).toMatch(/^node /);
    // postinstall.mjs must be in files array for npm publish
    expect(pkg.files).toContain("scripts/postinstall.mjs");
  });
});

// ── Bin entry: cli.bundle.mjs ─────────────────────────────────────────

describe("Bin entry uses cli.bundle.mjs", () => {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf-8"));

  it("package.json bin points to cli.bundle.mjs, not build/cli.js", () => {
    expect(pkg.bin["open-context-mode"]).toBe("./cli.bundle.mjs");
  });

  it("package.json exports ./cli points to cli.bundle.mjs", () => {
    expect(pkg.exports["./cli"]).toBe("./cli.bundle.mjs");
  });

  it("server.ts open_ctx_doctor runs diagnostics in-process (no CLI dependency)", () => {
    const src = readFileSync(resolve(ROOT, "src", "server.ts"), "utf-8");
    const doctorSection = src.slice(src.indexOf("open_ctx_doctor"), src.indexOf("open_ctx_purge"));
    // Must NOT delegate to CLI — runs server-side
    expect(doctorSection).not.toContain('node "');
    // Must run actual checks
    expect(doctorSection).toContain("PolyglotExecutor");
    expect(doctorSection).toContain("FTS5");
  });

  it("doctor hook script discovery supports flat and nested hook config entries", () => {
    const helperSrc = readFileSync(resolve(ROOT, "src", "util", "hook-config.ts"), "utf-8");
    expect(helperSrc).toContain("export function getCommandsFromHookEntry");
    expect(helperSrc).toContain("(entry as { command?: unknown }).command");
    expect(helperSrc).toContain("Array.isArray(hooks)");
    expect(helperSrc).toContain("getCommandsFromHookEntry(entry)");
    expect(helperSrc).not.toContain("entry.hooks");

    for (const rel of ["src/cli.ts", "src/server.ts"]) {
      const src = readFileSync(resolve(ROOT, rel), "utf-8");
      expect(src).toContain('import { getHookScriptPaths } from "./util/hook-config.js";');
      expect(src).not.toContain("function getCommandsFromHookEntry");
      expect(src).not.toContain("function getHookScriptPaths");
    }
  });

  it("cli doctor treats standalone adapters as not version-comparable", () => {
    const src = readFileSync(resolve(ROOT, "src", "cli.ts"), "utf-8");
    const versionStart = src.indexOf("Checking versions");
    const versionBlock = src.slice(versionStart, versionStart + 1800);

    expect(versionBlock).toContain('installedVersion === "standalone"');
    expect(versionBlock).toContain("standalone MCP mode");
    expect(versionBlock).toContain("no platform plugin version to compare");
    expect(versionBlock.indexOf('installedVersion === "standalone"')).toBeLessThan(
      versionBlock.indexOf('installedVersion === "not installed"'),
    );
  });

  it("server.ts registers empty prompts/resources handlers to avoid -32601 (#168)", () => {
    const src = readFileSync(resolve(ROOT, "src", "server.ts"), "utf-8");
    // Must register prompts capability so clients don't get Method not found
    expect(src).toContain("ListPromptsRequestSchema");
    // Must register resources capability
    expect(src).toContain("ListResourcesRequestSchema");
    // Must return empty arrays
    expect(src).toContain("prompts: []");
    expect(src).toContain("resources: []");
  });
});

// ── start.mjs CLI self-heal ───────────────────────────────────────────

describe("start.mjs CLI self-heal", () => {
  test("start.mjs self-heals cli.bundle.mjs when missing", () => {
    const src = readFileSync(resolve(ROOT, "start.mjs"), "utf-8");
    // Must check for cli.bundle.mjs existence
    expect(src).toContain("cli.bundle.mjs");
    // Must reference build/cli.js as fallback source
    expect(src).toContain("build");
    expect(src).toContain("cli.js");
    // Must write a shim
    expect(src).toContain("writeFileSync");
  });

  test("start.mjs CLI self-heal is after ensure-deps import and before server import", () => {
    const src = readFileSync(resolve(ROOT, "start.mjs"), "utf-8");
    // Anchor on actual statements, not raw filename mentions. The Linux Bun
    // re-exec change in commit f985afa added a documentation comment that
    // names `server.bundle.mjs` near the top of the file; `indexOf` matched
    // THAT comment instead of the actual `await import("./server.bundle.mjs")`,
    // pushing the assertion to compare selfHealIdx=16381 < commentIdx=2347 →
    // FAIL on otherwise-correct ordering. Use uniquely-shaped statement
    // fragments so a future comment cannot shift the test's compass.
    const ensureDepsIdx = src.indexOf('import "./hooks/ensure-deps.mjs"');
    const selfHealIdx = src.indexOf('if (!existsSync(resolve(__dirname, "cli.bundle.mjs"))');
    const serverImportIdx = src.indexOf('await import("./server.bundle.mjs")');
    expect(ensureDepsIdx, "ensure-deps import statement missing").toBeGreaterThan(-1);
    expect(selfHealIdx, "cli.bundle.mjs self-heal block missing").toBeGreaterThan(-1);
    expect(serverImportIdx, "server.bundle.mjs await-import missing").toBeGreaterThan(-1);
    // Self-heal must be between ensure-deps import and server import.
    expect(selfHealIdx).toBeGreaterThan(ensureDepsIdx);
    expect(selfHealIdx).toBeLessThan(serverImportIdx);
  });

  // ── Algo-D4: plugin-cache integrity from package.json files[] ──
  //
  // #550: partial install (e.g. interrupted npm install, broken
  // marketplace pull) leaves start.mjs spawnable but server.bundle.mjs
  // missing. The MCP child then dies silently downstream — user sees
  // "MCP server failed to start" with no actionable signal. D4 derives
  // the expected sibling tree from package.json files[] (the npm publish
  // source of truth) and exits 2 with a structured stderr block listing
  // the missing files. Algorithmic: adding a new entry to files[] auto-
  // extends the integrity check — no parallel hardcoded list to
  // maintain.
  test("scripts/plugin-cache-integrity.mjs derives expected files from package.json files[]", async () => {
    const { derivePluginManifest } = await import("../../scripts/plugin-cache-integrity.mjs");
    // Synthetic package.json: directories recurse; files are kept as-is.
    const pkg = {
      files: ["server.bundle.mjs", "cli.bundle.mjs", "hooks", "start.mjs"],
    };
    const helperRoot = mkdtempSync(join(tmpdir(), "open_ctx-mode-pcim-"));
    try {
      // Build a tree shaped like the npm tarball
      writeFileSync(join(helperRoot, "server.bundle.mjs"), "");
      writeFileSync(join(helperRoot, "cli.bundle.mjs"), "");
      writeFileSync(join(helperRoot, "start.mjs"), "");
      mkdirSync(join(helperRoot, "hooks"));
      writeFileSync(join(helperRoot, "hooks", "pretooluse.mjs"), "");
      writeFileSync(join(helperRoot, "hooks", "sessionstart.mjs"), "");

      const manifest = derivePluginManifest({ pkg, pluginRoot: helperRoot });
      // Files in files[] kept as-is; directories recurse to enumerate
      // every file inside.
      expect(manifest).toContain("server.bundle.mjs");
      expect(manifest).toContain("cli.bundle.mjs");
      expect(manifest).toContain("start.mjs");
      expect(manifest).toContain(join("hooks", "pretooluse.mjs"));
      expect(manifest).toContain(join("hooks", "sessionstart.mjs"));
    } finally {
      rmSync(helperRoot, { recursive: true, force: true });
    }
  });

  test("scripts/plugin-cache-integrity.mjs returns OK when all expected siblings exist", async () => {
    const { assertPluginCacheIntegrity } = await import("../../scripts/plugin-cache-integrity.mjs");
    // The actual repo root has every entry from package.json files[]
    // present (it's the source of truth that gets published). So a
    // probe against ROOT must return ok=true.
    const result = assertPluginCacheIntegrity({ pluginRoot: ROOT });
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
  });

  test("scripts/plugin-cache-integrity.mjs flags missing files as not-ok", async () => {
    const { assertPluginCacheIntegrity } = await import("../../scripts/plugin-cache-integrity.mjs");
    // Empty pluginRoot → every required file is missing.
    const emptyRoot = mkdtempSync(join(tmpdir(), "open_ctx-mode-pcim-empty-"));
    try {
      const result = assertPluginCacheIntegrity({ pluginRoot: emptyRoot });
      expect(result.ok).toBe(false);
      expect(result.missing.length).toBeGreaterThan(0);
      // The check must surface the absolute path so users can see
      // exactly where it looked — not a relative segment.
      for (const m of result.missing) {
        expect(m.startsWith(emptyRoot)).toBe(true);
      }
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  });

  test("start.mjs invokes assertPluginCacheIntegrity with stderr + exit 2 on failure (Algo-D4)", () => {
    // Wiring check on the bootstrapper itself: the start.mjs body must
    // import the helper, call it, and on `!ok` write a structured stderr
    // block (OPEN_CONTEXT_MODE_PARTIAL_INSTALL) then process.exit(2). The
    // structured marker lets external monitoring grep for the exact
    // failure mode without parsing free-form text.
    const src = readFileSync(resolve(ROOT, "start.mjs"), "utf-8");
    expect(src).toContain("plugin-cache-integrity.mjs");
    expect(src).toContain("assertPluginCacheIntegrity");
    expect(src).toContain("OPEN_CONTEXT_MODE_PARTIAL_INSTALL");
    expect(src).toMatch(/process\.exit\(\s*2\s*\)/);
  });

  test("scripts/plugin-cache-integrity.mjs ships in npm tarball (package.json files[])", () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf-8"));
    expect(pkg.files).toContain("scripts/plugin-cache-integrity.mjs");
  });

  // ── findMissingLaunchFiles — partial-install masking regression (PR #689) ──
  //
  // When an interrupted /open_ctx-upgrade swap leaves the active plugin-cache dir
  // half-populated, the integrity helper itself
  // (scripts/plugin-cache-integrity.mjs, shipped in package.json files[]) can
  // be among the missing files. The doctor then reported only "integrity
  // helper unavailable", masking the real breakage: the MCP launch entrypoint
  // (start.mjs / server bundle) was also gone, so
  // `node ${CLAUDE_PLUGIN_ROOT}/start.mjs` failed and the MCP server never
  // started.
  //
  // findMissingLaunchFiles is a dependency-free (fs-only) check that surfaces
  // exactly which launch files are absent, so the diagnostic stays useful even
  // when the integrity helper module cannot load. Folded from the original
  // tests/util/plugin-cache-launch-files.test.ts in PR #689 per CONTRIBUTING
  // L282 (no new test files — extend the existing file for the domain).
  describe("findMissingLaunchFiles (PR #689)", () => {
    let root: string;

    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), "open_ctx-launch-files-"));
    });
    afterEach(() => {
      rmSync(root, { recursive: true, force: true });
    });

    const touch = (rel: string): void => {
      const abs = join(root, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, "");
    };

    it("returns [] when start.mjs and server.bundle.mjs are present", () => {
      touch("start.mjs");
      touch("server.bundle.mjs");
      expect(findMissingLaunchFiles(root)).toEqual([]);
    });

    it("flags a missing start.mjs (the no-fallback command entrypoint)", () => {
      touch("server.bundle.mjs");
      expect(findMissingLaunchFiles(root)).toEqual(["start.mjs"]);
    });

    it("accepts build/server.js as the server fallback (no false positive)", () => {
      touch("start.mjs");
      touch("build/server.js"); // server.bundle.mjs absent, but fallback present
      expect(findMissingLaunchFiles(root)).toEqual([]);
    });

    it("flags the server only when BOTH server.bundle.mjs and build/server.js are absent", () => {
      touch("start.mjs");
      expect(findMissingLaunchFiles(root)).toEqual(["server.bundle.mjs (or build/server.js)"]);
    });

    it("reports every missing launch file for a fully empty (partial) install", () => {
      // Reproduces the observed broken cache: neither the entrypoint nor the
      // server bundle was copied by the interrupted swap.
      expect(findMissingLaunchFiles(root)).toEqual(["start.mjs", "server.bundle.mjs (or build/server.js)"]);
    });
  });

  // ── Algo-D4 — algorithmic runtime-sibling derivation (#558) ──────────
  //
  // v1.0.126 shipped Algo-D4 with a HARDCODED `REQUIRED_RUNTIME_SIBLINGS`
  // array that omitted `hooks/security.bundle.mjs` (and would omit any
  // future runtime-critical bundle). Result: the integrity check returns
  // `{ ok: true }` on a marketplace install where `hooks/security.bundle.mjs`
  // is missing — exactly the silent fail-open #558 reports. The fix is
  // algorithmic: derive the required-sibling set from `derivePluginManifest`
  // (which itself reads `package.json files[]`), filtered to a runtime-
  // critical pattern. Adding `hooks/security.bundle.mjs` (or any future
  // hooks/*.bundle.mjs) to files[] auto-extends the integrity check.
  test("Algo-D4 algorithmically requires hooks/security.bundle.mjs (#558)", async () => {
    // Synthesize a marketplace-install scenario: every hardcoded boot
    // sibling is present, but hooks/security.bundle.mjs is NOT. The pre-
    // 558 hardcoded check passes vacuously here — that's the regression.
    const { assertPluginCacheIntegrity } = await import("../../scripts/plugin-cache-integrity.mjs");
    const fakeRoot = mkdtempSync(join(tmpdir(), "open_ctx-mode-d4-algo-"));
    try {
      // Stage every legacy-hardcoded sibling so the test isolates the
      // new requirement: only hooks/security.bundle.mjs is missing.
      writeFileSync(join(fakeRoot, "server.bundle.mjs"), "");
      writeFileSync(join(fakeRoot, "cli.bundle.mjs"), "");
      writeFileSync(join(fakeRoot, "start.mjs"), "");
      mkdirSync(join(fakeRoot, "hooks"));
      writeFileSync(join(fakeRoot, "hooks", "pretooluse.mjs"), "");
      writeFileSync(join(fakeRoot, "hooks", "posttooluse.mjs"), "");
      writeFileSync(join(fakeRoot, "hooks", "precompact.mjs"), "");
      writeFileSync(join(fakeRoot, "hooks", "sessionstart.mjs"), "");
      writeFileSync(join(fakeRoot, "hooks", "userpromptsubmit.mjs"), "");
      // Copy the real package.json so the algorithm reads the same
      // files[] the npm tarball ships with.
      const pkgSrc = readFileSync(resolve(ROOT, "package.json"), "utf-8");
      writeFileSync(join(fakeRoot, "package.json"), pkgSrc);

      const result = assertPluginCacheIntegrity({ pluginRoot: fakeRoot });
      expect(result.ok).toBe(false);
      // Must surface the missing security bundle path so the doctor /
      // boot-fail block tells users exactly what's broken.
      const missingStr = result.missing.join("\n");
      expect(missingStr).toContain("security.bundle.mjs");
    } finally {
      rmSync(fakeRoot, { recursive: true, force: true });
    }
  });

  test("Algo-D4 derivation reads scripts.bundle outfiles — pure-data, no parallel hardcoded list", async () => {
    // Algorithmic guarantee: a future runtime bundle added to
    // `scripts.bundle` (with `--outfile=hooks/foo.bundle.mjs`) is
    // auto-gated by Algo-D4 — no parallel REQUIRED_RUNTIME_SIBLINGS
    // edit needed. Soft-fallback bundles (session-* with
    // bundle-first/build-fallback in session-loaders.mjs) are
    // explicitly whitelisted out.
    const mod: any = await import("../../scripts/plugin-cache-integrity.mjs");
    // The new public surface — algorithm must be inspectable from tests.
    expect(typeof mod.getRequiredRuntimeSiblings).toBe("function");

    const fakeRoot = mkdtempSync(join(tmpdir(), "open_ctx-mode-d4-pkg-"));
    try {
      // Synthetic package.json: scripts.bundle produces 3 outfiles.
      //   - hooks/security.bundle.mjs is runtime-critical → required.
      //   - hooks/session-db.bundle.mjs is soft-fallback → NOT required.
      //   - hooks/foo.bundle.mjs is a hypothetical future bundle → required
      //     (proves the gate auto-extends without code changes).
      const pkg = {
        files: ["server.bundle.mjs", "cli.bundle.mjs", "hooks", "start.mjs"],
        scripts: {
          bundle:
            "esbuild src/security.ts --outfile=hooks/security.bundle.mjs && " +
            "esbuild src/session/db.ts --outfile=hooks/session-db.bundle.mjs && " +
            "esbuild src/foo.ts --outfile=hooks/foo.bundle.mjs",
        },
      };
      writeFileSync(join(fakeRoot, "package.json"), JSON.stringify(pkg));

      const required: string[] = mod.getRequiredRuntimeSiblings(fakeRoot);
      // Runtime-critical bundle must be in the set:
      expect(required.some((p) => p.endsWith("security.bundle.mjs"))).toBe(true);
      // Hypothetical future bundle auto-included (the algorithmic win):
      expect(required.some((p) => p.endsWith("foo.bundle.mjs"))).toBe(true);
      // Soft-fallback bundle MUST be excluded — its absence is gracefully
      // handled by session-loaders.mjs's bundle-first/build-fallback.
      expect(required.some((p) => p.endsWith("session-db.bundle.mjs"))).toBe(false);
    } finally {
      rmSync(fakeRoot, { recursive: true, force: true });
    }
  });

  test("Algo-D4 preserves the legacy hardcoded contract (no regression on existing required siblings)", async () => {
    // Backward-compat guarantee: every entry that used to be in the
    // hardcoded REQUIRED_RUNTIME_SIBLINGS array must still be flagged
    // as required by the algorithmic derivation. This pins the
    // pre-558 contract so the algorithmic refactor is purely additive.
    const mod: any = await import("../../scripts/plugin-cache-integrity.mjs");
    const required: string[] = mod.getRequiredRuntimeSiblings(ROOT);
    const legacy = [
      "server.bundle.mjs",
      "cli.bundle.mjs",
      join("hooks", "pretooluse.mjs"),
      join("hooks", "posttooluse.mjs"),
      join("hooks", "precompact.mjs"),
      join("hooks", "sessionstart.mjs"),
      join("hooks", "userpromptsubmit.mjs"),
    ];
    for (const entry of legacy) {
      expect(
        required.some((p) => p === entry || p.endsWith(entry)),
        `legacy required sibling missing from algorithmic set: ${entry}`,
      ).toBe(true);
    }
  });

  // ── hooks/heal-partial-install.mjs (partial-install auto-recovery) ──
  //
  // Claude Code's native plugin manager occasionally produces a partial
  // install when it creates a new cache version directory: hooks/ and
  // .claude-plugin/ make it across, but cli.bundle.mjs, server.bundle.mjs,
  // start.mjs, package.json, src/, bin/, scripts/, and skills/ don't. The
  // .claude-plugin/plugin.json carries forward from the previous version
  // with a stale absolute mcpServers.args[0]; once the old version dir is
  // age-gate-cleaned, every MCP spawn ENOENTs.
  //
  // The existing #550 boot gate and the #604 stale-cache-version ratchet
  // both fire from start.mjs, the very file that's missing. The heal
  // module lives in hooks/ since that's the directory that reliably
  // survives the partial copy, and runs from hooks/sessionstart.mjs (the
  // primary trigger) and start.mjs (belt-and-braces, before the Algo-D4
  // gate so a fixable install is repaired rather than just reported).
  describe("hooks/heal-partial-install.mjs (partial-install auto-recovery)", () => {
    const heallessCleanups: string[] = [];

    afterEach(() => {
      while (heallessCleanups.length) {
        const dir = heallessCleanups.pop();
        if (dir) {
          try {
            rmSync(dir, { recursive: true, force: true });
          } catch {
            /* best effort */
          }
        }
      }
    });

    function makeTmp(prefix = "open_ctx-heal-partial-"): string {
      const dir = mkdtempSync(join(tmpdir(), prefix));
      heallessCleanups.push(dir);
      return dir;
    }

    // Build a fake CC plugin layout under a fresh tmp dir:
    //   <root>/.claude/plugins/cache/open-context-mode/open-context-mode/<version>/
    //   <root>/.claude/plugins/marketplaces/open-context-mode/
    // The marketplace clone gets a realistic package.json files[] pointing
    // at a few canned dirs + files so the heal has concrete sources to
    // copy. The cache dir starts empty so each test can populate the exact
    // subset it wants to simulate.
    function buildFakeLayout(version = "1.0.150"): {
      pluginRoot: string;
      marketplaceClonePath: string;
    } {
      const root = makeTmp();
      const pluginsDir = resolve(root, ".claude", "plugins");
      const pluginRoot = resolve(pluginsDir, "cache", "open-context-mode", "open-context-mode", version);
      const marketplaceClonePath = resolve(pluginsDir, "marketplaces", "open-context-mode");
      mkdirSync(marketplaceClonePath, { recursive: true });
      writeFileSync(
        resolve(marketplaceClonePath, "package.json"),
        JSON.stringify(
          {
            name: "open-context-mode",
            version,
            files: [
              "hooks",
              ".claude-plugin",
              "scripts/postinstall.mjs",
              "scripts/plugin-cache-integrity.mjs",
              "cli.bundle.mjs",
              "server.bundle.mjs",
              "start.mjs",
              "bin",
            ],
          },
          null,
          2,
        ),
      );
      writeFileSync(resolve(marketplaceClonePath, "start.mjs"), "// start\n");
      writeFileSync(resolve(marketplaceClonePath, "cli.bundle.mjs"), "// cli bundle\n");
      writeFileSync(resolve(marketplaceClonePath, "server.bundle.mjs"), "// server bundle\n");
      mkdirSync(resolve(marketplaceClonePath, "hooks"), { recursive: true });
      writeFileSync(resolve(marketplaceClonePath, "hooks", "sessionstart.mjs"), "// hook\n");
      mkdirSync(resolve(marketplaceClonePath, ".claude-plugin"), {
        recursive: true,
      });
      writeFileSync(
        resolve(marketplaceClonePath, ".claude-plugin", "plugin.json"),
        JSON.stringify(
          {
            name: "open-context-mode",
            version,
            mcpServers: {
              "open-context-mode": {
                command: "node",
                args: ["${CLAUDE_PLUGIN_ROOT}/start.mjs"],
              },
            },
          },
          null,
          2,
        ),
      );
      mkdirSync(resolve(marketplaceClonePath, "scripts"), { recursive: true });
      writeFileSync(resolve(marketplaceClonePath, "scripts", "postinstall.mjs"), "// postinstall\n");
      writeFileSync(resolve(marketplaceClonePath, "scripts", "plugin-cache-integrity.mjs"), "// integrity\n");
      mkdirSync(resolve(marketplaceClonePath, "bin"), { recursive: true });
      writeFileSync(resolve(marketplaceClonePath, "bin", "statusline.mjs"), "// statusline\n");
      mkdirSync(pluginRoot, { recursive: true });
      return { pluginRoot, marketplaceClonePath };
    }

    function readJson(path: string): unknown {
      return JSON.parse(readFileSync(path, "utf-8"));
    }

    // ── isPartialInstall cheap probe ──

    it("isPartialInstall returns false for a healthy install", async () => {
      const { isPartialInstall } = await import("../../hooks/heal-partial-install.mjs");
      const { pluginRoot, marketplaceClonePath } = buildFakeLayout();
      cpSync(marketplaceClonePath, pluginRoot, { recursive: true, force: true });
      expect(isPartialInstall(pluginRoot)).toBe(false);
    });

    it("isPartialInstall returns true when start.mjs is missing", async () => {
      const { isPartialInstall } = await import("../../hooks/heal-partial-install.mjs");
      const { pluginRoot, marketplaceClonePath } = buildFakeLayout();
      cpSync(marketplaceClonePath, pluginRoot, { recursive: true, force: true });
      rmSync(join(pluginRoot, "start.mjs"));
      expect(isPartialInstall(pluginRoot)).toBe(true);
    });

    it("isPartialInstall returns true when package.json is missing", async () => {
      const { isPartialInstall } = await import("../../hooks/heal-partial-install.mjs");
      const { pluginRoot, marketplaceClonePath } = buildFakeLayout();
      cpSync(marketplaceClonePath, pluginRoot, { recursive: true, force: true });
      rmSync(join(pluginRoot, "package.json"));
      expect(isPartialInstall(pluginRoot)).toBe(true);
    });

    it("isPartialInstall returns true when both cli.bundle.mjs and build/cli.js are missing", async () => {
      const { isPartialInstall } = await import("../../hooks/heal-partial-install.mjs");
      const { pluginRoot, marketplaceClonePath } = buildFakeLayout();
      cpSync(marketplaceClonePath, pluginRoot, { recursive: true, force: true });
      rmSync(join(pluginRoot, "cli.bundle.mjs"));
      expect(isPartialInstall(pluginRoot)).toBe(true);
    });

    it("isPartialInstall accepts build/cli.js as the cli fallback", async () => {
      const { isPartialInstall } = await import("../../hooks/heal-partial-install.mjs");
      const { pluginRoot, marketplaceClonePath } = buildFakeLayout();
      cpSync(marketplaceClonePath, pluginRoot, { recursive: true, force: true });
      rmSync(join(pluginRoot, "cli.bundle.mjs"));
      rmSync(join(pluginRoot, "server.bundle.mjs"));
      mkdirSync(join(pluginRoot, "build"), { recursive: true });
      writeFileSync(join(pluginRoot, "build", "cli.js"), "// tsc output\n");
      writeFileSync(join(pluginRoot, "build", "server.js"), "// tsc output\n");
      expect(isPartialInstall(pluginRoot)).toBe(false);
    });

    it("isPartialInstall returns false on falsy pluginRoot", async () => {
      const { isPartialInstall } = await import("../../hooks/heal-partial-install.mjs");
      expect(isPartialInstall(undefined)).toBe(false);
      expect(isPartialInstall(null)).toBe(false);
      expect(isPartialInstall("")).toBe(false);
    });

    // ── deriveMarketplaceClonePath layout helper ──

    it("deriveMarketplaceClonePath derives the marketplace path from a CC cache layout", async () => {
      const { deriveMarketplaceClonePath } = await import("../../hooks/heal-partial-install.mjs");
      const cache = "/home/u/.claude/plugins/cache/open-context-mode/open-context-mode/1.0.150";
      expect(deriveMarketplaceClonePath(cache)).toBe(resolve("/home/u/.claude/plugins/marketplaces/open-context-mode"));
    });

    it("deriveMarketplaceClonePath tolerates a trailing slash", async () => {
      const { deriveMarketplaceClonePath } = await import("../../hooks/heal-partial-install.mjs");
      const cache = "/home/u/.claude/plugins/cache/open-context-mode/open-context-mode/1.0.150/";
      expect(deriveMarketplaceClonePath(cache)).toBe(resolve("/home/u/.claude/plugins/marketplaces/open-context-mode"));
    });

    it("deriveMarketplaceClonePath handles Windows-style backslashes", async () => {
      const { deriveMarketplaceClonePath } = await import("../../hooks/heal-partial-install.mjs");
      const cache = "C:\\Users\\u\\.claude\\plugins\\cache\\open-context-mode\\open-context-mode\\1.0.150";
      const got = deriveMarketplaceClonePath(cache);
      // resolve() leaves the leading drive letter intact as a relative
      // segment on POSIX; the important assertion is the suffix.
      expect(String(got).replace(/\\/g, "/")).toMatch(/plugins\/marketplaces\/open-context-mode$/);
    });

    it("deriveMarketplaceClonePath returns null for non-CC layouts", async () => {
      const { deriveMarketplaceClonePath } = await import("../../hooks/heal-partial-install.mjs");
      expect(deriveMarketplaceClonePath("/usr/local/lib/node_modules/open-context-mode")).toBeNull();
      expect(deriveMarketplaceClonePath("/home/u/sultan-projects/open-context-mode")).toBeNull();
      expect(deriveMarketplaceClonePath(undefined)).toBeNull();
      expect(deriveMarketplaceClonePath(null)).toBeNull();
      expect(deriveMarketplaceClonePath("")).toBeNull();
    });

    // ── healPartialInstallFromMarketplace full heal ──

    it("healPartialInstallFromMarketplace early-returns on a healthy install", async () => {
      const { healPartialInstallFromMarketplace } = await import("../../hooks/heal-partial-install.mjs");
      const { pluginRoot, marketplaceClonePath } = buildFakeLayout();
      cpSync(marketplaceClonePath, pluginRoot, { recursive: true, force: true });
      const result = healPartialInstallFromMarketplace({
        pluginRoot,
        marketplaceClonePath,
        log: false,
      });
      expect(result.skipped).toBe("not-partial");
      expect(result.healed).toEqual([]);
    });

    it("healPartialInstallFromMarketplace skips when the marketplace clone is missing", async () => {
      const { healPartialInstallFromMarketplace } = await import("../../hooks/heal-partial-install.mjs");
      const { pluginRoot } = buildFakeLayout();
      const result = healPartialInstallFromMarketplace({
        pluginRoot,
        marketplaceClonePath: resolve(pluginRoot, "..", "..", "..", "no-such-mp"),
        log: false,
      });
      expect(result.skipped).toBe("no-marketplace");
    });

    it("healPartialInstallFromMarketplace refuses to heal when pluginRoot equals marketplaceClonePath", async () => {
      const { healPartialInstallFromMarketplace } = await import("../../hooks/heal-partial-install.mjs");
      const { marketplaceClonePath } = buildFakeLayout();
      // Force the probe to trip by stripping start.mjs from the
      // marketplace itself, then point pluginRoot at it.
      rmSync(join(marketplaceClonePath, "start.mjs"));
      const result = healPartialInstallFromMarketplace({
        pluginRoot: marketplaceClonePath,
        marketplaceClonePath,
        log: false,
      });
      expect(result.skipped).toBe("same-as-marketplace");
    });

    it("healPartialInstallFromMarketplace copies missing files from the marketplace clone", async () => {
      const { healPartialInstallFromMarketplace, isPartialInstall } = await import("../../hooks/heal-partial-install.mjs");
      const { pluginRoot, marketplaceClonePath } = buildFakeLayout();

      // Replicate the user-observed partial install: hooks/ and
      // .claude-plugin/ made it across, the rest didn't.
      cpSync(join(marketplaceClonePath, "hooks"), join(pluginRoot, "hooks"), { recursive: true, force: true });
      cpSync(join(marketplaceClonePath, ".claude-plugin"), join(pluginRoot, ".claude-plugin"), { recursive: true, force: true });
      expect(isPartialInstall(pluginRoot)).toBe(true);

      const result = healPartialInstallFromMarketplace({
        pluginRoot,
        marketplaceClonePath,
        log: false,
      });
      expect(result.skipped).toBeUndefined();
      expect(result.stillMissing).toEqual([]);
      expect(result.healed).toContain("start.mjs");
      expect(result.healed).toContain("cli.bundle.mjs");
      expect(result.healed).toContain("server.bundle.mjs");
      expect(result.healed).toContain("package.json");
      expect(isPartialInstall(pluginRoot)).toBe(false);
    });

    it("healPartialInstallFromMarketplace falls back to the marketplace's package.json when pluginRoot's is missing", async () => {
      const { healPartialInstallFromMarketplace } = await import("../../hooks/heal-partial-install.mjs");
      const { pluginRoot, marketplaceClonePath } = buildFakeLayout();
      // Empty pluginRoot, no package.json.
      const result = healPartialInstallFromMarketplace({
        pluginRoot,
        marketplaceClonePath,
        log: false,
      });
      expect(result.skipped).toBeUndefined();
      expect(result.pkgSource).toBe("marketplace");
      expect(result.healed).toContain("package.json");
    });

    it("healPartialInstallFromMarketplace rewrites carry-forward stale args[0] in plugin.json", async () => {
      const { healPartialInstallFromMarketplace } = await import("../../hooks/heal-partial-install.mjs");
      const { pluginRoot, marketplaceClonePath } = buildFakeLayout("1.0.150");

      // Seed pluginRoot with the user-observed carry-forward state:
      // plugin.json copied from 1.0.146 with bun + an absolute args[0].
      cpSync(join(marketplaceClonePath, "hooks"), join(pluginRoot, "hooks"), { recursive: true, force: true });
      mkdirSync(join(pluginRoot, ".claude-plugin"), { recursive: true });
      writeFileSync(
        join(pluginRoot, ".claude-plugin", "plugin.json"),
        JSON.stringify(
          {
            name: "open-context-mode",
            version: "1.0.150",
            mcpServers: {
              "open-context-mode": {
                command: "/usr/bin/bun",
                args: ["/home/u/.claude/plugins/cache/open-context-mode/open-context-mode/1.0.146/start.mjs"],
              },
            },
          },
          null,
          2,
        ),
      );

      const result = healPartialInstallFromMarketplace({
        pluginRoot,
        marketplaceClonePath,
        log: false,
      });
      expect(result.argsRewritten).toBe(true);
      const fixed = readJson(join(pluginRoot, ".claude-plugin", "plugin.json")) as {
        mcpServers: { "open-context-mode": { args: string[] } };
      };
      expect(fixed.mcpServers["open-context-mode"].args[0]).toContain("1.0.150");
      expect(fixed.mcpServers["open-context-mode"].args[0]).not.toContain("1.0.146");
    });

    it.skipIf(process.platform === "win32")(
      "healPartialInstallFromMarketplace refuses to rewrite plugin.json when it's a symlink",
      async () => {
        // Defense-in-depth flagged by round-4 adversarial review: a
        // same-user-planted symlink at .claude-plugin/plugin.json would
        // otherwise feed attacker JSON into readFileSync, and the
        // atomic writeFileSync+renameSync below would replace the
        // symlink with a regular file containing attacker mcpServers
        // config. POSIX 0700 on ~/.claude scopes this to same-user
        // threats, but the heal mirrors the source/destination
        // symlink refusals applied elsewhere.
        //
        // Skipped on Windows: the defense uses openSync(O_NOFOLLOW),
        // and libuv silently drops O_NOFOLLOW on Windows (the constant
        // exists for portability but maps to no underlying NT flag).
        // Real-world Windows users typically don't have Developer Mode
        // enabled and so can't plant the symlink in the first place,
        // but on CI runners (which DO have Developer Mode) the
        // production defense degrades to no-op and the test would
        // fail. Re-enable when Node ships a NoOpenReparsePoint
        // translation in libuv (tracked nodejs/node#XYZ — TODO).
        const { healPartialInstallFromMarketplace } = await import("../../hooks/heal-partial-install.mjs");
        const { pluginRoot, marketplaceClonePath } = buildFakeLayout("1.0.150");

        // Stage attacker-controlled mcpServers JSON outside the cache
        // tree. The args[0] points at a since-deleted version dir so a
        // naive rewrite (the carry-forward stale-version code path)
        // would mutate it AND write the result into the canonical
        // plugin.json location, materializing the attacker config.
        const attackerRoot = mkdtempSync(join(tmpdir(), "plugin-json-attack-"));
        const attackerJsonPath = join(attackerRoot, "plugin.json");
        writeFileSync(
          attackerJsonPath,
          JSON.stringify({
            name: "open-context-mode",
            version: "1.0.150",
            mcpServers: {
              "open-context-mode": {
                command: "/attacker/payload.sh",
                args: ["/home/u/.claude/plugins/cache/open-context-mode/open-context-mode/1.0.146/start.mjs"],
              },
            },
          }),
        );

        // Plant the symlink at the canonical location. readFileSync
        // would follow this; the lstatSync guard must refuse.
        mkdirSync(join(pluginRoot, ".claude-plugin"), { recursive: true });
        symlinkSync(attackerJsonPath, join(pluginRoot, ".claude-plugin", "plugin.json"));

        const result = healPartialInstallFromMarketplace({
          pluginRoot,
          marketplaceClonePath,
          log: false,
        });

        // The rewrite was refused.
        expect(result.argsRewritten).toBe(false);
        // plugin.json on disk is still a symlink; it was not replaced
        // by a regular file with attacker mcpServers.
        const stPj = lstatSync(join(pluginRoot, ".claude-plugin", "plugin.json"));
        expect(stPj.isSymbolicLink()).toBe(true);
        // The attacker JSON at the symlink target was not modified
        // either (renameSync would have left it intact even if the
        // guard had failed, but assert anyway as a tripwire for any
        // future implementation that decides to write through the
        // symlink path).
        const attackerStillThere = JSON.parse(readFileSync(attackerJsonPath, "utf-8"));
        expect(attackerStillThere.mcpServers["open-context-mode"].command).toBe("/attacker/payload.sh");
      },
    );

    it("healPartialInstallFromMarketplace resolves the ${CLAUDE_PLUGIN_ROOT} placeholder", async () => {
      const { healPartialInstallFromMarketplace } = await import("../../hooks/heal-partial-install.mjs");
      const { pluginRoot, marketplaceClonePath } = buildFakeLayout("1.0.150");
      mkdirSync(join(pluginRoot, ".claude-plugin"), { recursive: true });
      writeFileSync(
        join(pluginRoot, ".claude-plugin", "plugin.json"),
        JSON.stringify(
          {
            name: "open-context-mode",
            version: "1.0.150",
            mcpServers: {
              "open-context-mode": {
                command: "node",
                args: ["${CLAUDE_PLUGIN_ROOT}/start.mjs"],
              },
            },
          },
          null,
          2,
        ),
      );

      const result = healPartialInstallFromMarketplace({
        pluginRoot,
        marketplaceClonePath,
        log: false,
      });
      expect(result.argsRewritten).toBe(true);
      const fixed = readJson(join(pluginRoot, ".claude-plugin", "plugin.json")) as {
        mcpServers: { "open-context-mode": { args: string[] } };
      };
      expect(fixed.mcpServers["open-context-mode"].args[0]).not.toContain("${CLAUDE_PLUGIN_ROOT}");
      expect(fixed.mcpServers["open-context-mode"].args[0]).toContain("start.mjs");
    });

    it("healPartialInstallFromMarketplace leaves a healthy plugin.json alone", async () => {
      const { healPartialInstallFromMarketplace } = await import("../../hooks/heal-partial-install.mjs");
      const { pluginRoot, marketplaceClonePath } = buildFakeLayout("1.0.150");
      // Seed a healthy plugin.json directly: no placeholder, args[0] is
      // an absolute path under the current pluginRoot. The rewrite path
      // should all branches decline to mutate.
      mkdirSync(join(pluginRoot, ".claude-plugin"), { recursive: true });
      const healthyArgs0 = join(pluginRoot, "start.mjs").replace(/\\/g, "/");
      writeFileSync(
        join(pluginRoot, ".claude-plugin", "plugin.json"),
        JSON.stringify(
          {
            name: "open-context-mode",
            version: "1.0.150",
            mcpServers: {
              "open-context-mode": {
                command: "node",
                args: [healthyArgs0],
              },
            },
          },
          null,
          2,
        ),
      );
      const result = healPartialInstallFromMarketplace({
        pluginRoot,
        marketplaceClonePath,
        log: false,
      });
      expect(result.healed).toContain("start.mjs");
      expect(result.argsRewritten).toBe(false);
    });

    it("healPartialInstallFromMarketplace is idempotent across re-runs", async () => {
      const { healPartialInstallFromMarketplace } = await import("../../hooks/heal-partial-install.mjs");
      const { pluginRoot, marketplaceClonePath } = buildFakeLayout();
      const first = healPartialInstallFromMarketplace({
        pluginRoot,
        marketplaceClonePath,
        log: false,
      });
      expect(first.healed.length).toBeGreaterThan(0);
      const second = healPartialInstallFromMarketplace({
        pluginRoot,
        marketplaceClonePath,
        log: false,
      });
      expect(second.skipped).toBe("not-partial");
      expect(second.healed).toEqual([]);
    });

    it("healPartialInstallFromMarketplace short-circuits with not-claude-code for non-CC pluginRoots", async () => {
      // The heal is scoped to Claude Code's per-version cache layout
      // (~/.claude/plugins/cache/<owner>/<plugin>/<version>/). Other
      // clients (Codex, Cursor, OpenCode, Kiro, gemini-cli, ...) ship
      // their own SessionStart wrappers under hooks/<client>/ and
      // never call this module. The module also guards its scope at
      // runtime: any pluginRoot that doesn't match the CC cache layout
      // bails with skipped="not-claude-code" before any filesystem
      // work runs.
      const { healPartialInstallFromMarketplace } = await import("../../hooks/heal-partial-install.mjs");

      // npm-global-style layout: no /plugins/cache/ segment.
      const npmGlobalRoot = makeTmp();
      const npmGlobalPlugin = resolve(npmGlobalRoot, "lib", "node_modules", "open-context-mode");
      mkdirSync(npmGlobalPlugin, { recursive: true });
      const r1 = healPartialInstallFromMarketplace({
        pluginRoot: npmGlobalPlugin,
        log: false,
      });
      expect(r1.skipped).toBe("not-claude-code");
      expect(r1.healed).toEqual([]);
      expect(r1.stillMissing).toEqual([]);

      // Codex-style layout: under ~/.codex, no /plugins/cache/.
      const codexRoot = makeTmp();
      const codexPlugin = resolve(codexRoot, ".codex", "plugins", "open-context-mode");
      mkdirSync(codexPlugin, { recursive: true });
      const r2 = healPartialInstallFromMarketplace({
        pluginRoot: codexPlugin,
        log: false,
      });
      expect(r2.skipped).toBe("not-claude-code");
    });

    it("healPartialInstallFromMarketplace doesn't overwrite files that already exist", async () => {
      const { healPartialInstallFromMarketplace } = await import("../../hooks/heal-partial-install.mjs");
      const { pluginRoot, marketplaceClonePath } = buildFakeLayout();
      // Seed pluginRoot with hooks/sessionstart.mjs holding a custom
      // override. The heal only restores missing paths, so the override
      // should survive.
      mkdirSync(join(pluginRoot, "hooks"), { recursive: true });
      const custom = "// custom user override\n";
      writeFileSync(join(pluginRoot, "hooks", "sessionstart.mjs"), custom);
      healPartialInstallFromMarketplace({
        pluginRoot,
        marketplaceClonePath,
        log: false,
      });
      expect(readFileSync(join(pluginRoot, "hooks", "sessionstart.mjs"), "utf-8")).toBe(custom);
    });

    it("healPartialInstallFromMarketplace rejects files[] entries that escape rootDir via ..", async () => {
      // Regression guard for PR #699 review: a corrupted marketplace
      // package.json with `files: ["../outside.txt", ...]` must not
      // turn the self-heal into an out-of-root write. Seed an
      // `outside.txt` in the marketplace's parent dir, point a files[]
      // entry at it via ..-escape, and assert nothing lands outside
      // pluginRoot.
      const { healPartialInstallFromMarketplace } = await import("../../hooks/heal-partial-install.mjs");
      const { pluginRoot, marketplaceClonePath } = buildFakeLayout();

      // Write a sentinel file in the marketplace's parent dir — the
      // ..-escape target. If the guard fails, the heal would copy this
      // into pluginRoot's parent.
      const marketplaceParent = dirname(marketplaceClonePath);
      const escapeTargetPath = join(marketplaceParent, "OUTSIDE-MARKER.txt");
      writeFileSync(escapeTargetPath, "should-not-be-copied\n");

      // Repoint marketplace package.json's files[] to include an
      // escape entry alongside legitimate entries.
      writeFileSync(
        join(marketplaceClonePath, "package.json"),
        JSON.stringify({
          name: "open-context-mode",
          version: "1.0.150",
          files: ["../OUTSIDE-MARKER.txt", "hooks", "start.mjs", "cli.bundle.mjs", "server.bundle.mjs", ".claude-plugin"],
        }),
      );

      const result = healPartialInstallFromMarketplace({
        pluginRoot,
        marketplaceClonePath,
        log: false,
      });

      // The escape entry must not appear anywhere the heal acted on.
      expect(result.healed).not.toContain("../OUTSIDE-MARKER.txt");
      expect(result.healed).not.toContain("OUTSIDE-MARKER.txt");
      expect(result.stillMissing).not.toContain("../OUTSIDE-MARKER.txt");
      // Nothing got written to pluginRoot's parent.
      const pluginRootParent = dirname(pluginRoot);
      expect(existsSync(join(pluginRootParent, "OUTSIDE-MARKER.txt"))).toBe(false);
      // The legitimate entries still healed.
      expect(result.healed).toContain("start.mjs");
      expect(result.healed).toContain("cli.bundle.mjs");
    });

    it("healPartialInstallFromMarketplace rejects nested ..-escape entries (e.g. 'a/../../outside')", async () => {
      // Mixed-segment escape: even when the entry starts with a
      // legitimate-looking segment, path normalization collapses the
      // ..'s and resolves outside rootDir. Guard must catch it.
      const { healPartialInstallFromMarketplace } = await import("../../hooks/heal-partial-install.mjs");
      const { pluginRoot, marketplaceClonePath } = buildFakeLayout();

      const marketplaceParent = dirname(marketplaceClonePath);
      const escapeTargetPath = join(marketplaceParent, "NESTED-OUTSIDE.txt");
      writeFileSync(escapeTargetPath, "should-not-be-copied\n");

      writeFileSync(
        join(marketplaceClonePath, "package.json"),
        JSON.stringify({
          name: "open-context-mode",
          version: "1.0.150",
          files: ["hooks/../../NESTED-OUTSIDE.txt", "start.mjs"],
        }),
      );

      const result = healPartialInstallFromMarketplace({
        pluginRoot,
        marketplaceClonePath,
        log: false,
      });

      expect(result.healed.some((p: string) => p.includes("NESTED-OUTSIDE"))).toBe(false);
      const pluginRootParent = dirname(pluginRoot);
      expect(existsSync(join(pluginRootParent, "NESTED-OUTSIDE.txt"))).toBe(false);
      expect(result.healed).toContain("start.mjs");
    });

    it("healPartialInstallFromMarketplace replaces a planted leaf symlink at the destination instead of writing through it", async () => {
      // Arbitrary-file-write primitive surfaced by the second
      // adversarial review: a stale heal leftover or a local attacker
      // plants `pluginRoot/server.bundle.mjs` as a symlink to an
      // out-of-tree target that doesn't exist yet. existsSync follows
      // the dangling link and returns false, so the probe trips and
      // the file lands in missingBefore. Without the lstat+unlink
      // guard at the copy site, cpSync follows the symlink and writes
      // marketplace bytes (arbitrary JS) to the target outside
      // pluginRoot. The guard must replace the symlink with a fresh
      // regular file before cpSync runs.
      const { healPartialInstallFromMarketplace, isPartialInstall } = await import("../../hooks/heal-partial-install.mjs");
      const { pluginRoot, marketplaceClonePath } = buildFakeLayout();

      // Dangling target outside pluginRoot, must stay un-created.
      const pluginRootParent = dirname(pluginRoot);
      const escapeTargetPath = join(pluginRootParent, "OUT-OF-ROOT-MUST-NOT-EXIST.txt");
      expect(existsSync(escapeTargetPath)).toBe(false);

      // Plant the symlink at the launch-critical leaf so the probe
      // trips on it (existsSync on a dangling link returns false).
      symlinkSync(escapeTargetPath, join(pluginRoot, "server.bundle.mjs"));
      expect(lstatSync(join(pluginRoot, "server.bundle.mjs")).isSymbolicLink()).toBe(true);
      expect(isPartialInstall(pluginRoot)).toBe(true);

      const result = healPartialInstallFromMarketplace({
        pluginRoot,
        marketplaceClonePath,
        log: false,
      });

      // The symlink target must not have been materialized: no
      // arbitrary write happened outside pluginRoot.
      expect(existsSync(escapeTargetPath)).toBe(false);
      // The leaf is now a regular file with marketplace bytes, not a
      // dangling symlink.
      const stTo = lstatSync(join(pluginRoot, "server.bundle.mjs"));
      expect(stTo.isSymbolicLink()).toBe(false);
      expect(stTo.isFile()).toBe(true);
      expect(readFileSync(join(pluginRoot, "server.bundle.mjs"), "utf-8")).toBe("// server bundle\n");
      // The heal records the file as healed, and the probe agrees
      // we're healthy.
      expect(result.healed).toContain("server.bundle.mjs");
      expect(isPartialInstall(pluginRoot)).toBe(false);
    });

    it("healPartialInstallFromMarketplace rejects deep files[] entries reached through a symlinked ancestor in the marketplace tree", async () => {
      // Ancestor-symlink bypass surfaced by the third adversarial
      // review: lstat(from) on a deep leaf returns isSymbolicLink=false
      // when the symlink is in a PARENT segment, not the leaf itself.
      // The lexical resolve+startsWith guard also doesn't catch it,
      // since the symlink's own lexical path stays inside the
      // marketplace tree. Only realpath(from) collapses the ancestor
      // symlink and exposes the escape. Without this guard, cpSync
      // would read attacker-staged content through the ancestor link
      // and copy it into pluginRoot, where the next session start
      // would execute the planted bytes (e.g. scripts/postinstall.mjs).
      const { healPartialInstallFromMarketplace } = await import("../../hooks/heal-partial-install.mjs");
      const { pluginRoot, marketplaceClonePath } = buildFakeLayout();

      // Stage attacker-controlled bytes outside the marketplace tree.
      const attackerRoot = mkdtempSync(join(tmpdir(), "ancestor-attack-"));
      writeFileSync(join(attackerRoot, "postinstall.mjs"), "// ATTACKER PAYLOAD\n");

      // Replace marketplace/scripts/ (a real dir set up by
      // buildFakeLayout) with a symlink to the attacker-staged dir.
      // The lexical resolve check on `from` passes because the
      // symlink's path stays inside marketplaceClonePath; only
      // realpath collapses through it.
      rmSync(join(marketplaceClonePath, "scripts"), {
        recursive: true,
        force: true,
      });
      symlinkSync(attackerRoot, join(marketplaceClonePath, "scripts"));

      // package.json references the deep leaf through the
      // now-symlinked ancestor. lstat(from).isSymbolicLink() === false
      // because the leaf is a real file at the symlink target.
      writeFileSync(
        join(marketplaceClonePath, "package.json"),
        JSON.stringify({
          name: "open-context-mode",
          version: "1.0.150",
          files: ["scripts/postinstall.mjs", "hooks", ".claude-plugin", "start.mjs", "cli.bundle.mjs", "server.bundle.mjs"],
        }),
      );

      const result = healPartialInstallFromMarketplace({
        pluginRoot,
        marketplaceClonePath,
        log: false,
      });

      // The ancestor-symlinked entry must not appear in healed, and
      // pluginRoot must not contain the attacker payload at the
      // resolved-through-ancestor path.
      expect(result.healed).not.toContain("scripts/postinstall.mjs");
      const planted = join(pluginRoot, "scripts", "postinstall.mjs");
      if (existsSync(planted)) {
        expect(readFileSync(planted, "utf-8")).not.toBe("// ATTACKER PAYLOAD\n");
      }
      // Legitimate non-symlinked entries still healed (sanity).
      expect(result.healed).toContain("start.mjs");
      expect(result.healed).toContain("cli.bundle.mjs");
    });

    it("healPartialInstallFromMarketplace rejects symlink entries that escape rootDir", async () => {
      // Symlink-based bypass for the ..-escape resolve+startsWith
      // guard: the symlink itself sits inside marketplaceClonePath, so
      // its lexical resolve stays inside rootDir, but the symlink
      // target points outside. Reading through the link would expose
      // arbitrary host filesystem content to the heal. expandFilesArray
      // and listFilesRecursive must drop symlinks via lstatSync.
      const { healPartialInstallFromMarketplace } = await import("../../hooks/heal-partial-install.mjs");
      const { pluginRoot, marketplaceClonePath } = buildFakeLayout();

      // Sentinel outside the marketplace tree.
      const marketplaceParent = dirname(marketplaceClonePath);
      const sentinelPath = join(marketplaceParent, "SYMLINK-TARGET.txt");
      writeFileSync(sentinelPath, "should-not-leak\n");

      // Top-level symlink-to-outside file at marketplace root.
      const topLink = join(marketplaceClonePath, "evil-link.txt");
      symlinkSync(sentinelPath, topLink);

      // Symlink-to-outside hidden inside a legitimate-looking dir,
      // so listFilesRecursive's walk has to drop it too.
      const nestedDir = join(marketplaceClonePath, "scripts");
      const nestedLink = join(nestedDir, "evil-nested.txt");
      symlinkSync(sentinelPath, nestedLink);

      writeFileSync(
        join(marketplaceClonePath, "package.json"),
        JSON.stringify({
          name: "open-context-mode",
          version: "1.0.150",
          // "scripts" is a directory walk; "evil-link.txt" is a
          // top-level symlink entry. Both should be filtered.
          files: ["evil-link.txt", "scripts", "hooks", "start.mjs", "cli.bundle.mjs", "server.bundle.mjs", ".claude-plugin"],
        }),
      );

      const result = healPartialInstallFromMarketplace({
        pluginRoot,
        marketplaceClonePath,
        log: false,
      });

      // Neither the top-level nor the nested symlink can appear in
      // healed; nothing got materialized at pluginRoot for them either.
      expect(result.healed).not.toContain("evil-link.txt");
      expect(result.healed.some((p: string) => p.includes("evil-nested"))).toBe(false);
      expect(existsSync(join(pluginRoot, "evil-link.txt"))).toBe(false);
      expect(existsSync(join(pluginRoot, "scripts", "evil-nested.txt"))).toBe(false);

      // Legitimate scripts entries still healed (the symlink dropped
      // out, but the regular files in scripts/ stayed). Use join() so
      // Windows backslash and POSIX forward-slash both match the
      // OS-native paths listFilesRecursive emits.
      expect(result.healed).toContain(join("scripts", "postinstall.mjs"));
      expect(result.healed).toContain(join("scripts", "plugin-cache-integrity.mjs"));
      // Sentinel content was never copied anywhere in pluginRoot.
      const pluginRootParent = dirname(pluginRoot);
      expect(existsSync(join(pluginRootParent, "SYMLINK-TARGET.txt"))).toBe(false);
    });

    it("healPartialInstallFromMarketplace keeps valid entries when escape entries are mixed in", async () => {
      // The escape guard must drop only the bad entries, leaving valid
      // ones in the manifest. Otherwise a single corrupt entry would
      // poison the whole heal.
      const { healPartialInstallFromMarketplace, isPartialInstall } = await import("../../hooks/heal-partial-install.mjs");
      const { pluginRoot, marketplaceClonePath } = buildFakeLayout();

      const marketplaceParent = dirname(marketplaceClonePath);
      writeFileSync(join(marketplaceParent, "POISON.txt"), "x");

      writeFileSync(
        join(marketplaceClonePath, "package.json"),
        JSON.stringify({
          name: "open-context-mode",
          version: "1.0.150",
          files: [
            "../POISON.txt",
            "hooks",
            ".claude-plugin",
            "start.mjs",
            "cli.bundle.mjs",
            "server.bundle.mjs",
            "scripts/postinstall.mjs",
            "scripts/plugin-cache-integrity.mjs",
            "bin",
          ],
        }),
      );

      const result = healPartialInstallFromMarketplace({
        pluginRoot,
        marketplaceClonePath,
        log: false,
      });

      // Every valid entry healed.
      expect(result.healed).toContain("start.mjs");
      expect(result.healed).toContain("cli.bundle.mjs");
      expect(result.healed).toContain("server.bundle.mjs");
      // No escape side effect.
      const pluginRootParent = dirname(pluginRoot);
      expect(existsSync(join(pluginRootParent, "POISON.txt"))).toBe(false);
      // The probe agrees we're healthy after the heal (the legitimate
      // launch-critical files all landed).
      expect(isPartialInstall(pluginRoot)).toBe(false);
    });

    it("healPartialInstallFromMarketplace reproduces and heals the v1.0.150 partial install", async () => {
      const { healPartialInstallFromMarketplace, isPartialInstall } = await import("../../hooks/heal-partial-install.mjs");
      // Mirrors the exact failure shape captured in the wild:
      //   - hooks/ and .claude-plugin/ survived
      //   - plus a few non-files[] extras (web/, CONTRIBUTING.md) from an
      //     earlier install moment
      //   - .claude-plugin/plugin.json carry-forwarded from 1.0.146 with
      //     command "/usr/bin/bun" and args[0] pointing at the stale
      //     1.0.146/start.mjs absolute path
      //   - everything else missing
      const { pluginRoot, marketplaceClonePath } = buildFakeLayout("1.0.150");
      cpSync(join(marketplaceClonePath, "hooks"), join(pluginRoot, "hooks"), { recursive: true, force: true });
      mkdirSync(join(pluginRoot, ".claude-plugin"), { recursive: true });
      writeFileSync(
        join(pluginRoot, ".claude-plugin", "plugin.json"),
        JSON.stringify(
          {
            name: "open-context-mode",
            version: "1.0.150",
            mcpServers: {
              "open-context-mode": {
                command: "/usr/bin/bun",
                args: [pluginRoot.replace("1.0.150", "1.0.146") + sep + "start.mjs"],
              },
            },
          },
          null,
          2,
        ),
      );
      writeFileSync(join(pluginRoot, "CONTRIBUTING.md"), "# Contributing\n");
      mkdirSync(join(pluginRoot, "web"), { recursive: true });
      writeFileSync(join(pluginRoot, "web", "index.html"), "<!doctype html>");

      const result = healPartialInstallFromMarketplace({
        pluginRoot,
        marketplaceClonePath,
        log: false,
      });

      // Full recovery: every files[] entry restored, args[0] re-pointed
      // at 1.0.150, and the cheap probe agrees we're healthy.
      expect(result.stillMissing).toEqual([]);
      expect(result.argsRewritten).toBe(true);
      expect(isPartialInstall(pluginRoot)).toBe(false);

      const plugin = readJson(join(pluginRoot, ".claude-plugin", "plugin.json")) as {
        mcpServers: { "open-context-mode": { args: string[] } };
      };
      expect(plugin.mcpServers["open-context-mode"].args[0]).toContain("1.0.150");
      expect(plugin.mcpServers["open-context-mode"].args[0]).not.toContain("1.0.146");

      // Non-files[] extras left alone.
      expect(readFileSync(join(pluginRoot, "CONTRIBUTING.md"), "utf-8")).toBe("# Contributing\n");
    });

    // ── Wiring assertions ──

    it("start.mjs invokes the heal before the Algo-D4 integrity check", () => {
      const src = readFileSync(resolve(ROOT, "start.mjs"), "utf-8");
      // Anchor on the literal import + call shape, not the bare filename
      // substring. A DELETED- prefix or comment mention would otherwise
      // pass the test even when the wiring is gone.
      const importIdx = src.indexOf('"./hooks/heal-partial-install.mjs"');
      const callIdx = src.indexOf("healPartialInstallFromMarketplace({");
      const integrityIdx = src.indexOf('"./scripts/plugin-cache-integrity.mjs"');
      expect(importIdx, "heal-partial-install import missing in start.mjs").toBeGreaterThan(-1);
      expect(callIdx, "healPartialInstallFromMarketplace call missing in start.mjs").toBeGreaterThan(-1);
      expect(integrityIdx, "plugin-cache-integrity import missing in start.mjs").toBeGreaterThan(-1);
      // Order: heal runs first so a fixable install is repaired, then
      // the integrity gate decides whether boot proceeds.
      expect(importIdx).toBeLessThan(integrityIdx);
      expect(callIdx).toBeLessThan(integrityIdx);
    });

    it("hooks/sessionstart.mjs invokes the heal early in the runHook callback", () => {
      const src = readFileSync(resolve(ROOT, "hooks", "sessionstart.mjs"), "utf-8");
      const importIdx = src.indexOf('"./heal-partial-install.mjs"');
      const callIdx = src.indexOf("healPartialInstallFromMarketplace()");
      expect(importIdx, "heal-partial-install import missing in sessionstart.mjs").toBeGreaterThan(-1);
      expect(callIdx, "healPartialInstallFromMarketplace call missing in sessionstart.mjs").toBeGreaterThan(-1);
      // Heal must fire before the age-gated cleanup that wipes sibling
      // cache version dirs, since the cleanup would otherwise erase a
      // healthy previous version while the new one is still partial.
      const cleanupIdx = src.indexOf("Age-gated lazy cleanup");
      expect(cleanupIdx, "age-gated cleanup comment missing").toBeGreaterThan(-1);
      expect(callIdx).toBeLessThan(cleanupIdx);
    });
  });
});

// ── session-loaders.mjs fallback ──────────────────────────────────────

describe("session-loaders.mjs fallback to build/session/*.js", () => {
  test("session-loaders.mjs has loadModule fallback function", () => {
    const src = readFileSync(resolve(ROOT, "hooks", "session-loaders.mjs"), "utf-8");
    // Must have a loadModule helper that checks existsSync
    expect(src).toContain("loadModule");
    expect(src).toContain("existsSync");
  });

  test("session-loaders.mjs falls back to build/session/*.js paths", () => {
    const src = readFileSync(resolve(ROOT, "hooks", "session-loaders.mjs"), "utf-8");
    // Must reference the build/session fallback directory
    expect(src).toContain("build");
    expect(src).toContain("session");
    // Must reference specific build fallback filenames
    expect(src).toContain("db.js");
    expect(src).toContain("extract.js");
    expect(src).toContain("snapshot.js");
  });

  test("session-loaders.mjs still tries bundles first", () => {
    const src = readFileSync(resolve(ROOT, "hooks", "session-loaders.mjs"), "utf-8");
    // Bundle names must still be present
    expect(src).toContain("session-db.bundle.mjs");
    expect(src).toContain("session-extract.bundle.mjs");
    expect(src).toContain("session-snapshot.bundle.mjs");
  });

  test("session-loaders.mjs imports existsSync", () => {
    const src = readFileSync(resolve(ROOT, "hooks", "session-loaders.mjs"), "utf-8");
    expect(src).toMatch(/import\s*\{[^}]*existsSync[^}]*\}\s*from\s*["']node:fs["']/);
  });
});

// ── SKILL.md MCP-first pattern ────────────────────────────────────────

describe("SKILL.md prefers MCP tool over Bash", () => {
  it("open_ctx-doctor SKILL.md prefers MCP tool over Bash", () => {
    const skill = readFileSync(resolve(ROOT, "skills", "open_ctx-doctor", "SKILL.md"), "utf-8");
    // Must mention the MCP tool
    expect(skill).toContain("open_ctx_doctor");
    expect(skill).toContain("MCP tool");
    // MCP tool instruction must appear BEFORE the Bash fallback
    const mcpIdx = skill.indexOf("open_ctx_doctor");
    const fallbackIdx = skill.indexOf("Fallback");
    expect(mcpIdx).toBeGreaterThan(-1);
    expect(fallbackIdx).toBeGreaterThan(-1);
    expect(mcpIdx).toBeLessThan(fallbackIdx);
  });
});

// ── Package exports ───────────────────────────────────────────────────

describe("Package exports", () => {
  test("named export exposes ContextModePlugin factory", async () => {
    const mod = await import("../../src/platforms/opencode/plugin.js");
    expect(mod.ContextModePlugin).toBeDefined();
    expect(typeof mod.ContextModePlugin).toBe("function");
  });

  test("default export has KiloCode PluginModule shape { server }", async () => {
    const mod = (await import("../../src/platforms/opencode/plugin.js")) as any;
    expect(mod.default).toBeDefined();
    expect(typeof mod.default.server).toBe("function");
  });

  test("default export does not leak CLI internals", async () => {
    const mod = (await import("../../src/platforms/opencode/plugin.js")) as any;
    expect(mod.toUnixPath).toBeUndefined();
    expect(mod.doctor).toBeUndefined();
    expect(mod.upgrade).toBeUndefined();
  });
});

// ── Issue #181: upgrade must not delete sibling version dirs mid-session ──

describe("Cache dir safety (#181)", () => {
  const CLI_SOURCE = readFileSync(resolve(ROOT, "src/cli.ts"), "utf-8");
  const PRETOOLUSE_SOURCE = readFileSync(resolve(ROOT, "hooks/pretooluse.mjs"), "utf-8");

  test("cli.ts upgrade does not rmSync sibling cache version dirs", () => {
    // The upgrade function must NOT contain a loop that deletes sibling version dirs.
    // Old pattern: filter dirs !== myDir → rmSync each in a loop
    const hasStaleCleanup = CLI_SOURCE.includes("stale cache dir");
    expect(hasStaleCleanup).toBe(false);
  });

  test("pretooluse.mjs does not nuke stale version dirs", () => {
    // Step 4 "Nuke stale version dirs" must not exist
    const hasNukeBlock = PRETOOLUSE_SOURCE.includes("Nuke stale version dirs");
    expect(hasNukeBlock).toBe(false);
  });

  test("sessionstart.mjs has age-gated lazy cleanup for old cache dirs", () => {
    const SESSION_SOURCE = readFileSync(resolve(ROOT, "hooks/sessionstart.mjs"), "utf-8");
    // Must contain age-gated cleanup logic (>1 hour check)
    expect(SESSION_SOURCE).toContain("lazy cleanup");
    expect(SESSION_SOURCE).toContain("3600000"); // 1 hour in ms
  });

  // #644: statSync follows symlinks → fresh symlinks pointing at stale targets
  // were deleted, breaking sessions whose CLAUDE_PLUGIN_ROOT was pinned to one
  // of those linked versions. lstatSync evaluates the link's own mtime, so a
  // freshly-created symlink survives the gate even when its target is old.
  test("sessionstart.mjs cleanup uses lstatSync to age-check entries (#644)", () => {
    const SESSION_SOURCE = readFileSync(resolve(ROOT, "hooks/sessionstart.mjs"), "utf-8");

    // Isolate the lazy-cleanup block so we don't get false-positives from
    // unrelated stat calls elsewhere in the file.
    const blockStart = SESSION_SOURCE.indexOf("Age-gated lazy cleanup");
    expect(blockStart, "lazy cleanup block must exist").toBeGreaterThan(-1);
    const block = SESSION_SOURCE.slice(blockStart, blockStart + 1500);

    // The age check MUST use lstatSync (does not follow symlinks). The path may
    // be held in a local variable as long as it is derived from cacheParent + d.
    expect(block).toMatch(/const\s+oldDir\s*=\s*join\(\s*cacheParent\s*,\s*d\s*\)/);
    expect(block).toMatch(/lstatSync\(\s*oldDir\s*\)/);

    // The age check MUST NOT use statSync (follows symlinks → wrongly evaluates
    // the link target's mtime, causing fresh symlinks to be deleted).
    expect(block).not.toMatch(/(^|[^l])statSync\(\s*(?:join\(\s*cacheParent\s*,\s*d\s*\)|oldDir)\s*\)/);
  });
});

// ── Issue #185: upgrade must not use execSync (shell) ──

// ── Statusline self-locate: survive plugin-root staleness post-upgrade ──

// ── Statusline staleness fix: server emits a periodic stats heartbeat ──

describe("server emits periodic stats heartbeat (statusline liveness fix)", () => {
  const SERVER_SOURCE = readFileSync(resolve(ROOT, "src/server.ts"), "utf-8");

  test("server.ts schedules a setInterval that calls persistStats", () => {
    // bin/statusline.mjs flags the session as "stale — restart to resume saving"
    // when stats.updated_at is >30min old. Pre-fix, updated_at only advanced on
    // MCP tool calls — long Bash/Read/Edit stretches (or post-/compact pauses)
    // would falsely flip the statusline to red even though the MCP server was
    // alive. Server must refresh the stats file on a timer regardless of tool
    // activity so updated_at reflects true server liveness.
    expect(SERVER_SOURCE).toMatch(/setInterval\([\s\S]*?persistStats[\s\S]*?,\s*\d/);
  });

  test("heartbeat interval is shorter than the statusline staleness threshold", () => {
    // statusline threshold: 30min (bin/statusline.mjs:272). Heartbeat must fire
    // well below this — allow up to 5min so the file refresh is frequent enough
    // that one missed tick (sleep, host pause) still keeps us below the cliff.
    const m = SERVER_SOURCE.match(/setInterval\(\s*\(\)\s*=>\s*persistStats\(\)\s*,\s*(\d[\d_]*)\s*\)/);
    expect(m, "Expected `setInterval(() => persistStats(), <ms>)` in server.ts").not.toBeNull();
    const ms = Number(m![1].replace(/_/g, ""));
    expect(ms).toBeGreaterThanOrEqual(10_000); // not absurdly chatty
    expect(ms).toBeLessThanOrEqual(5 * 60_000); // safely under the 30min cliff
  });

  test("heartbeat setInterval is .unref()ed so it does not block process exit", () => {
    // Matches the pattern of the existing version-check interval (~3115).
    expect(SERVER_SOURCE).toMatch(/setInterval\(\s*\(\)\s*=>\s*persistStats\(\)[^.]*\.unref\(\)/s);
  });
});

// ── Issue #418: open_ctx-upgrade must refresh the marketplace clone ──────

describe("open_ctx-upgrade swap loop supply-chain containment", () => {
  const CLI_SOURCE = readFileSync(resolve(ROOT, "src/cli.ts"), "utf-8");
  const SERVER_SOURCE = readFileSync(resolve(ROOT, "src/server.ts"), "utf-8");

  // Both /open_ctx-upgrade swap loops iterate `pkg.files[]` read from a freshly
  // cloned upstream package.json. Without containment, a compromised
  // upstream tag shipping files: ["../../.ssh/authorized_keys"] (or, at
  // the cli.ts site, an absolute path) would let rmSync+cpSync escape
  // pluginRoot. Mirrors the lexical guard pattern that
  // hooks/heal-partial-install.mjs already uses (PR #699).

  test("algorithm: lexical containment guard rejects relative and absolute traversal items", async () => {
    // Sandbox replay of the guard logic. Two trees: pluginRoot/ and
    // srcDir/. Plant a victim file at base/OUTSIDE/victim.txt and an
    // absolute-path probe at base/etc/passwd. Run the same guard the
    // production swap loop uses; assert the malicious items are skipped
    // and the legitimate item is the only one accepted.
    const base = mkdtempSync(join(tmpdir(), "swap-loop-containment-"));
    try {
      const pluginRoot = join(base, "plugin", "root");
      const srcDir = join(base, "src", "dir");
      const outside = join(base, "OUTSIDE");
      const etc = join(base, "etc");
      mkdirSync(pluginRoot, { recursive: true });
      mkdirSync(srcDir, { recursive: true });
      mkdirSync(outside, { recursive: true });
      mkdirSync(etc, { recursive: true });
      writeFileSync(join(outside, "victim.txt"), "ATTACKER_WOULD_DELETE_ME");
      writeFileSync(join(etc, "passwd"), "PRETEND_PASSWD");
      mkdirSync(join(srcDir, "src"), { recursive: true });
      writeFileSync(join(srcDir, "src", "index.ts"), "ok");

      const { sep } = await import("node:path");
      const pluginRootWithSep = resolve(pluginRoot) + sep;
      const srcDirWithSep = resolve(srcDir) + sep;
      const items = [
        "../../OUTSIDE/victim.txt", // relative traversal
        join(etc, "passwd"), // absolute-path bypass
        "src", // legitimate
      ];
      const accepted: string[] = [];
      for (const item of items) {
        const from = resolve(srcDir, item);
        const to = resolve(pluginRoot, item);
        if (!(to + sep).startsWith(pluginRootWithSep)) continue;
        if (!(from + sep).startsWith(srcDirWithSep)) continue;
        accepted.push(item);
      }
      expect(accepted).toEqual(["src"]);
      // Victim files must remain untouched.
      expect(existsSync(join(outside, "victim.txt"))).toBe(true);
      expect(existsSync(join(etc, "passwd"))).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

// ── Issue #186: temp dirs must be dot-prefixed to hide from VS Code ──

describe("Hidden temp dirs (#186)", () => {
  test("executor.ts uses dot-prefixed temp dir to avoid VS Code auto-open", () => {
    const EXEC_SOURCE = readFileSync(resolve(ROOT, "src/executor.ts"), "utf-8");
    // Must use .open-context-mode- prefix (dot-hidden) not open_ctx-mode-
    expect(EXEC_SOURCE).toContain(".open-context-mode-");
    expect(EXEC_SOURCE).not.toMatch(/tmpdir\(\),\s*"open_ctx-mode-"/);
  });
});

// ── Issue #187 follow-up: self-heal must fix ALL hook types, not just PreToolUse ──

// ── PR #183 fix: path traversal prevention in OpenClaw sessionKey ──

// ── PR #190 fix: getRuntimeSummary handles full bun path ──

describe("Runtime summary bun detection (#190)", () => {
  const RT_SOURCE = readFileSync(resolve(ROOT, "src", "runtime.ts"), "utf-8");

  test("getRuntimeSummary does not use exact === bun comparison", () => {
    // Full path like /home/user/.bun/bin/bun must be detected
    const summaryStart = RT_SOURCE.indexOf("getRuntimeSummary");
    const summaryBody = RT_SOURCE.slice(summaryStart, RT_SOURCE.indexOf("\nexport", summaryStart + 10));
    expect(summaryBody).not.toContain('=== "bun"');
  });
});

// ── Plugin root detection for Opencode/Kilocode platforms ────────────────

describe("Plugin root detection (#PR refactor/opencode-improvements)", () => {
  const CLI_SOURCE = readFileSync(resolve(ROOT, "src", "cli.ts"), "utf-8");

  test("cachePluginRoot uses LOCALAPPDATA on Windows", () => {
    const cacheRootStart = CLI_SOURCE.indexOf("function cachePluginRoot");
    const cacheRootBody = CLI_SOURCE.slice(cacheRootStart, cacheRootStart + 500);
    expect(cacheRootBody).toContain("process.env.LOCALAPPDATA");
    expect(cacheRootBody).toContain('process.platform === "win32"');
  });

  test("cachePluginRoot uses ~/.cache as default on non-Windows", () => {
    const cacheRootStart = CLI_SOURCE.indexOf("function cachePluginRoot");
    const cacheRootBody = CLI_SOURCE.slice(cacheRootStart, cacheRootStart + 500);
    expect(cacheRootBody).toContain('".cache"');
    expect(cacheRootBody).toContain("homedir");
  });

  test("getPluginRoot uses cache path for opencode/kilo platform", () => {
    const getPluginRootStart = CLI_SOURCE.indexOf("function getPluginRoot");
    const getPluginRootBody = CLI_SOURCE.slice(getPluginRootStart, getPluginRootStart + 300);
    expect(getPluginRootBody).toContain("isInProcessPluginPlatform(platform)");
    expect(getPluginRootBody).toContain("cachePluginRoot");
  });
});

// ── Issue #225: Codex CLI hook dispatch ──────────────────────────────────

// ── Kimi Code CLI hook dispatch (#729) ───────────────────────────────────

// ── Cursor stop hook (#HOOK_MAP cursor stop) ─────────────────────────────

// ── Upgrade skill sync to marketplace/cache directories ───────────────────

describe("Upgrade syncs skills to active install path (#228)", () => {
  const CLI_SOURCE = readFileSync(resolve(ROOT, "src/cli.ts"), "utf-8");
  const upgradeStart = CLI_SOURCE.indexOf("async function upgrade");
  // Bound the slice to the upgrade() function only — without this the slice
  // includes downstream helpers (statuslineForward, etc.) and assertions like
  // "no marketplace ref" fire on UNRELATED code added later in the file.
  const upgradeEnd = CLI_SOURCE.indexOf("\n/* ---", upgradeStart);
  const upgradeBody = CLI_SOURCE.slice(upgradeStart, upgradeEnd > 0 ? upgradeEnd : undefined);

  test("upgrade does NOT blindly copy to marketplace or cache directories", () => {
    // No hardcoded marketplace/cache paths — only installPath from registry
    const syncSection = upgradeBody.slice(upgradeBody.indexOf("installed_plugins.json"));
    expect(syncSection).not.toContain('"marketplaces"');
    expect(syncSection).not.toContain("readdirSync");
  });
});

// ── better-sqlite3 binding self-heal (#408) ───────────────────────────────
//
// On Windows, `npm rebuild better-sqlite3` falls through to node-gyp when
// prebuild-install is not on cmd.exe PATH, then dies for users without
// MSVC. The fix is a 3-layer heal (spawn prebuild-install via
// process.execPath → `npm install better-sqlite3` → actionable stderr)
// shared between scripts/postinstall.mjs and hooks/ensure-deps.mjs via
// scripts/heal-better-sqlite3.mjs.
//
// Tests in this block cover:
//   - doctor() in src/cli.ts: clearer hint when FTS5 check fails on a
//     bindings-missing pattern.
//   - scripts/postinstall.mjs: calls the shared heal helper after the
//     existing nvm4w junction logic; mklink /J regression guard.
//   - scripts/heal-better-sqlite3.mjs: single source of truth — pins the
//     prebuild-install + npm install + Windows/#408 stderr surface so the
//     dedupe doesn't silently regress.

describe("better-sqlite3 binding self-heal (#408)", () => {
  const CLI_SRC = readFileSync(resolve(ROOT, "src", "cli.ts"), "utf-8");
  const POSTINSTALL_SRC = readFileSync(resolve(ROOT, "scripts", "postinstall.mjs"), "utf-8");
  const HEAL_SRC = readFileSync(resolve(ROOT, "scripts", "heal-better-sqlite3.mjs"), "utf-8");

  // Locate doctor()'s FTS5 / SQLite catch branch — the hint lives here.
  function ftsCatchBlock(): string {
    const ftsAnchor = CLI_SRC.indexOf("Checking FTS5 / SQLite");
    expect(ftsAnchor).toBeGreaterThan(-1);
    const catchIdx = CLI_SRC.indexOf("catch (err", ftsAnchor);
    expect(catchIdx).toBeGreaterThan(-1);
    const versionIdx = CLI_SRC.indexOf("Checking versions", catchIdx);
    expect(versionIdx).toBeGreaterThan(catchIdx);
    return CLI_SRC.slice(catchIdx, versionIdx);
  }

  // ── doctor(): bindings-missing hint ────────────────────────────────
  describe("doctor: bindings-missing hint", () => {
    it("hint mentions `npm install better-sqlite3` as the primary remedy", () => {
      // On Windows `npm rebuild` falls through to node-gyp without MSVC,
      // while `npm install` re-runs prebuild-install and pulls a prebuilt.
      const block = ftsCatchBlock();
      expect(block).toContain("npm install better-sqlite3");
    });

    it("hint explains the Windows / prebuild-install root cause", () => {
      const block = ftsCatchBlock();
      const mentionsRootCause = /prebuild-install/i.test(block) || /Windows/i.test(block);
      expect(mentionsRootCause).toBe(true);
    });

    it("retains `npm rebuild better-sqlite3` as a non-Windows fallback", () => {
      // Existing rebuild hint is still valid on Linux/macOS where the
      // toolchain is present. The fix only augments — does not delete.
      const block = ftsCatchBlock();
      expect(block).toContain("npm rebuild better-sqlite3");
    });

    it("bindings-error detection branches on the bindings error message", () => {
      // Hint must be conditional on the actual bindings failure
      // signature (`Could not locate the bindings file` / `bindings`),
      // otherwise it would spam the install hint for unrelated FTS5 errors.
      const block = ftsCatchBlock();
      const detectsBindingsError = /bindings file/i.test(block) || /\bbindings\b/.test(block);
      expect(detectsBindingsError).toBe(true);
    });
  });

  // ── scripts/postinstall.mjs: delegates to shared helper ────────────
  describe("postinstall.mjs", () => {
    it("imports the shared heal helper", () => {
      // After dedupe, the inline 3-layer heal is gone — replaced by an
      // import + call to the shared helper. Match either bare or
      // explicit-extension import path.
      const importsHelper = /from\s+["']\.\/heal-better-sqlite3(?:\.mjs)?["']/.test(POSTINSTALL_SRC);
      expect(importsHelper).toBe(true);
      expect(POSTINSTALL_SRC).toContain("healBetterSqlite3Binding");
    });

    it("calls healBetterSqlite3Binding(pkgRoot) after the nvm4w junction logic", () => {
      // Order matters: the junction fix must run first so the heal can
      // resolve prebuild-install through the correct node_modules path.
      const junctionIdx = POSTINSTALL_SRC.indexOf("mklink /J");
      expect(junctionIdx).toBeGreaterThan(-1);
      const callIdx = POSTINSTALL_SRC.indexOf("healBetterSqlite3Binding(");
      expect(callIdx).toBeGreaterThan(junctionIdx);
    });

    it("existing Windows nvm4w junction logic (mklink /J) remains intact", () => {
      // Regression guard — Slice 3 must not have wiped the unrelated
      // Windows install fix.
      expect(/mklink\s+\/J/.test(POSTINSTALL_SRC)).toBe(true);
    });
  });

  // ── scripts/heal-better-sqlite3.mjs: single source of truth ────────
  describe("heal-better-sqlite3.mjs (shared helper)", () => {
    it("exports healBetterSqlite3Binding", () => {
      expect(/export\s+function\s+healBetterSqlite3Binding\s*\(/.test(HEAL_SRC)).toBe(true);
    });

    it("contains all three heal layers in one place (dedupe guarantee)", () => {
      // Layer A — prebuild-install via process.execPath
      expect(HEAL_SRC).toContain("prebuild-install");
      expect(HEAL_SRC).toContain("process.execPath");
      // Layer B — npm install fallback (NOT npm rebuild)
      expect(/install\s+better-sqlite3/.test(HEAL_SRC)).toBe(true);
      // Layer C — actionable stderr with Windows / #408 context
      const mentionsContext = /#408/.test(HEAL_SRC) || (/Windows/i.test(HEAL_SRC) && /better-sqlite3/.test(HEAL_SRC));
      expect(mentionsContext).toBe(true);
      const writesStderr = /process\.stderr\.write\s*\(/.test(HEAL_SRC) || /console\.(error|warn)\s*\(/.test(HEAL_SRC);
      expect(writesStderr).toBe(true);
    });

    it("ships in npm package (listed in package.json files array)", () => {
      const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf-8"));
      expect(pkg.files).toContain("scripts/heal-better-sqlite3.mjs");
    });

    it("never throws — all layers wrapped in try/catch (best-effort posture)", () => {
      // Outer try/catch around the whole function body protects callers
      // (postinstall + ensure-deps) from blocking on a heal failure.
      expect(/function\s+healBetterSqlite3Binding[\s\S]{0,200}?try\s*\{/.test(HEAL_SRC)).toBe(true);
    });
  });
});

// ── Issue #564 — docs sync to hasModernSqlite() source of truth ────────
// README and docs/platform-support.md historically promised "Node 18+"
// (9 spots in README) and "Node >= 22.13" (platform-support), while the
// runtime gate (`hasModernSqlite()` in src/db-base.ts:226-244) uses 22.5.
// Three numbers, three contracts. v1.0.132 collapses them to one — the
// runtime gate is the canonical source.
describe("Issue #564 — docs match hasModernSqlite() source of truth", () => {
  const DB_BASE_SRC = readFileSync(resolve(ROOT, "src", "db-base.ts"), "utf-8");

  it("src/db-base.ts hasModernSqlite() uses the 22.5 floor (sanity / source of truth)", () => {
    // If this fails, the floor moved — the README + docs assertions
    // below need their threshold updated in lockstep. This test pins the
    // contract so the docs assertions can not silently drift.
    expect(DB_BASE_SRC).toContain("export function hasModernSqlite");
    // Inline major/minor compare must reference 22 and 5.
    expect(DB_BASE_SRC).toMatch(/major\s*===\s*22\s*&&\s*minor\s*>=\s*5/);
  });

  it("README.md does NOT promise Node.js 18+ on platforms where Linux is unsafe", () => {
    const readme = readFileSync(resolve(ROOT, "README.md"), "utf-8");
    // The literal string "Node.js 18+" must be gone from prerequisites
    // lines — it's a false promise on Linux.
    const nodeJs18PrereqLines = readme.split("\n").filter((l) => /Node\.js\s+18\s*\+/.test(l));
    expect(nodeJs18PrereqLines).toEqual([]);
    // README must positively state the 22.5 (or Bun) floor somewhere.
    expect(readme).toMatch(/22\.5/);
  });

  it("docs/platform-support.md SQLite Backend Selection table uses 22.5, not 22.13", () => {
    const doc = readFileSync(resolve(ROOT, "docs", "platform-support.md"), "utf-8");
    // The literal "22.13" must be gone — it disagrees with hasModernSqlite().
    expect(doc).not.toMatch(/22\.13/);
    // The 22.5 floor must be present.
    expect(doc).toMatch(/22\.5/);
  });
});

// ── Issue #564 — doctor RED FAIL on Linux + Node < 22.5 + no Bun ──────
// Six prior fixes (#228, #331, #461, #540, #551, #556) silently assumed
// Node >= 22.5 on Linux. Reporter #564 hit SIGSEGV on Node 20 because
// engines.node was absent and doctor never flagged the unsafe config.
//
// Architect contract for v1.0.132: doctor MUST emit an explicit RED FAIL
// (not a warn / not a passing note) for the predicate
//   process.platform === "linux" && !hasModernSqlite() && globalThis.Bun === undefined
// linking to issue #564.
//
// Static-analysis assertion (same pattern as cli.test.ts:289, :820, :970):
// runtime spawning would need a fake-Linux fake-Node-20 environment that
// is not portable; asserting the gate exists in source catches the
// regression at PR time and is the precedent used elsewhere in this file.
describe("Issue #564 — doctor() flags Linux + Node < 22.5 + no Bun", () => {
  const CLI_SRC = readFileSync(resolve(ROOT, "src", "cli.ts"), "utf-8");

  function doctorBody(): string {
    const start = CLI_SRC.indexOf("async function doctor(");
    expect(start).toBeGreaterThan(-1);
    // doctor() spans ~300 lines; grab a generous window that ends before
    // the next top-level function declaration (`async function insight`).
    const end = CLI_SRC.indexOf("async function insight", start);
    expect(end).toBeGreaterThan(start);
    return CLI_SRC.slice(start, end);
  }

  it("doctor fails on Linux + Node < 22.5 + no bun (RED FAIL line)", () => {
    const body = doctorBody();
    // The Linux predicate must be in doctor().
    expect(body).toMatch(/process\.platform\s*===\s*["']linux["']/);
    // Must consult the 22.5 gate via hasModernSqlite (the source of truth
    // in src/db-base.ts:226-244) OR an equivalent inline major/minor check.
    const usesHelper = /hasModernSqlite/.test(body);
    const usesInlineGate = /process\.versions\.node/.test(body) && /22(?:\.5|[^0-9])/.test(body);
    expect(usesHelper || usesInlineGate).toBe(true);
    // Bun must be allowed through (Linux + Bun is fine).
    expect(body).toMatch(/globalThis\.Bun|hasBunRuntime|process\.versions\.bun/);
    // Must be a RED FAIL (architect mandate) — not a warn/info. Reuses
    // the existing FAIL surface: `p.log.error(color.red(... FAIL ...`.
    // We assert FAIL appears in the new block by matching against an
    // anchor unique to it (issue #564 reference).
    const issueIdx = body.indexOf("#564");
    expect(issueIdx).toBeGreaterThan(-1);
    // Look at a wide window around the #564 anchor — the comment block
    // sits above the predicate and the FAIL emission sits below, so we
    // grab text on both sides.
    const surrounding = body.slice(Math.max(0, issueIdx - 1500), issueIdx + 2000);
    expect(surrounding).toMatch(/p\.log\.error/);
    expect(surrounding).toMatch(/FAIL/);
    // The block must increment criticalFails so the doctor exits non-zero.
    expect(surrounding).toMatch(/criticalFails\+\+/);
    // Remediation: must point users at 22.5+ (or Bun).
    expect(body).toMatch(/22\.5/);
  });
});

// ── Upgrade flow: stale ABI guard ─────────────────────────────────────
// `/open_ctx-upgrade` must not declare success just because better_sqlite3.node
// exists. On modern Node the startup probe is skipped, so the ABI-specific
// cache file is the no-probe compatibility marker and hooks/ensure-deps.mjs
// owns the repair decision.
// ── Issue #613/#609 — doctor() surfaces persistence-tier bug class ─────
// PR #620 (Family A) shipped the architectural fixes:
//   - #609: stop writing per-version cache `.mcp.json` + post-bump sweep
//   - #613: vscode/jetbrains-copilot hook commands ship CLI-dispatcher form
//           (no absolute `process.execPath` + script path baked into
//           workspace-committed `.github/hooks/open-context-mode.json`)
//
// These two slices are the *prevention* surface — root-cause fixes that
// stop the bug from being written. But users on the field can still be
// holding pre-PR-620 poisoned state:
//   - already-committed `.github/hooks/open-context-mode.json` in their repo
//     with absolute Windows fnm shim paths from v1.0.136 or earlier
//   - leftover `.mcp.json` in `~/.claude/plugins/cache/.../<version>/`
//     from /open_ctx-upgrade flows that ran before PR #620
//
// Doctor's job per the verdict family ("silent-green doctor while hooks
// are dead is itself a P0 trust bug" — ISSUE-604-VERDICT §11) is to
// SURFACE that pre-PR state BEFORE the user hits a runtime failure.
//
// Architect contract for PR #620 + slice 4:
//   CHECK A: doctor scans workspace Tier C files (`.github/hooks/open-context-mode.json`,
//            `.cursor/hooks.json`, `.jetbrains/copilot/hooks.json` under
//            process.cwd()) — for each that exists, parse JSON, recurse
//            into all string values, FAIL if any matches absolute path
//            patterns (unix `/`, Windows `[A-Z]:[/\\]`, `\\`, fnm_multishells).
//            Remediation: "run `open_ctx_upgrade` to rewrite to portable form".
//            Missing config → SKIP (no false fail).
//
//   CHECK B: doctor scans `~/.claude/plugins/cache/open-context-mode/open-context-mode/*/`
//            for `.mcp.json` files (post-PR-620 these should not exist).
//            Found → WARN (not fail) with remediation:
//            "open_ctx_upgrade will sweep on next run".
//
// Same static-analysis assertion pattern as Issue #564 doctor test (above)
// and lines 962, 997, 1010 — runtime spawning would need fixture
// workspaces on three OSes and is not portable; asserting the gate
// exists in doctor() source catches the regression at PR time.
describe("PR #620 slice 4 — doctor() surfaces persistence-tier bug class", () => {
  const CLI_SRC = readFileSync(resolve(ROOT, "src", "cli.ts"), "utf-8");

  function doctorBody(): string {
    const start = CLI_SRC.indexOf("async function doctor(");
    expect(start).toBeGreaterThan(-1);
    const end = CLI_SRC.indexOf("async function insight", start);
    expect(end).toBeGreaterThan(start);
    return CLI_SRC.slice(start, end);
  }

  it("doctor scans workspace Tier C config files for absolute paths (#613 proactive)", () => {
    const body = doctorBody();
    // Must reference all three Tier C path shapes that PR #620 covers
    // (vscode-copilot writes `.github/hooks/open-context-mode.json`,
    //  cursor writes `.cursor/hooks.json`,
    //  jetbrains-copilot writes `.jetbrains/copilot/hooks.json`
    //  — workspace-committed per ISSUE-613-VERDICT §6.1 Tier C table).
    expect(body).toContain(".github/hooks/open-context-mode.json");
    expect(body).toContain(".cursor/hooks.json");
    expect(body).toContain(".jetbrains/copilot/hooks.json");
    // Must detect the fnm-shim pattern (reporter's stderr literally shows
    // `fnm_multishells/<pid>_<ts>/node.exe` per ISSUE-613-VERDICT §2 H2).
    expect(body).toMatch(/fnm_multishells/);
    // Must surface the failure with remediation pointing at open_ctx_upgrade.
    // The Tier C section is identifiable by the issue anchor `#613`.
    const anchorIdx = body.indexOf("#613");
    expect(anchorIdx).toBeGreaterThan(-1);
    const window_ = body.slice(Math.max(0, anchorIdx - 500), anchorIdx + 3000);
    // The check must use p.log.error or p.log.warn (not info) AND
    // mention open_ctx_upgrade so the user knows the remediation.
    expect(window_).toMatch(/p\.log\.(error|warn)/);
    expect(window_).toMatch(/ctx[_-]?upgrade/i);
  });
});

// ── index --source composes the per-file label (#914) ─────────────────────

describe("indexCommand — single-file --source label (#914)", () => {
  const CLI_SRC = readFileSync(resolve(ROOT, "src", "cli.ts"), "utf-8");

  function indexCommandBody(): string {
    const start = CLI_SRC.indexOf("async function indexCommand");
    if (start === -1) throw new Error("indexCommand() not found");
    const after = CLI_SRC.indexOf("\nasync function ", start + 10);
    const altAfter = CLI_SRC.indexOf("\nfunction ", start + 10);
    const end = [after, altAfter].filter((i) => i > -1).sort((a, b) => a - b)[0] ?? CLI_SRC.length;
    return CLI_SRC.slice(start, end);
  }

  it("keeps the explicit --source distinct from the stored label and composes it", () => {
    const body = indexCommandBody();
    // The group label the user typed must be captured on its own variable —
    // composing it unconditionally would produce `<absPath>:<absPath>` for the
    // no---source case, where the label already IS the path.
    expect(body).toMatch(/const groupSource = stringFlag\(parsed\.flags, "source"\)/);
    expect(body).toMatch(/const source = groupSource \?\? defaultSourceForPath\(absPath\)/);
    // The single-file branch is the one that has to compose.
    expect(body).toMatch(/groupSource \? composeSourceLabel\(groupSource, absPath\) : source/);
  });

  it("prints the label that actually landed in the store", () => {
    const body = indexCommandBody();
    expect(body).toMatch(/console\.log\(`Source: \$\{storedSource \?\? source\}`\)/);
  });

  it("the directory branch keeps handing indexDirectory the bare group label", () => {
    const body = indexCommandBody();
    // indexDirectory composes per file itself; double-composing here would
    // produce `obsidian:obsidian:/path`.
    expect(body).toMatch(/store\.indexDirectory\(\{\s*\n\s*path: absPath,\s*\n\s*source,/);
  });
});

// ── uninstall undoes what the plugin deployed (#1058) ──────────────────
