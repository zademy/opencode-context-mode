/**
 * db-base — Reusable SQLite infrastructure for open-context-mode packages.
 *
 * Provides lazy-loading of better-sqlite3, WAL pragma setup, prepared
 * statement caching interface, and DB file cleanup helpers. Both
 * ContentStore and SessionDB build on top of these primitives.
 */

import type DatabaseConstructor from "better-sqlite3";
import type { Database as DatabaseInstance } from "better-sqlite3";

export type { DatabaseInstance };
import { createRequire } from "node:module";
import { existsSync, unlinkSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// v1.0.130 — `acquireDbLock` + `locking_mode = EXCLUSIVE` were REMOVED.
// See docs/adr/0001-sessiondb-multi-writer.md for the architectural
// rationale. The short version: SessionDB is multi-writer-safe and the
// process-identity invariants the lockfile tried to enforce belong in
// the process layer (sibling-mcp), not the DB layer. WAL + busy_timeout
// + withRetry handle the actual concurrency safely.

// ─────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────

/**
 * Explicit interface for cached prepared statements that accept varying
 * parameter counts. better-sqlite3's generic `Statement` collapses under
 * `ReturnType` to a single-param signature, so we define our own.
 */
export interface PreparedStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  iterate(...params: unknown[]): IterableIterator<unknown>;
}

// ─────────────────────────────────────────────────────────
// bun:sqlite adapter (#45)
// ─────────────────────────────────────────────────────────

/**
 * Wraps a bun:sqlite Database to provide better-sqlite3-compatible API.
 * Bridges: .pragma(), multi-statement .exec(), .get() null→undefined.
 */
export class BunSQLiteAdapter {
  #raw: any;
  /** Every statement handed out by {@link prepare}, released on close (#1205). */
  #statements = new Set<any>();

  constructor(rawDb: any) {
    this.#raw = rawDb;
  }

  pragma(source: string): any {
    const stmt = this.#raw.prepare(`PRAGMA ${source}`);
    const rows = stmt.all();
    if (!rows || rows.length === 0) return undefined;
    // Multi-row pragmas (table_xinfo, etc.) → return array
    if (rows.length > 1) return rows;
    // Single-row: extract scalar value (e.g. journal_mode = "wal")
    const values = Object.values(rows[0] as Record<string, unknown>);
    return values.length === 1 ? values[0] : rows[0];
  }

  exec(sql: string): any {
    // bun:sqlite .exec() is single-statement only.
    // Split multi-statement SQL respecting string literals and comments — a
    // `;`, `'` or `"` inside a comment must neither split the statement nor
    // open a literal.
    let current = "";
    let inString: string | null = null;
    let inLineComment = false;
    let inBlockComment = false;
    // Whether `current` holds SQL outside comments. Neither bun:sqlite nor
    // better-sqlite3 can prepare a comment-only statement, so skip those.
    let hasCode = false;
    const flush = (): void => {
      const trimmed = current.trim();
      if (hasCode && trimmed) this.#raw.prepare(trimmed).run();
      current = "";
      hasCode = false;
    };
    for (let i = 0; i < sql.length; i++) {
      const ch = sql[i];
      const next = sql[i + 1];
      if (inLineComment) {
        current += ch;
        if (ch === "\n" || ch === "\r") inLineComment = false;
      } else if (inBlockComment) {
        current += ch;
        if (ch === "*" && next === "/") {
          current += next;
          i++;
          inBlockComment = false;
        }
      } else if (inString) {
        current += ch;
        if (ch === inString) inString = null;
      } else if (ch === "'" || ch === '"') {
        current += ch;
        inString = ch;
        hasCode = true;
      } else if (ch === "-" && next === "-") {
        current += ch + next;
        i++;
        inLineComment = true;
      } else if (ch === "/" && next === "*") {
        current += ch + next;
        i++;
        inBlockComment = true;
      } else if (ch === ";") {
        flush();
      } else {
        current += ch;
        // Every SQL whitespace character is at or below U+0020.
        if (ch.charCodeAt(0) > 32) hasCode = true;
      }
    }
    flush();
    return this;
  }

  prepare(sql: string): any {
    const stmt = this.#raw.prepare(sql);
    // #1205: bun:sqlite statements hold a connection pointer and are NOT
    // reclaimed by GC the way node:sqlite's are. Handing one out and never
    // finalizing it is what produced ~150k "invalid database connection
    // pointer" errors per day per pi session — the analytics scan alone
    // prepares a fresh statement per call (src/session/analytics.ts) and the
    // engine never closes the DB it borrows, so the statements outlived it.
    // Tracking them here means close() releases the whole set.
    this.#statements.add(stmt);
    return {
      run: (...args: unknown[]) => stmt.run(...args),
      get: (...args: unknown[]) => {
        const r = stmt.get(...args);
        return r === null ? undefined : r;
      },
      all: (...args: unknown[]) => stmt.all(...args),
      iterate: (...args: unknown[]) => stmt.iterate(...args),
    };
  }

