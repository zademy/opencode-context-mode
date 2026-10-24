/**
 * #1022 — buildResumeSnapshot() accepted `maxBytes` and never read it; the
 * errors / git / subagents sections iterated every event with no cap at all.
 * The issue's repro (5 error events x 40 KB) produced 196 KB against an
 * advertised "<2KB XML" budget — a resume block that re-inflates the context
 * it was built to relieve re-triggers the compaction that produced it.
 *
 * Pins: the parameter is honoured, the default is a real ceiling, the output
 * stays well-formed XML (sections are evicted whole, never sliced), and what
 * got dropped is still announced.
 */
import { strict as assert } from "node:assert";
import { describe, test } from "vite-plus/test";
import { buildResumeSnapshot, type StoredEvent } from "../../src/session/snapshot.js";

function makeEvent(o: Partial<StoredEvent> & Pick<StoredEvent, "type" | "category" | "data">): StoredEvent {
  return {
    type: o.type,
    category: o.category,
    data: o.data,
    priority: o.priority ?? 2,
    created_at: o.created_at ?? new Date().toISOString(),
  };
}

/** The issue's minimal repro, verbatim in shape. */
function reproEvents() {
  return Array.from({ length: 5 }, (_, i) => makeEvent({ type: "error", category: "error", data: "E".repeat(40000) + `#${i}` }));
}

describe("#1022 the resume snapshot honours its byte budget", () => {
  test("issue repro: 5 x 40KB error events stay far under 100KB", () => {
    const xml = buildResumeSnapshot(reproEvents());
    assert.ok(xml.length < 100_000, `expected a bounded snapshot, got ${xml.length} bytes`);
  });

  test("default budget holds even for an event storm across every section", () => {
    const events: StoredEvent[] = [];
    for (let i = 0; i < 400; i++) {
      events.push(makeEvent({ type: "error", category: "error", data: `boom ${i} ${"E".repeat(2000)}` }));
      events.push(makeEvent({ type: "git", category: "git", data: `commit ${i} ${"G".repeat(2000)}` }));
      events.push(makeEvent({ type: "subagent_completed", category: "subagent", data: `agent ${i} ${"S".repeat(2000)}` }));
      events.push(makeEvent({ type: "decision", category: "decision", data: `decided ${i} ${"D".repeat(2000)}` }));
    }
    const xml = buildResumeSnapshot(events);
    assert.ok(xml.length <= 16_000, `default budget not enforced, got ${xml.length} bytes`);
  });

  test("explicit maxBytes is honoured", () => {
    for (const maxBytes of [2_048, 4_096, 16_000]) {
      const xml = buildResumeSnapshot(reproEvents(), { maxBytes });
      assert.ok(xml.length <= maxBytes, `maxBytes=${maxBytes} not honoured, got ${xml.length}`);
    }
  });

  test("eviction keeps the XML well-formed — no half-closed section", () => {
    const xml = buildResumeSnapshot(reproEvents(), { maxBytes: 2_048 });
    assert.ok(xml.startsWith("<session_resume"), "still opens the root element");
    assert.ok(xml.endsWith("</session_resume>"), "still closes the root element");
    // Stack-walk: a byte cut through the XML would leave a tag unclosed.
    const stack: string[] = [];
    for (const m of xml.matchAll(/<(\/?)([a-z_]+)[^>]*?(\/?)>/g)) {
      if (m[3] === "/") continue; // self-closing
      if (m[1] === "/") {
        assert.equal(stack.pop(), m[2], `unbalanced close </${m[2]}>`);
      } else {
        stack.push(m[2]);
      }
    }
    assert.deepEqual(stack, [], `unclosed tags: ${stack.join(", ")}`);
  });

  test("<how_to_search> survives eviction so the dropped rows stay reachable", () => {
    const xml = buildResumeSnapshot(reproEvents(), { maxBytes: 2_048 });
    assert.ok(xml.includes("For FULL DETAILS"), "retrieval instructions must never be the thing dropped");
  });

  test("per-section caps keep the useful head of an oversized section", () => {
    const events = reproEvents();
    const xml = buildResumeSnapshot(events);
    assert.ok(xml.includes("<errors"), "the errors section should survive its own cap");
    assert.ok(!xml.includes("E".repeat(4000)), "a 40KB error body must not be inlined whole");
  });

  test("a capped section says how much it left out", () => {
    const events = Array.from({ length: 25 }, (_, i) => makeEvent({ type: "error", category: "error", data: `boom ${i}` }));
    const xml = buildResumeSnapshot(events);
    assert.ok(xml.includes('count="25"'), "count stays the total, matching the <files> contract");
    assert.ok(xml.includes("15 more"), `expected a "15 more" note, got: ${xml.slice(xml.indexOf("<errors"), xml.indexOf("</errors>"))}`);
    assert.ok(!xml.includes("boom 0\n"), "oldest error dropped");
    assert.ok(xml.includes("boom 24"), "newest error kept");
  });

  test("capped items keep a mark showing the row was cut", () => {
    const long = `starts-here ${"Z".repeat(500)}`;
    const xml = buildResumeSnapshot([makeEvent({ type: "error", category: "error", data: long })]);
    const section = xml.slice(xml.indexOf("<errors"), xml.indexOf("</errors>"));
    assert.ok(section.includes("starts-here"), "keeps the head of a long error");
    assert.ok(section.includes("…"), "marks the cut");
    assert.ok(!section.includes("Z".repeat(300)), "does not carry the whole row");
  });

  test("a normal-sized session is untouched by the budget", () => {
    const events: StoredEvent[] = [
      makeEvent({ type: "file_edit", category: "file", data: "src/server.ts" }),
      makeEvent({ type: "error_tool", category: "error", data: "Push rejected: non-fast-forward" }),
      makeEvent({ type: "goal", category: "goal", data: "Ship the resume budget" }),
    ];
    const xml = buildResumeSnapshot(events);
    assert.ok(xml.includes("<files"), "files kept");
    assert.ok(xml.includes("<errors"), "errors kept");
    assert.ok(xml.includes("<session_goal"), "goal kept");
    assert.ok(xml.includes("Ship the resume budget"), "goal verbatim");
  });
});
