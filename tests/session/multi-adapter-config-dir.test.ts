/**
 * enumerateAdapterDirs — one storage tree, and only the `home` override that
 * relocates it. The multi-adapter rows are gone with the integrations; what
 * must not regress is the path itself.
 */
import { describe, expect, test } from "vitest";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { opencodeConfigDir } from "../../src/platforms/opencode/index.js";
import { enumerateAdapterDirs } from "../../src/session/analytics-query.js";

describe("enumerateAdapterDirs", () => {
  test("returns exactly one row — every client writes under OpenCode's tree", () => {
    const dirs = enumerateAdapterDirs();
    expect(dirs).toHaveLength(1);
    expect(dirs[0].name).toBe("opencode");
  });

  test("resolves under the OpenCode config dir, without doubling the segments", () => {
    const dir = enumerateAdapterDirs()[0];
    expect(dir.sessionsDir).toBe(join(opencodeConfigDir(), "open-context-mode", "sessions"));
    expect(dir.contentDir).toBe(join(opencodeConfigDir(), "open-context-mode", "content"));
    // The regression this guards: joining the <config>/opencode segments onto a
    // root that already ends there produced <config>/opencode/.config/opencode.
    expect(dir.sessionsDir).not.toContain(join(".config", "opencode", ".config"));
  });

  test("an explicit home override relocates the whole tree", () => {
    const dir = enumerateAdapterDirs({ home: tmpdir() })[0];
    expect(dir.sessionsDir).toBe(resolve(tmpdir(), ".config", "opencode", "open-context-mode", "sessions"));
  });

  test("defaults to the profile root when no override is passed", () => {
    expect(enumerateAdapterDirs({ home: homedir() })[0].sessionsDir).toContain(homedir());
  });
});
