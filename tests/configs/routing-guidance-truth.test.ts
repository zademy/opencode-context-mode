import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

/**
 * Shipped routing guidance must describe what the hooks actually do (#1130).
 *
 * The PreToolUse hook DENIES the call and answers with a redirect; it never
 * "replaces the call with an error" and it never tells the model to give up.
 * The deny reason explicitly invites a retry on a transient network error
 * (PR #683 follow-up), so guidance saying "Do NOT retry" contradicts the code
 * the model is actually talking to — the same rubric the generated payload is
 * held to in tests/core/server.test.ts.
 */

const CONFIGS = fileURLToPath(new URL("../../configs", import.meta.url));

function guidanceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...guidanceFiles(full));
    else if (/\.(md|mdc)$/.test(entry)) out.push(full);
  }
  return out;
}

describe("shipped routing guidance matches the hook behavior (#1130)", () => {
  it("no config tells the model to give up on a denied call", () => {
    const offenders = guidanceFiles(CONFIGS)
      .filter((f) => /\bDo NOT retry\b/i.test(readFileSync(f, "utf-8")))
      .map((f) => f.slice(CONFIGS.length + 1));
    expect(offenders).toEqual([]);
  });

  it("no config claims a call is 'intercepted and replaced with an error'", () => {
    const offenders = guidanceFiles(CONFIGS)
      .filter((f) => /intercepted and (?:replaced with error|blocked)/i.test(readFileSync(f, "utf-8")))
      .map((f) => f.slice(CONFIGS.length + 1));
    expect(offenders).toEqual([]);
  });

  it("no config tells the model open_ctx_execute is JavaScript-only (#941)", () => {
    // open_ctx_execute runs javascript, typescript, python, shell, ruby, go, rust,
    // php, perl, r, elixir and csharp (src/runtime.ts).
    const offenders = guidanceFiles(CONFIGS)
      .filter((f) => /Pure JavaScript/i.test(readFileSync(f, "utf-8")))
      .map((f) => f.slice(CONFIGS.length + 1));
    expect(offenders).toEqual([]);
  });
});
