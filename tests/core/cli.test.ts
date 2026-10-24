/**
 * Consolidated CLI tests
 *
 * Combines:
 *   - cli-bundle.test.ts (marketplace install support)
 *   - cli-hook-path.test.ts (forward-slash hook paths)
 *   - package-exports.test.ts (public API surface)
 */
import { describe, it, test, expect, beforeEach, afterEach } from "vite-plus/test";
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

const ROOT = resolve(import.meta.dirname, "../..");

// ── CLI Hook Path Tests ───────────────────────────────────────────────

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

  test("cli.ts upgrade does not rmSync sibling cache version dirs", () => {
    // The upgrade function must NOT contain a loop that deletes sibling version dirs.
    // Old pattern: filter dirs !== myDir → rmSync each in a loop
    const hasStaleCleanup = CLI_SOURCE.includes("stale cache dir");
    expect(hasStaleCleanup).toBe(false);
  });
});

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
