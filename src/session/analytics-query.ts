/**
 * Analytics query layer — AnalyticsEngine + disk/DB aggregation.
 *
 * Everything here READS state: the unified queryAll report, per-conversation
 * aggregates, lifetime scans, multi-adapter sweeps, and content-store byte
 * sums. No rendering, no USD math — those live in analytics-render.ts and
 * analytics-metrics.ts. Split out of analytics.ts (bundle entry) per C2.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadDatabase as loadDatabaseImpl } from "../db-base.js";
import { ensureSessionEventsSchema } from "./db.js";
import { opencodeConfigDir } from "../platforms/opencode/index.js";
import { categoryLabels, categoryHints } from "./analytics-render.js";

/** Database adapter — anything with a prepare() method (better-sqlite3, bun:sqlite, etc.) */
export interface DatabaseAdapter {
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}

/** Context savings result (#1) */
export interface ContextSavings {
  rawBytes: number;
  contextBytes: number;
  savedBytes: number;
  savedPercent: number;
}

/** Think in code comparison result (#2) */
export interface ThinkInCodeComparison {
  fileBytes: number;
  outputBytes: number;
  ratio: number;
}

/** Tool-level savings result (#3) */
export interface ToolSavingsRow {
  tool: string;
  rawBytes: number;
  contextBytes: number;
  savedBytes: number;
}

/** Sandbox I/O result (#19) */
export interface SandboxIO {
  inputBytes: number;
  outputBytes: number;
}

/** MCP tool usage row — concurrency stats for batch-style tools. */
export interface McpToolUsageRow {
  tool_name: string;
  calls: number;
  median_concurrency: number | null;
  max_concurrency: number | null;
}

/**
 * Conversation-scoped stats — aggregated from `session_events` for a single
 * `session_id` across every worktree DB plus the compact-rescue snapshot from
 * `session_resume`. Replaces the broken in-memory `tool_call_counter` that
 * only saw `open_ctx_*` MCP calls and reset to 0 every time the MCP server PID
 * changed (which is what made hours-of-work conversations show "1 call · 5 KB").
 */
export interface ConversationStats {
  /** session_id this aggregate covers (the current Claude Code conversation). */
  sessionId: string;
  /** Total event count for this session_id, summed across all DBs. */
  events: number;
  /** Distinct DB files this session_id appeared in (a rotation indicator). */
  dbCount: number;
  /** Wall-clock days from first to last event. Captures real activity length. */
  daysAlive: number;
  /** Bytes restored from the compact snapshot for this session_id. 0 if no compact. */
  snapshotBytes: number;
  /** Number of compact snapshots consumed for this session_id. */
  snapshotsConsumed: number;
  /** Category breakdown for this session_id. */
  byCategory: Array<{ category: string; count: number; label: string }>;
  /**
   * Earliest event timestamp (ms epoch) for this session_id across every DB.
   * Used by the section-1 "started X" line in the narrative renderer. 0 when
   * the session has no events yet. Optional for back-compat with older
   * callers / fixtures that pre-date the narrative layout.
   */
  firstEventMs?: number;
  /** Latest event timestamp (ms epoch) — pairs with firstEventMs. */
  lastEventMs?: number;
  /**
   * Wall-clock timestamp of the most recent /compact rescue for this session.
   * Drives the "On <datetime>, /compact fired" line in section 1. Undefined
   * when the conversation has never been compacted.
   */
  lastRescueMs?: number;
  /**
   * Per-day capture breakdown for the section-1 horizontal timeline. Each
   * entry is one calendar day (UTC midnight ms) with that day's event count
   * + optional rescueBytes when /compact fired on that day. Empty array
   * when no events recorded yet.
   */
  byDay?: Array<{ ms: number; count: number; rescueBytes?: number }>;
}

// ─────────────────────────────────────────────────────────
// Runtime stats — passed in from server.ts (can't come from DB)
// ─────────────────────────────────────────────────────────

/** Runtime stats tracked by server.ts during a live session. */
export interface RuntimeStats {
  bytesReturned: Record<string, number>;
  bytesIndexed: number;
  bytesSandboxed: number;
  calls: Record<string, number>;
  sessionStart: number;
  cacheHits: number;
  cacheMisses?: number;
  cacheBytesSaved: number;
}

// ─────────────────────────────────────────────────────────
// FullReport — single unified object returned by queryAll()
// ─────────────────────────────────────────────────────────

/** Unified report combining runtime stats, DB analytics, and continuity data. */
export interface FullReport {
  /** Runtime context savings (passed in, not from DB) */
  savings: {
    processed_kb: number;
    entered_kb: number;
    saved_kb: number;
    pct: number;
    savings_ratio: number;
    by_tool: Array<{ tool: string; calls: number; context_kb: number; tokens: number }>;
    total_calls: number;
    total_bytes_returned: number;
    kept_out: number;
    total_processed: number;
  };
  cache?: {
    hits: number;
    misses: number;
    hit_rate: number; // hits / (hits + misses); 0 when both are zero
    bytes_saved: number;
    ttl_hours_left: number;
    total_with_cache: number;
    total_savings_ratio: number;
  };
  /** Session metadata from SessionDB */
  session: {
    id: string;
    uptime_min: string;
  };
  /** Session continuity data */
  continuity: {
    total_events: number;
    by_category: Array<{
      category: string;
      count: number;
      label: string;
      preview: string;
      why: string;
    }>;
    compact_count: number;
    resume_ready: boolean;
  };
  /** Persistent project memory — all events across all sessions */
  projectMemory: {
    total_events: number;
    session_count: number;
    by_category: Array<{ category: string; count: number; label: string }>;
  };
}

// ─────────────────────────────────────────────────────────
// AnalyticsEngine
// ─────────────────────────────────────────────────────────

export class AnalyticsEngine {
  private readonly db: DatabaseAdapter;

  /**
   * Create an AnalyticsEngine.
   *
   * Accepts either a SessionDB instance (extracts internal db via
   * the protected getter — use the static fromDB helper for raw adapters)
   * or any object with a prepare() method for direct usage.
   */
  constructor(db: DatabaseAdapter) {
    this.db = db;
  }

  // ═══════════════════════════════════════════════════════
  // GROUP 3 — Runtime (4 metrics, stubs)
  // ═══════════════════════════════════════════════════════

  /**
   * #1 Context Savings Total — bytes kept out of context window.
   *
   * Stub: requires server.ts to accumulate rawBytes and contextBytes
   * during a live session. Call with tracked values.
   */
  static contextSavingsTotal(rawBytes: number, contextBytes: number): ContextSavings {
    const savedBytes = rawBytes - contextBytes;
    const savedPercent = rawBytes > 0 ? Math.round((savedBytes / rawBytes) * 1000) / 10 : 0;
    return { rawBytes, contextBytes, savedBytes, savedPercent };
  }

  /**
   * #2 Think in Code Comparison — ratio of file size to sandbox output size.
   *
   * Stub: requires server.ts tracking of execute/execute_file calls.
   */
  static thinkInCodeComparison(fileBytes: number, outputBytes: number): ThinkInCodeComparison {
    const ratio = outputBytes > 0 ? Math.round((fileBytes / outputBytes) * 10) / 10 : 0;
    return { fileBytes, outputBytes, ratio };
  }

  /**
   * #3 Tool Savings — per-tool breakdown of context savings.
   *
   * Stub: requires per-tool accumulators in server.ts.
   */
  static toolSavings(tools: Array<{ tool: string; rawBytes: number; contextBytes: number }>): ToolSavingsRow[] {
    return tools.map((t) => ({
      ...t,
      savedBytes: t.rawBytes - t.contextBytes,
    }));
  }

  /**
   * #19 Sandbox I/O — total input/output bytes processed by the sandbox.
   *
   * Stub: requires PolyglotExecutor byte counters.
   */
  static sandboxIO(inputBytes: number, outputBytes: number): SandboxIO {
    return { inputBytes, outputBytes };
  }

