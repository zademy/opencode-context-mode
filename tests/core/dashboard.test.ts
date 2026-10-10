import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { startDashboardServer } from "../../src/dashboard/server.js";

// ADR 0005 contract: read-only ephemeral server over fixture adapter data.
let home = "";
let server: Awaited<ReturnType<typeof startDashboardServer>> | null = null;

function utcDate(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "open_ctx-dash-"));
  const sessions = join(home, ".config", "opencode", "open-context-mode", "sessions");
  mkdirSync(sessions, { recursive: true });

  const db = new Database(join(sessions, "abc.db"));
  db.exec(`
    CREATE TABLE session_events (session_id TEXT, category TEXT, data TEXT, created_at TEXT, project_dir TEXT);
    CREATE TABLE session_meta (session_id TEXT PRIMARY KEY);
    CREATE TABLE session_resume (consumed INTEGER, snapshot TEXT);
  `);
  const ins = db.prepare("INSERT INTO session_events (session_id, category, data, created_at, project_dir) VALUES (?, ?, ?, ?, ?)");
  ins.run("s1", "file", "x", `${utcDate(0)}T10:00:00`, "/p");
  ins.run("s1", "file", "yy", `${utcDate(0)}T11:00:00`, "/p");
  ins.run("s2", "error", "z", `${utcDate(0)}T12:00:00`, "/p");
  ins.run("s2", "file", "w", `${utcDate(1)}T10:00:00`, "/p");
  ins.run("s2", "decision", "v", `${utcDate(1)}T09:00:00`, "/p");
  db.prepare("INSERT INTO session_meta VALUES ('s1'), ('s2')").run();
  db.close();

  // Second adapter, full current schema: bytes accounting, tool_calls, meta columns.
  // One storage tree: the second fixture is a second DB in the same dir,
  const codexSessions = join(home, ".config", "opencode", "open-context-mode", "sessions");
  mkdirSync(codexSessions, { recursive: true });
  const db2 = new Database(join(codexSessions, "full.db"));
  db2.exec(`
    CREATE TABLE session_events (
      session_id TEXT, type TEXT, category TEXT, priority INTEGER DEFAULT 2, data TEXT,
      project_dir TEXT, attribution_source TEXT, attribution_confidence REAL,
      bytes_avoided INTEGER DEFAULT 0, bytes_returned INTEGER DEFAULT 0,
      source_hook TEXT, created_at TEXT DEFAULT (datetime('now')), data_hash TEXT
    );
    CREATE TABLE session_meta (
      session_id TEXT PRIMARY KEY, project_dir TEXT, started_at TEXT, last_event_at TEXT,
      event_count INTEGER, compact_count INTEGER, usage_cursor TEXT
    );
    CREATE TABLE session_resume (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT UNIQUE, snapshot TEXT, event_count INTEGER, created_at TEXT, consumed INTEGER);
    CREATE TABLE tool_calls (session_id TEXT, tool TEXT, calls INTEGER, bytes_returned INTEGER, updated_at TEXT, PRIMARY KEY (session_id, tool));
  `);
  const ins2 = db2.prepare(
    "INSERT INTO session_events (session_id, category, data, project_dir, bytes_avoided, bytes_returned, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  ins2.run("sA", "decision", "aaaa", "/work/alpha", 400, 60, `${utcDate(0)}T10:00:00`);
  ins2.run("sA", "file", "bbbb", "/work/alpha", 400, 20, `${utcDate(0)}T11:00:00`);
  ins2.run("sB", "error", "cccccc", "/work/beta", 1000, 0, `${utcDate(3)}T15:00:00`);
  const meta = db2.prepare(
    "INSERT INTO session_meta (session_id, project_dir, started_at, last_event_at, event_count, compact_count) VALUES (?, ?, ?, ?, ?, ?)",
  );
  meta.run("sA", "/work/alpha", `${utcDate(0)}T10:00:00`, `${utcDate(0)}T11:00:00`, 2, 1);
  meta.run("sB", "/work/beta", `${utcDate(3)}T15:00:00`, `${utcDate(3)}T15:00:00`, 1, 0);
  const tool = db2.prepare("INSERT INTO tool_calls (session_id, tool, calls, bytes_returned) VALUES (?, ?, ?, ?)");
  tool.run("sA", "open_ctx_execute", 3, 60);
  tool.run("sA", "open_ctx_search", 1, 20);
  db2.close();

  server = await startDashboardServer({ home });
});

afterAll(async () => {
  await server?.close();
  if (home) rmSync(home, { recursive: true, force: true });
});

