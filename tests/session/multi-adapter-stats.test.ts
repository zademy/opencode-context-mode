/**
 * multi-adapter-stats — B3a (PRD-stats-multi-adapter)
 *
 * Today `getLifetimeStats` and `getRealBytesStats` scan ONE sessionsDir
 * (~/.claude/open-context-mode/sessions/ by default). The marketing line
 * promises "your work everywhere on this machine across all AI tools" —
 * code MUST aggregate across every adapter dir.
 *
 * This file tests the additive multi-adapter API. Existing single-dir
 * behaviour is covered by `lifetime-stats.test.ts` and
 * `real-bytes-stats.test.ts` and must keep passing untouched.
 *
 * Cited code:
 *   src/session/analytics.ts:592-731  — current getLifetimeStats (single-dir)
 *   src/session/analytics.ts:887-989  — current getRealBytesStats (single-dir)
 *   src/platforms/detect.ts:92-111     — getSessionDirSegments map (17 platforms)
 *
 * Filter (decided in /diagnose conversation, B3a PRD):
 *   real = eventCount >= 100
 *       && distinctProjects >= 5
 *       && lastActivityWithin(30 days)
 *       && avgEventBytes >= 50
 */

import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, test } from "vite-plus/test";
import { SessionDB } from "../../src/session/db.js";
import {
  enumerateAdapterDirs,
  getMultiAdapterLifetimeStats,
  getMultiAdapterRealBytesStats,
  getLifetimeStats,
} from "../../src/session/analytics-query.js";

const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const fn of cleanups) {
    try {
      fn();
    } catch {
      /* ignore */
    }
  }
});

function tmpHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "multi-adapter-home-"));
  cleanups.push(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  });
  return dir;
}

function ensureDir(p: string): string {
  mkdirSync(p, { recursive: true });
  return p;
}

function dbPathFor(sessionsDir: string, hash: string): string {
  return join(sessionsDir, `${hash}__suffix.db`);
}

function seed(
  dbPath: string,
  sessionId: string,
  events: Array<{ type: string; category: string; data: string; bytesAvoided?: number; bytesReturned?: number; projectDir?: string }>,
  snapshots?: Array<{ snapshot: string }>,
): void {
  const sdb = new SessionDB({ dbPath });
  try {
    sdb.ensureSession(sessionId, events[0]?.projectDir ?? "/tmp/proj");
    let i = 0;
    for (const e of events) {
      sdb.insertEvent(
        sessionId,
        {
          type: e.type,
          category: e.category,
          priority: 1,
          data: `${e.data}#${i++}`,
          project_dir: e.projectDir ?? "",
          attribution_source: "test",
          attribution_confidence: 1,
        },
        "test",
        undefined,
        { bytesAvoided: e.bytesAvoided, bytesReturned: e.bytesReturned },
      );
    }
    if (snapshots) {
      for (const s of snapshots) sdb.upsertResume(sessionId, s.snapshot, events.length);
    }
  } finally {
    sdb.close();
  }
}

// ─────────────────────────────────────────────────────────
// Slice 2.1 — adapter dir enumeration
// ─────────────────────────────────────────────────────────

describe("Slice 2.1 — enumerateAdapterDirs()", () => {
  test("each entry exposes sessionsDir and contentDir under <home>/<segments>/open-context-mode/", () => {
    const home = "/HOME";
    const dirs = enumerateAdapterDirs({ home });
    // Use path.join() so the expected prefix/suffix match the platform's
    // separator. enumerateAdapterDirs uses node:path.join under the hood,
    // which emits backslashes on Windows AND converts the leading "/" of
    // "/HOME" to "\\". Normalize the home prefix through join() too — a
    // raw "/HOME" + sep would compare against an apple-and-orange first
    // character on Windows ("/HOME\\..." vs actual "\\HOME\\...").
    const expectedHomePrefix = join(home) + sep;
    const expectedSessionsSuffix = sep + join("open-context-mode", "sessions");
    const expectedContentSuffix = sep + join("open-context-mode", "content");
    for (const d of dirs) {
      expect(d.sessionsDir.startsWith(expectedHomePrefix)).toBe(true);
      expect(d.contentDir.startsWith(expectedHomePrefix)).toBe(true);
      expect(d.sessionsDir.endsWith(expectedSessionsSuffix)).toBe(true);
      expect(d.contentDir.endsWith(expectedContentSuffix)).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────
// Slice 2.2 — multi-adapter scan with per-source breakdown
// ─────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────
// Slice 2.3 — real-usage filter
// ─────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────
// Slice 2.4 — real-bytes multi-adapter variant
// ─────────────────────────────────────────────────────────

describe("Slice 2.4 — getMultiAdapterRealBytesStats()", () => {
  test("returns zeroes when no adapter dir exists", () => {
    const home = tmpHome();
    const r = getMultiAdapterRealBytesStats({ home });
    expect(r.eventDataBytes).toBe(0);
    expect(r.bytesAvoided).toBe(0);
    expect(r.bytesReturned).toBe(0);
    expect(r.snapshotBytes).toBe(0);
    expect(r.totalSavedTokens).toBe(0);
    expect(r.perAdapter).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────
// Slice 2.5 — backward compat (sanity guard inside this file too)
// ─────────────────────────────────────────────────────────

describe("Slice 2.5 — backward compat", () => {
  test("getLifetimeStats and getRealBytesStats are still exported and accept sessionsDir", async () => {
    const m = await import("../../src/session/analytics-query.js");
    expect(typeof m.getLifetimeStats).toBe("function");
    expect(typeof m.getRealBytesStats).toBe("function");
    expect(typeof m.enumerateAdapterDirs).toBe("function");
    expect(typeof m.getMultiAdapterLifetimeStats).toBe("function");
    expect(typeof m.getMultiAdapterRealBytesStats).toBe("function");
  });

  test("multi-adapter helpers do NOT mutate single-dir behaviour: getLifetimeStats({sessionsDir}) only sees that one dir", () => {
    const home = tmpHome();
    const claudeSessions = ensureDir(join(home, ".claude", "open-context-mode", "sessions"));
    const codexSessions = ensureDir(join(home, ".codex", "open-context-mode", "sessions"));
    seed(dbPathFor(claudeSessions, "1111111111111111"), `a-${randomUUID()}`, [
      { type: "t", category: "file", data: "x", projectDir: "/p/cc" },
    ]);
    seed(dbPathFor(codexSessions, "2222222222222222"), `b-${randomUUID()}`, [
      { type: "t", category: "file", data: "y", projectDir: "/p/cdx" },
    ]);

    const memoryRoot = ensureDir(join(home, "memory"));
    const single = getLifetimeStats({ sessionsDir: claudeSessions, memoryRoot });
    expect(single.totalEvents).toBe(1); // ONLY claude — not 2
  });
});