  transaction(fn: (...args: any[]) => any): any {
    return this.#raw.transaction(fn);
  }

  close(): void {
    for (const stmt of this.#statements) {
      try {
        stmt.finalize();
      } catch {
        // Already finalized, or the raw db went first — never throw from close.
      }
    }
    this.#statements.clear();
    this.#raw.close();
  }
}

// ─────────────────────────────────────────────────────────
// node:sqlite adapter (#228)
// ─────────────────────────────────────────────────────────

/**
 * Wraps node:sqlite's DatabaseSync to provide better-sqlite3-compatible API.
 * Bridges: .pragma(), .transaction(). Everything else is passthrough.
 * Eliminates native addon SIGSEGV on Linux (nodejs/node#62515).
 */
export class NodeSQLiteAdapter {
  #raw: any; // DatabaseSync instance

  constructor(rawDb: any) {
    this.#raw = rawDb;
  }

  pragma(source: string): any {
    // "journal_mode = WAL" → PRAGMA journal_mode = WAL
    // "table_xinfo(session_events)" → PRAGMA table_xinfo(session_events)
    // "wal_checkpoint(TRUNCATE)" → PRAGMA wal_checkpoint(TRUNCATE)
    const stmt = this.#raw.prepare(`PRAGMA ${source}`);
    const rows = stmt.all();
    if (!rows || rows.length === 0) return undefined;
    if (rows.length > 1) return rows;
    const values = Object.values(rows[0] as Record<string, unknown>);
    return values.length === 1 ? values[0] : rows[0];
  }

  exec(sql: string): any {
    // node:sqlite's exec() supports multi-statement natively
    this.#raw.exec(sql);
    return this;
  }

  prepare(sql: string): any {
    const stmt = this.#raw.prepare(sql);
    return {
      run: (...args: unknown[]) => stmt.run(...args),
      get: (...args: unknown[]) => stmt.get(...args),
      all: (...args: unknown[]) => stmt.all(...args),
      iterate: (...args: unknown[]) => {
        // node:sqlite uses Symbol.iterator on StatementSync, not .iterate()
        // Check if iterate exists, otherwise use Symbol.iterator
        if (typeof stmt.iterate === "function") {
          return stmt.iterate(...args);
        }
        // Fallback: use all() to create an iterator
        const rows = stmt.all(...args);
        return rows[Symbol.iterator]();
      },
    };
  }

  transaction(fn: (...args: any[]) => any): any {
    // node:sqlite has no transaction() method — manual BEGIN/COMMIT/ROLLBACK
    return (...args: any[]) => {
      this.#raw.exec("BEGIN");
      try {
        const result = fn(...args);
        this.#raw.exec("COMMIT");
        return result;
      } catch (err) {
        this.#raw.exec("ROLLBACK");
        throw err;
      }
    };
  }

  close(): void {
    this.#raw.close();
  }
}

// ─────────────────────────────────────────────────────────
// Lazy loader
// ─────────────────────────────────────────────────────────

let _Database: typeof DatabaseConstructor | null = null;

/**
 * Probe whether the supplied node:sqlite DatabaseSync constructor links a
 * SQLite build that includes the FTS5 module. Some Node.js Linux builds
 * (e.g. v22.14.0 on Ubuntu) ship node:sqlite without FTS5 even though the
 * import succeeds, which silently breaks open_ctx_search/open_ctx_batch_execute and
 * the doctor's FTS5 check (issue #461).
 *
 * Returns true only when a `CREATE VIRTUAL TABLE … USING fts5(x)` statement
 * succeeds. Always returns false on any failure (constructor throw, missing
 * module, etc.) so the caller can fall through to better-sqlite3, whose
 * bundled SQLite always ships with FTS5.
 */
export function nodeSqliteHasFts5(DatabaseSync: any): boolean {
  let probe: any = null;
  try {
    probe = new DatabaseSync(":memory:");
    probe.exec("CREATE VIRTUAL TABLE __fts5_probe USING fts5(x)");
    return true;
  } catch {
    return false;
  } finally {
    try {
      probe?.close();
    } catch {
      /* probe never opened or already closed */
    }
  }
}

/**
 * Returns true when the current runtime ships a built-in SQLite binding:
 * - Bun has `bun:sqlite` always
 * - Node has `node:sqlite` since 22.5 (no flag since 22.13)
 *
 * Mirrors the helper in hooks/ensure-deps.mjs:61. Exported so the platform
 * gate in loadDatabase() can be unit-tested without spawning a child
 * process. `versionsOverride` and `bunOverride` are injection points for
 * tests — production callers pass nothing.
 *
 * Widening the gate from `process.platform === "linux"` to this helper is
 * required for Node 26 on macOS arm64 (#551): Node 26 removed
 * `info.This()` from V8 PropertyCallbackInfo, breaking better-sqlite3
 * 12.9.0's native compile. Using node:sqlite sidesteps the native addon
 * entirely on every platform that has it.
 */
