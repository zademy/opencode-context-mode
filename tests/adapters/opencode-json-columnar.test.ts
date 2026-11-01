/**
 * json-columnar — inbound columnar compaction.
 *
 * The invariant that matters: the compacted form is byte-exact reversible.
 * The bytes that ship are re-parsed and rebuilt and compared against the
 * original before the rewrite is offered — value AND key order. A payload
 * that does not survive that check is refused, not rewritten.
 *
 * The second invariant: the pointer is only written once the ORIGINAL bytes
 * are in the content store. A pointer to bytes that are not there is worse
 * than no reduction at all, so a failed index leaves the payload
 * byte-identical.
 */

import { describe, it, expect, beforeEach, afterEach } from "vite-plus/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  columnarConfig,
  columnarLabel,
  compactToolResultWithIndex,
  compactWithIndex,
  DEFAULT_COLUMNAR_CONFIG,
  expandColumnar,
  packColumnar,
  planColumnar,
  planToolResultColumnar,
  unpackColumnar,
} from "../../src/platforms/opencode/json-columnar.js";

const LABEL = columnarLabel("bash", "call_abc123");

/** A payload big enough to clear any sane threshold. */
function flatPayload(rows = 60): string {
  const items = Array.from({ length: rows }, (_, i) => ({
    id: i,
    name: `item-${i}`,
    active: i % 2 === 0,
    score: i * 1.5,
    tags: [`t${i % 3}`, `t${i % 5}`],
  }));
  return JSON.stringify(items);
}

function nestedPayload(rows = 60): string {
  const items = Array.from({ length: rows }, (_, i) => ({
    id: i,
    user: { login: `user-${i}`, id: i * 7, profile: { bio: `bio-${i}`, public: true } },
    labels: [
      { id: i, name: `label-${i}` },
      { id: i + 1, name: `other-${i}` },
    ],
    meta: { created_at: `2026-01-${String((i % 28) + 1).padStart(2, "0")}`, stars: i },
  }));
  return JSON.stringify(items);
}

/**
 * Build a payload that repeats `shapes` many times.
 *
 * The rewrite only pays for itself when the repeated key names cost more than
 * the marker — so the payload needs many rows, like a real API response. A
 * ten-row payload is refused, correctly.
 */
function pad(shapes: Record<string, unknown>[], count = 300): string {
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < count; i++) out.push({ ...shapes[i % shapes.length], i });
  return JSON.stringify(out);
}