  /**
   * MCP tool usage — call counts and concurrency stats per MCP tool.
   *
   * Reads `mcp_tool_call` events, parses the JSON payload, and aggregates:
   *  - call count per tool_name
   *  - median + max of `params.concurrency` (only for tools that take it,
   *    e.g. open_ctx_batch_execute, open_ctx_fetch_and_index). Returns null when the
   *    tool doesn't carry a concurrency param so callers can render N/A.
   *
   * Best-effort: malformed rows or truncated payloads are skipped silently.
   */
  getMcpToolUsage(): McpToolUsageRow[] {
    let rows: Array<{ data: string }>;
    try {
      rows = this.db.prepare("SELECT data FROM session_events WHERE category = 'mcp_tool_call'").all() as Array<{ data: string }>;
    } catch {
      return [];
    }

    // toolName -> { calls, concurrencies }
    const agg = new Map<string, { calls: number; concurrencies: number[] }>();

    for (const row of rows) {
      let parsed: { tool_name?: unknown; params?: unknown; truncated?: unknown };
      try {
        parsed = JSON.parse(row.data);
      } catch {
        continue;
      }
      const toolName = typeof parsed.tool_name === "string" ? parsed.tool_name : null;
      if (!toolName) continue;

      const bucket = agg.get(toolName) ?? { calls: 0, concurrencies: [] };
      bucket.calls += 1;

      // Skip concurrency extraction when the row was truncated — the params
      // blob is a substring of JSON that may not parse cleanly.
      if (parsed.truncated !== true && parsed.params && typeof parsed.params === "object") {
        const c = (parsed.params as Record<string, unknown>).concurrency;
        if (typeof c === "number" && Number.isFinite(c) && c > 0) {
          bucket.concurrencies.push(c);
        }
      }

      agg.set(toolName, bucket);
    }

    const out: McpToolUsageRow[] = [];
    for (const [tool_name, b] of agg) {
      let median: number | null = null;
      let max: number | null = null;
      if (b.concurrencies.length > 0) {
        b.concurrencies.sort((a, c) => a - c);
        const sorted = b.concurrencies;
        const mid = Math.floor(sorted.length / 2);
        median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
        max = sorted[sorted.length - 1];
      }
      out.push({
        tool_name,
        calls: b.calls,
        median_concurrency: median,
        max_concurrency: max,
      });
    }

    // Stable sort: most-called first, then alphabetical
    out.sort((a, c) => c.calls - a.calls || a.tool_name.localeCompare(c.tool_name));
    return out;
  }

  // ═══════════════════════════════════════════════════════
  // queryAll — single unified report from ONE source
  // ═══════════════════════════════════════════════════════

