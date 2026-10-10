/**
 * open-context-mode dashboard — ephemeral local server (ADR 0005).
 *
 * Boots an HTTP server on 127.0.0.1 (random port unless overridden) that
 * serves a single HTML page, a JSON snapshot, and a Server-Sent Events
 * stream. Every SQLite file is opened read-only, so the plugin's WAL writers
 * are never blocked. Nothing is cached to disk and nothing survives the
 * process: Ctrl+C ends it.
 *
 * Change detection is a file-mtime digest over every adapter's session DBs,
 * recomputed on a 2s interval. Only a digest change triggers a full re-scan
 * and an SSE push, so an idle dashboard costs two stat() passes per second.
 *
 * Token semantics (mirrors analytics.ts renderNarrative5Section):
 *   "avoided"  = bytes_avoided/4  — never entered the context window.
 *   "returned" = bytes_returned/4 — what the model actually re-read.
 *   "without open-context-mode" = returned + avoided.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { enumerateAdapterDirs, getMultiAdapterLifetimeStats, getMultiAdapterRealBytesStats } from "../session/analytics-query.js";
import { pricePerToken } from "../session/analytics-metrics.js";
import { categoryLabels } from "../session/analytics-render.js";
import { loadDatabase } from "../db-base.js";
import { dashboardHtml } from "./ui.js";

export interface DayPoint {
  /** UTC date, `YYYY-MM-DD`. */
  day: string;
  count: number;
  /** Tokens kept out of the context window that day (`bytes_avoided/4`). */
  avoided: number;
  /** Tokens the model actually re-read that day (`bytes_returned/4`). */
  returned: number;
  /** Per-adapter split: adapter name → [events, avoided tokens, returned tokens]. */
  perAdapter: Record<string, [number, number, number]>;
}

export interface CategoryPoint {
  category: string;
  label: string;
  count: number;
}

export interface ToolPoint {
  tool: string;
  adapter: string;
  calls: number;
  /** Tokens the model re-read through this tool (`tool_calls.bytes_returned/4`). */
  tokensReturned: number;
}

export interface ProjectPoint {
  project: string;
  adapter: string;
  sessions: number;
  events: number;
  avoidedTokens: number;
  returnedTokens: number;
}

export interface SessionToolPoint {
  tool: string;
  calls: number;
  tokensReturned: number;
}

export interface SessionPoint {
  sessionId: string;
  adapter: string;
  project: string;
  startedAt: string;
  lastAt: string;
  events: number;
  compacts: number;
  avoidedTokens: number;
  returnedTokens: number;
  tools: SessionToolPoint[];
}

export interface HeatCell {
  /** Events in this local weekday×hour bucket. */
  e: number;
  /** Tokens (avoided+returned) in this bucket. */
  t: number;
}

export interface DashboardSnapshot {
  generatedAt: number;
  lifetime: ReturnType<typeof getMultiAdapterLifetimeStats>;
  realBytes: ReturnType<typeof getMultiAdapterRealBytesStats>;
  byDay: DayPoint[];
  byCategory: CategoryPoint[];
  byTool: ToolPoint[];
  byProject: ProjectPoint[];
  bySession: SessionPoint[];
  /** Local-time weekday×hour activity, Monday-major, 168 cells (7×24). */
  heat: HeatCell[];
  /** Current per-token valuation, exposed so the page can price saved tokens. */
  pricing: { usdPerMillionTokens: number };
}

/** Days kept in the per-day series. The page slices 7/30 out of this. */
const TIMELINE_DAYS = 90;
/** Categories shown before the list truncates. */
const CATEGORY_LIMIT = 14;
const TOOL_LIMIT = 14;
const PROJECT_LIMIT = 12;
const SESSION_LIMIT = 60;
const POLL_INTERVAL_MS = 2_000;
const SSE_HEARTBEAT_MS = 15_000;
/** Bytes→tokens divisor used everywhere in analytics.ts. */
const BYTES_PER_TOKEN = 4;

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

type Row = Record<string, unknown>;
type ReadonlyDb = {
  prepare: (sql: string) => { all: () => unknown[] };
  pragma: (q: string) => unknown;
  close: () => void;
};

/** Run a query, swallowing old-schema/corrupt errors — matches analytics.ts' skip policy. */
function safeAll(db: ReadonlyDb, sql: string): Row[] {
  try {
    return db.prepare(sql).all() as Row[];
  } catch {
    return [];
  }
}

