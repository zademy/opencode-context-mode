/**
 * #1005 — the normalize-hooks ratchet must survive Claude Code's version-dir copy.
 *
 * The report: on macOS with bun installed, `open-context-mode upgrade` opens the
 * Windows-only normalization (the gate is `platform !== win32/linux AND
 * !(jsRuntimePath && jsRuntimePath !== nodePath)`), so the NEW version dir's
 * hooks.json gets absolute paths. The reporter then observed those paths
 * resolving into the PREVIOUS version dir.
 *
 * That last step is the part worth pinning. Claude Code's plugin manager
 * COPIES a version dir forward on auto-update (#604), so a hooks.json that
 * names version N can end up living inside version N+1. The ratchet in
 * `normalizeHooksJson` exists for exactly that: `hasStaleCacheVersionSegment`
 * compares every `open-context-mode/open-context-mode/<version>` segment against the
 * pluginRoot's own version and re-points it.
 *
 * These tests run the real hooks/normalize-hooks.mjs against a synthetic
 * two-version cache tree on the darwin+bun configuration from the report.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, test } from "vitest";

// @ts-expect-error — untyped hooks/*.mjs, same import the plugin uses
import { normalizeHooksJson, normalizeHooksJsonOnly, needsHookNormalization } from "../../hooks/normalize-hooks.mjs";

const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const fn of cleanups) {
    try {
      fn();
    } catch {
      /* ignore */
    }
  }
});

const OLD_V = "1.0.169";
const NEW_V = "1.0.170";

/** A `<cache>/<marketplace>/<plugin>/<version>` tree, matching CC's layout. */
function versionDir(v: string): string {
  const base = mkdtempSync(join(tmpdir(), "cm-hooks-"));
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, "plugins", "cache", "open-context-mode", "open-context-mode", v);
  mkdirSync(join(root, "hooks"), { recursive: true });
  return root;
}

