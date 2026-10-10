/**
 * #1004 — buildRulesSection() branched on `ev.type === "rule_content"` but both
 * arms pushed the full `ev.data`, so rule-file BODIES were inlined verbatim into
 * <session_resume>. The host already supplies AGENTS.md / CLAUDE.md, so the
 * resume block re-injected a second truncated copy of them and the sibling
 * `rule` events (the file paths — the only navigational info in the section)
 * were pushed out of the rendered list.
 *
 * Pins: the body is referenced by size instead of inlined, and the path events
 * (which feed queryTerms) survive.
 */
import { strict as assert } from "node:assert";
import { describe, test } from "vitest";
import { buildResumeSnapshot, type StoredEvent } from "../../src/session/snapshot.js";

const MARKER = "NEVER-INLINE-THIS-RULE-BODY";

function makeEvent(o: Partial<StoredEvent> & Pick<StoredEvent, "type" | "category" | "data">): StoredEvent {
  return {
    type: o.type,
    category: o.category,
    data: o.data,
    priority: o.priority ?? 1,
    created_at: o.created_at ?? new Date().toISOString(),
  };
}

describe("#1004 rule_content is referenced, not inlined", () => {
  const body = `# Project rules\n${MARKER}\n` + "always prefer typescript\n".repeat(400);
  const events: StoredEvent[] = [
    makeEvent({ type: "rule", category: "rule", data: "/project/AGENTS.md" }),
    makeEvent({ type: "rule_content", category: "rule", data: body }),
  ];

  test("does not inline the rule file body into <rules>", () => {
    const xml = buildResumeSnapshot(events);
    assert.ok(xml.includes("<rules"), "should still render the <rules> section");
    assert.ok(!xml.includes(MARKER), `rule body leaked into the snapshot (${xml.length} bytes)`);
  });

  test("keeps the path event so the section stays navigable", () => {
    const xml = buildResumeSnapshot(events);
    assert.ok(xml.includes("AGENTS.md"), "path event must survive — it is the navigation hint");
  });

  test("reports the omitted body's size so the model knows it exists", () => {
    const xml = buildResumeSnapshot(events);
    assert.ok(xml.includes(`${body.length} bytes`), "should report the body size it skipped");
  });

  test("query terms come from the path, not the body", () => {
    const xml = buildResumeSnapshot(events);
    const queries = /queries: \[([^\]]*)\]/.exec(xml)?.[1] ?? "";
    assert.ok(queries.includes("AGENTS.md"), `expected path in query terms, got: ${queries}`);
  });

  test("1000 rules-worth of body stays a table of contents, not a file dump", () => {
    const fat: StoredEvent[] = [makeEvent({ type: "rule", category: "rule", data: "/project/AGENTS.md" })];
    for (let i = 0; i < 5; i++) {
      fat.push(makeEvent({ type: "rule_content", category: "rule", data: `${body} #${i}\n` }));
    }
    const xml = buildResumeSnapshot(fat);
    assert.ok(Buffer.byteLength(xml) < 2048, `expected a small snapshot, got ${Buffer.byteLength(xml)} bytes`);
  });
});
