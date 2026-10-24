import "../setup-home";
import { describe, it, expect } from "vite-plus/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Slice 5 — server.ts open_ctx_search timeline mode.
 *
 * A static guard against the original bug (#367 follow-ups): timeline mode used
 * to open the unsuffixed db while the snapshot/extract hooks write the one with
 * the worktree suffix, so the timeline silently saw an empty database.
 */
const SERVER_SRC = readFileSync(resolve(__dirname, "../../src/server.ts"), "utf-8");

describe("open_ctx_search timeline mode wiring (server.ts)", () => {
  it("opens SessionDB via resolveSessionDbPath (worktree suffix + casing migration)", () => {
    expect(SERVER_SRC).toMatch(/resolveSessionDbPath\(\{\s*projectDir\s*,\s*sessionsDir\s*\}\)/);
  });

  it("derives configDir from OpenCode's config dir, not a hardcoded ~/.claude", () => {
    expect(SERVER_SRC).toMatch(/const configDir = opencodeConfigDir\(\)/);
  });
});