export function hasModernSqlite(versionsOverride?: NodeJS.ProcessVersions, bunOverride?: unknown): boolean {
  const bun = bunOverride !== undefined ? bunOverride : (globalThis as any).Bun;
  if (typeof bun !== "undefined" && bun !== null) return true;
  const versions = versionsOverride ?? process.versions;
  const [majorStr, minorStr] = (versions.node ?? "0.0.0").split(".");
  const major = Number(majorStr);
  const minor = Number(minorStr);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return false;
  return major > 22 || (major === 22 && minor >= 5);
}

/**
 * Lazy-load the SQLite driver for the current runtime.
 * Bun → bun:sqlite via BunSQLiteAdapter (issue #45).
 * Modern Node (>= 22.5) → node:sqlite via NodeSQLiteAdapter when it ships FTS5 (#228, #461, #551).
 * Other Node (or modern Node without FTS5) → better-sqlite3 (native addon).
 */
export function loadDatabase(): typeof DatabaseConstructor {
  if (!_Database) {
    const require = createRequire(import.meta.url);

    if ((globalThis as any).Bun) {
      // Bun runtime — use bun:sqlite directly.
      // Array.join() prevents esbuild from resolving the specifier at bundle time.
      const BunDB = require(["bun", "sqlite"].join(":")).Database;
      _Database = function BunDatabaseFactory(path: string, opts?: any) {
        const raw = new BunDB(path, {
          readonly: opts?.readonly,
          create: true,
        });
        const adapter = new BunSQLiteAdapter(raw);
        // Propagate busy_timeout — better-sqlite3 does this via constructor
        // option but bun:sqlite does not, so we set it via pragma (#243)
        if (opts?.timeout) {
          adapter.pragma(`busy_timeout = ${opts.timeout}`);
        }
        return adapter;
      } as any;
    } else if (hasModernSqlite()) {
      // Any Node >= 22.5 — try node:sqlite to avoid the native addon path
      // entirely. Historically this was Linux-only (avoiding the Linux
      // SIGSEGV per nodejs/node#62515, #228), but Node 26 also broke
      // better-sqlite3's native compile on macOS arm64 by removing
      // V8 `info.This()` (#551). The built-in `node:sqlite` ships its
      // own SQLite, so it sidesteps both issues at once.
      //
      // Probe FTS5 support before committing — some Node builds ship
      // node:sqlite without FTS5, which would silently break open_ctx_search
      // (#461). The probe runs at most once per process (cached via
      // _Database below), so the cost of an in-memory DatabaseSync is
      // negligible.
      let DatabaseSync: any = null;
      try {
        // Array.join() prevents esbuild from resolving the specifier at bundle time
        // (mirrors the bun:sqlite branch above).
        ({ DatabaseSync } = require(["node", "sqlite"].join(":")));
      } catch {
        DatabaseSync = null;
      }
      if (DatabaseSync && nodeSqliteHasFts5(DatabaseSync)) {
        _Database = function NodeDatabaseFactory(path: string, opts?: any) {
          const raw = new DatabaseSync(path, {
            readOnly: opts?.readonly ?? false,
          });
          const adapter = new NodeSQLiteAdapter(raw);
          // Propagate busy_timeout — node:sqlite's DatabaseSync constructor
          // silently ignores `{ timeout }` (unlike better-sqlite3's native
          // C++ constructor), so we set it via PRAGMA, mirroring the Bun
          // branch above. Without this, the default is 0 and the first
          // write contention surfaces as immediate `SQLITE_BUSY`/`database
          // is locked` — defeating the 30s grace `withRetry()` is built
          // around. See issue #642 and ADR-0001 (multi-writer contract).
          if (opts?.timeout) {
            adapter.pragma(`busy_timeout = ${opts.timeout}`);
          }
          return adapter;
        } as any;
      } else {
        // node:sqlite missing or built without FTS5 — fall through to
        // better-sqlite3. Trade-off: on Node 26 + macOS this may now hit
        // the V8 ABI break (#551). A visible crash on the rare
        // unstable build is preferable to silent "no such module: fts5"
        // on every open_ctx_search call.
        _Database = require("better-sqlite3") as typeof DatabaseConstructor;
      }
    } else {
      // Old Node (< 22.5) without bun:sqlite — fall back to better-sqlite3.
      _Database = require("better-sqlite3") as typeof DatabaseConstructor;
    }
  }
  return _Database!;
}

