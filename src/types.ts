/**
 * types — Shared type definitions for open-context-mode packages.
 *
 * Contains interfaces that are genuinely shared between the core (ContentStore,
 * PolyglotExecutor) and the session domain (SessionDB, event extraction).
 * Import from "./types.js".
 */

// ─────────────────────────────────────────────────────────
// Session event types
// ─────────────────────────────────────────────────────────

/**
 * Session event as stored in SessionDB.
 * Each event captures a discrete unit of session activity (tool use, user
 * message, assistant response summary, etc.) for later resume-snapshot
 * reconstruction.
 */
export interface SessionEvent {
  type: string;
  category: string;
  data: string;
  priority: number;
  data_hash: string;
  /**
   * Best-effort project attribution for this event.
   * Empty string means unattributed/unknown.
   */
  project_dir?: string;
  attribution_source?: string;
  /** 0..1 confidence score for project attribution. */
  attribution_confidence?: number;
}

// ─────────────────────────────────────────────────────────
// Execution result
// ─────────────────────────────────────────────────────────

/**
 * Result returned by PolyglotExecutor after running a code snippet.
 * Shared here so SessionDB can record execution outcomes without importing
 * the full executor module.
 */
export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  /** Process was detached and continues running in the background. */
  backgrounded?: boolean;
}

// ─────────────────────────────────────────────────────────
// Content store shared types
// ─────────────────────────────────────────────────────────

/**
 * Result returned after indexing content into the knowledge base.
 * Shared so session tooling can record what was indexed without importing
 * ContentStore.
 */
export interface IndexResult {
  sourceId: number;
  label: string;
  totalChunks: number;
  codeChunks: number;
}

/**
 * A single search result returned from FTS5 BM25-ranked lookup.
 * Shared for consumers that display or log results outside of ContentStore.
 */
export interface SearchResult {
  title: string;
  content: string;
  source: string;
  rank: number;
  contentType: "code" | "prose";
  matchLayer?: "porter" | "trigram" | "fuzzy" | "rrf" | "rrf-fuzzy";
  highlighted?: string;
  timestamp?: string;
  /**
   * Session-id attribution copied from the `chunks.session_id` column
   * (legacy unattributed chunks carry an empty string). Used by the
   * `open_ctx_search` per-project filter (#737) to scope shared-DB results
   * to the current project via the 2-step IN-clause strategy.
   */
  sessionId?: string;
}

/**
 * Aggregate statistics for a ContentStore instance.
 */
export interface StoreStats {
  sources: number;
  chunks: number;
  codeChunks: number;
}

// ─────────────────────────────────────────────────────────
// Priority constants
// ─────────────────────────────────────────────────────────

/**
 * Priority levels for SessionEvent records. Lower numbers are more important
 * and are retained when the event store reaches its capacity. The persisted
 * scale has been 1=critical since the eviction fix (#902 class): this map
 * was the stale half of the old inverted belief.
 */
export const EventPriority = {
  LOW: 4,
  NORMAL: 3,
  HIGH: 2,
  CRITICAL: 1,
} as const;
