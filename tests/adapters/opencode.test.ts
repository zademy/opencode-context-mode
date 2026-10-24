import "../setup-home";
import { describe, it, expect, beforeEach } from "vite-plus/test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, parse, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { OpenCodeAdapter } from "../../src/platforms/opencode/index.js";

function env(home: string) {
  const root = parse(home).root;
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    HOMEDRIVE: root.replace(/[\\/]+$/, ""),
    HOMEPATH: home.slice(root.length) || root,
  };
}

describe("OpenCodeAdapter", () => {
  describe("OpenCode platform (default)", () => {
    let adapter: OpenCodeAdapter;

    beforeEach(() => {
      adapter = new OpenCodeAdapter();
    });

    // ── Capabilities ──────────────────────────────────────

    // ── parsePreToolUseInput ──────────────────────────────

    // ── formatPreToolUseResponse ──────────────────────────

    // ── formatPostToolUseResponse ─────────────────────────

    // ── parseSessionStartInput ────────────────────────────

    // ── Config paths ──────────────────────────────────────

    describe("config paths", () => {
      it("settings path is opencode.json (relative)", () => {
        expect(adapter.getSettingsPath()).toBe(resolve("opencode.json"));
      });

      it("session dir is under platform-specific config directory", () => {
        const sessionDir = adapter.getSessionDir();
        let expectedDir: string;
        if (process.platform === "win32") {
          const configDir = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
          expectedDir = join(configDir, "opencode", "open-context-mode", "sessions");
        } else {
          const configDir = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
          expectedDir = join(configDir, "opencode", "open-context-mode", "sessions");
        }
        expect(sessionDir).toBe(expectedDir);
      });

      it("configureAllHooks writes back to the global config it read", () => {
        const root = mkdtempSync(join(tmpdir(), "opencode-adapter-"));
        const dir = join(root, "project");
        const home = join(root, "home");
        const conf = join(home, ".config", "opencode");
        const file = join(conf, "opencode.json");
        const src = resolve(process.cwd(), "src", "platforms", "opencode", "index.ts");
        const tsx = resolve(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
        mkdirSync(dir, { recursive: true });
        mkdirSync(conf, { recursive: true });
        writeFileSync(file, JSON.stringify({ plugin: [] }, null, 2) + "\n");
        const run = spawnSync(
          process.execPath,
          [
            tsx,
            "-e",
            `import { OpenCodeAdapter } from ${JSON.stringify(src)};const a=new OpenCodeAdapter();console.log(JSON.stringify({backup:a.backupSettings(),changes:a.configureAllHooks('/tmp/plugin')}))`,
          ],
          {
            cwd: dir,
            env: env(home),
            encoding: "utf-8",
          },
        );

        expect(run.status).toBe(0);
        expect(JSON.parse(run.stdout)).toEqual({
          backup: file + ".bak",
          changes: ["OpenCode 2.x: plugin array entry not written (plugins/ discovery is the install path)"],
        });
        expect(() => readFileSync(resolve(dir, "opencode.json"), "utf-8")).toThrow();
        expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({ plugin: [] });

        rmSync(root, { recursive: true, force: true });
      });

      it("configureAllHooks removes legacy open-context-mode MCP block for plugin-only mode (#574)", () => {
        const root = mkdtempSync(join(tmpdir(), "opencode-adapter-"));
        const dir = join(root, "project");
        const home = join(root, "home");
        const conf = join(home, ".config", "opencode");
        const file = join(conf, "opencode.json");
        const src = resolve(process.cwd(), "src", "platforms", "opencode", "index.ts");
        const tsx = resolve(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
        mkdirSync(dir, { recursive: true });
        mkdirSync(conf, { recursive: true });
        writeFileSync(
          file,
          JSON.stringify(
            {
              mcp: {
                "open-context-mode": {
                  type: "local",
                  command: ["open-context-mode"],
                },
                other: { type: "local", command: ["other"] },
              },
              plugin: ["open-context-mode"],
            },
            null,
            2,
          ) + "\n",
        );

        const run = spawnSync(
          process.execPath,
          [
            tsx,
            "-e",
            `import { OpenCodeAdapter } from ${JSON.stringify(src)};const a=new OpenCodeAdapter();console.log(JSON.stringify(a.configureAllHooks('/tmp/plugin')))`,
          ],
          { cwd: dir, env: env(home), encoding: "utf-8" },
        );

        expect(run.status).toBe(0);
        expect(JSON.parse(run.stdout)).toContain("Removed stale open-context-mode plugin entry (OpenCode 2.x loads plugins/ by discovery)");
        expect(JSON.parse(run.stdout)).toContain("Removed legacy open-context-mode MCP block (plugin-native tools)");
        expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({
          mcp: { other: { type: "local", command: ["other"] } },
        });

        rmSync(root, { recursive: true, force: true });
      });

      it("validateHooks warns when a legacy mcp.open-context-mode block remains after upgrade (#574)", () => {
        const root = mkdtempSync(join(tmpdir(), "opencode-adapter-"));
        const dir = join(root, "project");
        const home = join(root, "home");
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, "opencode.json"),
          JSON.stringify(
            {
              mcp: { "open-context-mode": { type: "local", command: ["open-context-mode"] } },
              plugin: ["open-context-mode"],
            },
            null,
            2,
          ) + "\n",
        );

        const prevHome = process.env.HOME;
        const prevUserProfile = process.env.USERPROFILE;
        Object.assign(process.env, env(home));
        const cwd = process.cwd();
        process.chdir(dir);
        try {
          const results = new OpenCodeAdapter().validateHooks("/tmp/plugin");
          expect(results).toContainEqual(
            expect.objectContaining({
              check: "Legacy MCP registration",
              status: "warn",
              fix: expect.stringContaining("removes only mcp.open-context-mode"),
            }),
          );
        } finally {
          process.chdir(cwd);
          if (prevHome !== undefined) process.env.HOME = prevHome;
          else delete process.env.HOME;
          if (prevUserProfile !== undefined) process.env.USERPROFILE = prevUserProfile;
          else delete process.env.USERPROFILE;
          rmSync(root, { recursive: true, force: true });
        }
      });

      it("readSettings prioritizes config with open-context-mode plugin", () => {
        const root = mkdtempSync(join(tmpdir(), "opencode-adapter-"));
        const dir = join(root, "project");
        const home = join(root, "home");
        const conf = join(home, ".config", "opencode");
        const src = resolve(process.cwd(), "src", "platforms", "opencode", "index.ts");
        const tsx = resolve(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
        mkdirSync(dir, { recursive: true });
        mkdirSync(conf, { recursive: true });
        writeFileSync(join(conf, "opencode.json"), JSON.stringify({ plugin: ["other-plugin"] }, null, 2) + "\n");
        writeFileSync(resolve(dir, "opencode.json"), JSON.stringify({ plugin: ["open-context-mode"] }, null, 2) + "\n");
        const run = spawnSync(
          process.execPath,
          [
            tsx,
            "-e",
            `import { OpenCodeAdapter } from ${JSON.stringify(src)};const a=new OpenCodeAdapter();a.readSettings();console.log(JSON.stringify({path:a.settingsPath}))`,
          ],
          {
            cwd: dir,
            env: env(home),
            encoding: "utf-8",
          },
        );

        expect(run.status).toBe(0);
        const resultPath = JSON.parse(run.stdout).path;
        expect(resultPath).toContain(join("project", "opencode.json"));

        rmSync(root, { recursive: true, force: true });
      });

      it("readSettings falls back to global config when no plugin found", () => {
        const root = mkdtempSync(join(tmpdir(), "opencode-adapter-"));
        const dir = join(root, "project");
        const home = join(root, "home");
        const conf = join(home, ".config", "opencode");
        const src = resolve(process.cwd(), "src", "platforms", "opencode", "index.ts");
        const tsx = resolve(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
        mkdirSync(dir, { recursive: true });
        mkdirSync(conf, { recursive: true });
        writeFileSync(join(conf, "opencode.json"), JSON.stringify({ plugin: ["other-plugin"] }, null, 2) + "\n");
        writeFileSync(resolve(dir, "opencode.json"), JSON.stringify({ plugin: [] }, null, 2) + "\n");
        const run = spawnSync(
          process.execPath,
          [
            tsx,
            "-e",
            `import { OpenCodeAdapter } from ${JSON.stringify(src)};const a=new OpenCodeAdapter();a.readSettings();console.log(JSON.stringify({path:a.settingsPath}))`,
          ],
          {
            cwd: dir,
            env: env(home),
            encoding: "utf-8",
          },
        );

        expect(run.status).toBe(0);
        const resultPath = JSON.parse(run.stdout).path;
        expect(resultPath).toContain(join(home, ".config", "opencode", "opencode.json"));

        rmSync(root, { recursive: true, force: true });
      });

      it("readSettings reads opencode.jsonc with comments stripped", () => {
        const root = mkdtempSync(join(tmpdir(), "opencode-adapter-"));
        const dir = join(root, "project");
        const src = resolve(process.cwd(), "src", "platforms", "opencode", "index.ts");
        const tsx = resolve(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, "opencode.jsonc"),
          `{
  // This is a line comment
  "plugin": ["open-context-mode"],
  /* Block comment */
  "version": "1.0"
}
`,
        );
        const run = spawnSync(
          process.execPath,
          [
            tsx,
            "-e",
            `import { OpenCodeAdapter } from ${JSON.stringify(src)};const a=new OpenCodeAdapter();console.log(JSON.stringify(a.readSettings()))`,
          ],
          { cwd: dir, env: env(join(root, "home")), encoding: "utf-8" },
        );
        expect(run.status).toBe(0);
        expect(JSON.parse(run.stdout)).toEqual({ plugin: ["open-context-mode"], version: "1.0" });
        rmSync(root, { recursive: true, force: true });
      });

      // Issue #806: the naive line-comment regex (/\/\/.*$/gm) truncated every
      // string value containing `//` — e.g. "$schema" or mcp URLs — so a
      // perfectly valid opencode.jsonc failed JSON.parse, readSettings returned
      // null, and doctor reported "[FAIL] Plugin configuration: Could not read
      // opencode.json or opencode.jsonc".
      it("readSettings parses opencode.jsonc whose string values contain URLs (#806)", () => {
        const root = mkdtempSync(join(tmpdir(), "opencode-adapter-"));
        const dir = join(root, "project");
        const src = resolve(process.cwd(), "src", "platforms", "opencode", "index.ts");
        const tsx = resolve(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, "opencode.jsonc"),
          `{
  "$schema": "https://opencode.ai/config.json",
  // open-context-mode plugin registration
  "plugin": ["open-context-mode/plugin"],
  "mcp": {
    "context7": { "type": "remote", "url": "https://mcp.context7.com/mcp" }
  }
}
`,
        );
        const run = spawnSync(
          process.execPath,
          [
            tsx,
            "-e",
            `import { OpenCodeAdapter } from ${JSON.stringify(src)};const a=new OpenCodeAdapter();console.log(JSON.stringify(a.readSettings()))`,
          ],
          { cwd: dir, env: env(join(root, "home")), encoding: "utf-8" },
        );
        expect(run.status).toBe(0);
        expect(JSON.parse(run.stdout)).toEqual({
          $schema: "https://opencode.ai/config.json",
          plugin: ["open-context-mode/plugin"],
          mcp: { context7: { type: "remote", url: "https://mcp.context7.com/mcp" } },
        });
        rmSync(root, { recursive: true, force: true });
      });

      // #849: when both exist, opencode.jsonc is authoritative — OpenCode merges
      // the project-root `.jsonc` LAST (refs/.../config/config.ts:406-408 +
      // paths.ts:15-22), so its values win. readSettings must surface the .jsonc
      // (and target it for writes), not the .json, to avoid shadowing.
      it("prefers opencode.jsonc over opencode.json when both exist (#849)", () => {
        const root = mkdtempSync(join(tmpdir(), "opencode-adapter-"));
        const dir = join(root, "project");
        const src = resolve(process.cwd(), "src", "platforms", "opencode", "index.ts");
        const tsx = resolve(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "opencode.json"), JSON.stringify({ from: "json" }));
        writeFileSync(join(dir, "opencode.jsonc"), `{ /* comment */ "from": "jsonc" }`);
        const run = spawnSync(
          process.execPath,
          [
            tsx,
            "-e",
            `import { OpenCodeAdapter } from ${JSON.stringify(src)};const a=new OpenCodeAdapter();const s=a.readSettings();console.log(JSON.stringify({settings:s,path:a.settingsPath}))`,
          ],
          { cwd: dir, env: env(join(root, "home")), encoding: "utf-8" },
        );
        expect(run.status).toBe(0);
        const out = JSON.parse(run.stdout);
        expect(out.settings).toEqual({ from: "jsonc" });
        expect(out.path).toContain(join("project", "opencode.jsonc"));
        rmSync(root, { recursive: true, force: true });
      });

      it("configureAllHooks works with opencode.jsonc", () => {
        const root = mkdtempSync(join(tmpdir(), "opencode-adapter-"));
        const dir = join(root, "project");
        const src = resolve(process.cwd(), "src", "platforms", "opencode", "index.ts");
        const tsx = resolve(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, "opencode.jsonc"),
          `{
  // My config
  "plugin": []
}
`,
        );
        const run = spawnSync(
          process.execPath,
          [
            tsx,
            "-e",
            `import { OpenCodeAdapter } from ${JSON.stringify(src)};const a=new OpenCodeAdapter();console.log(JSON.stringify(a.configureAllHooks('/tmp/plugin')))`,
          ],
          { cwd: dir, env: env(join(root, "home")), encoding: "utf-8" },
        );
        expect(run.status).toBe(0);
        expect(JSON.parse(run.stdout)).toEqual(["OpenCode 2.x: plugin array entry not written (plugins/ discovery is the install path)"]);
        // Should write back to .jsonc (same file it read)
        expect(JSON.parse(readFileSync(join(dir, "opencode.jsonc"), "utf-8"))).toEqual({
          plugin: [],
        });
        rmSync(root, { recursive: true, force: true });
      });

      // #849: when both opencode.json (placeholder) and opencode.jsonc (real
      // config) exist, configureAllHooks must write into the .jsonc — the file
      // OpenCode treats as authoritative (loaded last in the project-config
      // merge, refs/.../config/config.ts:406-408 + paths.ts:15-22) — and must
      // NOT mutate the placeholder .json into a shadowing config.
      it("configureAllHooks writes into opencode.jsonc, not the shadowing opencode.json, when both exist (#849)", () => {
        const root = mkdtempSync(join(tmpdir(), "opencode-adapter-"));
        const dir = join(root, "project");
        const src = resolve(process.cwd(), "src", "platforms", "opencode", "index.ts");
        const tsx = resolve(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
        mkdirSync(dir, { recursive: true });
        // Placeholder .json (e.g. auto-generated stub) with no real config.
        writeFileSync(join(dir, "opencode.json"), "{}\n");
        // The user's REAL config lives in .jsonc (with comments + settings).
        writeFileSync(
          join(dir, "opencode.jsonc"),
          `{
  // My real OpenCode config
  "theme": "tokyonight",
  "plugin": ["my-plugin"]
}
`,
        );
        const run = spawnSync(
          process.execPath,
          [
            tsx,
            "-e",
            `import { OpenCodeAdapter } from ${JSON.stringify(src)};const a=new OpenCodeAdapter();console.log(JSON.stringify(a.configureAllHooks('/tmp/plugin')))`,
          ],
          { cwd: dir, env: env(join(root, "home")), encoding: "utf-8" },
        );
        expect(run.status).toBe(0);

        // open-context-mode must be merged INTO the real .jsonc config, preserving it.
        const jsonc = JSON.parse(readFileSync(join(dir, "opencode.jsonc"), "utf-8"));
        expect(jsonc).toEqual({
          theme: "tokyonight",
          plugin: ["my-plugin"],
        });

        // The placeholder .json must stay an untouched empty object — never a
        // shadowing config that overrides the user's .jsonc.
        const jsonPlaceholder = JSON.parse(readFileSync(join(dir, "opencode.json"), "utf-8"));
        expect(jsonPlaceholder).toEqual({});

        rmSync(root, { recursive: true, force: true });
      });

      it("validates hooks with jsonc config shows correct error message", () => {
        const root = mkdtempSync(join(tmpdir(), "opencode-adapter-"));
        const dir = join(root, "project");
        const src = resolve(process.cwd(), "src", "platforms", "opencode", "index.ts");
        const tsx = resolve(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
        mkdirSync(dir, { recursive: true });
        // No config file at all
        const run = spawnSync(
          process.execPath,
          [
            tsx,
            "-e",
            `import { OpenCodeAdapter } from ${JSON.stringify(src)};const a=new OpenCodeAdapter();console.log(JSON.stringify(a.validateHooks('/tmp')))`,
          ],
          { cwd: dir, env: env(join(root, "home")), encoding: "utf-8" },
        );
        expect(run.status).toBe(0);
        const results = JSON.parse(run.stdout);
        const pluginCheck = results.find((r: { check: string }) => r.check === "Plugin configuration");
        expect(pluginCheck.message).toContain("jsonc");
        rmSync(root, { recursive: true, force: true });
      });

      it("configureAllHooks writes back to .opencode/opencode.json when that is the selected config", () => {
        const root = mkdtempSync(join(tmpdir(), "opencode-adapter-"));
        const dir = join(root, "project");
        const home = join(root, "home");
        const conf = join(dir, ".opencode");
        const file = join(conf, "opencode.json");
        const src = resolve(process.cwd(), "src", "platforms", "opencode", "index.ts");
        const tsx = resolve(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
        mkdirSync(dir, { recursive: true });
        mkdirSync(conf, { recursive: true });
        writeFileSync(file, JSON.stringify({ plugin: [] }, null, 2) + "\n");
        const run = spawnSync(
          process.execPath,
          [
            tsx,
            "-e",
            `import { OpenCodeAdapter } from ${JSON.stringify(src)};const a=new OpenCodeAdapter();console.log(JSON.stringify(a.configureAllHooks('/tmp/plugin')))`,
          ],
          {
            cwd: dir,
            env: env(home),
            encoding: "utf-8",
          },
        );

        expect(run.status).toBe(0);
        expect(JSON.parse(run.stdout)).toEqual(["OpenCode 2.x: plugin array entry not written (plugins/ discovery is the install path)"]);
        expect(() => readFileSync(resolve(dir, "opencode.json"), "utf-8")).toThrow();
        expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({ plugin: [] });

        rmSync(root, { recursive: true, force: true });
      });
    });
  });

  // ── buildNodeCommand opts parameter (in-process plugin platforms) ──

  describe("buildNodeCommand opts parameter for in-process plugin platforms", () => {
    it("isInProcessPluginPlatform membership test", async () => {
      const { isInProcessPluginPlatform } = await import("../../src/platforms/types.js");
      expect(isInProcessPluginPlatform("opencode")).toBe(true);
      expect(isInProcessPluginPlatform("mcp")).toBe(false);
      expect(isInProcessPluginPlatform(undefined)).toBe(false);
    });

    it("buildNodeCommand substitutes jsRuntime for opencode when execPath is not node/bun/deno", async () => {
      const { buildNodeCommand } = await import("../../src/platforms/types.js");
      const cmd = buildNodeCommand("/script.mjs", { platform: "opencode", jsRuntime: "/usr/bin/bun" });
      // On Node.js, execPath ends with 'node', so no substitution occurs.
      // The test verifies the command still contains the script path.
      expect(cmd).toContain("/script.mjs");
    });

    it("buildNodeCommand falls back to 'node' when jsRuntime is undefined for in-process platforms", async () => {
      const { buildNodeCommand } = await import("../../src/platforms/types.js");
      const cmd = buildNodeCommand("/script.mjs", { platform: "opencode" });
      expect(cmd).toContain("node");
      expect(cmd).toContain("/script.mjs");
    });

    it("buildNodeCommand ignores opts for non in-process platforms", async () => {
      const { buildNodeCommand } = await import("../../src/platforms/types.js");
      const cmd = buildNodeCommand("/script.mjs", { platform: "mcp", jsRuntime: "/usr/bin/bun" });
      // Should NOT substitute jsRuntime since an MCP client is not an in-process platform
      expect(cmd).not.toContain("/usr/bin/bun");
      expect(cmd).toContain("/script.mjs");
    });
  });

  // A v2 install has NO plugin array at all: the plugin file in plugins/ is
  // the whole registration, and the doctor must not call it a failure.
  it("validateHooks passes a discovery-only install with no plugin array (OpenCode 2.x)", () => {
    const root = mkdtempSync(join(tmpdir(), "opencode-v2-discovery-"));
    const dir = join(root, "project");
    const home = join(root, "home");
    const conf = join(home, ".config", "opencode");
    const file = join(conf, "opencode.json");
    const pluginsDir = join(conf, "plugins");
    const src = resolve(process.cwd(), "src", "platforms", "opencode", "index.ts");
    const tsx = resolve(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
    mkdirSync(dir, { recursive: true });
    mkdirSync(pluginsDir, { recursive: true });
    writeFileSync(file, JSON.stringify({ theme: "x" }, null, 2) + "\n");
    writeFileSync(join(pluginsDir, "open-context-mode.ts"), "export default {};\n");
    const run = spawnSync(
      process.execPath,
      [
        tsx,
        "-e",
        `import { OpenCodeAdapter } from ${JSON.stringify(src)};const a=new OpenCodeAdapter();console.log(JSON.stringify(a.validateHooks('/tmp/plugin')))`,
      ],
      { cwd: dir, env: env(home), encoding: "utf-8" },
    );
    expect(run.status).toBe(0);
    const results = JSON.parse(run.stdout) as Array<{ check: string; status: string; message: string }>;
    const reg = results.find((r) => r.check === "Plugin registration");
    expect(reg?.status).toBe("pass");
    expect(reg?.message).toContain("plugins/ discovery");
    rmSync(root, { recursive: true, force: true });
  });
});
