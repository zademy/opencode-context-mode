/**
 * history-elide — the pass that keeps oversized native tool results out of an
 * OpenCode 2.x outbound message list.
 *
 * The invariant that matters is the two-phase one: a pointer is only written
 * for bytes the caller already stored. So every test below that asserts a
 * rewrite also asserts the indexer ran, and the indexer-failure test asserts
 * the transcript is byte-identical afterwards.
 */

import { describe, it, expect } from "vitest";

import {
  applyElision,
  DEFAULT_ELIDE_CONFIG,
  elideConfig,
  elideToolResults,
  elisionLabel,
  findElidableToolResults,
  toolResultText,
  type ElideConfig,
  type ElisionCandidate,
} from "../../src/platforms/opencode/history-elide.js";

// keepRecent:1 so a single-message transcript is still elidable — the point of
// these tests is the tool-result policy, not the tail guard (covered separately).
const CFG: ElideConfig = { ...DEFAULT_ELIDE_CONFIG, minBytes: 100, capBytes: 100, keepRecent: 1, enabled: true };

/** A `Message` shaped the way OpenCode 2.x delivers it: role + content parts. */
function toolMessage(id: string, name: string, text: string, extra: Record<string, unknown> = {}) {
  return {
    role: "tool",
    content: [
      { type: "tool-call", id, name, input: {} },
      { type: "tool-result", id, name, result: { type: "text", value: text }, ...extra },
    ],
  };
}

function textOf(message: unknown): string {
  return (message as any).content[1].result.value;
}

/**
 * A trailing user turn. No test result is ever the last message in a real
 * transcript, and with `keepRecent: 1` this is what makes the message before
 * it eligible.
 */
function filler(): unknown {
  return { role: "user", content: [{ type: "text", text: "and now?" }] };
}

describe("toolResultText", () => {
  it("reads a text result", () => {
    expect(toolResultText({ type: "text", value: "hello" })).toBe("hello");
  });

  it("joins an all-text content array", () => {
    expect(
      toolResultText({
        type: "content",
        value: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ],
      }),
    ).toBe("a\nb");
  });

  it("refuses a content array holding a file reference", () => {
    expect(
      toolResultText({
        type: "content",
        value: [
          { type: "text", text: "a" },
          { type: "file", uri: "file:///x", mime: "text/plain" },
        ],
      }),
    ).toBeNull();
  });

  // An error the agent has to read is not dead weight, and rewriting it into a
  // `text` result would change what the model is told happened.
  it("refuses an error result", () => {
    expect(toolResultText({ type: "error", value: "boom" })).toBeNull();
  });

  it("refuses a json result", () => {
    expect(toolResultText({ type: "json", value: { a: 1 } })).toBeNull();
  });

  it("refuses junk", () => {
    expect(toolResultText(null)).toBeNull();
    expect(toolResultText("nope")).toBeNull();
    expect(toolResultText({ type: "text", value: 42 })).toBeNull();
  });
});

describe("elisionLabel", () => {
  it("is stable and FTS5-safe", () => {
    expect(elisionLabel("bash", "call_abc123")).toBe("cm-elide/bash/call_abc123");
  });

  it("strips separators out of a hostile name", () => {
    const label = elisionLabel("we ird/name", "id/with/slashes");
    expect(label).toBe("cm-elide/we-ird-name/id-with-slashes");
  });
});

