/**
 * #895 — timeline truncation must not discard the captures the caller just made.
 *
 * `searchAllSources` merges three sources in timeline mode, and each one caps
 * itself at `limit` first:
 *
 *   ContentStore.searchWithFallback(query, limit)   → ≤ limit
 *   sessionDB.searchEvents(query, limit, …)         → ≤ limit
 *   searchAutoMemory([query], limit, …)             → ≤ limit
 *
 * so the merged array holds up to 3× `limit` rows. The merge then sorted that
 * array ASCENDING by timestamp and took `results.slice(0, limit)` — which keeps
 * the OLDEST `limit` rows of the merge and throws the rest away.
 *
 * For the round-trip this feature exists for, that is exactly backwards. The
 * agent indexes a large output with open_ctx_batch_execute, immediately searches for
 * the label it just used, and the fresh chunk is the last row of an ascending
 * sort — so the slice deletes it and answers with prior-session auto-captured
 * memory. The reporter's failure was not "old memory scored higher"; it was
 * "the new capture was never in the window at all".
 *
 * Fix: truncate from the fresh end (`slice(-limit)`). The slice is already
 * ascending, so the returned set is still chronological — the documented
 * contract of timeline mode, pinned by tests/core/search.test.ts ("timeline
 * results are sorted chronologically").
 */
import { describe, it, expect } from "vite-plus/test";
import { searchAllSources } from "../../src/search/unified.js";

const NOW = Date.parse("2026-03-01T12:00:00.000Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** ContentStore row shape — mapped 1:1 onto UnifiedSearchResult. */
function chunk(title: string, tsAgo: number) {
  return {
    title,
    content: `body of ${title}`,
    source: "execute:shell",
    timestamp: iso(tsAgo),
  };
}

/** SessionDB row shape — searchAllSources re-titles these as `[category] type`. */
function event(label: string, tsAgo: number) {
  return {
    id: label,
    session_id: "prior-session",
    category: "note",
    type: label,
    data: `prior-session body ${label}`,
    created_at: iso(tsAgo).replace("T", " ").slice(0, 19),
  };
}

const noMemory = { searchWithFallback: () => [] } as never;

describe("searchAllSources timeline truncation keeps the freshest matches (#895)", () => {
  it("keeps the just-indexed captures when older cross-session results fill the window", () => {
    // The reported shape: `limit` fresh batch chunks indexed moments ago, plus
    // prior-session results that match the same query and fill every source cap.
    const results = searchAllSources({
      query: "package.json",
      limit: 3,
      store: { searchWithFallback: () => [chunk("package.json", 0), chunk("README.md", MINUTE)] } as never,
      sessionDB: {
        searchEvents: () => [event("old-memory-a", 5 * DAY), event("old-memory-b", 4 * DAY), event("old-memory-c", 3 * DAY)],
      } as never,
      sort: "timeline",
      configDir: "/nonexistent",
    });

    expect(results).toHaveLength(3);
    // The two captures indexed in this session must survive the truncation.
    const titles = results.map((r) => r.title);
    expect(titles).toContain("package.json");
    expect(titles).toContain("README.md");
  });

  it("drops the oldest rows, not the newest", () => {
    const results = searchAllSources({
      query: "just-indexed",
      limit: 2,
      store: { searchWithFallback: () => [chunk("just-indexed", 0)] } as never,
      sessionDB: { searchEvents: () => [event("stale-1", 5 * DAY), event("stale-2", 4 * DAY), event("stale-3", 3 * DAY)] } as never,
      sort: "timeline",
      configDir: "/nonexistent",
    });

    expect(results.map((r) => r.title)).toEqual(["[note] stale-3", "just-indexed"]);
  });

  it("returns the whole merge unchanged when it is already within limit", () => {
    const results = searchAllSources({
      query: "small",
      limit: 10,
      store: { searchWithFallback: () => [chunk("b", MINUTE), chunk("a", 0)] } as never,
      sessionDB: null,
      sort: "timeline",
      configDir: "/nonexistent",
    });
    expect(results.map((r) => r.title)).toEqual(["b", "a"]);
  });

  it("still returns the newest results in chronological order", () => {
    const results = searchAllSources({
      query: "t",
      limit: 2,
      store: {
        searchWithFallback: () => [chunk("t-old", 3 * DAY), chunk("t-new", 0), chunk("t-mid", DAY)],
      } as never,
      sessionDB: null,
      sort: "timeline",
      configDir: "/nonexistent",
    });

    // Newest two, still ascending — the contract the existing timeline test pins.
    expect(results.map((r) => r.title)).toEqual(["t-mid", "t-new"]);
    for (let i = 1; i < results.length; i++) {
      expect((results[i - 1].timestamp ?? "") <= (results[i].timestamp ?? "")).toBe(true);
    }
  });

  it("relevance mode keeps its existing single-source window", () => {
    const results = searchAllSources({
      query: "only",
      limit: 3,
      store: { searchWithFallback: () => [chunk("only", 0)] } as never,
    });
    expect(results.map((r) => r.title)).toEqual(["only"]);
  });

  it("an empty merge stays empty", () => {
    expect(searchAllSources({ query: "x", limit: 3, store: noMemory, sort: "timeline", configDir: "/nonexistent" })).toEqual([]);
  });
});