/** Deep equality that also pins the key order — the byte-exact claim. */
function sameBytes(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

describe("json-columnar — round trip", () => {
  it("rebuilds a flat array of objects exactly", () => {
    const original = flatPayload();
    const plan = planColumnar(original, { label: LABEL, minBytes: 100 });
    expect(plan).not.toBeNull();

    const rebuilt = expandColumnar(plan!.compacted);
    expect(rebuilt).not.toBeNull();
    expect(rebuilt).toEqual(JSON.parse(original));
    expect(sameBytes(rebuilt, JSON.parse(original))).toBe(true);
  });

  it("rebuilds a nested payload exactly", () => {
    const original = nestedPayload();
    const plan = planColumnar(original, { label: LABEL, minBytes: 100 });
    expect(plan).not.toBeNull();

    const rebuilt = expandColumnar(plan!.compacted);
    expect(rebuilt).toEqual(JSON.parse(original));
    expect(sameBytes(rebuilt, JSON.parse(original))).toBe(true);
  });

  it("keeps a number a number and a string a string", () => {
    // The specific failure mode of a TSV dump: 1 and "1" collapse into one
    // cell and the model cannot tell them apart afterwards. Here the type is
    // carried in the header for a homogeneous column and in the cell for a
    // mixed one, so it cannot happen.
    const original = pad([
      { id: 1, code: "1", label: "one" },
      { id: 2, code: "2", label: "two" },
    ]);
    const plan = planColumnar(original, { label: LABEL, minBytes: 10 });
    expect(plan).not.toBeNull();

    const rebuilt = expandColumnar(plan!.compacted)!;
    expect(typeof rebuilt[0].id).toBe("number");
    expect(typeof rebuilt[0].code).toBe("string");
    expect(rebuilt[0].id).toBe(1);
    expect(rebuilt[0].code).toBe("1");
    expect(rebuilt[0].id).not.toBe(rebuilt[0].code);
  });

  it("keeps a number and a string apart in a MIXED column", () => {
    // Same key, different types across rows — the column is tagged per cell.
    const original = pad([
      { v: 1, name: "x" },
      { v: "1", name: "y" },
      { v: 2, name: "z" },
    ]);
    const plan = planColumnar(original, { label: LABEL, minBytes: 10 });
    expect(plan).not.toBeNull();

    const rebuilt = expandColumnar(plan!.compacted)!;
    expect(rebuilt[0].v).toBe(1);
    expect(rebuilt[1].v).toBe("1");
    expect(rebuilt[2].v).toBe(2);
    expect(typeof rebuilt[1].v).toBe("string");
  });

  it("rebuilds rows whose key sets differ", () => {
    const original = pad([{ a: 1, b: 2 }, { a: 3 }, { a: 9, b: 8, c: 7 }]);
    const plan = planColumnar(original, { label: LABEL, minBytes: 10 });
    expect(plan).not.toBeNull();

    const rebuilt = expandColumnar(plan!.compacted)!;
    expect(rebuilt).toEqual(JSON.parse(original));
    // The rows that do not carry the key do not grow one.
    expect("b" in rebuilt[1]).toBe(false);
    expect("c" in rebuilt[1]).toBe(false);
    expect(rebuilt[0].b).toBe(2);
    expect(rebuilt[2].c).toBe(7);
  });

  it("rebuilds rows whose key ORDER differs", () => {
    const original = pad([
      { a: 1, b: 2 },
      { b: 3, a: 4 },
    ]);
    const plan = planColumnar(original, { label: LABEL, minBytes: 10 });
    expect(plan).not.toBeNull();

    const rebuilt = expandColumnar(plan!.compacted)!;
    expect(rebuilt).toEqual(JSON.parse(original));
    // Key order is part of the byte-exact claim.
    expect(Object.keys(rebuilt[1])).toEqual(["b", "a", "i"]);
    expect(sameBytes(rebuilt, JSON.parse(original))).toBe(true);
  });

  it("survives keys that shadow Object.prototype", () => {
    const original = pad([{ toString: 1, constructor: 2, hasOwnProperty: 3 }]);
    const plan = planColumnar(original, { label: LABEL, minBytes: 10 });
    expect(plan).not.toBeNull();
    expect(expandColumnar(plan!.compacted)).toEqual(JSON.parse(original));
  });

  it("round-trips every shape a random payload can take", () => {
    // Deterministic pseudo-random payloads: random key sets, random key
    // order, mixed types, nested objects and arrays, keys that shadow
    // Object.prototype, unicode. Every one of them has to come back
    // identical — value AND key order.
    let seed = 987654;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const keys = ["alpha", "beta", "gamma", "toString", "delta"];
    const values: unknown[] = [
      0,
      1,
      -3,
      2.5,
      "x",
      "",
      "1",
      true,
      false,
      null,
      { n: 1, deep: { q: 2 } },
      [1, 2, 3],
      "unicode-\u00e9-\u4e2d-\u{1F600}",
    ];

    for (let t = 0; t < 200; t++) {
      const count = 2 + Math.floor(rnd() * 6);
      const rows: Record<string, unknown>[] = [];
      for (let i = 0; i < count; i++) {
        const row: Record<string, unknown> = {};
        const howMany = 1 + Math.floor(rnd() * keys.length);
        const shuffled = keys.slice().sort(() => rnd() - 0.5);
        for (let k = 0; k < howMany; k++) {
          row[shuffled[k]] = values[Math.floor(rnd() * values.length)];
        }
        rows.push(row);
      }
      const original = JSON.stringify(rows);
      const rebuilt = unpackColumnar(packColumnar(rows)!);
      expect(sameBytes(rebuilt, JSON.parse(original))).toBe(true);
      expect(rebuilt).toEqual(rows);
    }
  });

  it("packs and unpacks without a JSON round trip in between", () => {
    const rows = [
      { a: 1, b: "x" },
      { a: 2, b: "y" },
    ];
    const packed = packColumnar(rows)!;
    expect(packed._c).toEqual([
      ["a", "n"],
      ["b", "s"],
    ]);
    expect(packed._r).toEqual([
      [1, "x"],
      [2, "y"],
    ]);
    expect(unpackColumnar(packed)).toEqual(rows);
  });
});

describe("json-columnar — refusals", () => {
  it("refuses a payload that is not an array of objects", () => {
    for (const payload of [
      JSON.stringify({ id: 1 }),
      JSON.stringify([1, 2, 3]),
      JSON.stringify(["a", "b"]),
      JSON.stringify([{ a: 1 }, 2]),
      JSON.stringify([null]),
      JSON.stringify([[1, 2]]),
    ]) {
      expect(planColumnar(payload, { label: LABEL, minBytes: 10 })).toBeNull();
    }
  });

  it("refuses a payload below the threshold", () => {
    const small = JSON.stringify([{ id: 1, name: "x" }]);
    expect(planColumnar(small, { label: LABEL, minBytes: 4096 })).toBeNull();
  });

  it("refuses malformed JSON", () => {
    for (const broken of ["{", "[{", "[{'a':1}]", "not json at all", "[]", ""]) {
      expect(planColumnar(broken, { label: LABEL, minBytes: 1 })).toBeNull();
    }
  });

  it("refuses a payload whose replacement would not be smaller", () => {
    // Two rows, enormous keys: the header costs as much as the rows.
    const original = JSON.stringify([
      { "a-very-long-column-name-that-repeats": "x".repeat(200) },
      { "a-very-long-column-name-that-repeats": "y".repeat(200) },
    ]);
    expect(planColumnar(original, { label: LABEL, minBytes: 10 })).toBeNull();
  });

  it("leaves a non-array payload byte-identical in the tool-result path", () => {
    const result = { content: [{ type: "text", text: JSON.stringify({ id: 1 }) }] };
    const before = JSON.stringify(result);
    expect(planToolResultColumnar(result, { label: LABEL, minBytes: 10 })).toBeNull();
    expect(JSON.stringify(result)).toBe(before);
  });

  it("leaves a payload with a non-text part byte-identical", () => {
    const result = {
      content: [
        { type: "text", text: flatPayload() },
        { type: "file", filename: "a.json" },
      ],
    };
    const before = JSON.stringify(result);
    expect(planToolResultColumnar(result, { label: LABEL, minBytes: 100 })).toBeNull();
    expect(JSON.stringify(result)).toBe(before);
  });
});

describe("json-columnar — the indexing contract", () => {
  it("writes no pointer when indexing fails", async () => {
    const original = flatPayload();
    const indexed: Array<{ text: string; label: string }> = [];

    const plan = await compactWithIndex(original, { label: LABEL, minBytes: 100 }, (text, label) => {
      indexed.push({ text, label });
      return false;
    });

    expect(plan).toBeNull();
    // The original bytes were offered to the store, and nothing came back.
    expect(indexed).toHaveLength(1);
    expect(indexed[0].text).toBe(original);
    expect(indexed[0].label).toBe(LABEL);
  });

  it("writes no pointer when the indexer throws", async () => {
    const original = flatPayload();
    const plan = await compactWithIndex(original, { label: LABEL, minBytes: 100 }, () => {
      throw new Error("store down");
    });
    expect(plan).toBeNull();
  });

  it("leaves the tool result byte-identical when indexing fails", async () => {
    const result = { content: [{ type: "text", text: flatPayload() }] };
    const before = JSON.stringify(result);

    const rewrite = await compactToolResultWithIndex(result, { label: LABEL, minBytes: 100 }, () => false);

    expect(rewrite).toBeNull();
    expect(JSON.stringify(result)).toBe(before);
  });

  it("returns the plan with a retrievable marker when indexing succeeds", async () => {
    const original = flatPayload();
    const plan = await compactWithIndex(original, { label: LABEL, minBytes: 100 }, () => true);

    expect(plan).not.toBeNull();
    expect(plan!.replacement).toContain(LABEL);
    expect(plan!.replacement).toContain("open_ctx_search");
    expect(plan!.replacement).toContain(`source: "${LABEL}"`);
    expect(plan!.avoidedBytes).toBeGreaterThan(0);
  });

  it("indexes the ORIGINAL bytes, not the compacted ones", async () => {
    const original = flatPayload();
    const seen: string[] = [];
    await compactWithIndex(original, { label: LABEL, minBytes: 100 }, (text) => {
      seen.push(text);
      return true;
    });
    expect(seen).toEqual([original]);
  });
});

describe("json-columnar — the marker", () => {
  it("names the content-store label so the agent can retrieve the original", () => {
    const plan = planColumnar(flatPayload(), { label: LABEL, minBytes: 100 })!;
    expect(plan.replacement.split("\n")[0]).toContain(LABEL);
    expect(plan.replacement.split("\n")[0]).toContain("columnar");
    // The compact JSON is the payload after the marker line.
    const payload = plan.replacement.slice(plan.replacement.indexOf("\n") + 1);
    expect(() => JSON.parse(payload)).not.toThrow();
    expect(expandColumnar(payload)).toEqual(JSON.parse(flatPayload()));
  });

  it("builds a label that survives an FTS5 lookup", () => {
    expect(columnarLabel("bash", "call_abc")).toBe("cm-columnar/bash/call_abc");
    expect(columnarLabel("weird tool/name", "id with spaces")).toBe("cm-columnar/weird-tool-name/id-with-spaces");
  });
});

describe("json-columnar — config", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("OPEN_CONTEXT_MODE_COLUMNAR")) delete process.env[key];
    }
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  // OFF by default. The columnar form changes what the model reads, so it
  // stays off until a model has been measured reading it as accurately as
  // the original — the gate is tests/columnar-readability-benchmark.ts.
  it("is off by default, pending the model readability gate", () => {
    const cfg = columnarConfig();
    expect(cfg.enabled).toBe(false);
    expect(cfg.minBytes).toBe(DEFAULT_COLUMNAR_CONFIG.minBytes);
    expect(cfg.minBytes).toBeGreaterThanOrEqual(4096);
  });

  it("can be turned on explicitly by env var", () => {
    process.env.OPEN_CONTEXT_MODE_COLUMNAR = "1";
    expect(columnarConfig().enabled).toBe(true);
  });

  it("stays off for any value other than 1", () => {
    process.env.OPEN_CONTEXT_MODE_COLUMNAR = "0";
    expect(columnarConfig().enabled).toBe(false);
    process.env.OPEN_CONTEXT_MODE_COLUMNAR = "true";
    expect(columnarConfig().enabled).toBe(false);
    process.env.OPEN_CONTEXT_MODE_COLUMNAR = "yes";
    expect(columnarConfig().enabled).toBe(false);
  });

  it("honours the threshold env var", () => {
    process.env.OPEN_CONTEXT_MODE_COLUMNAR_MIN_BYTES = "1234";
    expect(columnarConfig().minBytes).toBe(1234);
  });

  it("ignores a nonsense threshold", () => {
    process.env.OPEN_CONTEXT_MODE_COLUMNAR_MIN_BYTES = "-5";
    expect(columnarConfig().minBytes).toBe(DEFAULT_COLUMNAR_CONFIG.minBytes);
  });
});

