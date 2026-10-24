/**
 * store-resilience — mid-session DB faults must heal, not propagate.
 *
 * SessionDB assertions are fully behavioural: a corruption-class error is
 * injected through the statement cache (the TS-private `stmts` map — the
 * one seam every DB read/write flows through). The assertion is that the
 * operation HEALS: openSQLite's reopenAfterHeal re-runs prepareStatements,
 * which replaces the injected stub with a live statement bound to the
 * reopened connection, and the retried call returns real results. If the
 * method under test does not route through the healed withRetry seam, the
 * injected error simply propagates and the test fails.
 *
 * ContentStore search statements are ES-# private and unreachable from
 * tests, so those call sites are pinned on source text instead — same
 * precedent as tests/hooks/auto-injection-label.test.ts.
 */

import { describe, test, expect, afterEach } from "vite-plus/test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { SessionDB } from "../src/session/db.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

type StubStmt = {
  get?: (...a: unknown[]) => unknown;
  all?: (...a: unknown[]) => unknown;
  run?: (...a: unknown[]) => unknown;
};

/** The statement cache — TS-private (erased at runtime), the injection seam. */
function stmtsOf(db: SessionDB): Map<string, StubStmt> {
  return (db as unknown as { stmts: Map<string, StubStmt> }).stmts;
}

const live: Array<{ db: SessionDB; dir: string }> = [];

function fixture(): SessionDB {
  const dir = mkdtempSync(join(tmpdir(), "store-res-"));
  const db = new SessionDB({ dbPath: join(dir, "session.db") });
  live.push({ db, dir });
  return db;
}

afterEach(() => {
  while (live.length) {
    const { db, dir } = live.pop()!;
    try {
      db.cleanup();
    } catch {
      /* already closed */
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

const sid = "sess-resilience";

describe("SessionDB — mid-session corruption heals instead of propagating", () => {
  test("read path: getEvents heals, keeps committed rows, and re-binds statements", () => {
    const db = fixture();
    db.ensureSession(sid, "/proj/resilience");
    db.insertEvent(sid, { type: "file_edit", category: "tool", data: "alpha", priority: 2 });
    expect(db.getEvents(sid)).toHaveLength(1);

    let armed = true;
    stmtsOf(db).set("getEvents", {
      all: () => {
        if (armed) {
          armed = false;
          throw new Error("file is not a database");
        }
        throw new Error("stub survived reinit — statement was not re-bound after heal");
      },
    });

    // Current behaviour (unrouted): throws. Healed behaviour: lossless heal
    // preserves the committed row and the retried read returns it.
    expect(db.getEvents(sid)).toHaveLength(1);
  });

  test("write path: insertEvent retries on the reopened connection (transaction re-bind)", () => {
    const db = fixture();
    db.ensureSession(sid, "/proj/resilience");

    let armed = true;
    stmtsOf(db).set("insertEvent", {
      run: () => {
        if (armed) {
          armed = false;
          throw new Error("database disk image is malformed");
        }
      },
    });

    // A transaction object built outside withRetry is bound to the pre-heal
    // connection and dies with it; the retry must BEGIN on the reopened one.
    expect(() => db.insertEvent(sid, { type: "file_edit", category: "tool", data: "beta", priority: 2 })).not.toThrow();
    expect(db.getEventCount(sid)).toBe(1);
  });

  test("resume claim heals and returns the snapshot", () => {
    const db = fixture();
    db.ensureSession("s-author", "/proj/resilience");
    db.ensureSession("s-reader", "/proj/resilience");
    db.upsertResume("s-author", "SNAPSHOT-CONTENT", 3);

    let armed = true;
    stmtsOf(db).set("claimLatestUnconsumedResume", {
      get: () => {
        if (armed) {
          armed = false;
          throw new Error("database disk image is malformed");
        }
        throw new Error("stub survived reinit — statement was not re-bound after heal");
      },
    });

    const claimed = db.claimLatestUnconsumedResume("s-reader");
    expect(claimed?.snapshot).toBe("SNAPSHOT-CONTENT");
  });

  test("transient BUSY on a write retries without losing the write", () => {
    const db = fixture();
    db.ensureSession(sid, "/proj/resilience");

    const real = stmtsOf(db).get("upsertResume")!;
    let calls = 0;
    stmtsOf(db).set("upsertResume", {
      run: (...a: unknown[]) => {
        calls += 1;
        if (calls === 1) throw new Error("database is locked");
        (real.run as (...a: unknown[]) => unknown)(...a);
      },
    });

    expect(() => db.upsertResume(sid, "TRANSIENT", 1)).not.toThrow();
    expect(calls).toBe(2);
  });
});

describe("ContentStore — search paths route through the healed handle seam", () => {
  test("search and searchTrigram heal on corruption and re-resolve statements inside the closure", () => {
    const src = readFileSync(join(root, "src", "store.ts"), "utf8");

    // Statements must be picked INSIDE the retried closure: a heal re-runs
    // prepareStatements, so a statement captured outside points at the
    // closed pre-heal connection. This pins that shape.
    expect(src).toMatch(/#handle\.withRetry\(\(\) => \{\s*\n\s*let stmt: PreparedStatement;/);

    // The old unhealed routing is gone.
    expect(src).not.toMatch(/return withRetry\(\(\) => this\.#mapSearchRows/);

    // The standalone transient-only withRetry is no longer imported for the
    // search paths (write paths use #handle.withRetry).
    expect(src).not.toMatch(/import \{ openSQLite, withRetry, startWalCheckpointTimer \}/);
  });
});
