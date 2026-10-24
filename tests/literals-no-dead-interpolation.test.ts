import { describe, it, expect } from "vite-plus/test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * An interpolation inside a plain string literal reaches the user verbatim.
 *
 * The batch timeout notice read `"… hit the ${effTimeout}ms limit …"` — single
 * quotes, so the model was told "hit the ${effTimeout}ms limit" and never how
 * long its own budget was. Nothing caught it: no test asserted the sentence.
 *
 * A regex cannot tell a template literal from a quoted one (a template full of
 * apostrophes looks like three string literals), so this walks the source and
 * only reports `${…}` found inside a ' or " span that is not itself part of a
 * template literal.
 */

const SRC = fileURLToPath(new URL("../src", import.meta.url));

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** Line/column of the first dead interpolation outside a template literal. */
function findDeadInterpolation(code: string): { line: number; text: string } | null {
  let i = 0;
  const lineOf = (idx: number) => code.slice(0, idx).split("\n").length;
  const lineText = (idx: number) => (code.split("\n")[lineOf(idx) - 1] ?? "").trim();

  while (i < code.length) {
    const ch = code[i];

    // Comments and regex-ish noise: skip to the end of the line.
    if (ch === "/" && code[i + 1] === "/") {
      i = code.indexOf("\n", i);
      if (i < 0) return null;
      continue;
    }
    if (ch === "/" && code[i + 1] === "*") {
      const end = code.indexOf("*/", i + 2);
      i = end < 0 ? code.length : end + 2;
      continue;
    }

    // Template literal: consume it whole, interpolations inside are fine.
    if (ch === "`") {
      i++;
      while (i < code.length) {
        if (code[i] === "\\") i += 2;
        else if (code[i] === "`") {
          i++;
          break;
        } else if (code[i] === "$" && code[i + 1] === "{") {
          let depth = 1;
          i += 2;
          while (i < code.length && depth > 0) {
            if (code[i] === "{") depth++;
            else if (code[i] === "}") depth--;
            i++;
          }
        } else i++;
      }
      continue;
    }

    // Plain string literal: a ${…} here is dead text.
    if (ch === "'" || ch === '"') {
      const start = i;
      i++;
      let body = "";
      while (i < code.length && code[i] !== ch) {
        if (code[i] === "\\") {
          body += code[i + 1] ?? "";
          i += 2;
          continue;
        }
        if (code[i] === "\n") break;
        body += code[i];
        i++;
      }
      if (/\$\{[A-Za-z_][^}]*\}/.test(body)) {
        return { line: lineOf(start), text: lineText(start) };
      }
      i++;
      continue;
    }

    i++;
  }
  return null;
}

describe("no interpolation inside a plain string literal (server cutNotice)", () => {
  it("src/ has no quoted string carrying an unexpanded ${…}", () => {
    const offenders: string[] = [];
    for (const file of tsFiles(SRC)) {
      const hit = findDeadInterpolation(readFileSync(file, "utf-8"));
      if (hit) offenders.push(file.slice(SRC.length + 1) + ":" + hit.line + "  " + hit.text);
    }
    expect(offenders).toEqual([]);
  });
});