/** Column names of a table, empty when the table (or db) predates it. */
function tableColumns(db: ReadonlyDb, table: string): Set<string> {
  try {
    const rows = db.pragma(`table_xinfo(${table})`) as Array<{ name: string }>;
    return new Set(rows.map((c) => c.name));
  } catch {
    return new Set();
  }
}

interface DayAcc {
  count: number;
  avoidedB: number;
  returnedB: number;
  per: Map<string, [number, number, number]>;
}

/**
 * One read-only pass over every adapter's session DBs: computes the change
 * digest (mtime+size of every .db) and the per-day / per-category / per-tool /
 * per-project / per-session / heatmap breakdowns the multi-adapter aggregates
 * don't provide. Old schemas (pre-v1.0.130, no bytes columns) degrade to
 * counts-only via table_xinfo guards.
 */
function scanBreakdown(home?: string): {
  digest: string;
  byDay: Map<string, DayAcc>;
  byCategory: Map<string, number>;
  byTool: Map<string, ToolPoint>;
  byProject: Map<string, ProjectPoint>;
  bySession: SessionPoint[];
  heat: HeatCell[];
} {
  const byDay = new Map<string, DayAcc>();
  const byCategory = new Map<string, number>();
  const byTool = new Map<string, ToolPoint>();
  const byProject = new Map<string, ProjectPoint>();
  const bySession: SessionPoint[] = [];
  const heat: HeatCell[] = Array.from({ length: 168 }, () => ({ e: 0, t: 0 }));

  const digestParts: string[] = [];
  // Local-time shift for the UTC-stamped created_at column, in minutes.
  const tzOffsetMin = new Date().getTimezoneOffset();

  let DatabaseCtor: ReturnType<typeof loadDatabase> | null = null;
  try {
    DatabaseCtor = loadDatabase();
  } catch {
    DatabaseCtor = null;
  }

  for (const entry of enumerateAdapterDirs(home ? { home } : undefined)) {
    if (!existsSync(entry.sessionsDir)) continue;
    let files: string[] = [];
    try {
      files = readdirSync(entry.sessionsDir).filter((f) => f.endsWith(".db"));
    } catch {
      continue;
    }

    for (const file of files) {
      const dbPath = join(entry.sessionsDir, file);
      try {
        const st = statSync(dbPath);
        digestParts.push(`${dbPath}:${st.mtimeMs}:${st.size}`);
      } catch {
        continue;
      }
      if (!DatabaseCtor) continue;
      try {
        const db = new DatabaseCtor(dbPath, { readonly: true }) as unknown as ReadonlyDb;
        try {
          const evCols = tableColumns(db, "session_events");
          const avExpr = evCols.has("bytes_avoided") ? "COALESCE(SUM(bytes_avoided),0)" : "0";
          const retExpr = evCols.has("bytes_returned") ? "COALESCE(SUM(bytes_returned),0)" : "0";
          const adapter = entry.name;

          const dayRows = safeAll(
            db,
            `SELECT substr(created_at, 1, 10) AS d, COUNT(*) AS c, ${avExpr} AS av, ${retExpr} AS ret
             FROM session_events GROUP BY d`,
          );
          for (const row of dayRows) {
            const d = String(row.d ?? "");
            if (!d) continue;
            let acc = byDay.get(d);
            if (!acc) {
              acc = { count: 0, avoidedB: 0, returnedB: 0, per: new Map() };
              byDay.set(d, acc);
            }
            const c = Number(row.c ?? 0);
            const av = Number(row.av ?? 0);
            const ret = Number(row.ret ?? 0);
            acc.count += c;
            acc.avoidedB += av;
            acc.returnedB += ret;
            const per = acc.per.get(adapter) ?? [0, 0, 0];
            per[0] += c;
            per[1] += Math.floor(av / BYTES_PER_TOKEN);
            per[2] += Math.floor(ret / BYTES_PER_TOKEN);
            acc.per.set(adapter, per);
          }

          const catRows = safeAll(db, "SELECT category, COUNT(*) AS c FROM session_events WHERE category != '' GROUP BY category");
          for (const row of catRows) {
            const cat = String(row.category ?? "");
            if (!cat) continue;
            byCategory.set(cat, (byCategory.get(cat) ?? 0) + Number(row.c ?? 0));
          }

          // Heatmap: weekday (0=Sunday) × hour, UTC → local via modular minutes.
          const heatRows = safeAll(
            db,
            `SELECT CAST(strftime('%w', created_at) AS INTEGER) AS w, CAST(substr(created_at, 12, 2) AS INTEGER) AS h,
                    COUNT(*) AS c, (${avExpr}) + (${retExpr}) AS b
             FROM session_events GROUP BY w, h`,
          );
          for (const row of heatRows) {
            const w = Number(row.w);
            const h = Number(row.h);
            if (!Number.isInteger(w) || !Number.isInteger(h) || w < 0 || w > 6 || h < 0 || h > 23) continue;
            const minutes = (((w * 1440 + h * 60 - tzOffsetMin) % 10080) + 10080) % 10080;
            const cell = heat[Math.floor(minutes / 60)];
            cell.e += Number(row.c ?? 0);
            cell.t += Math.floor(Number(row.b ?? 0) / BYTES_PER_TOKEN);
          }

          const toolRows = safeAll(
            db,
            "SELECT tool, COALESCE(SUM(calls),0) AS c, COALESCE(SUM(bytes_returned),0) AS b FROM tool_calls GROUP BY tool",
          );
          for (const row of toolRows) {
            const tool = String(row.tool ?? "");
            if (!tool) continue;
            const key = `${adapter}\u0000${tool}`;
            const acc = byTool.get(key) ?? { tool, adapter, calls: 0, tokensReturned: 0 };
            acc.calls += Number(row.c ?? 0);
            acc.tokensReturned += Math.floor(Number(row.b ?? 0) / BYTES_PER_TOKEN);
            byTool.set(key, acc);
          }

          const projectRows = safeAll(
            db,
            `SELECT COALESCE(NULLIF(m.project_dir, ''), NULLIF(e.project_dir, ''), '(no project)') AS p,
                    COUNT(*) AS ev, COUNT(DISTINCT e.session_id) AS s, ${avExpr} AS av, ${retExpr} AS ret
             FROM session_events e LEFT JOIN session_meta m ON m.session_id = e.session_id GROUP BY p`,
          );
          for (const row of projectRows) {
            const project = String(row.p ?? "");
            if (!project || project === "(no project)") continue;
            const key = `${adapter}\u0000${project}`;
            const acc = byProject.get(key) ?? {
              project,
              adapter,
              sessions: 0,
              events: 0,
              avoidedTokens: 0,
              returnedTokens: 0,
            };
            acc.sessions += Number(row.s ?? 0);
            acc.events += Number(row.ev ?? 0);
            acc.avoidedTokens += Math.floor(Number(row.av ?? 0) / BYTES_PER_TOKEN);
            acc.returnedTokens += Math.floor(Number(row.ret ?? 0) / BYTES_PER_TOKEN);
            byProject.set(key, acc);
          }

          const metaCols = tableColumns(db, "session_meta");
          if (metaCols.has("session_id")) {
            const st = metaCols.has("started_at") ? "COALESCE(m.started_at, '')" : "''";
            const le = metaCols.has("last_event_at") ? "COALESCE(m.last_event_at, '')" : "''";
            const pd = metaCols.has("project_dir") ? "COALESCE(NULLIF(m.project_dir, ''), '(no project)')" : "'(no project)'";
            const ec = metaCols.has("event_count")
              ? "COALESCE(NULLIF(m.event_count,0), (SELECT COUNT(*) FROM session_events e WHERE e.session_id = m.session_id))"
              : "(SELECT COUNT(*) FROM session_events e WHERE e.session_id = m.session_id)";
            const cc = metaCols.has("compact_count") ? "COALESCE(m.compact_count,0)" : "0";
            const sessionRows = safeAll(
              db,
              `SELECT m.session_id AS sid, ${pd} AS p, ${st} AS st, ${le} AS le, ${ec} AS ev, ${cc} AS cc,
                      (SELECT COALESCE(SUM(bytes_avoided),0) FROM session_events e WHERE e.session_id = m.session_id) AS av,
                      (SELECT COALESCE(SUM(bytes_returned),0) FROM session_events e WHERE e.session_id = m.session_id) AS ret
               FROM session_meta m`,
            );
            const sessionTools = safeAll(
              db,
              "SELECT session_id AS sid, tool, calls AS c, bytes_returned AS b FROM tool_calls ORDER BY b DESC",
            );
            const toolsBySession = new Map<string, SessionToolPoint[]>();
            for (const row of sessionTools) {
              const sid = String(row.sid ?? "");
              if (!sid) continue;
              const list = toolsBySession.get(sid) ?? [];
              if (list.length < 3) {
                list.push({
                  tool: String(row.tool ?? ""),
                  calls: Number(row.c ?? 0),
                  tokensReturned: Math.floor(Number(row.b ?? 0) / BYTES_PER_TOKEN),
                });
                toolsBySession.set(sid, list);
              }
            }
            for (const row of sessionRows) {
              const sid = String(row.sid ?? "");
              if (!sid) continue;
              bySession.push({
                sessionId: sid,
                adapter,
                project: String(row.p ?? "(no project)"),
                startedAt: String(row.st ?? ""),
                lastAt: String(row.le ?? ""),
                events: Number(row.ev ?? 0),
                compacts: Number(row.cc ?? 0),
                avoidedTokens: Math.floor(Number(row.av ?? 0) / BYTES_PER_TOKEN),
                returnedTokens: Math.floor(Number(row.ret ?? 0) / BYTES_PER_TOKEN),
                tools: toolsBySession.get(sid) ?? [],
              });
            }
          }
        } finally {
          db.close();
        }
      } catch {
        /* missing tables / corrupt — skip, matches analytics.ts */
      }
    }
  }

  return { digest: digestParts.join("|"), byDay, byCategory, byTool, byProject, bySession, heat };
}

