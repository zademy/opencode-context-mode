import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The deployed cache-heal script must not follow symlinks (#1096).
 *
 * #644 fixed this predicate in hooks/sessionstart.mjs and left the reasoning in
 * the code. The same predicate lives a second time inside the healScript
 * template that start.mjs writes to <claude-config>/hooks/, and that copy was
 * the one users cannot patch locally: a symlinked version directory passed
 * statSync's isDirectory(), the heal followed it, and a self-referential link
 * threw ELOOP — which broke every new session.
 *
 * There is no behavioural test for the template (it is a deployed artifact, not
 * an importable module), so this pins the predicate itself.
 */

const START_MJS = fileURLToPath(new URL("../start.mjs", import.meta.url));

describe("start.mjs healScript version-dir filter (#1096)", () => {
  const src = readFileSync(START_MJS, "utf-8");

  it("uses lstatSync, so a symlinked version directory is not a heal target", () => {
    const filter = src.match(/const dirs=readdirSync\([^;]+;/);
    expect(filter, "version-directory filter not found in start.mjs").not.toBeNull();
    expect(filter![0]).toContain("lstatSync(");
    expect(filter![0]).not.toMatch(/\bstatSync\(/);
  });

  it("keeps the lstat rationale next to the predicate (#644 wording)", () => {
    expect(src).toMatch(/lstatSync, not statSync \(#1096\)/);
  });
});