describe("dashboard server", () => {
  it("serves the dashboard page", async () => {
    const res = await fetch(`http://127.0.0.1:${server!.port}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Local dashboard");
    expect(html).toContain("/api/stats");
    expect(html).toContain("/events");
  });

  it("aggregates SQLite data read-only into /api/stats", async () => {
    const res = await fetch(`http://127.0.0.1:${server!.port}/api/stats`);
    expect(res.status).toBe(200);
    const snap = (await res.json()) as {
      lifetime: {
        totalEvents: number;
        totalSessions: number;
        perAdapter: Array<{ name: string }>;
      };
      byCategory: Array<{ category: string; count: number }>;
      byDay: Array<{ day: string; count: number }>;
    };
    expect(snap.lifetime.totalEvents).toBe(8);
    expect(snap.lifetime.totalSessions).toBe(4);
    expect(snap.lifetime.perAdapter.map((a) => a.name)).toEqual(["opencode"]);
    const files = snap.byCategory.find((c) => c.category === "file");
    expect(files?.count).toBe(4);
    const today = snap.byDay[snap.byDay.length - 1];
    expect(today.count).toBe(5);
    expect(snap.byDay[snap.byDay.length - 2].count).toBe(2);
  });

  it("derives token, tool, project, session and heatmap breakdowns from the full schema", async () => {
    const res = await fetch(`http://127.0.0.1:${server!.port}/api/stats`);
    expect(res.status).toBe(200);
    const snap = (await res.json()) as {
      byDay: Array<{ day: string; avoided: number; returned: number }>;
      byTool: Array<{ tool: string; calls: number; tokensReturned: number }>;
      byProject: Array<{ project: string; sessions: number; avoidedTokens: number; returnedTokens: number }>;
      bySession: Array<{ sessionId: string; compacts: number; tools: Array<{ tool: string }> }>;
      heat: Array<{ e: number; t: number }>;
      pricing: { usdPerMillionTokens: number };
    };
    const today = snap.byDay[snap.byDay.length - 1];
    expect(today.avoided).toBe(200); // (400+400)/4 — old-schema db contributes 0
    expect(today.returned).toBe(20); // (60+20)/4
    const exec = snap.byTool.find((t) => t.tool === "open_ctx_execute");
    expect(exec?.calls).toBe(3);
    expect(exec?.tokensReturned).toBe(15); // 60/4
    const alpha = snap.byProject.find((p) => p.project === "/work/alpha");
    expect(alpha?.sessions).toBe(1);
    expect(alpha?.avoidedTokens).toBe(200);
    expect(alpha?.returnedTokens).toBe(20);
    const newest = snap.bySession.find((s) => s.sessionId === "sA");
    expect(newest?.compacts).toBe(1);
    expect(newest?.tools.map((t) => t.tool)).toContain("open_ctx_execute");
    expect(snap.heat.some((c) => c.e >= 2)).toBe(true); // 10:00 bucket merges both adapters
    expect(snap.heat.some((c) => c.t >= 100)).toBe(true); // (400+60)/4 tokens in that bucket
    expect(snap.pricing.usdPerMillionTokens).toBeGreaterThan(0);
  });

  it("streams the first snapshot over SSE", async () => {
    const res = await fetch(`http://127.0.0.1:${server!.port}/events`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const chunk = new TextDecoder().decode(value);
    expect(chunk.startsWith("data:")).toBe(true);
    expect(chunk).toContain('"totalEvents":8');
    await reader.cancel();
  });

  it("pushes updates when the underlying DB changes", async () => {
    const db = new Database(join(home, ".config", "opencode", "open-context-mode", "sessions", "abc.db"));
    try {
      db.prepare(
        "INSERT INTO session_events (session_id, category, data, created_at, project_dir) VALUES ('s1', 'file', 'new', ?, '/p')",
      ).run(`${utcDate(0)}T13:00:00`);
    } finally {
      db.close();
    }

    const deadline = Date.now() + 8_000;
    let events = 8;
    while (Date.now() < deadline) {
      const res = await fetch(`http://127.0.0.1:${server!.port}/api/stats`);
      events = ((await res.json()) as { lifetime: { totalEvents: number } }).lifetime.totalEvents;
      if (events === 9) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    expect(events).toBe(9);
  }, 15_000);

  it("rejects unknown paths and non-GET methods", async () => {
    expect((await fetch(`http://127.0.0.1:${server!.port}/nope`)).status).toBe(404);
    expect(
      (
        await fetch(`http://127.0.0.1:${server!.port}/api/stats`, {
          method: "POST",
        })
      ).status,
    ).toBe(405);
  });
});