export function collectSnapshot(home?: string): DashboardSnapshot {
  const opts = home ? { home } : undefined;
  const lifetime = getMultiAdapterLifetimeStats(opts);
  const realBytes = getMultiAdapterRealBytesStats(opts);
  const { byDay, byCategory, byTool, byProject, bySession, heat } = scanBreakdown(home);

  // Fill the trailing TIMELINE_DAYS UTC days so the chart shows gaps as zero.
  const todayUtc = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
  const byDayOut: DayPoint[] = [];
  for (let i = TIMELINE_DAYS - 1; i >= 0; i--) {
    const day = utcDay(todayUtc - i * 86_400_000);
    const acc = byDay.get(day);
    byDayOut.push({
      day,
      count: acc?.count ?? 0,
      avoided: Math.floor((acc?.avoidedB ?? 0) / BYTES_PER_TOKEN),
      returned: Math.floor((acc?.returnedB ?? 0) / BYTES_PER_TOKEN),
      perAdapter: Object.fromEntries(acc?.per ?? []),
    });
  }

  const byCategoryOut: CategoryPoint[] = Array.from(byCategory.entries())
    .map(([category, count]) => ({
      category,
      label: categoryLabels[category] ?? category,
      count,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, CATEGORY_LIMIT);

  const byToolOut = Array.from(byTool.values())
    .sort((a, b) => b.tokensReturned - a.tokensReturned)
    .slice(0, TOOL_LIMIT);

  const byProjectOut = Array.from(byProject.values())
    .sort((a, b) => b.avoidedTokens + b.returnedTokens - (a.avoidedTokens + a.returnedTokens))
    .slice(0, PROJECT_LIMIT);

  const bySessionOut = bySession.sort((a, b) => (b.lastAt || b.startedAt).localeCompare(a.lastAt || a.startedAt)).slice(0, SESSION_LIMIT);

  return {
    generatedAt: Date.now(),
    lifetime,
    realBytes,
    byDay: byDayOut,
    byCategory: byCategoryOut,
    byTool: byToolOut,
    byProject: byProjectOut,
    bySession: bySessionOut,
    heat,
    pricing: { usdPerMillionTokens: Math.round(pricePerToken() * 1_000_000 * 100) / 100 },
  };
}

export interface DashboardServer {
  port: number;
  close: () => Promise<void>;
}

export function startDashboardServer(opts: { port?: number; home?: string }): Promise<DashboardServer> {
  let snapshot = collectSnapshot(opts.home);
  let digest = scanBreakdown(opts.home).digest;

  const sseClients = new Set<ServerResponse>();

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? "/").split("?")[0];
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { "Content-Type": "text/plain", Allow: "GET, HEAD" });
      res.end("Method not allowed");
      return;
    }
    if (path === "/" || path === "/index.html") {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(dashboardHtml());
      return;
    }
    if (path === "/api/stats") {
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(JSON.stringify(snapshot));
      return;
    }
    if (path === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
      sseClients.add(res);
      res.on("close", () => sseClients.delete(res));
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  });

  const poll = setInterval(() => {
    const next = scanBreakdown(opts.home).digest;
    if (next === digest) return;
    digest = next;
    snapshot = collectSnapshot(opts.home);
    const body = `data: ${JSON.stringify(snapshot)}\n\n`;
    for (const client of sseClients) client.write(body);
  }, POLL_INTERVAL_MS);

  const heartbeat = setInterval(() => {
    for (const client of sseClients) client.write(": ping\n\n");
  }, SSE_HEARTBEAT_MS);

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        port,
        close: () =>
          new Promise<void>((done) => {
            clearInterval(poll);
            clearInterval(heartbeat);
            for (const client of sseClients) client.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}