// ─────────────────────────────────────────────────────────
// WAL setup
// ─────────────────────────────────────────────────────────

/**
 * Apply WAL mode and NORMAL synchronous pragma to a database instance.
 * Should be called immediately after opening a new database connection.
 *
 * WAL mode provides:
 * - Concurrent readers while a write is in progress
 * - Dramatically faster writes (no full-page sync on each commit)
 * NORMAL synchronous is safe under WAL and avoids an extra fsync per
 * transaction.
 */
export function applyWALPragmas(db: DatabaseInstance): void {
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  // mmap_size is opt-in (OPEN_CONTEXT_MODE_MMAP_SIZE=<bytes>), default off.
  // This helper is shared by ContentStore and SessionDB, both multi-writer
  // by contract (ADR 0001): sibling server processes rename/delete/recreate
  // these files on corruption recovery and stale cleanup (renameCorruptDB,
  // deleteDBFiles), and the DB itself may be truncated by a sibling's
  // checkpoint. Under mmap, a fault on a replaced or truncated mapping
  // cannot be handled by SQLite — it surfaces as an uncatchable signal
  // rather than a catchable error (https://sqlite.org/mmap.html,
  // disadvantage 1) — and Windows cannot truncate a memory-mapped file at
  // all (disadvantage 4). This fork shipped mmap ON by default for
  // read-heavy FTS5 performance; that default is what #1056 trades away
  // for multi-writer safety. Set OPEN_CONTEXT_MODE_MMAP_SIZE to buy the read()
  // bypass back for single-process, read-heavy workloads.
  const mmapSize = Number(process.env.OPEN_CONTEXT_MODE_MMAP_SIZE ?? "0");
  if (Number.isFinite(mmapSize) && mmapSize > 0) {
    try {
      db.pragma(`mmap_size = ${mmapSize}`);
    } catch {
      /* unsupported runtime */
    }
  }
  // NOTE: `locking_mode = EXCLUSIVE` is intentionally NOT applied here.
  // ALL DBs built on this helper — ContentStore (FTS5 shared knowledge
  // base) AND SessionDB (per-project events) — are multi-writer-safe by
  // contract. WAL + busy_timeout + the withRetry() wrapper below handle
  // SQLITE_BUSY natively. EXCLUSIVE locking is opt-out, never opt-in
  // from a base class shared by multi-writer consumers.
  // See docs/adr/0001-sessiondb-multi-writer.md for the v1.0.130 ADR.
}

// ─────────────────────────────────────────────────────────
// DB file helpers
// ─────────────────────────────────────────────────────────

/**
 * Remove orphaned WAL/SHM files when the main DB file doesn't exist.
 * On Windows, stale -wal/-shm files from crashed processes cause
 * "file is not a database" errors when creating a fresh DB.
 */