describe("findElidableToolResults", () => {
  it("reports an oversized result and nothing else", () => {
    const messages = [toolMessage("c1", "bash", "x".repeat(500)), filler()];
    const found = findElidableToolResults(messages, CFG);
    expect(found).toHaveLength(1);
    expect(found[0]!.label).toBe("cm-elide/bash/c1");
  });

  it("leaves a result under the threshold alone", () => {
    expect(findElidableToolResults([toolMessage("c1", "bash", "x".repeat(10)), filler()], CFG)).toHaveLength(0);
  });

  // The server-side open_ctx_* tools already run the output ladder. Eliding them
  // fights the pipeline that just made them small.
  it("never touches a open_ctx_* result", () => {
    expect(findElidableToolResults([toolMessage("c1", "open_ctx_execute", "x".repeat(500)), filler()], CFG)).toHaveLength(0);
  });

  it("never touches a provider-executed result", () => {
    expect(findElidableToolResults([toolMessage("c1", "bash", "x".repeat(500), { providerExecuted: true }), filler()], CFG)).toHaveLength(
      0,
    );
  });

  // The label is the recovery handle, so a part we cannot address is a part
  // we cannot point at.
  it("skips a part with no id", () => {
    const messages = [{ role: "tool", content: [{ type: "tool-result", name: "bash", result: { type: "text", value: "x".repeat(500) } }] }];
    expect(findElidableToolResults(messages, CFG)).toHaveLength(0);
  });

  // The model is actively reasoning about the most recent exchange.
  it("never touches the trailing keepRecent messages", () => {
    const cfg: ElideConfig = { ...CFG, keepRecent: 2 };
    const messages = [
      toolMessage("old", "bash", "x".repeat(500)),
      toolMessage("new1", "bash", "x".repeat(500)),
      toolMessage("new2", "bash", "x".repeat(500)),
    ];
    const found = findElidableToolResults(messages, cfg);
    expect(found.map((c) => c.part.id)).toEqual(["old"]);
  });

  it("returns nothing when the whole transcript is inside keepRecent", () => {
    const cfg: ElideConfig = { ...CFG, keepRecent: 4 };
    expect(findElidableToolResults([toolMessage("a", "bash", "x".repeat(500))], cfg)).toHaveLength(0);
  });

  it("is inert when disabled", () => {
    expect(findElidableToolResults([toolMessage("a", "bash", "x".repeat(500)), filler()], { ...CFG, enabled: false })).toHaveLength(0);
  });

  it("tolerates a non-array input", () => {
    expect(findElidableToolResults(undefined, CFG)).toHaveLength(0);
    expect(findElidableToolResults({ nope: true }, CFG)).toHaveLength(0);
  });

  it("walks assistant messages too, not just role==='tool'", () => {
    const messages = [
      { role: "assistant", content: [{ type: "tool-result", id: "c1", name: "bash", result: { type: "text", value: "x".repeat(500) } }] },
      filler(),
    ];
    expect(findElidableToolResults(messages, CFG)).toHaveLength(1);
  });
});

