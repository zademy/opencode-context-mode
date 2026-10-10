import "../setup-home";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { searchAutoMemory } from "../../src/search/auto-memory.js";
import { hashProjectDirCanonical } from "../../src/session/db.js";

/**
 * With no adapter and no explicit configDir, auto-memory falls back to the one
 * tree that exists: OpenCode's config dir (XDG_CONFIG_HOME aware), scoped by a
 * project hash so two projects can't read each other's notes.
 */
describe("searchAutoMemory adapterless fallback", () => {
  let projectDir: string;
  let configHome: string;
  let savedXdg: string | undefined;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "ctxam-proj-"));
    configHome = mkdtempSync(join(tmpdir(), "ctxam-cfg-"));
    savedXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = configHome;
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(configHome, { recursive: true, force: true });
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdg;
  });

  it("reads <xdg>/opencode/memory/<projectHash>", () => {
    const memDir = join(configHome, "opencode", "memory", hashProjectDirCanonical(projectDir));
    mkdirSync(memDir, { recursive: true });
    writeFileSync(join(memDir, "decisions.md"), "# Decisions\n- SCOPED-MARKER: scoped to this project.\n", "utf-8");

    const results = searchAutoMemory(["SCOPED-MARKER"], 5, projectDir);
    expect(results.map((r) => r.content).join("\n")).toContain("SCOPED-MARKER");
  });

  it("does not read the unscoped <xdg>/opencode/memory path", () => {
    const unscoped = join(configHome, "opencode", "memory");
    mkdirSync(unscoped, { recursive: true });
    writeFileSync(join(unscoped, "decisions.md"), "# Decisions\n- UNSCOPED-LEAK-CANARY: must not surface.\n", "utf-8");

    expect(searchAutoMemory(["UNSCOPED-LEAK-CANARY"], 5, projectDir)).toEqual([]);
  });
});
