/**
 * Unified multi-source search — merges ContentStore, SessionDB, and
 * auto-memory results into a single ranked or chronological result set.
 *
 * Used by open_ctx_search when sort="timeline" to search across all sources,
 * or sort="relevance" (default) for ContentStore-only BM25 search.
 */

import type { ContentStore, SearchResult } from "../store.js";
import type { SessionDB, StoredEvent } from "../session/db.js";
import { searchAutoMemory, type AutoMemoryAdapter } from "./auto-memory.js";

const DEBUG = process.env.DEBUG?.includes("open-context-mode");

// ─────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────

export interface UnifiedSearchResult {
  title: string;
  content: string;
  source: string;
  origin: "current-session" | "prior-session" | "auto-memory";
  timestamp?: string;
  rank?: number;
  matchLayer?: string;
  highlighted?: string;
  contentType?: "code" | "prose";
}

export interface SearchAllSourcesOpts {
  query: string;
  limit: number;
  store: ContentStore;
  sort?: "relevance" | "timeline";
  source?: string;
  contentType?: "code" | "prose";
  sessionDB?: SessionDB | null;
  projectDir?: string;
  configDir?: string;
  /** Detected platform adapter — used for adapter-aware auto-memory. */
  adapter?: AutoMemoryAdapter;
  /**
   * Per-project scope for the ContentStore filter (#737). Only honoured
   * when a `sessionDB` is also supplied (the 2-step IN-clause needs the
   * SessionDB to translate `project_dir` → list of session ids).
   *
   *   - `undefined` — no project filter, today's behaviour.
   *   - `null`      — cross-project recall in shared-DB mode (also no filter).
   *   - `string`    — restrict ContentStore results to chunks attributed to
   *                   session ids whose events match this `project_dir`,
   *                   plus legacy `session_id=''` chunks (public surface).
   */
  projectScope?: string | null;
}

// ─────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────

/**
 * Search across all available sources.
 *
 * - sort="relevance" (default): BM25-ranked results from ContentStore only.
 * - sort="timeline": chronological merge of ContentStore + SessionDB + auto-memory.
 *
 * Errors in any single source are caught and logged — partial results
 * are always returned.
 */
export function searchAllSources(opts: SearchAllSourcesOpts): UnifiedSearchResult[] {
  const {
    query,
    limit: rawLimit,
    store,
    sort = "relevance",
    source,
    contentType,
    sessionDB,
    projectDir,
    configDir,
    adapter,
    projectScope,
  } = opts;

  // #1119: every source below takes `limit` as a row count, and the merge ends
  // with `results.slice(0, limit)` — a negative or fractional value turned that
  // into an arbitrary count (7 / 4 / 0 depending on which branch ran) instead
  // of an error. Clamping once here covers all of them: the store, the SessionDB
  // timeline branch, auto-memory, and the final slice. The schema rejects these
  // values for MCP callers; this guards the internal ones.
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.floor(rawLimit)) : 1;

  const results: UnifiedSearchResult[] = [];

  // Capture session start time once — used as proxy for ContentStore items
  // (we don't know exact indexing time, but all content is from current session)
  const sessionStartTime = new Date().toISOString();

  // ── Project scope (#737) ──
  // Resolve the per-project session-id allow-set ONCE, before the
  // ContentStore call. `projectScope === null` means cross-project recall —
  // an explicit "no filter" choice surfaced by the open_ctx_search caller — and
  // `undefined` falls back to today's unfiltered behaviour.
  let sessionIdAllowSet: Set<string> | undefined;
  if (typeof projectScope === "string" && sessionDB) {
    try {
      sessionIdAllowSet = new Set(sessionDB.getSessionIdsForProject(projectScope));
    } catch (e) {
      if (DEBUG) process.stderr.write(`[ctx] getSessionIdsForProject failed: ${e}\n`);
    }
  }

  // ── Source 1: ContentStore (always, both modes) ──
  try {
    const storeResults = store.searchWithFallback(query, limit, source, contentType, "like", sessionIdAllowSet);
    results.push(
      ...storeResults.map((r: SearchResult) => ({
        title: r.title,
        content: r.content,
        source: r.source,
        origin: "current-session" as const,
        timestamp: r.timestamp || sessionStartTime,
        rank: r.rank,
        matchLayer: r.matchLayer,
        highlighted: r.highlighted,
        contentType: r.contentType,
      })),
    );
  } catch (e) {
    if (DEBUG) process.stderr.write(`[ctx] ContentStore search failed: ${e}\n`);
  }

  // ── Sources 2+3: timeline mode only ──
  if (sort === "timeline") {
    // Source 2: SessionDB — prior session events
    try {
      if (sessionDB) {
        const dbResults = sessionDB.searchEvents(query, limit, projectDir || "", source);
        results.push(
          ...dbResults.map((r: Pick<StoredEvent, "id" | "session_id" | "category" | "type" | "data" | "created_at">) => ({
            title: `[${r.category}] ${r.type}`,
            content: r.data,
            source: "prior-session",
            origin: "prior-session" as const,
            timestamp: r.created_at,
          })),
        );
      }
    } catch (e) {
      if (DEBUG) process.stderr.write(`[ctx] SessionDB search failed: ${e}\n`);
    }

    // Source 3: Auto-memory
    try {
      const memResults = searchAutoMemory([query], limit, projectDir, configDir, adapter);
      results.push(...memResults);
    } catch (e) {
      if (DEBUG) process.stderr.write(`[ctx] auto-memory search failed: ${e}\n`);
    }
  }

  // ── Normalize timestamps for consistent sorting ──
  // SQLite datetime('now') → "YYYY-MM-DD HH:MM:SS" (no T, no Z)
  // ISO → "YYYY-MM-DDTHH:MM:SS.sssZ"
  for (const r of results) {
    if (r.timestamp && !r.timestamp.includes("T")) {
      r.timestamp = r.timestamp.replace(" ", "T") + "Z";
    }
  }

  // ── Sort ──
  if (sort === "timeline") {
    results.sort((a, b) => (a.timestamp || "").localeCompare(b.timestamp || ""));
    // Issue #895: each source above already capped itself at `limit`, so this
    // merge holds up to 3× `limit` rows and the truncation below is a real
    // decision, not a no-op. Slicing from the front of an ASCENDING sort keeps
    // the OLDEST rows — which for the index→search round-trip is backwards: a
    // capture indexed seconds ago is the last row, so `slice(0, limit)`
    // deleted it and answered the query with prior-session memory instead.
    // Take the fresh end instead. The slice is still ascending, so timeline
    // mode's documented chronological order is unchanged.
    return results.slice(-limit);
  }

  return results.slice(0, limit);
}