const SHIPPED = JSON.stringify(
  {
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/sessionstart.mjs"' }] }],
      PreToolUse: [{ hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/pretooluse.mjs"' }] }],
    },
  },
  null,
  2,
);

describe("#1005 the version ratchet re-points a carried-forward hooks.json", () => {
  test("a hooks.json carrying the OLD version is detected as needing normalization", () => {
    const root = versionDir(NEW_V);
    // Simulate CC copying 1.0.169/hooks/hooks.json into 1.0.170/ verbatim.
    const frozen = JSON.stringify(
      {
        hooks: {
          SessionStart: [
            {
              hooks: [
                {
                  type: "command",
                  command: `"/usr/local/bin/bun" "/home/u/.claude/plugins/cache/open-context-mode/open-context-mode/${OLD_V}/hooks/sessionstart.mjs"`,
                },
              ],
            },
          ],
        },
      },
      null,
      2,
    );
    expect(needsHookNormalization(frozen, root)).toBe(true);
  });

  test("normalizeHooksJson rewrites the OLD version segment to the NEW one", () => {
    const root = versionDir(NEW_V);
    const frozen = JSON.stringify(
      {
        hooks: {
          SessionStart: [
            {
              hooks: [
                {
                  type: "command",
                  command: `"/usr/local/bin/bun" "/home/u/.claude/plugins/cache/open-context-mode/open-context-mode/${OLD_V}/hooks/sessionstart.mjs"`,
                },
              ],
            },
          ],
          PreToolUse: [
            {
              hooks: [
                {
                  type: "command",
                  command: `"/usr/local/bin/bun" "/home/u/.claude/plugins/cache/open-context-mode/open-context-mode/${OLD_V}/hooks/pretooluse.mjs"`,
                },
              ],
            },
          ],
        },
      },
      null,
      2,
    );

    const healed = normalizeHooksJson(frozen, "/usr/local/bin/bun", root);
    const parsed = JSON.parse(healed);
    for (const event of ["SessionStart", "PreToolUse"]) {
      expect(parsed.hooks[event][0].hooks[0].command).not.toContain(`/${OLD_V}/`);
      expect(parsed.hooks[event][0].hooks[0].command).toContain(`/${NEW_V}/`);
    }
  });

  test("idempotent: a hooks.json already on the current version is left alone", () => {
    const root = versionDir(NEW_V);
    const current = JSON.stringify(
      {
        hooks: {
          SessionStart: [
            {
              hooks: [
                {
                  type: "command",
                  command: `"/usr/local/bin/bun" "/home/u/.claude/plugins/cache/open-context-mode/open-context-mode/${NEW_V}/hooks/sessionstart.mjs"`,
                },
              ],
            },
          ],
        },
      },
      null,
      2,
    );
    expect(needsHookNormalization(current, root)).toBe(false);
    expect(normalizeHooksJson(current, "/usr/local/bin/bun", root)).toBe(current);
  });
});

describe("#1005 darwin + bun: the gate opens, and the ratchet still holds", () => {
  test("on darwin with a distinct bun path, normalization runs (this is the #738 gate)", () => {
    const root = versionDir(NEW_V);
    writeFileSync(join(root, "hooks", "hooks.json"), SHIPPED, "utf-8");

    normalizeHooksJsonOnly({
      pluginRoot: root,
      nodePath: "/usr/local/bin/node",
      jsRuntimePath: "/home/u/.bun/bin/bun", // != nodePath → hasBunSwap
      platform: "darwin",
    });

    const written = JSON.parse(readFileSync(join(root, "hooks", "hooks.json"), "utf-8"));
    const cmd = written.hooks.SessionStart[0].hooks[0].command;
    // Placeholder resolved, bun used, and the path names THIS version dir.
    expect(cmd).not.toContain("CLAUDE_PLUGIN_ROOT");
    expect(cmd).toContain("/home/u/.bun/bin/bun");
    expect(cmd.replace(/\\/g, "/")).toContain(`/${NEW_V}/hooks/sessionstart.mjs`);
  });

  test("the next boot inside the new dir heals a version carried forward from the old one", () => {
    const root = versionDir(NEW_V);
    // The file CC copied forward: absolute paths naming the PREVIOUS version.
    writeFileSync(
      join(root, "hooks", "hooks.json"),
      JSON.stringify(
        {
          hooks: {
            SessionStart: [
              {
                hooks: [
                  {
                    type: "command",
                    command: `"/home/u/.bun/bin/bun" "/home/u/.claude/plugins/cache/open-context-mode/open-context-mode/${OLD_V}/hooks/sessionstart.mjs"`,
                  },
                ],
              },
            ],
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    normalizeHooksJsonOnly({
      pluginRoot: root,
      nodePath: "/usr/local/bin/node",
      jsRuntimePath: "/home/u/.bun/bin/bun",
      platform: "darwin",
    });

    const healed = JSON.parse(readFileSync(join(root, "hooks", "hooks.json"), "utf-8"));
    expect(healed.hooks.SessionStart[0].hooks[0].command).toContain(`/${NEW_V}/hooks/sessionstart.mjs`);
    expect(healed.hooks.SessionStart[0].hooks[0].command).not.toContain(`/${OLD_V}/`);
  });

  test("a non-cache layout (npm global / dev checkout) is left as shipped", () => {
    // pluginRootVersion() returns null → no stale check possible → the file
    // must not be rewritten with absolute paths it cannot keep fresh.
    const base = mkdtempSync(join(tmpdir(), "cm-hooks-dev-"));
    cleanups.push(() => rmSync(base, { recursive: true, force: true }));
    const root = join(base, "open-context-mode");
    mkdirSync(join(root, "hooks"), { recursive: true });
    writeFileSync(join(root, "hooks", "hooks.json"), SHIPPED, "utf-8");

    normalizeHooksJsonOnly({
      pluginRoot: root,
      nodePath: "/usr/local/bin/node",
      jsRuntimePath: undefined,
      platform: "darwin",
    });

    // No bun → the darwin gate stays shut, placeholder preserved.
    expect(readFileSync(join(root, "hooks", "hooks.json"), "utf-8")).toBe(SHIPPED);
  });
});
