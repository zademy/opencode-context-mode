import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * "Is a cache-heal hook already registered?" must recognise a wrapper (#1049).
 *
 * start.mjs appends the SessionStart cache-heal hook when this check says no.
 * The check used to substring-match the full package-scoped script name, so a
 * wrapper that runs the same script (`bash "$HOME/.claude/hooks/cache-heal.sh"`)
 * read as "absent" — and the append put a second, absolute-path hook into the
 * user's settings.json, reappearing right after the user deleted it.
 *
 * The registration check matches the naming stem. The self-heal predicate in
 * hooks/cache-heal-utils.mjs deliberately does NOT: it rewrites whatever it
 * matches, and clobbering someone's wrapper is worse than missing a stale node
 * path inside it. Both halves are pinned here so neither drifts.
 */

const START_MJS = readFileSync(fileURLToPath(new URL("../start.mjs", import.meta.url)), "utf8");
const HEAL_UTILS = readFileSync(fileURLToPath(new URL("../hooks/cache-heal-utils.mjs", import.meta.url)), "utf8");

const registration = START_MJS.match(/const alreadyRegistered[\s\S]{0,320}?\);/);
const selfHeal = HEAL_UTILS.match(/for \(const h of inner\)[\s\S]{0,320}?continue;\n\s*if \(!isStaleNodePath/);

describe("cache-heal hook recognition (#1049)", () => {
  it("the registration check matches the stem, not the full script name", () => {
    expect(registration, "alreadyRegistered check not found in start.mjs").not.toBeNull();
    expect(registration![0]).toContain("cache[-_]?heal");
    expect(registration![0]).not.toContain('includes("open-context-mode-cache-heal")');
  });

  it("the self-heal keeps the narrow match — it rewrites what it matches", () => {
    expect(selfHeal, "self-heal predicate not found in cache-heal-utils.mjs").not.toBeNull();
    expect(selfHeal![0]).toMatch(/open-context-mode-cache-heal/);
  });
});
