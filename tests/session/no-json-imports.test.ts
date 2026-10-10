import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * No runtime JSON module imports in `src/` (#890).
 *
 * oh-my-pi validates an installed plugin by transpiling every RESOLVED module
 * with a TypeScript transpiler, so a plain `import data from "./x.json"` makes
 * the JSON itself get parsed as code and `omp plugin install` fails with
 * "7 errors building x.json". Data tables therefore live as TS modules
 * (esbuild inlines those into the bundles).
 */

const SRC = fileURLToPath(new URL("../../src", import.meta.url));
const JSON_IMPORT = /(?:from|import)\s*\(?\s*["'][^"']+\.json["']/;

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...tsFiles(full));
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("src/ has no runtime JSON module imports (#890)", () => {
  it("every .ts under src/ loads data through TS modules, not .json files", () => {
    const offenders = tsFiles(SRC)
      .filter((f) => JSON_IMPORT.test(readFileSync(f, "utf-8")))
      .map((f) => relative(SRC, f));
    expect(offenders).toEqual([]);
  });
});
