import { describe, it, expect } from "vite-plus/test";
import { BunSQLiteAdapter } from "../src/db-base.js";

/**
 * bun:sqlite statements must be finalized, and the adapter owns them (#1205).
 *
 * bun:sqlite does not reclaim statements by GC the way node:sqlite does: an
 * unfinalized statement keeps a connection pointer, and a busy pi session
 * produced ~150k "invalid database connection pointer" errors per day. The
 * analytics engine prepares a fresh statement per call and never closes the DB
 * it borrows, so the statements outlive the caller — the only place that can
 * release them is the adapter's close().
 *
 * A fake raw db stands in for bun:sqlite: this is about the adapter's
 * bookkeeping, not about bun's internals.
 */

interface FakeStmt {
  finalized: boolean;
  run: () => unknown;
  get: () => unknown;
  all: () => unknown[];
  iterate: () => IterableIterator<unknown>;
  finalize: () => void;
}

function fakeRaw() {
  const prepared: FakeStmt[] = [];
  let closed = false;
  return {
    prepared,
    closed: () => closed,
    db: {
      prepare: (): FakeStmt => {
        const stmt: FakeStmt = {
          finalized: false,
          run: () => ({ changes: 0, lastInsertRowid: 0 }),
          get: () => ({ ok: 1 }),
          all: () => [{ ok: 1 }],
          iterate: () => [][Symbol.iterator]() as IterableIterator<unknown>,
          finalize: () => {
            stmt.finalized = true;
          },
        };
        prepared.push(stmt);
        return stmt;
      },
      close: () => {
        closed = true;
      },
    },
  };
}

describe("BunSQLiteAdapter statement ownership (#1205)", () => {
  it("finalizes every statement it handed out, before closing the db", () => {
    const raw = fakeRaw();
    const adapter = new BunSQLiteAdapter(raw.db);

    for (let i = 0; i < 25; i++) adapter.prepare(`SELECT ${i}`);
    expect(raw.prepared).toHaveLength(25);
    expect(raw.prepared.every((s) => !s.finalized)).toBe(true);

    adapter.close();

    expect(
      raw.prepared.every((s) => s.finalized),
      "a statement survived close()",
    ).toBe(true);
    expect(raw.closed()).toBe(true);
  });

  it("still bridges the better-sqlite3 surface (get null -> undefined, all, run)", () => {
    const adapter = new BunSQLiteAdapter({
      prepare: () => ({
        run: () => ({ changes: 1, lastInsertRowid: 7 }),
        get: () => null,
        all: () => [{ a: 1 }],
        iterate: () => [][Symbol.iterator](),
        finalize: () => {},
      }),
      close: () => {},
    });

    expect(adapter.prepare("SELECT 1").get()).toBeUndefined();
    expect(adapter.prepare("SELECT 1").all()).toEqual([{ a: 1 }]);
    expect(adapter.prepare("INSERT").run()).toEqual({ changes: 1, lastInsertRowid: 7 });
    adapter.close();
  });

  it("close() survives a statement that throws on finalize", () => {
    let closed = false;
    const adapter = new BunSQLiteAdapter({
      prepare: () => ({
        run: () => ({}),
        get: () => null,
        all: () => [],
        iterate: () => [][Symbol.iterator](),
        finalize: () => {
          throw new Error("statement already finalized");
        },
      }),
      close: () => {
        closed = true;
      },
    });

    adapter.prepare("SELECT 1");
    expect(() => adapter.close()).not.toThrow();
    expect(closed).toBe(true);
  });
});
