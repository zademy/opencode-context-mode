import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { composeSourceLabel, ContentStore } from "../src/store.js";

/**
 * Two files, one label, one of them silently deleted (#914).
 *
 * ContentStore.index() dedupes by source label: it clears the chunks carrying
 * the incoming label before inserting the new ones. The CLI composed
 * `label:path`, so two files indexed with `--source obsidian` got distinct keys
 * and both survived. The MCP handler passed the bare label through, so the
 * second `open_ctx_index(path: …, source: "obsidian")` DELETED the first file's
 * chunks — not a cosmetic label, a data-loss path.
 *
 * The MCP surface composes the label in src/server.ts. This pins the property
 * that makes composing it necessary, so the store cannot be "simplified" back
 * into deleting data, plus the raw-content case where there is no path to
 * qualify the label with.
 */

describe("source label composition prevents cross-file deletion (#914)", () => {
  let dir: string;
  let store: ContentStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "open_ctx-src-label-"));
    store = new ContentStore(join(dir, "content.db"));
  });

  afterEach(() => {
    try {
      store.close();
    } catch {
      /* best effort */
    }
    rmSync(dir, { recursive: true, force: true });
  });

  test("two files sharing a label both survive when the label is composed", () => {
    const a = join(dir, "a.md");
    const b = join(dir, "b.md");
    writeFileSync(a, "# alpha\n\nthe first document\n");
    writeFileSync(b, "# beta\n\nthe second document\n");

    store.index({ path: a, source: composeSourceLabel("obsidian", a) });
    store.index({ path: b, source: composeSourceLabel("obsidian", b) });

    const sources = store
      .searchWithFallback("document", 20)
      .map((r) => r.source)
      .sort();
    expect(sources).toEqual([composeSourceLabel("obsidian", a), composeSourceLabel("obsidian", b)].sort());
  });

  test("a bare shared label deletes the previous file's chunks (the bug)", () => {
    const a = join(dir, "a.md");
    const b = join(dir, "b.md");
    writeFileSync(a, "# alpha\n\nthe first document\n");
    writeFileSync(b, "# beta\n\nthe second document\n");

    store.index({ path: a, source: "obsidian" });
    store.index({ path: b, source: "obsidian" });

    // Only the second file's chunks are left — the first one was wiped.
    expect(store.searchWithFallback("document", 20).map((r) => r.source)).toEqual(["obsidian"]);
  });

  test("raw content with a label keeps the label as its own key", () => {
    store.index({ content: "# inline\n\nsome inline body\n", source: "inline-doc" });
    const all = store.searchWithFallback("inline", 20);
    expect(all.length).toBeGreaterThan(0);
    expect(all[0].source).toBe("inline-doc");
  });

  test("the MCP handler composes the label too, not just the CLI (#914)", () => {
    // Driving the registered tool needs a live server, so the composition is
    // pinned at the source level — same accepted pattern as the start.mjs pins.
    // Without this, two open_ctx_index calls sharing a source delete each other's
    // chunks through the MCP surface even though the CLI is fixed.
    const server = readFileSync(fileURLToPath(new URL("../src/server.ts", import.meta.url)), "utf-8");
    const ctxIndex = server.slice(server.indexOf("open_ctx_index"));
    expect(
      ctxIndex.slice(0, 20_000).includes("composeSourceLabel(source, resolvedPath)"),
      "the open_ctx_index handler must compose the caller label with the file",
    ).toBe(true);
  });
});
