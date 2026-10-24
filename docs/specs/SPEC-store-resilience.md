# SPEC — store-resilience

**Status:** Implemented 2026-10-24 (see Implementation Record)
**Module:** `store-resilience` (SPEC-map build order #2)

## Problem

The persistence layer (SessionDB for session capture/resume, ContentStore for FTS5 search) already has two resilience tiers, but they only cover half the failure surface:

**Tier 1 — open-time corruption (handled, #244/#871):** `openSQLite` → `openWithCorruptionRecovery`: lossless heal (`VACUUM INTO` + `quick_check` verify + atomic swap) → `onCorrupt` policy (`rename` for SessionDB, `delete` for ContentStore) → reopen.

**Tier 2 — mid-session WRITE corruption (handled, #867):** `SQLiteHandle.withRetry(fn)` wires the heal chain: SQLITE_CORRUPT-class error → close held handle → `reopenAfterHeal` (lossless heal → rename fallback) → reopen → `initSchema`+`prepareStatements` re-run (`reinit`) → retry the fn. SessionDB `insertEvent`/`bulkInsertEvents` and ContentStore `#insertChunks` callers route through it.

**The gap — mid-session READS and the remaining WRITES bypass both tiers:**

- SessionDB reads (`getEvents`, `getSessionStats`, `claimLatestUnconsumedResume`, `searchEvents`, `getToolCallStats`, …) call `this.stmt(...).get/.all()` directly: no transient retry, no corruption heal. A SQLITE_BUSY or SQLITE_CORRUPT surfaces as a throw.
- SessionDB writes outside insertEvent (`ensureSession`, `upsertResume`, `incrementCompactCount`, `setUsageCursor`, `markResumeConsumed`, `incrementToolCall`, `deleteEvents`, `cleanupOldSessions`) are equally unwrapped.
- ContentStore search paths (`search` L1297, `searchTrigram` L1330) call the standalone `withRetry` (transient-only, no heal); `getIndexState` and `#refreshStaleSources` use `this.#db` raw.

Consequence today: a runtime DB fault turns a read into a propagated error (MCP tool error / hook failure — module `hook-resilience` skips and eventually disables the hook, but the session's capture/resume is lost until process restart, and the corrupt file is never healed because only a write triggers heal).

## Goals

1. **One resilience seam for every DB touchpoint.** All SessionDB and ContentStore public operations route through the handle's healed `withRetry` (transient backoff + corruption heal + reopen + reinit + one retry).
2. **Reads degrade gracefully, not loudly.** A corrupt-at-read DB heals transparently; the read returns healed-DB results (lossless heal preserves data; unhealable corruption quarantines → fresh empty DB → empty result) instead of throwing into the host.
3. **No capture loss on transient contention.** The unwrapped write set gets the same BUSY/locked backoff the insert paths already had.
4. **Closure re-resolution invariant.** Statement handles are re-resolved inside the retried closure (cached statements are re-created by `reinit` after a heal; a statement captured outside the closure points at a closed connection).

## Non-Goals

- Changing the heal machinery itself (`attemptLosslessHeal`, `renameCorruptDB`, policies) — it exists and works; this module routes traffic to it.
- ContentStore mid-session heal policy change (mid-session falls back to `rename` even though open-time policy is `delete` — preserving evidence is acceptable; documented, not changed).
- FTS5 index rebuild strategy beyond what reopen+`initSchema` already does → potential future work.
- MCP-tool-layer error wrapping → already exists (`wrapToolHandler`).
- Hook-layer degradation → module `hook-resilience` (shipped 3.3.0).

## Resolved Decisions

| Open question | Decision | Rationale |
|---|---|---|
| Wrap reads individually or at a statement-seam proxy? | **Explicit per-method body wraps**, matching the existing `insertEvent` house pattern. | A proxy over `stmt()` cannot catch execution-time throws (they happen after lookup, in `.get()/.all()`); explicit wraps are dumb, greppable, and consistent. |
| Retry semantics for multi-statement methods | **Wrap the whole body in ONE withRetry**; reads are pure, writes are idempotent (single statements or INSERT OR IGNORE / flag sets). | Atomic-statement retries can't double-apply: a thrown statement did not commit; heal preserves committed state. |
| How to test mid-session corruption without flaky real-file corruption (SQLite page cache can serve reads from cache and never see the corrupted bytes) | **Seam tests**: inject a corruption-class error through a real handle's `withRetry` (real files, lossless heal, real reopen+reinit) + **source-contract tests** (house pattern from `auto-injection-label`) pinning that the read/write methods route through the healed seam. | Deterministic on all platforms; the heal chain itself is exercised for real (file-level), the routing is pinned textually. |
| Behavior change: reads that previously threw now return healed/empty results | **Accepted — this is the module's purpose.** Corrupt-at-read no longer errors the tool/hook; it heals and returns what the healed DB has. | Graceful degradation over loud failure (initiative mission). The quarantine file preserves the pre-heal evidence. |

## Success Criteria — Verification

1. Seam test: a corruption-class error thrown inside `handle.withRetry` on a populated DB → operation returns the retried result AND previously-inserted rows are still readable (lossless heal preserved them).
2. Seam test: transient error then success → retries succeed without heal.
3. Source-contract test: every SessionDB public DB-touching method except the already-wrapped inserts routes through `this.withRetry`; ContentStore `search`/`searchTrigram` route through `this.#handle.withRetry` with statements re-resolved inside the closure.
4. Full suite green (`vp test run`), lint 0 errors, format check passes.
5. No behavioral regression: existing open-time and write-heal tests stay green unchanged.

## Testing Strategy

- `tests/store-resilience.test.ts` (vite-plus/test, house style): BEHAVIOURAL seam tests — corruption-class errors injected through the statement cache prove the heal chain end-to-end (reopen, reinit re-binds statements, lossless data preservation) — plus one source-contract group for ContentStore (ES-# private statements are unreachable from tests; precedent: auto-injection-label).
- Real mid-session file corruption is deliberately NOT simulated (page-cache non-determinism → flake risk); open-time corruption stays covered by existing tests.

## Implementation Record

- **Latent bug fixed**: `insertEvent`/`bulkInsertEvents` built the transaction object OUTSIDE `withRetry`; after a corruption heal the retry re-ran a binding to the CLOSED pre-heal connection ("connection is not open") — the #867 write-heal could never actually succeed. The transaction is now constructed inside the retried closure (`this.withRetry(() => this.db.transaction(work)())`).
- `src/session/db.ts`: wrapped public read/write methods in `this.withRetry(() => …)` — getEvents, getEventCount, getEventBytesSummary, getLatestAttributedProjectDir, _getSessionProjectDir, searchEvents, getSessionIdsForProject, getSessionStats, getSessionRollup, getUsageCursor, getResume, claimLatestUnconsumedResume, getLatestSessionId, getToolCallStats, ensureSession, incrementCompactCount, setUsageCursor, upsertResume, markResumeConsumed, incrementToolCall, deleteSession, cleanupOldSessions.
- `src/store.ts`: `search`/`searchTrigram` → `this.#handle.withRetry` with statement re-resolution inside the closure; `getIndexState` and `#refreshStaleSources` wrapped via the handle; standalone `withRetry` import dropped.
- `src/store.ts`: `search`/`searchTrigram` → `this.#handle.withRetry` with statement re-resolution inside the closure; `getIndexState` and `#refreshStaleSources` wrapped via the handle.
- `tests/store-resilience.test.ts`: 5 tests — 4 behavioural (read heal, write transaction re-bind, resume claim heal, transient BUSY retry) + 1 source-contract group (ContentStore). A "corruption survives heal" test was designed out: the injection seam is the statement cache, and reinit legitimately replaces injected stubs after every heal, so a permanent-corruption scenario cannot be simulated deterministically at this seam (file-level simulation rejected as flaky).
