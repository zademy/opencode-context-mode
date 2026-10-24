import { describe, it, expect, vi } from "vite-plus/test";
import { searchAllSources } from "../../src/search/unified.js";
import { buildCtxSearchInputSchema } from "../../src/search/open_ctx-search-schema.js";

const schema = buildCtxSearchInputSchema(false);

/**
 * `limit` is a row count, not a slice bound (#1119).
 *
 * open_ctx_search accepted a negative (or fractional) limit and returned an
 * arbitrary number of results: `results.slice(0, -1)` drops the last element,
 * `-5` returns five from the end, and which count you got depended on the
 * branch that ran (store / SessionDB timeline / auto-memory) — 7, 4 or 0 for the
 * same input.
 *
 * Two layers: the schema rejects the value for MCP callers (it is a caller bug,
 * not something to reinterpret), and searchAllSources clamps for the internal
 * callers that bypass the schema.
 */

type Row = { id: string };

function fakeStore(rows: Row[]) {
  return {
    searchWithFallback: vi.fn((_q: string, limit: number) => rows.slice(0, Math.max(0, limit))),
  } as never;
}

const sessionDB = {
  searchEvents: vi.fn((_q: string, limit: number) => [] as Row[]),
  getRecentEvents: vi.fn(() => [] as Row[]),
} as never;

describe("open_ctx_search limit validation (#1119)", () => {
  it("rejects a negative limit at the schema", () => {
    const parsed = schema.safeParse({ queries: ["a"], limit: -1 });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(JSON.stringify(parsed.error.issues)).toMatch(/at least 1/);
    }
  });

  it("rejects a fractional limit at the schema", () => {
    expect(schema.safeParse({ queries: ["a"], limit: 2.5 }).success).toBe(false);
  });

  it("still accepts the ordinary values", () => {
    for (const limit of [1, 3, 100]) {
      const parsed = schema.safeParse({ queries: ["a"], limit });
      expect(parsed.success, `limit ${limit} should be valid`).toBe(true);
    }
    expect(schema.safeParse({ queries: ["a"] }).success).toBe(true);
  });
});

describe("searchAllSources clamps a hostile limit (#1119)", () => {
  it.each([
    [-1, 1],
    [-99, 1],
    [0, 1],
    [2.7, 2],
  ])("limit %s reaches the sources as %s", (given, expected) => {
    const store = fakeStore([{ id: "a" }, { id: "b" }, { id: "c" }]);
    searchAllSources({
      query: "x",
      limit: given as number,
      store,
      sessionDB,
    });
    const passed = (store as unknown as { searchWithFallback: { mock: { calls: unknown[][] } } }).searchWithFallback.mock.calls[0][1];
    expect(passed).toBe(expected);
  });
});