  /**
   * Build a FullReport by merging runtime stats (passed in)
   * with continuity data from the DB.
   *
   * This is the ONE call that open_ctx_stats should use.
   */
  queryAll(runtimeStats: RuntimeStats): FullReport {
    // ── Resolve latest session ID ──
    const latestSession = this.db.prepare("SELECT session_id FROM session_meta ORDER BY started_at DESC LIMIT 1").get() as
      { session_id: string } | undefined;
    const sid = latestSession?.session_id ?? "";

    // ── Runtime savings ──
    const totalBytesReturned = Object.values(runtimeStats.bytesReturned).reduce((sum, b) => sum + b, 0);
    const totalCalls = Object.values(runtimeStats.calls).reduce((sum, c) => sum + c, 0);
    const keptOut = runtimeStats.bytesIndexed + runtimeStats.bytesSandboxed;
    const totalProcessed = keptOut + totalBytesReturned;
    const savingsRatio = totalProcessed / Math.max(totalBytesReturned, 1);
    const reductionPct = totalProcessed > 0 ? Math.round((1 - totalBytesReturned / totalProcessed) * 100) : 0;

    const toolNames = new Set([...Object.keys(runtimeStats.calls), ...Object.keys(runtimeStats.bytesReturned)]);
    const byTool = Array.from(toolNames)
      .sort()
      .map((tool) => ({
        tool,
        calls: runtimeStats.calls[tool] || 0,
        context_kb: Math.round(((runtimeStats.bytesReturned[tool] || 0) / 1024) * 10) / 10,
        tokens: Math.round((runtimeStats.bytesReturned[tool] || 0) / 4),
      }));

    const uptimeMs = Date.now() - runtimeStats.sessionStart;
    const uptimeMin = (uptimeMs / 60_000).toFixed(1);

    // ── Cache ──
    let cache: FullReport["cache"];
    const cacheMisses = runtimeStats.cacheMisses ?? 0;
    if (runtimeStats.cacheHits > 0 || runtimeStats.cacheBytesSaved > 0 || cacheMisses > 0) {
      const totalWithCache = totalProcessed + runtimeStats.cacheBytesSaved;
      const totalSavingsRatio = totalWithCache / Math.max(totalBytesReturned, 1);
      const ttlHoursLeft = Math.max(0, 24 - Math.floor((Date.now() - runtimeStats.sessionStart) / (60 * 60 * 1000)));
      // hit_rate is the nominal cache effectiveness — the metric open_ctx_stats
      // historically inferred-only by diffing tokens_saved snapshots. When
      // there is no activity we report 0 instead of NaN/undefined so the
      // renderer stays JSON-safe.
      const totalLookups = runtimeStats.cacheHits + cacheMisses;
      const hitRate = totalLookups > 0 ? runtimeStats.cacheHits / totalLookups : 0;
      cache = {
        hits: runtimeStats.cacheHits,
        misses: cacheMisses,
        hit_rate: hitRate,
        bytes_saved: runtimeStats.cacheBytesSaved,
        ttl_hours_left: ttlHoursLeft,
        total_with_cache: totalWithCache,
        total_savings_ratio: totalSavingsRatio,
      };
    }

    // ── Continuity data (scoped to current session) ──
    const eventTotal = (this.db.prepare("SELECT COUNT(*) as cnt FROM session_events WHERE session_id = ?").get(sid) as { cnt: number }).cnt;

    const byCategory = this.db
      .prepare("SELECT category, COUNT(*) as cnt FROM session_events WHERE session_id = ? GROUP BY category ORDER BY cnt DESC")
      .all(sid) as Array<{ category: string; cnt: number }>;

    const meta = this.db.prepare("SELECT compact_count FROM session_meta WHERE session_id = ?").get(sid) as
      { compact_count: number } | undefined;
    const compactCount = meta?.compact_count ?? 0;

    const resume = this.db
      .prepare("SELECT event_count, consumed FROM session_resume WHERE session_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(sid) as { event_count: number; consumed: number } | undefined;
    const resumeReady = resume ? !resume.consumed : false;

    // Build category previews (current session only)
    const previewRows = this.db
      .prepare("SELECT category, type, data FROM session_events WHERE session_id = ? ORDER BY id DESC")
      .all(sid) as Array<{ category: string; type: string; data: string }>;

    const previews = new Map<string, Set<string>>();
    for (const row of previewRows) {
      if (!previews.has(row.category)) previews.set(row.category, new Set());
      const set = previews.get(row.category)!;
      if (set.size < 5) {
        let display = row.data;
        if (row.category === "file") {
          display = row.data.split("/").pop() || row.data;
        } else if (row.category === "prompt" || row.category === "user-prompt") {
          display = display.length > 50 ? display.slice(0, 47) + "..." : display;
        }
        if (display.length > 40) display = display.slice(0, 37) + "...";
        set.add(display);
      }
    }

    const continuityByCategory = byCategory.map((row) => ({
      category: row.category,
      count: row.cnt,
      label: categoryLabels[row.category] || row.category,
      preview: previews.get(row.category) ? Array.from(previews.get(row.category)!).join(", ") : "",
      why: categoryHints[row.category] || "Survives context resets",
    }));

    // ── Project-wide persistent memory (all sessions, no session_id filter) ──
    const projectTotals = this.db.prepare("SELECT COUNT(*) as cnt, COUNT(DISTINCT session_id) as sessions FROM session_events").get() as {
      cnt: number;
      sessions: number;
    };

    const projectByCategory = this.db
      .prepare("SELECT category, COUNT(*) as cnt FROM session_events GROUP BY category ORDER BY cnt DESC")
      .all() as Array<{ category: string; cnt: number }>;

    const projectMemoryByCategory = projectByCategory
      .filter((row) => row.cnt > 0)
      .map((row) => ({
        category: row.category,
        count: row.cnt,
        label: categoryLabels[row.category] || row.category,
      }));

    return {
      savings: {
        processed_kb: Math.round((totalProcessed / 1024) * 10) / 10,
        entered_kb: Math.round((totalBytesReturned / 1024) * 10) / 10,
        saved_kb: Math.round((keptOut / 1024) * 10) / 10,
        pct: reductionPct,
        savings_ratio: Math.round(savingsRatio * 10) / 10,
        by_tool: byTool,
        total_calls: totalCalls,
        total_bytes_returned: totalBytesReturned,
        kept_out: keptOut,
        total_processed: totalProcessed,
      },
      cache,
      session: {
        id: sid,
        uptime_min: uptimeMin,
      },
      continuity: {
        total_events: eventTotal,
        by_category: continuityByCategory,
        compact_count: compactCount,
        resume_ready: resumeReady,
      },
      projectMemory: {
        total_events: projectTotals.cnt,
        session_count: projectTotals.sessions,
        by_category: projectMemoryByCategory,
      },
    };
  }
}

// ─────────────────────────────────────────────────────────
// Adapter dir enumeration (B3a multi-adapter aggregation)
// ─────────────────────────────────────────────────────────

/**
 * Where one adapter stores its open-context-mode sidecars on disk. Mirrors the
 * map in `src/platforms/detect.ts:92-111` (`getSessionDirSegments`) so we
 * never go out of sync as a single source of truth.
 *
 * `sessionsDir` = `<home>/<segments>/open-context-mode/sessions`
 * `contentDir`  = `<home>/<segments>/open-context-mode/content`
 *
 * Why duplicated here: `getSessionDirSegments` returns segments relative to
 * `homedir()`; analytics needs the absolute joined paths for both `sessions`
 * and `content` siblings. Keeping a parallel hard-coded list avoids importing
 * detect.ts (which pulls in adapter loaders) into the stats path.
 */
export interface AdapterDirEntry {
  /** Adapter id matching `src/platforms/detect.ts` PlatformId. */
  name: string;
  /** Absolute path to `<home>/<segments>/open-context-mode/sessions`. */
  sessionsDir: string;
  /** Absolute path to `<home>/<segments>/open-context-mode/content`. */
  contentDir: string;
}

/**
 * Enumerate every known adapter's sessions + content dirs under `home`.
 * Used by `getMultiAdapterLifetimeStats` and `getMultiAdapterRealBytesStats`
 * so a single call surfaces "your work everywhere on this machine across
 * all AI tools" (the marketing line).
 *
 * One row, because there is one storage tree: every client writes under
 * OpenCode's config dir. An explicit `home` is a whole-tree override (tests,
 * dashboard `--home`) and keeps the home-relative segments.
 */
export function enumerateAdapterDirs(opts?: { home?: string }): AdapterDirEntry[] {
  const home = opts?.home ?? homedir();
  // opencodeConfigDir() already ends at <config>/opencode; only the `home`
  // override walks the segments from the profile root.
  const root = opts?.home ? join(home, ".config", "opencode") : opencodeConfigDir();
  return [
    {
      name: "opencode",
      sessionsDir: join(root, "open-context-mode", "sessions"),
      contentDir: join(root, "open-context-mode", "content"),
    },
  ];
}

// ─────────────────────────────────────────────────────────
// Lifetime stats (Bug #3 + #4)
// ─────────────────────────────────────────────────────────

/** Aggregated stats spanning every SessionDB + auto-memory under the user's profile. */
export interface LifetimeStats {
  totalEvents: number;
  totalSessions: number;
  autoMemoryCount: number;
  autoMemoryProjects: number;
  /** Per-prefix breakdown of auto-memory files (user/feedback/project/...). */
  autoMemoryByPrefix: Record<string, number>;
  /**
   * Per-category event counts aggregated across every SessionDB on disk.
   * Keys are the raw category strings (file/cwd/rule/...) — the renderer
   * looks them up against `categoryLabels` for display. Empty `{}` when no
   * sidecar has any events. Optional for back-compat with older fixtures.
   */
  categoryCounts: Record<string, number>;
  /**
   * Total bytes restored from compact-rescue snapshots across every DB on
   * disk. Adds the rescue benefit to lifetime $ so the headline isn't
   * silently undercounting the killer feature. 0 when no compact has fired
   * or older fixtures don't pass this. Optional for back-compat with tests.
   */
  rescueBytes?: number;
  /**
   * Earliest event timestamp (ms epoch) across every DB. Used for the
   * "since 2026-04-14" lifetime narrative. 0 when unknown. Optional.
   */
  firstEventMs?: number;
  /**
   * Distinct project_dir count across every DB. Different from
   * `autoMemoryProjects` (which only counts dirs with auto-memory files).
   * Captures every cwd open-context-mode has ever seen events for. Optional.
   */
  distinctProjects?: number;
}

/** Extract leading prefix from auto-memory filename: `feedback_push.md` → `feedback`. */
function autoMemoryPrefix(filename: string): string {
  const base = filename.replace(/\.md$/i, "");
  const m = base.match(/^([a-z]+)/i);
  return m ? m[1].toLowerCase() : "other";
}

/**
 * Aggregate lifetime stats from all SessionDB files in `sessionsDir` and
 * all auto-memory markdown files under `memoryRoot/<project>/memory/`.
 *
 * Best-effort: silently ignores missing/unreadable files so open_ctx_stats
 * can never be broken by a corrupt sidecar.
 */
/** Mutable tally that the lifetime scan folds every SessionDB sidecar into. */
type LifetimeTally = {
  totalEvents: number;
  totalSessions: number;
  rescueBytes: number;
  firstEventMs: number;
  categoryCounts: Record<string, number>;
  projects: Set<string>;
};

/**
 * Fold one SessionDB sidecar into `tally`. Each query is guarded on its own:
 * a sidecar written by an older schema contributes what it can and skips the
 * rest, so one absent column never costs the whole file.
 */
function tallySidecar(sdb: DatabaseAdapter & { close(): void }, tally: LifetimeTally): void {
  const ev = sdb.prepare("SELECT COUNT(*) AS cnt FROM session_events").get() as { cnt: number } | undefined;
  const ss = sdb.prepare("SELECT COUNT(*) AS cnt FROM session_meta").get() as { cnt: number } | undefined;
  tally.totalEvents += ev?.cnt ?? 0;
  tally.totalSessions += ss?.cnt ?? 0;

  // Per-category aggregation across every sidecar so the Persistent memory
  // bars stay populated even when the current project's local DB is fresh.
  try {
    const catRows = sdb.prepare("SELECT category, COUNT(*) AS cnt FROM session_events GROUP BY category").all() as Array<{
      category: string;
      cnt: number;
    }>;
    for (const row of catRows) {
      if (!row.category) continue;
      tally.categoryCounts[row.category] = (tally.categoryCounts[row.category] ?? 0) + (row.cnt ?? 0);
    }
  } catch {
    // older schema / no category column — ignore
  }

  // Lifetime rescue: compact-snapshot bytes restored across every DB. Without
  // this, the lifetime figure silently undercounts the continuity-after-
  // /compact feature.
  try {
    const snap = sdb.prepare("SELECT COALESCE(SUM(length(snapshot)), 0) AS bytes FROM session_resume WHERE consumed = 1").get() as
      { bytes: number } | undefined;
    if (snap?.bytes) tally.rescueBytes += snap.bytes;
  } catch {
    /* old schema */
  }

  // Earliest event timestamp + distinct project_dirs feed the lifetime
  // narrative's "since X · Y projects" line.
  try {
    const mn = sdb.prepare("SELECT MIN(created_at) AS t FROM session_events").get() as { t: string | null } | undefined;
    if (mn?.t) {
      const stamp = mn.t.endsWith("Z") ? mn.t : mn.t + "Z";
      const ms = Date.parse(stamp);
      if (Number.isFinite(ms) && ms < tally.firstEventMs) tally.firstEventMs = ms;
    }
  } catch {
    /* old schema */
  }
  try {
    const projRows = sdb.prepare("SELECT DISTINCT project_dir AS p FROM session_events WHERE project_dir != ''").all() as Array<{
      p: string;
    }>;
    for (const row of projRows) if (row.p) tally.projects.add(row.p);
  } catch {
    /* old schema */
  }
}

/** Count `<memoryRoot>/<project>/memory/*.md`, grouped by filename prefix. */
function scanAutoMemory(memoryRoot: string): {
  count: number;
  projects: number;
  byPrefix: Record<string, number>;
} {
  const out = { count: 0, projects: 0, byPrefix: {} as Record<string, number> };
  if (!existsSync(memoryRoot)) return out;

  let projectDirs: string[] = [];
  try {
    projectDirs = readdirSync(memoryRoot).filter((entry) => {
      try {
        return statSync(join(memoryRoot, entry)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return out; /* unreadable */
  }

  for (const proj of projectDirs) {
    const memDir = join(memoryRoot, proj, "memory");
    if (!existsSync(memDir)) continue;
    let mdFiles: string[] = [];
    try {
      mdFiles = readdirSync(memDir).filter((f) => f.endsWith(".md"));
    } catch {
      continue;
    }
    if (mdFiles.length === 0) continue;
    out.projects++;
    out.count += mdFiles.length;
    for (const f of mdFiles) {
      const prefix = autoMemoryPrefix(f);
      out.byPrefix[prefix] = (out.byPrefix[prefix] ?? 0) + 1;
    }
  }
  return out;
}

export function getLifetimeStats(opts?: {
  sessionsDir?: string;
  memoryRoot?: string;
  /** Override for tests — defaults to db-base loadDatabase(). */
  loadDatabase?: () => unknown;
}): LifetimeStats {
  const storageRoot = opencodeConfigDir();
  const sessionsDir = opts?.sessionsDir ?? join(storageRoot, "open-context-mode", "sessions");
  const memoryRoot = opts?.memoryRoot ?? join(storageRoot, "projects");

  const tally: LifetimeTally = {
    totalEvents: 0,
    totalSessions: 0,
    rescueBytes: 0,
    firstEventMs: Number.POSITIVE_INFINITY,
    categoryCounts: {},
    projects: new Set<string>(),
  };

  // ── SessionDB aggregation ──
  if (existsSync(sessionsDir)) {
    let dbFiles: string[] = [];
    try {
      dbFiles = readdirSync(sessionsDir).filter((f) => f.endsWith(".db"));
    } catch {
      /* unreadable */
    }

    if (dbFiles.length > 0) {
      let DatabaseCtor: ReturnType<typeof loadDatabaseImpl> | null = null;
      try {
        DatabaseCtor = opts?.loadDatabase ? (opts.loadDatabase() as ReturnType<typeof loadDatabaseImpl>) : loadDatabaseImpl();
      } catch {
        /* sqlite unavailable */
      }

      if (DatabaseCtor) {
        for (const file of dbFiles) {
          try {
            const sdb = new DatabaseCtor(join(sessionsDir, file), {
              readonly: true,
            });
            try {
              tallySidecar(sdb, tally);
            } finally {
              sdb.close();
            }
          } catch {
            // missing tables / corrupt file — skip
          }
        }
      }
    }
  }

  const memory = scanAutoMemory(memoryRoot);

  return {
    totalEvents: tally.totalEvents,
    totalSessions: tally.totalSessions,
    autoMemoryCount: memory.count,
    autoMemoryProjects: memory.projects,
    autoMemoryByPrefix: memory.byPrefix,
    categoryCounts: tally.categoryCounts,
    rescueBytes: tally.rescueBytes,
    firstEventMs: Number.isFinite(tally.firstEventMs) ? tally.firstEventMs : 0,
    distinctProjects: tally.projects.size,
  };
}

/**
 * Aggregate every event for one `session_id` across all SessionDB files in
 * `sessionsDir` plus the compact-rescue snapshot bytes from `session_resume`.
 *
 * Why this exists: the Claude Code session_id can persist across days while
 * the underlying DB file rotates (size cap), and a compact-rescue snapshot
 * carries hundreds of KB of context that would otherwise have been lost. The
 * old in-memory `tool_call_counter` saw none of this — it counted only `open_ctx_*`
 * MCP calls against the current MCP server PID and reset on every restart.
 * Reading from `session_events` + `session_resume` is the source-of-truth
 * version that matches what users actually experienced.
 */
/** Mutable tally that the conversation scan folds every SessionDB sidecar into. */
type ConversationTally = {
  catCounts: Record<string, number>;
  events: number;
  snapshotBytes: number;
  snapshotsConsumed: number;
  firstMs: number;
  lastMs: number;
  lastRescueMs: number;
  /** UTC-midnight ms -> that day's event count and rescue-byte overlay. */
  byDay: Map<number, { count: number; rescueBytes: number }>;
  dbCount: number;
};

const DAY_MS = 86_400_000;

/** UTC midnight of `ms`, the key the narrative timeline groups days by. */
const dayKey = (ms: number): number => Math.floor(ms / DAY_MS) * DAY_MS;

/**
 * Fold one SessionDB sidecar into `tally`. The three sub-reads are guarded
 * independently so a sidecar with an older schema still contributes its
 * category counts and time range.
 */
/** Returns true when the sidecar actually held rows for this session. */
/**
 * Fold one sidecar's consumed compact-rescue snapshots into `tally`: total
 * restored bytes, how many snapshots, the latest rescue timestamp, and the
 * per-day overlay that paints the /compact glyph on the narrative timeline.
 */
function foldRescueRows(sdb: DatabaseAdapter, sessionId: string, tally: ConversationTally): void {
  const snap = sdb
    .prepare(
      "SELECT COALESCE(SUM(length(snapshot)), 0) AS bytes, COUNT(*) AS n, MAX(strftime('%s', created_at)) AS lastSec FROM session_rescue WHERE session_id = ? AND consumed = 1",
    )
    .get(sessionId) as { bytes: number; n: number; lastSec: string | null } | undefined;
  if (!snap) return;

  if (snap.bytes) tally.snapshotBytes += snap.bytes;
  if (snap.n) tally.snapshotsConsumed += snap.n;
  if (!snap.lastSec) return;

  const t = parseInt(snap.lastSec, 10) * 1000;
  if (!Number.isFinite(t)) return;
  if (t > tally.lastRescueMs) tally.lastRescueMs = t;
  // Overlay the rescue bytes onto the day bucket for the timeline.
  if (snap.bytes > 0) {
    const k = dayKey(t);
    const cur = tally.byDay.get(k) ?? { count: 0, rescueBytes: 0 };
    cur.rescueBytes = Math.max(cur.rescueBytes, snap.bytes);
    tally.byDay.set(k, cur);
  }
}

/** Returns true when the sidecar actually held rows for this session. */
function foldConversationDb(sdb: DatabaseAdapter & { close(): void }, sessionId: string, tally: ConversationTally): boolean {
  let touched = false;
  const cats = sdb
    .prepare("SELECT category, COUNT(*) AS cnt FROM session_events WHERE session_id = ? GROUP BY category")
    .all(sessionId) as Array<{ category: string; cnt: number }>;
  for (const row of cats) {
    if (!row.category) continue;
    tally.catCounts[row.category] = (tally.catCounts[row.category] ?? 0) + (row.cnt ?? 0);
    tally.events += row.cnt ?? 0;
    touched = true;
  }

  const range = sdb
    .prepare("SELECT MIN(created_at) AS mn, MAX(created_at) AS mx FROM session_events WHERE session_id = ?")
    .get(sessionId) as { mn: string | null; mx: string | null } | undefined;
  if (range?.mn) {
    const t = Date.parse(range.mn + (range.mn.endsWith("Z") ? "" : "Z"));
    if (Number.isFinite(t) && t < tally.firstMs) tally.firstMs = t;
  }
  if (range?.mx) {
    const t = Date.parse(range.mx + (range.mx.endsWith("Z") ? "" : "Z"));
    if (Number.isFinite(t) && t > tally.lastMs) tally.lastMs = t;
  }

  // Per-day captures + per-day rescue overlay for the narrative timeline.
  // Best-effort: silently skip when the schema lacks created_at.
  try {
    const dayRows = sdb
      .prepare(
        "SELECT strftime('%s', created_at) AS sec, COUNT(*) AS cnt FROM session_events WHERE session_id = ? GROUP BY date(created_at)",
      )
      .all(sessionId) as Array<{ sec: string | null; cnt: number }>;
    for (const row of dayRows) {
      if (!row.sec) continue;
      const ms = parseInt(row.sec, 10) * 1000;
      if (!Number.isFinite(ms)) continue;
      const k = dayKey(ms);
      const cur = tally.byDay.get(k) ?? { count: 0, rescueBytes: 0 };
      cur.count += row.cnt ?? 0;
      tally.byDay.set(k, cur);
    }
  } catch {
    /* old schema */
  }

  try {
    foldRescueRows(sdb, sessionId, tally);
  } catch {
    /* old schema */
  }
  return touched;
}

export function getConversationStats(opts: {
  sessionId: string;
  sessionsDir?: string;
  /** Optional worktree filename prefix (sha256(cwd)[:16]). When omitted, scans every DB. */
  worktreeHash?: string;
  loadDatabase?: () => unknown;
}): ConversationStats {
  const sessionsDir = opts.sessionsDir ?? join(homedir(), ".claude", "open-context-mode", "sessions");
  const sessionId = opts.sessionId;

  const empty: ConversationStats = {
    sessionId,
    events: 0,
    dbCount: 0,
    daysAlive: 0,
    snapshotBytes: 0,
    snapshotsConsumed: 0,
    byCategory: [],
  };
  if (!sessionId || !existsSync(sessionsDir)) return empty;

  let dbFiles: string[] = [];
  try {
    dbFiles = readdirSync(sessionsDir).filter((f) => {
      if (!f.endsWith(".db")) return false;
      if (opts.worktreeHash && !f.startsWith(opts.worktreeHash)) return false;
      return true;
    });
  } catch {
    return empty;
  }
  if (dbFiles.length === 0) return empty;

  let DatabaseCtor: ReturnType<typeof loadDatabaseImpl> | null = null;
  try {
    DatabaseCtor = opts.loadDatabase ? (opts.loadDatabase() as ReturnType<typeof loadDatabaseImpl>) : loadDatabaseImpl();
  } catch {
    return empty;
  }
  if (!DatabaseCtor) return empty;

  const tally: ConversationTally = {
    catCounts: {},
    events: 0,
    snapshotBytes: 0,
    snapshotsConsumed: 0,
    firstMs: Number.POSITIVE_INFINITY,
    lastMs: 0,
    lastRescueMs: 0,
    byDay: new Map<number, { count: number; rescueBytes: number }>(),
    dbCount: 0,
  };

  for (const file of dbFiles) {
    try {
      const sdb = new DatabaseCtor(join(sessionsDir, file), { readonly: true });
      try {
        if (foldConversationDb(sdb, sessionId, tally)) tally.dbCount++;
      } finally {
        sdb.close();
      }
    } catch {
      /* missing tables / corrupt */
    }
  }

  const daysAlive = tally.firstMs < tally.lastMs ? (tally.lastMs - tally.firstMs) / DAY_MS : 0;
  const byCategory = Object.entries(tally.catCounts)
    .filter(([, n]) => n > 0)
    .map(([category, count]) => ({
      category,
      count,
      label: categoryLabels[category] || category,
    }))
    .sort((a, b) => b.count - a.count);
  const byDay = [...tally.byDay.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ms, v]) => ({
      ms,
      count: v.count,
      ...(v.rescueBytes > 0 ? { rescueBytes: v.rescueBytes } : {}),
    }));

  return {
    sessionId,
    events: tally.events,
    dbCount: tally.dbCount,
    daysAlive,
    snapshotBytes: tally.snapshotBytes,
    snapshotsConsumed: tally.snapshotsConsumed,
    byCategory,
    firstEventMs: Number.isFinite(tally.firstMs) ? tally.firstMs : 0,
    lastEventMs: tally.lastMs > 0 ? tally.lastMs : 0,
    lastRescueMs: tally.lastRescueMs > 0 ? tally.lastRescueMs : undefined,
    byDay,
  };
}

// ─────────────────────────────────────────────────────────
// getRealBytesStats — Phase 8 of D2 PRD (stats-event-driven-architecture)
// ─────────────────────────────────────────────────────────

/**
 * Real-bytes counter the renderer uses to replace the conservative
 * `events × 256` token estimate. Reads four sources from disk and
 * returns the sum the renderer divides by 4 to get tokens.
 *
 * - `eventDataBytes`  = SUM(LENGTH(data))      FROM session_events
 * - `bytesAvoided`    = SUM(bytes_avoided)     FROM session_events
 * - `bytesReturned`   = SUM(bytes_returned)    FROM session_events
 * - `snapshotBytes`   = SUM(LENGTH(snapshot))  FROM session_resume
 * - `totalSavedTokens` = bytesAvoided / 4
 *
 * `bytesReturned` is reported but NOT folded into `totalSavedTokens`
 * because it represents bytes the model already paid for — adding it
 * would double-count what's already on the user's invoice. The same
 * rationale excludes `eventDataBytes` and `snapshotBytes` (analytics /
 * resume infrastructure that never enters the context window) and
 * `contentBytes` (captured for recall; the original bytes were already
 * seen by the model when the tool ran).
 */
export interface RealBytesStats {
  eventDataBytes: number;
  bytesAvoided: number;
  bytesReturned: number;
  snapshotBytes: number;
  /**
   * v1.0.133 Slice 3: bytes attributed to this session in the FTS5 content
   * DB — `SUM(LENGTH(title) + LENGTH(content)) FROM chunks WHERE session_id = ?`.
   *
   * Read-only, render-time computation. Populated only when
   * `getRealBytesStats` is called with both `sessionId` AND `contentDbPath`
   * (i.e. the conversation tier from open_ctx_stats). Lifetime / project tiers
   * leave this at 0 — aggregating across every adapter's content DB is a
   * separate concern.
   *
   * Legacy chunks with empty `session_id` (pre-Slice-1) are NOT backfilled:
   * the architect rejected the time-window join as unsafe. Old conversations
   * stay low; new conversations populate honestly.
   */
  contentBytes: number;
  totalSavedTokens: number;
}

/**
 * v1.0.133 Slice 3: Sum the bytes attributed to one session in the FTS5
 * content DB.
 *
 * Returns `LENGTH(title) + LENGTH(content)` summed across every chunk
 * whose `session_id` column matches `sessionId`. Best-effort — returns 0
 * when the DB file is missing, the schema lacks the `session_id` column
 * (pre-Slice-1 content DBs), or the query fails. Never throws.
 *
 * Render-time only. Does NOT mutate the content DB. Architect-approved
 * because the read-only join carries no risk of cross-session attribution
 * (the FK was set at chunk insert time by Slice 1).
 */
export function getContentBytesForSession(sessionId: string, contentDbPath: string, opts?: { loadDatabase?: () => unknown }): number {
  if (!sessionId || !contentDbPath) return 0;
  if (!existsSync(contentDbPath)) return 0;

  let DatabaseCtor: ReturnType<typeof loadDatabaseImpl> | null = null;
  try {
    DatabaseCtor = opts?.loadDatabase ? (opts.loadDatabase() as ReturnType<typeof loadDatabaseImpl>) : loadDatabaseImpl();
  } catch {
    return 0;
  }
  if (!DatabaseCtor) return 0;

  try {
    const db = new DatabaseCtor(contentDbPath, { readonly: true });
    try {
      const row = db
        .prepare(
          `SELECT COALESCE(SUM(LENGTH(content) + LENGTH(title)), 0) AS bytes
         FROM chunks WHERE session_id = ?`,
        )
        .get(sessionId) as { bytes: number } | undefined;
      return Number(row?.bytes ?? 0);
    } finally {
      db.close();
    }
  } catch {
    return 0;
  }
}

/**
 * v1.0.134 SLICE C — lifetime tier all-chunks aggregate.
 *
 * Sibling of {@link getContentBytesForSession} that omits the session_id
 * filter so the lifetime tier sees every chunk in the content store —
 * including legacy unattributed rows (sessionId === '') and chunks
 * attributed to other adapters' sessions. Without this, the lifetime
 * "kept out" headline only counts session_events.bytes_avoided and
 * misses the bulk of indexed payload.
 *
 * Best-effort: returns 0 when the DB file is missing, the schema lacks
 * the `chunks` table, or the query fails. Never throws — same contract
 * as the rest of the analytics module so a corrupt content DB cannot
 * crash open_ctx_stats.
 */
export function getContentBytesAllSessions(contentDbPath: string, opts?: { loadDatabase?: () => unknown }): number {
  if (!contentDbPath) return 0;
  if (!existsSync(contentDbPath)) return 0;

  let DatabaseCtor: ReturnType<typeof loadDatabaseImpl> | null = null;
  try {
    DatabaseCtor = opts?.loadDatabase ? (opts.loadDatabase() as ReturnType<typeof loadDatabaseImpl>) : loadDatabaseImpl();
  } catch {
    return 0;
  }
  if (!DatabaseCtor) return 0;

  try {
    const db = new DatabaseCtor(contentDbPath, { readonly: true });
    try {
      const row = db
        .prepare(
          `SELECT COALESCE(SUM(LENGTH(content) + LENGTH(title)), 0) AS bytes
         FROM chunks`,
        )
        .get() as { bytes: number } | undefined;
      return Number(row?.bytes ?? 0);
    } finally {
      db.close();
    }
  } catch {
    return 0;
  }
}

/**
 * Compute real-bytes stats across one session, one project (worktree
 * filter), or every session on disk (lifetime).
 *
 * - Pass `sessionId` for the conversation tier.
 * - Pass `worktreeHash` to filter `*.db` files by name prefix
 *   (per-project lifetime — `sha256(cwd).slice(0, 16)`).
 * - Pass neither — full lifetime aggregate.
 *
 * Best-effort: returns zeroes when the dir is missing, the DB is
 * corrupt, or the session has no events. Never throws — same
 * contract as `getConversationStats` / `getLifetimeStats` so the
 * stats-render path can never crash on a bad sidecar.
 */
/** Column scope the three real-bytes queries share: one session, every
 * session under one project_dir (Bug E+F META subquery), or the whole DB. */
type RealBytesScope = {
  events: string;
  resume: string;
  tools: string;
  params: string[];
};

/** Mutable totals getRealBytesStats folds every SessionDB sidecar into. */
type RealBytesTally = {
  eventDataBytes: number;
  bytesAvoided: number;
  bytesReturned: number;
  snapshotBytes: number;
};

/** The META subquery both scoped variants filter session ids through. */
const META_PROJECT_FILTER = "(SELECT session_id FROM session_meta WHERE project_dir = ?)";

const RETRIEVAL_TOOLS = "('open_ctx_search', 'open_ctx_fetch_and_index')";

/**
 * Resolve the WHERE fragments for the caller's scope. `sessionId` wins over
 * `projectDir` when both are set — the back-compat rule documented on
 * getRealBytesStats' opts.
 */
function realBytesScope(opts: { sessionId?: string; projectDir?: string }): RealBytesScope {
  if (opts.sessionId) {
    return {
      events: " WHERE session_id = ?",
      resume: " WHERE session_id = ?",
      tools: ` WHERE session_id = ? AND tool IN ${RETRIEVAL_TOOLS}`,
      params: [opts.sessionId],
    };
  }
  if (opts.projectDir) {
    return {
      events: ` WHERE session_id IN ${META_PROJECT_FILTER}`,
      resume: ` WHERE session_id IN ${META_PROJECT_FILTER}`,
      tools: ` WHERE session_id IN ${META_PROJECT_FILTER} AND tool IN ${RETRIEVAL_TOOLS}`,
      params: [opts.projectDir],
    };
  }
  return {
    events: "",
    resume: "",
    tools: ` WHERE tool IN ${RETRIEVAL_TOOLS}`,
    params: [],
  };
}

/**
 * Fold one sidecar's contribution into `tally`. The snapshot and tool_calls
 * reads are guarded independently so a sidecar on an older schema still
 * contributes its event sums instead of losing the whole file.
 */
function foldRealBytesDb(sdb: DatabaseAdapter & { close(): void }, scope: RealBytesScope, tally: RealBytesTally): void {
  // "With open-context-mode" = the bytes the model paid to ACCESS the
  // kept-out content: open_ctx_search (query the index) + open_ctx_fetch_and_index
  // (fetch + index a URL). Sandbox compute (open_ctx_execute/batch/file) is
  // work-output the model would see regardless — NOT redirect savings —
  // so it is excluded; folding it crushed the bar to a false ~43%.
  const row = sdb
    .prepare(
      `SELECT
         COALESCE(SUM(LENGTH(data)), 0)   AS data_bytes,
         COALESCE(SUM(bytes_avoided), 0)  AS bytes_avoided,
         COALESCE(SUM(bytes_returned), 0) AS bytes_returned
       FROM session_events${scope.events}`,
    )
    .get(...scope.params) as { data_bytes: number; bytes_avoided: number; bytes_returned: number } | undefined;
  if (row) {
    tally.eventDataBytes += Number(row.data_bytes ?? 0);
    tally.bytesAvoided += Number(row.bytes_avoided ?? 0);
    tally.bytesReturned += Number(row.bytes_returned ?? 0);
  }

  try {
    const snap = sdb
      .prepare(`SELECT COALESCE(SUM(LENGTH(snapshot)), 0) AS bytes FROM session_resume${scope.resume}`)
      .get(...scope.params) as { bytes: number } | undefined;
    if (snap?.bytes) tally.snapshotBytes += Number(snap.bytes);
  } catch {
    /* old schema */
  }

  try {
    const tc = sdb.prepare(`SELECT COALESCE(SUM(bytes_returned), 0) AS bytes FROM tool_calls${scope.tools}`).get(...scope.params) as
      { bytes: number } | undefined;
    if (tc?.bytes) tally.bytesReturned += Number(tc.bytes);
  } catch {
    /* old schema: no tool_calls table */
  }
}

export function getRealBytesStats(opts: {
  sessionId?: string;
  sessionsDir?: string;
  worktreeHash?: string;
  /**
   * v1.0.148 follow-up (Bug E+F): when set, the function aggregates across
   * EVERY session whose `session_meta.project_dir` matches this value, not
   * just one session_id. Resolves the per-conversation under-attribution:
   * one Claude Code conversation typically spans many session_ids (resume
   * cycles, /compact rebirths, PID sub-process sessions spawned by
   * open_ctx_execute), so a single-session_id filter loses the sandbox-burst
   * bytes_avoided that all live under the conversation's cwd.
   *
   * Uses a META subquery (`session_id IN (SELECT session_id FROM
   * session_meta WHERE project_dir = ?)`), then sums ALL events for
   * matching sessions regardless of their event-level project_dir
   * (sandbox-burst events write `project_dir = ''` even when the
   * META row carries the parent cwd — see Bug F).
   *
   * Mutually exclusive with `sessionId`. When both are set, `sessionId`
   * wins for back-compat.
   */
  projectDir?: string;
  /**
   * v1.0.133 Slice 3: when set alongside `sessionId`, the function joins
   * the FTS5 content DB at this path and folds chunk bytes into
   * `bytesAvoided` + `totalSavedTokens` + `contentBytes`. Render-time
   * only — no DB writes.
   */
  contentDbPath?: string;
  loadDatabase?: () => unknown;
}): RealBytesStats {
  const empty: RealBytesStats = {
    eventDataBytes: 0,
    bytesAvoided: 0,
    bytesReturned: 0,
    snapshotBytes: 0,
    contentBytes: 0,
    totalSavedTokens: 0,
  };

  const sessionsDir = opts.sessionsDir ?? join(homedir(), ".claude", "open-context-mode", "sessions");
  if (!existsSync(sessionsDir)) return empty;

  let dbFiles: string[] = [];
  try {
    dbFiles = readdirSync(sessionsDir).filter((f) => {
      if (!f.endsWith(".db")) return false;
      if (opts.worktreeHash && !f.startsWith(opts.worktreeHash)) return false;
      return true;
    });
  } catch {
    return empty;
  }
  if (dbFiles.length === 0) return empty;

  let DatabaseCtor: ReturnType<typeof loadDatabaseImpl> | null = null;
  try {
    DatabaseCtor = opts.loadDatabase ? (opts.loadDatabase() as ReturnType<typeof loadDatabaseImpl>) : loadDatabaseImpl();
  } catch {
    return empty;
  }
  if (!DatabaseCtor) return empty;

  const tally: RealBytesTally = {
    eventDataBytes: 0,
    bytesAvoided: 0,
    bytesReturned: 0,
    snapshotBytes: 0,
  };
  const scope = realBytesScope(opts);

  for (const file of dbFiles) {
    const dbPath = join(sessionsDir, file);
    // v1.0.148 hotfix: historical DBs were created with pre-v1.0.130
    // schema (no bytes_avoided / bytes_returned / project_dir columns).
    // The SELECT below references those columns, so without an in-place
    // migration the prepare() throws and the surrounding catch silently
    // skips the WHOLE DB — losing even the LENGTH(data) signal. Run the
    // shared migration helper before opening readonly. Idempotent: a
    // PRAGMA check inside the helper short-circuits when the DB is
    // already current, so post-first-read calls are cheap.
    ensureSessionEventsSchema(
      dbPath,
      DatabaseCtor as unknown as new (
        path: string,
        opts?: { readonly?: boolean },
      ) => {
        pragma: (q: string) => Array<{ name: string }>;
        exec: (sql: string) => void;
        close: () => void;
      },
    );
    try {
      const sdb = new DatabaseCtor(dbPath, { readonly: true });
      try {
        foldRealBytesDb(sdb, scope, tally);
      } finally {
        sdb.close();
      }
    } catch {
      /* missing tables / corrupt — skip */
    }
  }

  // Honest-savings fix (#952): indexed chunk bytes are content captured
  // FOR RECALL — most of it already entered the context window through
  // the original tool result, so folding it into bytesAvoided
  // double-counts. Report it as contentBytes ("indexed for recall")
  // only; bytesAvoided stays strictly SUM(bytes_avoided) from recorded
  // redirect events.
  // TODO(recall-attribution): credit a chunk as avoided only when a later
  // open_ctx_search hit returns its snippet instead of a re-read (chunk − snippet).
  let contentBytes = 0;
  if (opts.sessionId && opts.contentDbPath) {
    contentBytes = getContentBytesForSession(opts.sessionId, opts.contentDbPath, { loadDatabase: opts.loadDatabase });
  }

  // eventDataBytes and snapshotBytes are analytics/resume infrastructure —
  // they never enter the model context window — so they are excluded from
  // the savings estimate too (#952).
  const totalSavedTokens = Math.floor(tally.bytesAvoided / 4);

  const { eventDataBytes, bytesAvoided, bytesReturned, snapshotBytes } = tally;
  return { eventDataBytes, bytesAvoided, bytesReturned, snapshotBytes, contentBytes, totalSavedTokens };
}

/**
 * v1.0.169 — Section 1 "Where you are now" = the LIVE conversation window.
 *
 * A single live conversation fans out into sub-agents and open_ctx_execute
 * sub-process sessions. Each runs in its OWN, disposable context window (its
 * own session_id) — but all under the SAME worktree DB, because the worktree
 * hash is sha256(cwd) and they share the cwd. Their retrieval (open_ctx_search /
 * open_ctx_fetch_and_index returns) entered THOSE windows and was thrown away when
 * each returned its short summary; it never touched the window the user is
 * reading now. So the live-window savings bar must split the worktree by
 * which retrieval actually landed in the user's window:
 *
 *   bytesReturned ("With open-context-mode")  = THIS session's retrieval only —
 *       what genuinely entered the live window.
 *   bytesAvoided  ("kept out")           = everything the whole worktree moved
 *       (avoided + every session's retrieval) MINUS what landed in your window.
 *
 * Scoping by `worktreeHash` (not project-root + time) means the user's OTHER
 * parallel worktrees never bleed in — a different worktree is a different
 * cwd-hash, hence a different DB file the prefix filter excludes — while the
 * sub-agent fan-out this conversation actually spawned is fully credited.
 */
export function getConversationWindowStats(opts: {
  sessionId: string;
  worktreeHash: string;
  sessionsDir?: string;
  contentDbPath?: string;
}): RealBytesStats {
  // Whole current worktree: every session that shares this cwd-hash DB.
  const pool = getRealBytesStats({
    worktreeHash: opts.worktreeHash,
    sessionsDir: opts.sessionsDir,
  });
  // Just the live window: this session_id (folds its own open_ctx_search/open_ctx_fetch
  // retrieval + content chunks).
  const mine = getRealBytesStats({
    sessionId: opts.sessionId,
    worktreeHash: opts.worktreeHash,
    sessionsDir: opts.sessionsDir,
    contentDbPath: opts.contentDbPath,
  });

  const windowReturned = mine.bytesReturned;
  const movedTotal = pool.bytesAvoided + pool.bytesReturned;
  // What open-context-mode kept OUT of the live window = everything moved across the
  // worktree minus the slice that actually entered this window. Clamp at 0 so a
  // stale/edge DB can never produce a negative bar.
  const keptOut = Math.max(0, movedTotal - windowReturned);

  return {
    eventDataBytes: pool.eventDataBytes,
    bytesAvoided: keptOut,
    bytesReturned: windowReturned,
    snapshotBytes: pool.snapshotBytes,
    contentBytes: mine.contentBytes,
    // #952 honest savings: keptOut/4 only — capture volume (eventDataBytes,
    // snapshotBytes of the pool) is not savings. Pool scoping stays (ADR-0004).
    totalSavedTokens: Math.floor(keptOut / 4),
  };
}

// ─────────────────────────────────────────────────────────
// Multi-adapter aggregation (B3a — "your work everywhere")
// ─────────────────────────────────────────────────────────

/**
 * Real-usage filter thresholds. Decided in the B3a /diagnose conversation
 * to suppress fixture-noise dirs (test runs that touched ~/.X but never
 * carried real user work).
 *
 * An adapter is `isReal=true` iff ALL four hold:
 *   eventCount     >= 100
 *   distinctProjects >= 5
 *   lastActivity within 30 days
 *   avgEventBytes  >= 50
 *
 * Tuneable via `getMultiAdapterLifetimeStats({ filter })` for testing.
 */
export interface RealUsageFilter {
  minEvents?: number;
  minProjects?: number;
  recencyMs?: number;
  minAvgBytes?: number;
  /** Fixed "now" timestamp for deterministic testing. Defaults to Date.now(). */
  nowMs?: number;
}

const DEFAULT_REAL_USAGE_FILTER: Required<Omit<RealUsageFilter, "nowMs">> = {
  minEvents: 100,
  minProjects: 5,
  recencyMs: 30 * 86_400_000,
  minAvgBytes: 50,
};

/** Per-adapter scan result returned by {@link scanOneAdapter}. */
export interface AdapterScanResult {
  /** Adapter id (matches `enumerateAdapterDirs().name`). */
  name: string;
  /** Total event rows across every `*.db` in this adapter's sessions dir. */
  eventCount: number;
  /** Total distinct session_meta rows across every db. */
  sessionCount: number;
  /** Sum of LENGTH(data) across every session_event row. */
  dataBytes: number;
  /** Sum of LENGTH(snapshot) across consumed compact-rescue snapshots. */
  rescueBytes: number;
  /** Reserved for future content/ scan (B3b). 0 today. */
  contentBytes: number;
  /** Distinct session_id count across all dbs (alias of sessionCount). */
  uuidConvs: number;
  /** Distinct project_dir values across all session_events. */
  projectDirs: string[];
  /** Earliest event ms epoch (Number.POSITIVE_INFINITY when no events). */
  firstMs: number;
  /** Latest event ms epoch (0 when no events). */
  lastMs: number;
  /** Real-usage flag — see {@link RealUsageFilter}. */
  isReal: boolean;
}

/**
 * Scan one adapter's sessions dir. Always returns a result — never throws.
 * When the dir is missing, the result has zeroed counts and `isReal=false`.
 *
 * Mirrors the inner SessionDB-walk inside `getLifetimeStats`
 * (analytics.ts:677-752) so the new multi-adapter path stays in lock-step
 * with the per-DB queries the single-dir path already trusts.
 */
function scanOneAdapter(
  entry: AdapterDirEntry,
  loadDb: () => unknown,
  filter: Required<Omit<RealUsageFilter, "nowMs">> & { nowMs: number },
): AdapterScanResult {
  const result: AdapterScanResult = {
    name: entry.name,
    eventCount: 0,
    sessionCount: 0,
    dataBytes: 0,
    rescueBytes: 0,
    contentBytes: 0,
    uuidConvs: 0,
    projectDirs: [],
    firstMs: Number.POSITIVE_INFINITY,
    lastMs: 0,
    isReal: false,
  };
  if (!existsSync(entry.sessionsDir)) return result;

  let dbFiles: string[] = [];
  try {
    dbFiles = readdirSync(entry.sessionsDir).filter((f) => f.endsWith(".db"));
  } catch {
    return result;
  }
  if (dbFiles.length === 0) return result;

  let DatabaseCtor: ReturnType<typeof loadDatabaseImpl> | null = null;
  try {
    DatabaseCtor = loadDb() as ReturnType<typeof loadDatabaseImpl>;
  } catch {
    return result;
  }
  if (!DatabaseCtor) return result;

  const projectsSet = new Set<string>();
  const sessionsSet = new Set<string>();

  for (const file of dbFiles) {
    const dbPath = join(entry.sessionsDir, file);
    try {
      const sdb = new DatabaseCtor(dbPath, { readonly: true });
      try {
        const ev = sdb.prepare("SELECT COUNT(*) AS cnt, COALESCE(SUM(LENGTH(data)), 0) AS bytes FROM session_events").get() as
          { cnt: number; bytes: number } | undefined;
        if (ev) {
          result.eventCount += Number(ev.cnt ?? 0);
          result.dataBytes += Number(ev.bytes ?? 0);
        }
        try {
          const ss = sdb.prepare("SELECT COUNT(*) AS cnt FROM session_meta").get() as { cnt: number } | undefined;
          result.sessionCount += Number(ss?.cnt ?? 0);
        } catch {
          /* old schema */
        }
        try {
          const snap = sdb.prepare("SELECT COALESCE(SUM(length(snapshot)), 0) AS bytes FROM session_resume WHERE consumed = 1").get() as
            { bytes: number } | undefined;
          if (snap?.bytes) result.rescueBytes += Number(snap.bytes);
        } catch {
          /* old schema */
        }
        try {
          const range = sdb.prepare("SELECT MIN(created_at) AS mn, MAX(created_at) AS mx FROM session_events").get() as
            { mn: string | null; mx: string | null } | undefined;
          if (range?.mn) {
            const t = Date.parse(range.mn + (range.mn.endsWith("Z") ? "" : "Z"));
            if (Number.isFinite(t) && t < result.firstMs) result.firstMs = t;
          }
          if (range?.mx) {
            const t = Date.parse(range.mx + (range.mx.endsWith("Z") ? "" : "Z"));
            if (Number.isFinite(t) && t > result.lastMs) result.lastMs = t;
          }
        } catch {
          /* old schema */
        }
        try {
          const projRows = sdb.prepare("SELECT DISTINCT project_dir AS p FROM session_events WHERE project_dir != ''").all() as Array<{
            p: string;
          }>;
          for (const row of projRows) if (row.p) projectsSet.add(row.p);
        } catch {
          /* old schema */
        }
        try {
          const sidRows = sdb.prepare("SELECT DISTINCT session_id AS s FROM session_events").all() as Array<{ s: string }>;
          for (const row of sidRows) if (row.s) sessionsSet.add(row.s);
        } catch {
          /* old schema */
        }
      } finally {
        sdb.close();
      }
    } catch {
      /* missing tables / corrupt — skip */
    }
  }

  result.projectDirs = Array.from(projectsSet);
  result.uuidConvs = sessionsSet.size;

  // Real-usage filter — see RealUsageFilter docstring.
  const avgBytes = result.eventCount > 0 ? result.dataBytes / result.eventCount : 0;
  const recentEnough = result.lastMs > 0 && filter.nowMs - result.lastMs <= filter.recencyMs;
  result.isReal =
    result.eventCount >= filter.minEvents && projectsSet.size >= filter.minProjects && recentEnough && avgBytes >= filter.minAvgBytes;

  return result;
}

/** Aggregated multi-adapter lifetime stats. */
export interface MultiAdapterLifetimeStats {
  /** Sum of eventCount across every adapter that exists on disk. */
  totalEvents: number;
  /** Sum of sessionCount across every adapter. */
  totalSessions: number;
  /** Sum of dataBytes + rescueBytes across every adapter. */
  totalBytes: number;
  /** Per-adapter rows for adapters that have >= one .db file. */
  perAdapter: AdapterScanResult[];
}

/**
 * Aggregate lifetime stats across every adapter dir under `home`.
 * The marketing line — "your work everywhere on this machine across all
 * AI tools" — depends on this. Existing `getLifetimeStats` (single dir)
 * is untouched; this is purely additive.
 */
export function getMultiAdapterLifetimeStats(opts?: {
  home?: string;
  loadDatabase?: () => unknown;
  filter?: RealUsageFilter;
}): MultiAdapterLifetimeStats {
  const dirs = enumerateAdapterDirs({ home: opts?.home });
  const loadDb = opts?.loadDatabase ?? loadDatabaseImpl;
  const filter = {
    ...DEFAULT_REAL_USAGE_FILTER,
    ...(opts?.filter ?? {}),
    nowMs: opts?.filter?.nowMs ?? Date.now(),
  };

  const perAdapter: AdapterScanResult[] = [];
  let totalEvents = 0;
  let totalSessions = 0;
  let totalBytes = 0;

  for (const entry of dirs) {
    if (!existsSync(entry.sessionsDir)) continue; // only surface adapters with a sessions dir
    const r = scanOneAdapter(entry, loadDb, filter);
    perAdapter.push(r);
    totalEvents += r.eventCount;
    totalSessions += r.sessionCount;
    totalBytes += r.dataBytes + r.rescueBytes;
  }

  return { totalEvents, totalSessions, totalBytes, perAdapter };
}

/** Aggregated multi-adapter real-bytes stats. */
export interface MultiAdapterRealBytesStats extends RealBytesStats {
  /** Per-adapter row in the same shape as {@link RealBytesStats}, keyed by name. */
  perAdapter: Array<RealBytesStats & { name: string }>;
}

/**
 * Aggregate real-bytes stats across every adapter dir under `home`.
 * Mirrors `getRealBytesStats` (single dir, analytics.ts:887-989) but
 * iterates {@link enumerateAdapterDirs}. Optional `sessionId` /
 * `worktreeHash` filters apply uniformly to every dir.
 */
export function getMultiAdapterRealBytesStats(opts?: {
  home?: string;
  sessionId?: string;
  worktreeHash?: string;
  loadDatabase?: () => unknown;
}): MultiAdapterRealBytesStats {
  const dirs = enumerateAdapterDirs({ home: opts?.home });

  const sum: RealBytesStats = {
    eventDataBytes: 0,
    bytesAvoided: 0,
    bytesReturned: 0,
    snapshotBytes: 0,
    contentBytes: 0,
    totalSavedTokens: 0,
  };
  const perAdapter: MultiAdapterRealBytesStats["perAdapter"] = [];

  for (const entry of dirs) {
    if (!existsSync(entry.sessionsDir)) continue;
    const one = getRealBytesStats({
      sessionsDir: entry.sessionsDir,
      sessionId: opts?.sessionId,
      worktreeHash: opts?.worktreeHash,
      loadDatabase: opts?.loadDatabase,
    });
    // ARCH-REVIEW-V134-ABC SLICE C: aggregate this adapter's content DB
    // bytes into the lifetime sum. `getRealBytesStats` operates on
    // session events only and never touches the sibling content/ tree —
    // without this step the lifetime tier in open_ctx_stats reports 0 for
    // every adapter except whichever one happens to share the
    // sessionsDir of the caller. Lifetime tier ignores sessionId so
    // the all-sessions aggregator is the right helper here.
    if (!opts?.sessionId) {
      const contentDbPath = join(entry.contentDir, "content.db");
      const adapterContentBytes = getContentBytesAllSessions(contentDbPath, {
        loadDatabase: opts?.loadDatabase as (() => unknown) | undefined,
      });
      one.contentBytes += adapterContentBytes;
      sum.contentBytes += adapterContentBytes;
    }
    perAdapter.push({ name: entry.name, ...one });
    sum.eventDataBytes += one.eventDataBytes;
    sum.bytesAvoided += one.bytesAvoided;
    sum.bytesReturned += one.bytesReturned;
    sum.snapshotBytes += one.snapshotBytes;
  }
  // Honest-savings fix (#952): only recorded redirects count.
  sum.totalSavedTokens = Math.floor(sum.bytesAvoided / 4);

  return { ...sum, perAdapter };
}