describe("applyElision", () => {
  const candidate = (text: string): ElisionCandidate => ({
    messageIndex: 0,
    partIndex: 0,
    part: { type: "tool-result", id: "c1", name: "bash", result: { type: "text", value: text } },
    text,
    label: "cm-elide/bash/c1",
  });

  // Build and test output puts the actionable part — the failure summary — at
  // the end, so a head-only cut keeps the part nobody wants.
  it("keeps both ends, not just the head", () => {
    const text = `HEADMARKER${"m".repeat(2000)}TAILMARKER`;
    const c = candidate(text);
    const avoided = applyElision(c, { ...CFG, capBytes: 200 });
    const out = (c.part.result as any).value as string;
    expect(out).toContain("HEADMARKER");
    expect(out).toContain("TAILMARKER");
    expect(avoided).toBeGreaterThan(0);
  });

  it("writes a pointer naming the indexed source", () => {
    const c = candidate("x".repeat(500));
    applyElision(c, CFG);
    const out = (c.part.result as any).value as string;
    expect(out).toContain('source "cm-elide/bash/c1"');
    expect(out).toContain("open_ctx_search");
  });

  it("shrinks the payload to roughly the cap", () => {
    const c = candidate("x".repeat(100_000));
    applyElision(c, { ...CFG, capBytes: 2000 });
    expect((c.part.result as any).value.length).toBeLessThan(2400);
  });

  it("reports avoided bytes equal to the size drop", () => {
    const c = candidate("x".repeat(10_000));
    const before = 10_000;
    const avoided = applyElision(c, CFG);
    const after = Buffer.byteLength((c.part.result as any).value as string, "utf8");
    expect(avoided).toBe(before - after);
  });

  it("does not emit a lone surrogate when the cut lands mid-astral-char", () => {
    const c = candidate("😀".repeat(5000));
    applyElision(c, CFG);
    const out = (c.part.result as any).value as string;
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  // A `content` result is an array the host maps over on every later turn.
  // Replacing it with a bare string throws "value.map is not a function" and
  // leaves the session permanently unusable.
  it("keeps a content result an array", () => {
    const c = candidate("x".repeat(10_000));
    c.part.result = { type: "content", value: [{ type: "text", text: c.text }] } as any;
    applyElision(c, CFG);
    const result = c.part.result as any;
    expect(Array.isArray(result.value)).toBe(true);
    expect(result.value).toHaveLength(1);
    expect(result.value[0].type).toBe("text");
    expect(result.value[0].text).toContain('source "cm-elide/bash/c1"');
    expect(() => result.value.map((p: unknown) => p)).not.toThrow();
  });
});

describe("elideToolResults", () => {
  it("rewrites only after the indexer confirms the write", async () => {
    const messages = [toolMessage("c1", "bash", "x".repeat(500)), filler()];
    const stored: ElisionCandidate[] = [];
    const report = await elideToolResults(messages, CFG, (c) => {
      stored.push(c);
      return true;
    });
    expect(stored).toHaveLength(1);
    expect(report.elided).toBe(1);
    expect(report.avoidedBytes).toBeGreaterThan(0);
    expect(textOf(messages[0]).length).toBeLessThan(500);
  });

  // A pointer naming bytes that are not stored is worse than no reduction: the
  // model would go looking for content that does not exist.
  it("leaves the transcript byte-identical when indexing fails", async () => {
    const original = "x".repeat(500);
    const messages = [toolMessage("c1", "bash", original), filler()];
    const report = await elideToolResults(messages, CFG, () => false);
    expect(report.elided).toBe(0);
    expect(report.avoidedBytes).toBe(0);
    expect(textOf(messages[0])).toBe(original);
  });

  it("survives an indexer that throws", async () => {
    const original = "x".repeat(500);
    const messages = [toolMessage("c1", "bash", original), filler()];
    const report = await elideToolResults(messages, CFG, () => {
      throw new Error("db gone");
    });
    expect(report.elided).toBe(0);
    expect(textOf(messages[0])).toBe(original);
  });

  // The real indexer is async (it goes through the open_ctx_index handler), so a
  // rejected promise is the actual failure mode, not a synchronous throw.
  it("survives a rejecting indexer", async () => {
    const original = "x".repeat(500);
    const messages = [toolMessage("c1", "bash", original), filler()];
    const report = await elideToolResults(messages, CFG, () => Promise.reject(new Error("db gone")));
    expect(report.elided).toBe(0);
    expect(textOf(messages[0])).toBe(original);
  });

  it("does not treat a truthy non-true resolution as a confirmed write", async () => {
    const original = "x".repeat(500);
    const messages = [toolMessage("c1", "bash", original), filler()];
    // `undefined` is what an indexer that forgets its `return true` produces.
    // Accepting it would write pointers to nothing.
    const report = await elideToolResults(messages, CFG, async () => undefined as unknown as boolean);
    expect(report.elided).toBe(0);
    expect(textOf(messages[0])).toBe(original);
  });
});

describe("elideConfig", () => {
  const saved = { ...process.env };
  const restore = () => {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, saved);
  };

  it("defaults to on with the documented thresholds", () => {
    for (const k of [
      "OPEN_CONTEXT_MODE_ELIDE",
      "OPEN_CONTEXT_MODE_ELIDE_MIN_BYTES",
      "OPEN_CONTEXT_MODE_ELIDE_CAP_BYTES",
      "OPEN_CONTEXT_MODE_ELIDE_KEEP_RECENT",
    ]) {
      delete process.env[k];
    }
    expect(elideConfig()).toEqual({ minBytes: 4096, capBytes: 2048, keepRecent: 8, enabled: true });
    restore();
  });

  it("reads the thresholds from the environment", () => {
    process.env.OPEN_CONTEXT_MODE_ELIDE_MIN_BYTES = "1000";
    process.env.OPEN_CONTEXT_MODE_ELIDE_CAP_BYTES = "3000";
    process.env.OPEN_CONTEXT_MODE_ELIDE_KEEP_RECENT = "3";
    expect(elideConfig()).toEqual({ minBytes: 1000, capBytes: 3000, keepRecent: 3, enabled: true });
    restore();
  });

  it("disables on OPEN_CONTEXT_MODE_ELIDE=0 without disturbing the thresholds", () => {
    process.env.OPEN_CONTEXT_MODE_ELIDE = "0";
    process.env.OPEN_CONTEXT_MODE_ELIDE_MIN_BYTES = "1000";
    const cfg = elideConfig();
    expect(cfg.enabled).toBe(false);
    expect(cfg.minBytes).toBe(1000);
    restore();
  });

  it("ignores a nonsense threshold", () => {
    process.env.OPEN_CONTEXT_MODE_ELIDE_MIN_BYTES = "banana";
    expect(elideConfig().minBytes).toBe(4096);
    restore();
  });
});
