/**
 * json-summary — turn an oversized JSON tool result into a structured
 * shape + samples digest, so the transcript keeps the SHAPE of the payload
 * instead of an arbitrary head/tail slice.
 *
 * The invariant that matters: the summary never invents data. Every value in
 * it is derived from the payload it describes, and the payload itself stays
 * retrievable through the content-store pointer the elide pass writes.
 *
 * A summary the model can reason about beats a slice it cannot: the head/tail
 * cut of a JSON array shows the first rows and the last rows and nothing
 * between, so the model cannot tell "there are 500 of these" from "there are
 * two".
 */

import { describe, it, expect } from "vite-plus/test";

import { jsonSummary, isJsonArrayPayload } from "../../src/platforms/opencode/json-summary.js";

describe("isJsonArrayPayload", () => {
  it("accepts an array of objects", () => {
    expect(isJsonArrayPayload('[{"a":1},{"a":2}]')).toBe(true);
  });

  it("rejects an array of primitives", () => {
    expect(isJsonArrayPayload("[1,2,3]")).toBe(false);
  });

  it("rejects a bare object", () => {
    expect(isJsonArrayPayload('{"a":1}')).toBe(false);
  });

  it("rejects text that is not JSON at all", () => {
    expect(isJsonArrayPayload("npm ERR! code E404")).toBe(false);
  });

  it("rejects malformed JSON", () => {
    expect(isJsonArrayPayload('[{"a":1},')).toBe(false);
  });

  it("rejects an empty array", () => {
    expect(isJsonArrayPayload("[]")).toBe(false);
  });
});

describe("jsonSummary", () => {
  it("reports the column names and their types", () => {
    const summary = jsonSummary('[{"id":1,"name":"a"},{"id":2,"name":"b"}]');
    expect(summary).toContain("id:number");
    expect(summary).toContain("name:string");
  });

  it("reports the row count", () => {
    const rows = Array.from({ length: 42 }, (_, i) => JSON.stringify({ id: i }));
    const summary = jsonSummary(`[${rows.join(",")}]`);
    expect(summary).toContain("42");
  });

  it("shows sample rows so the model sees real values", () => {
    const summary = jsonSummary('[{"title":"first","n":1},{"title":"second","n":2}]');
    expect(summary).toContain("first");
    expect(summary).toContain("second");
  });

  it("distinguishes a number column from a string column", () => {
    const summary = jsonSummary('[{"v":1},{"v":2}]');
    expect(summary).toContain("v:number");
    const strSummary = jsonSummary('[{"v":"1"},{"v":"2"}]');
    expect(strSummary).toContain("v:string");
  });

  it("reports null as its own type rather than folding it into string", () => {
    const summary = jsonSummary('[{"v":null},{"v":1}]');
    expect(summary).toContain("v:null");
  });

  it("describes a nested object without flattening its keys away", () => {
    const summary = jsonSummary('[{"user":{"login":"a","id":1}}]');
    expect(summary).toContain("user:object");
  });

  it("describes an array column with its length", () => {
    const summary = jsonSummary('[{"labels":["a","b"]}]');
    expect(summary).toContain("labels:array");
  });

  it("handles rows with differing key sets", () => {
    const summary = jsonSummary('[{"a":1},{"b":2}]');
    expect(summary).toContain("a:number");
    expect(summary).toContain("b:number");
  });

  it("returns null for a payload it cannot summarise", () => {
    expect(jsonSummary("not json")).toBeNull();
    expect(jsonSummary("[1,2,3]")).toBeNull();
    expect(jsonSummary('{"a":1}')).toBeNull();
  });

  // The summary replaces a byte-budgeted slice, so it has to fit in that
  // budget for the elide pass to prefer it.
  it("stays inside the byte budget it is given", () => {
    const wide = Array.from({ length: 200 }, (_, i) =>
      JSON.stringify({ id: i, title: "a-really-long-title-value-" + i, body: "x".repeat(200), meta: { a: 1, b: 2 } }),
    );
    const summary = jsonSummary(`[${wide.join(",")}]`, 2048);
    expect(summary).not.toBeNull();
    expect(Buffer.byteLength(summary!, "utf8")).toBeLessThanOrEqual(2048);
  });

  it("reports how many rows share the sample shape", () => {
    const rows = Array.from({ length: 10 }, (_, i) => JSON.stringify({ id: i, same: "v" }));
    const summary = jsonSummary(`[${rows.join(",")}]`);
    // 10 rows, 1 distinct sampled row-value pattern beyond the id column
    expect(summary).toContain("10");
  });
});