export function cleanOrphanedWALFiles(dbPath: string): void {
  if (!existsSync(dbPath)) {
    for (const suffix of ["-wal", "-shm"]) {
      try {
        unlinkSync(dbPath + suffix);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Delete all three SQLite files for a given db path (main, WAL, SHM).
 * Silently ignores individual deletion errors so a partial cleanup
 * does not abort the rest.
 */
export function deleteDBFiles(dbPath: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(dbPath + suffix);
    } catch {
      // ignore — file may not exist
    }
  }
}

/**
 * Safely close a database connection. Swallows errors so callers can
 * always call this in a finally/cleanup path without try/catch.
 *
 * No manual wal_checkpoint(TRUNCATE) is issued. On the multi-writer DBs
 * this helper serves (ADR 0001), every per-session server close used to
 * TRUNCATE the shared WAL and reset the wal-index while sibling server
 * processes held live connections — a cross-process file mutation that
 * is implicated in permanent SQLITE_IOERR wedges (#880, #992, #905). It
 * was also redundant: SQLite auto-checkpoints whenever the WAL reaches
 * 1000 pages, and when the LAST connection closes it runs its own
 * checkpoint and deletes the -wal/-shm files
 * (https://sqlite.org/wal.html sections 3.1 and 6). WAL bounding on
 * hard-exit paths (where the last close never happens) is covered by the
 * periodic PASSIVE checkpoint timer — startWalCheckpointTimer (#985,
 * NOT a proposal in this fork), wired via ContentStore.startCheckpointTimer.
 */
export function closeDB(db: DatabaseInstance): void {
  try {
    db.close();
  } catch {
    // ignore
  }
}

/**
 * Start a periodic PASSIVE WAL checkpoint on `db`, returning a stop function.
 *
 * `closeDB()`'s `wal_checkpoint(TRUNCATE)` is the only WAL-truncation path, and
 * it only runs on graceful shutdown. A server killed hard (crash, reboot,
 * SIGKILL, or a Windows parent-death before the lifecycle guard fires) never
 * reaches it, so under multi-session load the shared content-store WAL can grow
 * unbounded — the reader-starvation failure ADR 0001 attributes to #560. A
 * PASSIVE checkpoint reclaims whatever WAL frames it can between reader gaps; it
 * never blocks and touches no locking, so it stays fully within ADR 0001's
 * multi-writer contract (no EXCLUSIVE, no lockfile).
 *
 * The timer is `.unref()`'d so it never keeps the event loop alive. A
 * non-positive or non-finite interval disables it and returns a no-op stopper.
 */
export function startWalCheckpointTimer(db: DatabaseInstance, intervalMs: number): () => void {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return () => {};
  const timer = setInterval(() => {
    try {
      db.pragma("wal_checkpoint(PASSIVE)");
    } catch {
      /* best-effort — a busy or closing DB just retries next tick */
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

// ─────────────────────────────────────────────────────────
// Default path helper
// ─────────────────────────────────────────────────────────

/**
 * Return the default per-process DB path for open-context-mode databases.
 * Uses the OS temp directory and embeds the current PID so multiple
 * server instances never share a file.
 */
export function defaultDBPath(prefix: string = "open-context-mode"): string {
  return join(tmpdir(), `${prefix}-${process.pid}.db`);
}

// ─────────────────────────────────────────────────────────
// Retry helper
// ─────────────────────────────────────────────────────────

/**
 * Retry a DB operation with exponential backoff on SQLITE_BUSY errors.
 * Catches errors containing "SQLITE_BUSY" or "database is locked" and
 * retries up to 3 times with delays: 100ms, 500ms, 2000ms.
 * If all retries fail, throws a descriptive error.
 * Pass custom delays for testing (e.g., [0, 0, 0] to skip waits).
 */
// Shared 4-byte cell for Atomics.wait; the value is never read.
const _sleepCell = new Int32Array(new SharedArrayBuffer(4));

/**
 * Block the calling thread for `ms` without consuming CPU.
 *
 * withRetry has to stay synchronous — it wraps prepared-statement calls that
 * are synchronous — but the previous backoff spun on Date.now() for the whole
 * delay. On a contended database that pegged a core for 100 + 500 + 2000 ms
 * per operation, inside the event loop, with every statement queued behind it
 * (#985). Atomics.wait parks the thread instead.
 */
function sleepSync(ms: number): void {
  if (!(ms > 0)) return;
  Atomics.wait(_sleepCell, 0, 0, ms);
}

/**
 * Error substrings that indicate a *transient* SQLite failure $ one worth
 * retrying rather than surfacing to the caller.
 *
 * SQLITE_IOERR is included deliberately. On macOS it is most often transient
 * (filesystem pressure, Spotlight/iCloud touching the DB mid-write, a WAL
 * hiccup) rather than a damaged file. Before this list existed, IOERR fell
 * into a gap: not matched here so it got zero retries, and not matched by
 * isSQLiteCorruptionError() either, so no recovery ran. A single blip
 * hard-failed the caller $ e.g. open_ctx_fetch_and_index aborting a page index.
 *
 * IOERR must NOT be added to isSQLiteCorruptionError(): that path renames or
 * deletes the DB file, which would destroy a healthy knowledge base over a
 * momentary I/O stall. Retry here; recover there.
 */
const TRANSIENT_ERROR_PATTERNS = ["SQLITE_BUSY", "database is locked", "SQLITE_IOERR", "disk I/O error"];

/**
 * Retry a DB operation with exponential backoff on transient SQLite errors.
 * Catches SQLITE_BUSY / "database is locked" and SQLITE_IOERR / "disk I/O
 * error" and retries up to 3 times with delays: 100ms, 500ms, 2000ms.
 * If all retries fail, throws a descriptive error naming the actual cause.
 * Pass custom delays for testing (e.g., [0, 0, 0] to skip waits).
 *
 * When a heal callback is provided AND the caught error matches the
 * SQLite-corruption predicate (SQLITE_CORRUPT / disk image is malformed /
 * file is not a database), the callback is invoked BEFORE the retry so the
 * caller can close the held connection, heal the on-disk file (best-effort
 * lossless VACUUM INTO → atomic swap, falling back to rename-and-recreate),
 * and reopen. The retry then passes through the full transient-retry loop
 * so lock contention on the healed DB does not fail the operation.
 * Covers mid-session corruption on a long-held handle (ContentStore,
 * SessionDB) — the open-time guard alone missed it (#867).
 */
/**
 * Corruption branch of {@link withRetry}: heal, then re-run the full
 * transient-retry loop. The nested call deliberately omits `heal` — a DB
 * still corrupt after one heal falls through to rename-and-recreate
 * paths, never recursion. Returns normally when the retry succeeds.
 */
function retryAfterHeal<T>(fn: () => T, delays: number[], originalMsg: string): T {
  // Preserves the BUSY/IOERR resilience on the healed DB instead of giving
  // up after one shot (#867 review).
  try {
    return withRetry(fn, delays);
  } catch (retryErr: unknown) {
    const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
    throw new Error(`Write failed after corruption heal: ${retryMsg}. ` + `Original corruption: ${originalMsg}`);
  }
}

/**
 * Build the error thrown once every retry is spent. It names the class we
 * actually exhausted on — reporting "database is locked" for an I/O failure
 * sends the caller after the wrong root cause.
 */
function retriesExhausted(lastError: Error | undefined, attempts: number): Error {
  const failure = lastError?.message ?? "";
  const cause =
    failure.includes("SQLITE_IOERR") || failure.includes("disk I/O error")
      ? "SQLITE_IOERR: disk I/O error"
      : "SQLITE_BUSY: database is locked";
  return new Error(`${cause} after ${attempts} retries. ` + `Original error: ${lastError?.message}`);
}

export function withRetry<T>(fn: () => T, delays: number[] = [100, 500, 2000], heal?: () => boolean): T {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return fn();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isSQLiteCorruptionError(msg) && heal) {
        if (heal()) return retryAfterHeal(fn, delays, msg);
        // heal failed — throw original corruption error
      }
      if (!TRANSIENT_ERROR_PATTERNS.some((p) => msg.includes(p))) {
        throw err;
      }
      lastError = err instanceof Error ? err : new Error(msg);
      if (attempt < delays.length) sleepSync(delays[attempt]);
    }
  }
  throw retriesExhausted(lastError, delays.length);
}

// ─────────────────────────────────────────────────────────
// Corrupt DB recovery (#244)
// ─────────────────────────────────────────────────────────

/**
 * Detect SQLite corruption errors that warrant a rename-and-recreate.
 * Matches SQLITE_CORRUPT, SQLITE_NOTADB, and their human-readable equivalents.
 */
export function isSQLiteCorruptionError(msg: string): boolean {
  return (
    msg.includes("SQLITE_CORRUPT") ||
    msg.includes("SQLITE_NOTADB") ||
    msg.includes("database disk image is malformed") ||
    msg.includes("file is not a database")
  );
}

/**
 * Rename a corrupt DB and its WAL/SHM files so a fresh DB can be created.
 * Best-effort — individual rename failures are silently ignored.
 */
export function renameCorruptDB(dbPath: string): void {
  const ts = Date.now();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      renameSync(dbPath + suffix, `${dbPath}${suffix}.corrupt-${ts}`);
    } catch {
      /* file may not exist */
    }
  }
}

/**
 * Best-effort lossless heal of a corrupt SQLite database via
 * VACUUM INTO → integrity check → atomic swap (#867).
 *
 * Opens a read-only connection on the corrupt file, runs
 * `VACUUM INTO '<tmp>'` to rebuild a clean copy (data-preserving
 * when corruption is in freelist / indexes — the common mid-session
 * case, but not guaranteed when the b-tree itself is damaged), then
 * verifies the result with `PRAGMA quick_check` before atomically
 * swapping the healed file in place.
 *
 * Returns `true` if the heal + verification succeeded, `false` if
 * the file is too damaged even for a readonly open, VACUUM INTO
 * throws, or quick_check does not return "ok" (caller should fall
 * back to `renameCorruptDB` → recreate-empty).
 */
export function attemptLosslessHeal(dbPath: string): boolean {
  const Database = loadDatabase();
  const tmpPath = `${dbPath}.heal-${Date.now()}`;
  try {
    const src = new Database(dbPath, { readonly: true });
    try {
      src.exec(`VACUUM INTO '${tmpPath.replace(/'/g, "''")}'`);
    } finally {
      try {
        src.close();
      } catch {
        /* ignore */
      }
    }

    // Verify healed copy before swapping — don't replace the original
    // with a broken rebuild (#867 review).
    // Use prepare().get() instead of pragma() because adapters disagree on
    // the return type: better-sqlite3 returns [{quick_check:"ok"}], while
    // NodeSQLiteAdapter unwraps single-row/single-col to the scalar "ok".
    // prepare('PRAGMA quick_check').get() always returns {quick_check:…}.
    const healed = new Database(tmpPath, { readonly: true });
    let ok = false;
    try {
      const row = healed.prepare("PRAGMA quick_check").get() as { quick_check: string } | undefined;
      ok = row?.quick_check === "ok";
    } catch {
      /* quick_check threw — heal failed */
    }
    try {
      healed.close();
    } catch {
      /* ignore */
    }
    if (!ok) {
      try {
        unlinkSync(tmpPath);
      } catch {
        /* ignore */
      }
      return false;
    }

    // Atomic swap: backup old → healed takes its place
    const backupPath = `${dbPath}.corrupt-${Date.now()}`;
    renameSync(dbPath, backupPath);
    renameSync(tmpPath, dbPath);
    // Fork adaptation (#871 ledger): drop the LIVE path's stale -wal/-shm
    // too, not just the backup's. This fork is multi-writer by contract
    // (v1.0.130) — another process's WAL for this dbPath survives the swap,
    // and the healed file would re-attach it and re-corrupt on first write.
    // Upstream only removed the backup's sidecars.
    for (const s of ["-wal", "-shm"]) {
      try {
        unlinkSync(dbPath + s);
      } catch {
        /* ignore */
      }
      try {
        unlinkSync(backupPath + s);
      } catch {
        /* ignore */
      }
    }
    return true;
  } catch {
    try {
      unlinkSync(tmpPath);
    } catch {
      /* ignore */
    }
    return false;
  }
}

/**
 * Close a held DB handle, heal (or rename) the on-disk file, and reopen
 * with fresh schema + statements initialized via `onReopen` (#867).
 *
 * Extracted from `SQLiteBase` and `ContentStore` — the same heal+reopen
 * sequence is used by both mid-session corruption paths.
 */
export function reopenAfterHeal(dbPath: string, oldDb: DatabaseInstance, onReopen: (db: DatabaseInstance) => void): DatabaseInstance {
  try {
    oldDb.close();
  } catch {
    /* already closed or damaged */
  }

  if (!attemptLosslessHeal(dbPath)) {
    renameCorruptDB(dbPath);
  }

  const Database = loadDatabase();
  const newDb = new Database(dbPath, { timeout: 30000 });
  applyWALPragmas(newDb);
  onReopen(newDb);
  return newDb;
}

// ─────────────────────────────────────────────────────────
// Shared open/lifecycle seam (openSQLite)
// ─────────────────────────────────────────────────────────

/**
 * Track all live DatabaseInstance objects so we can close them on process exit.
 * Prevents better-sqlite3 segfaults caused by V8 garbage-collecting Database
 * objects after the native addon context is already torn down.
 *
 * Uses a global symbol so the set and exit handler survive vitest's module
 * re-imports within the same fork process (ESM isolate mode clears
 * module-level state but globalThis persists).
 */
// v1.0.130 — symbol name bumped because the value type reverted from
// Map<DatabaseInstance, string> (v1.0.128 lockfile pairing) back to
// Set<DatabaseInstance>. A persistent global slot from a v1.0.128 or
// v1.0.129 module would deserialize as the wrong shape and crash the
// exit hook iteration.
const _kLiveDBs = Symbol.for("__context_mode_live_dbs_v3__");
const _liveDBs: Set<DatabaseInstance> = (() => {
  const g = globalThis as Record<symbol, Set<DatabaseInstance> | undefined>;
  if (!g[_kLiveDBs]) {
    g[_kLiveDBs] = new Set<DatabaseInstance>();
    process.on("exit", () => {
      for (const db of g[_kLiveDBs]!) {
        closeDB(db);
      }
      g[_kLiveDBs]!.clear();
    });
  }
  return g[_kLiveDBs]!;
})();

/** What to do with the on-disk files when the initial open reports corruption. */
export type CorruptOpenPolicy = "rename" | "delete";

export interface OpenSQLiteOptions {
  /**
   * Create tables / run migrations. Invoked with every freshly opened
   * connection — the initial open AND every reopen after a mid-session
   * corruption heal — before `prepareStatements`.
   */
  initSchema?: (db: DatabaseInstance) => void;
  /**
   * Compile and cache prepared statements. Invoked after `initSchema` on
   * every open. Statements from a previous open are stale after a heal —
   * recompile here.
   */
  prepareStatements?: (db: DatabaseInstance) => void;
  /**
   * Corrupt-file policy when the initial open hits SQLITE_CORRUPT /
   * NOTADB. "rename" (default) keeps a `<file>.corrupt-<ts>` quarantine
   * copy — right when the data is NOT re-derivable (SessionDB events).
   * "delete" removes main/-wal/-shm outright — right when the data IS
   * re-derivable (ContentStore chunks can be re-indexed from source).
   */
  onCorrupt?: CorruptOpenPolicy;
}

/**
 * Compositional replacement for the old `SQLiteBase` template-method base
 * class: a handle owns ONE database's lifecycle (open → WAL → schema →
 * statements → close/cleanup/heal) so stores embed it instead of
 * inheriting it. SessionDB and ContentStore both build on this seam,
 * which is what ADR 0001 describes ("the shared ctor for SessionDB and
 * ContentStore").
 */
export interface SQLiteHandle {
  /**
   * The live connection. Replaced (and re-registered in the process-exit
   * set) after a mid-session corruption heal — always read it fresh
   * rather than caching it across a withRetry boundary.
   */
  readonly db: DatabaseInstance;
  /** The path this database was opened from. */
  readonly dbPath: string;
  /** Close the connection without deleting files. Unregisters from the exit set. */
  close(): void;
  /** Close and delete the main/-wal/-shm files. Unregisters from the exit set. */
  cleanup(): void;
  /**
   * `withRetry` with the #867 heal chain wired: on SQLITE_CORRUPT the
   * held handle is closed, the file is healed (lossless VACUUM INTO →
   * atomic swap, falling back to rename-and-recreate), the DB is
   * reopened, and `initSchema` + `prepareStatements` re-run before the
   * write is retried.
   */
  withRetry<T>(fn: () => T): T;
}

/**
 * Open (or create) a SQLite DB at `dbPath` and return a handle owning its
 * lifecycle: open (with corrupt-file recovery per `opts.onCorrupt`) → WAL
 * pragmas → `initSchema` → `prepareStatements`, plus `_liveDBs`
 * registration for the process-exit close guard.
 *
 * v1.0.130 — multi-writer is the contract. ALL consumers (SessionDB,
 * ContentStore) may open the same on-disk dbPath from multiple processes
 * simultaneously — that is the legitimate multi-window UX shape and the
 * WAL handles it natively. SQLITE_BUSY on write contention is absorbed
 * by `withRetry()` (busy_timeout = 30000ms inside `new Database(...)`).
 *
 * v1.0.128 introduced a single-writer guard here as a defense against
 * #560. That defense was an over-correction — the actual root causes of
 * #560 were #559 (zombie MCP child accumulation) and #561 (Pi
 * misdetection writing to the wrong DB path), both fixed in v1.0.128 +
 * v1.0.129. The single-writer guard broke legitimate multi-window users;
 * v1.0.130 rolls it out. See docs/adr/0001-sessiondb-multi-writer.md and
 * the v1.0.130 INVARIANT block in tests/util/db-base-platform-gate.test.ts
 * for the regression-proof anchor (source-pin + behavioural).
 */
export function openSQLite(dbPath: string, opts: OpenSQLiteOptions = {}): SQLiteHandle {
  const onCorrupt = opts.onCorrupt ?? "rename";
  let db = openWithCorruptionRecovery(dbPath, onCorrupt);
  _liveDBs.add(db);

  // Runs on the initial open AND on every reopen inside withRetry's heal
  // chain — callbacks receive the CURRENT connection, so schema init and
  // statement compilation never race a handle swap.
  const reinit = (d: DatabaseInstance): void => {
    opts.initSchema?.(d);
    opts.prepareStatements?.(d);
  };
  reinit(db);

  return {
    get db() {
      return db;
    },
    dbPath,
    close() {
      _liveDBs.delete(db);
      closeDB(db);
    },
    cleanup() {
      _liveDBs.delete(db);
      closeDB(db);
      deleteDBFiles(dbPath);
    },
    withRetry<T>(fn: () => T): T {
      return withRetry(fn, undefined, () => {
        _liveDBs.delete(db);
        db = reopenAfterHeal(dbPath, db, reinit);
        _liveDBs.add(db);
        return true;
      });
    },
  };
}

/**
 * Open a DB at `dbPath` with WAL pragmas applied. On a corruption error,
 * apply the caller's policy to the on-disk files (`rename` quarantines
 * them, `delete` unlinks them), then retry the open once. Non-corruption
 * errors propagate unchanged.
 */
function openWithCorruptionRecovery(dbPath: string, onCorrupt: CorruptOpenPolicy): DatabaseInstance {
  const Database = loadDatabase();
  cleanOrphanedWALFiles(dbPath);
  let db: DatabaseInstance | undefined;
  try {
    db = new Database(dbPath, { timeout: 30000 });
    applyWALPragmas(db);
    return db;
  } catch (err) {
    // Release the failed connection BEFORE touching the files. SQLite opens
    // them on Windows without FILE_SHARE_DELETE, so a handle still open here
    // turns the rename/unlink below into a silent no-op (its try/catch
    // swallows the sharing violation) and the retry open then fails on the
    // very corruption we were asked to recover from.
    if (db) closeDB(db);
    const msg = err instanceof Error ? err.message : String(err);
    if (!isSQLiteCorruptionError(msg)) throw err;
    if (onCorrupt === "delete") deleteDBFiles(dbPath);
    else renameCorruptDB(dbPath);
    cleanOrphanedWALFiles(dbPath);
    try {
      const db = new Database(dbPath, { timeout: 30000 });
      applyWALPragmas(db);
      return db;
    } catch (retryErr) {
      throw new Error(
        `Failed to create fresh DB after ${onCorrupt === "delete" ? "deleting" : "renaming"} corrupt file: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`,
      );
    }
  }
}
