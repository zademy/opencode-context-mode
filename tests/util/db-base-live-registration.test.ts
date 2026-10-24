/**
 * openSQLite() seam — _liveDBs registration + per-mode corrupt-file policy.
 *
 * C6 (composition over template-method inheritance): the lifecycle that
 * SQLiteBase used to own lives in the openSQLite() factory. Two contracts
 * moved with it and are pinned here:
 *
 * 1. Every handle registers its connection in the process-exit set
 *    (`__context_mode_live_dbs_v3__` on globalThis) so the exit hook can
 *    close it even on a hard shutdown, and UNREGISTERS on close() and
 *    cleanup() so the hook never double-closes. Before C6, ContentStore
 *    re-implemented the lifecycle privately and silently missed this
 *    registration — the exit-hook/segfault protection was SessionDB-only.
 * 2. The corrupt-open policy does what each store did before the seam:
 *    "rename" (SessionDB's default) quarantines the files as
 *    `<path>.corrupt-<ts>`; "delete" (ContentStore) unlinks them outright.
 */
import { describe, it, expect } from "vite-plus/test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openSQLite } from "../../src/db-base.js";

const kLiveDBs = Symbol.for("__context_mode_live_dbs_v3__");

function liveDBs(): Set<unknown> {
  const set = (globalThis as Record<symbol, Set<unknown> | undefined>)[kLiveDBs];
  expect(set, "db-base must have created the _liveDBs exit set").toBeInstanceOf(Set);
  return set!;
}

function tmpDb(name: string): string {
  return join(mkdtempSync(join(tmpdir(), `.open-context-mode-open-sqlite-${name}-`)), `${name}.db`);
}

describe("openSQLite — _liveDBs registration (C6)", () => {
  it("rename-mode handle registers on open and unregisters on close()", () => {
    const dbPath = tmpDb("reg-rename");
    const handle = openSQLite(dbPath);
    try {
      expect(liveDBs().has(handle.db)).toBe(true);
      handle.close();
      expect(liveDBs().has(handle.db)).toBe(false);
    } finally {
      rmSync(join(dbPath, ".."), { recursive: true, force: true });
    }
  });

  it("delete-mode handle registers on open and unregisters on cleanup()", () => {
    const dbPath = tmpDb("reg-delete");
    const handle = openSQLite(dbPath, { onCorrupt: "delete" });
    try {
      expect(liveDBs().has(handle.db)).toBe(true);
      handle.cleanup();
      expect(liveDBs().has(handle.db)).toBe(false);
      // cleanup() also removes the on-disk trio.
      expect(existsSync(dbPath)).toBe(false);
      expect(existsSync(`${dbPath}-wal`)).toBe(false);
      expect(existsSync(`${dbPath}-shm`)).toBe(false);
    } finally {
      rmSync(join(dbPath, ".."), { recursive: true, force: true });
    }
  });

  it("runs initSchema before prepareStatements, each once, with the live connection", () => {
    const order: string[] = [];
    const dbPath = tmpDb("open-order");
    const handle = openSQLite(dbPath, {
      initSchema: (db) => {
        order.push("initSchema");
        db.exec("CREATE TABLE IF NOT EXISTS seam_probe(x INTEGER)");
      },
      prepareStatements: (db) => {
        order.push("prepareStatements");
        expect(db.prepare("SELECT count(*) AS c FROM seam_probe").get()).toEqual({ c: 0 });
      },
    });
    try {
      expect(order).toEqual(["initSchema", "prepareStatements"]);
      handle.db.exec("INSERT INTO seam_probe VALUES (1)");
      expect(handle.db.prepare("SELECT count(*) AS c FROM seam_probe").get()).toEqual({ c: 1 });
      handle.close();
    } finally {
      rmSync(join(dbPath, ".."), { recursive: true, force: true });
    }
  });
});

describe("openSQLite — corrupt-open policy per mode", () => {
  const writeGarbage = (dbPath: string): void => {
    writeFileSync(dbPath, "THIS IS NOT A SQLITE DATABASE FILE");
    writeFileSync(`${dbPath}-wal`, "CORRUPT WAL");
  };

  it('onCorrupt "rename" (default, SessionDB policy): quarantines a .corrupt-<ts> copy and opens fresh', () => {
    const dbPath = tmpDb("corrupt-rename");
    writeGarbage(dbPath);
    try {
      const handle = openSQLite(dbPath);
      // Fresh DB is functional.
      handle.db.exec("CREATE TABLE IF NOT EXISTS t(x INTEGER)");
      handle.db.prepare("INSERT INTO t VALUES (?)").run(1);
      expect(handle.db.prepare("SELECT count(*) AS c FROM t").get()).toEqual({ c: 1 });
      // The corrupt original was renamed aside, not deleted.
      const quarantined = readdirSync(join(dbPath, "..")).filter((f) => f.includes(".corrupt-"));
      expect(quarantined.length).toBeGreaterThan(0);
      handle.close();
    } finally {
      rmSync(join(dbPath, ".."), { recursive: true, force: true });
    }
  });

  it('onCorrupt "delete" (ContentStore policy): removes the corrupt files outright, no quarantine', () => {
    const dbPath = tmpDb("corrupt-delete");
    writeGarbage(dbPath);
    try {
      const handle = openSQLite(dbPath, { onCorrupt: "delete" });
      handle.db.exec("CREATE TABLE IF NOT EXISTS t(x INTEGER)");
      handle.db.prepare("INSERT INTO t VALUES (?)").run(1);
      expect(handle.db.prepare("SELECT count(*) AS c FROM t").get()).toEqual({ c: 1 });
      // Nothing survives except the fresh DB trio — the garbage is gone.
      const stray = readdirSync(join(dbPath, "..")).filter((f) => f.includes(".corrupt-"));
      expect(stray).toEqual([]);
      handle.close();
    } finally {
      rmSync(join(dbPath, ".."), { recursive: true, force: true });
    }
  });

  it("non-corruption open errors propagate unchanged", () => {
    expect(() => openSQLite(tmpdir())).toThrow();
  });
});