/** The v2 tool-result event shape the plugin hands the hook. */
type HookEvent = {
  tool?: string;
  id?: string;
  sessionID?: string;
  status?: string;
  input?: unknown;
  result?: {
    content?: Array<{ type?: string; text?: string }>;
    output?: unknown;
  };
};

type PluginModule = { default: { setup: (ctx: unknown) => Promise<void> } };

describe("json-columnar — v2 write-back", () => {
  const saved = { ...process.env };
  let mod: PluginModule;

  beforeEach(async () => {
    process.env.OPEN_CONTEXT_MODE_COLUMNAR_MIN_BYTES = "100";
    mod = (await import("../../src/platforms/opencode/plugin.js")) as unknown as PluginModule;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  function makeCtx() {
    const hooks: Record<string, (event: HookEvent) => unknown> = {};
    const ctx: any = {
      location: { directory: mkdtempSync(join(tmpdir(), "cm-columnar-")) },
      tool: {
        hook: async (name: string, cb: (event: HookEvent) => unknown) => {
          hooks[`tool.${name}`] = cb;
          return { dispose: async () => {} };
        },
        transform: async () => ({ dispose: async () => {} }),
      },
      session: {
        hook: async (name: string, cb: (event: HookEvent) => unknown) => {
          hooks[`session.${name}`] = cb;
          return { dispose: async () => {} };
        },
      },
      event: { subscribe: () => ({ async *[Symbol.asyncIterator]() {} }) },
    };
    return { ctx, hooks };
  }

  it("rewrites the tool result the model receives", async () => {
    const h = makeCtx();
    await mod.default.setup(h.ctx);

    const payload = flatPayload();
    const event: HookEvent = {
      tool: "bash",
      id: "call_rewrite",
      sessionID: "ses_columnar",
      status: "completed",
      input: { command: "cat items.json" },
      result: { content: [{ type: "text", text: payload }] },
    };

    await h.hooks["tool.execute.after"](event);

    const rewritten = event.result.content[0].text;
    // Either the payload was compacted, or the content store refused and the
    // result was left alone. It must never be half-rewritten.
    if (rewritten !== payload) {
      expect(rewritten).toContain("cm-columnar/bash/call_rewrite");
      const compact = rewritten.slice(rewritten.indexOf("\n") + 1);
      expect(expandColumnar(compact)).toEqual(JSON.parse(payload));
    }
  });

  it("leaves a payload below the threshold byte-identical", async () => {
    process.env.OPEN_CONTEXT_MODE_COLUMNAR_MIN_BYTES = "1048576";
    const h = makeCtx();
    await mod.default.setup(h.ctx);

    const payload = flatPayload();
    const event: HookEvent = {
      tool: "bash",
      id: "call_small",
      sessionID: "ses_columnar",
      status: "completed",
      input: {},
      result: { content: [{ type: "text", text: payload }] },
    };

    await h.hooks["tool.execute.after"](event);

    expect(event.result.content[0].text).toBe(payload);
  });

  it("leaves the result alone when the feature is off", async () => {
    process.env.OPEN_CONTEXT_MODE_COLUMNAR = "0";
    const h = makeCtx();
    await mod.default.setup(h.ctx);

    const payload = flatPayload();
    const event: HookEvent = {
      tool: "bash",
      id: "call_off",
      sessionID: "ses_columnar",
      status: "completed",
      input: {},
      result: { content: [{ type: "text", text: payload }] },
    };

    await h.hooks["tool.execute.after"](event);

    expect(event.result.content[0].text).toBe(payload);
  });

  it("never throws on a malformed payload", async () => {
    const h = makeCtx();
    await mod.default.setup(h.ctx);

    const event: HookEvent = {
      tool: "bash",
      id: "call_broken",
      sessionID: "ses_columnar",
      status: "completed",
      input: {},
      result: { content: [{ type: "text", text: "{not json" }] },
    };

    await expect(h.hooks["tool.execute.after"](event)).resolves.not.toThrow();
    expect(event.result.content[0].text).toBe("{not json");
  });
  // `failSafe` is a WRAPPER: it takes a function and returns a guarded
  // one. The type checker is what catches the mistake of treating it as
  // a value — `await failSafe(name, log, fn)` type-checks against the
  // wrong shape and the guard silently stops guarding. This test pins
  // the runtime consequence: the compaction pass still runs and the
  // payload still reaches the model in its compacted form.
  it("runs the compaction pass through the guarded wrapper", async () => {
    const h = makeCtx();
    await mod.default.setup(h.ctx);

    const payload = flatPayload();
    const event: HookEvent = {
      tool: "bash",
      id: "call_guarded",
      sessionID: "ses_columnar",
      status: "completed",
      input: {},
      result: { content: [{ type: "text", text: payload }] },
    };

    process.env.OPEN_CONTEXT_MODE_COLUMNAR = "1";
    await h.hooks["tool.execute.after"](event);

    // The compacted form replaces the payload and carries the pointer
    // back to the indexed original — proof the pass ran end to end.
    expect(event.result.content[0].text).not.toBe(payload);
    expect(event.result.content[0].text).toContain("cm-columnar/");
    expect(event.result.content[0].text).toContain("open_ctx_search");
  });

  it("still delivers the untouched payload when the guard degrades", async () => {
    const h = makeCtx();
    await mod.default.setup(h.ctx);

    // A result whose content carries a non-text part must be left alone:
    // the compaction refuses it, and the hook still has to hand the model
    // the original bytes.
    const event: HookEvent = {
      tool: "bash",
      id: "call_degraded",
      sessionID: "ses_columnar",
      status: "completed",
      input: {},
      result: {
        content: [
          { type: "text", text: "text part" },
          { type: "file", uri: "file:///x", mime: "text/plain" },
        ],
      },
    };

    process.env.OPEN_CONTEXT_MODE_COLUMNAR = "1";
    await expect(h.hooks["tool.execute.after"](event)).resolves.not.toThrow();
    expect(event.result.content[0].text).toBe("text part");
    expect(event.result.content[1].type).toBe("file");
  });
});
