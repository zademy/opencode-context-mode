/**
 * platforms/opencode — OpenCode platform adapter.
 *
 * Implements HookAdapter for OpenCode's TypeScript plugin paradigm.
 *
 * OpenCode hook specifics:
 *   - I/O: TS plugin functions (not JSON stdin/stdout)
 *   - Hook names: tool.execute.before, tool.execute.after, experimental.session.compacting
 *   - Arg modification: output.args mutation
 *   - Blocking: throw Error in tool.execute.before
 *   - Output modification: output.output mutation (TUI bug for bash #13575)
 *   - SessionStart: broken (#14808, no hook #5409)
 *   - Session ID: input.sessionID (camelCase!)
 *   - Project dir: ctx.directory in plugin init (no env var)
 *   - Config: opencode.json plugin array, .opencode/plugins/*.ts
 *   - Session dir: ~/.config/opencode/open-context-mode/sessions/
 */

import { readFileSync, writeFileSync, copyFileSync, accessSync, existsSync, readdirSync, constants } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { homedir } from "node:os";

import { BaseAdapter, resolveContextModeSessionDir } from "../base.js";
import { parseJsonc } from "../../util/jsonc.js";

import type { HookAdapter, DiagnosticResult, HookRegistration, PlatformId } from "../types.js";

// ─────────────────────────────────────────────────────────
// Hook constants (re-exported from hooks.ts)
// ─────────────────────────────────────────────────────────

import { HOOK_TYPES as OPENCODE_HOOK_NAMES } from "./hooks.js";

// ─────────────────────────────────────────────────────────
// Adapter implementation
// ─────────────────────────────────────────────────────────

export type AdapterPlatformType = Extract<PlatformId, "opencode">;

/**
 * OpenCode's config root — XDG_CONFIG_HOME on POSIX, APPDATA on Windows.
 *
 * Every caller needs this, not just the adapter: an MCP client started from
 * anywhere still stores its sessions under OpenCode's config tree, because
 * that is where the user pointed OPEN_CONTEXT_MODE_DATA_DIR's default at.
 */
export function opencodeConfigDir(): string {
  const root =
    process.platform === "win32"
      ? process.env.APPDATA || join(homedir(), "AppData", "Roaming")
      : process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(root, "opencode");
}

export class OpenCodeAdapter extends BaseAdapter implements HookAdapter {
  get name(): string {
    return "OpenCode";
  }
  private settingsPath?: string;

  private platform: AdapterPlatformType;

  constructor(platform: AdapterPlatformType = "opencode") {
    // sessionDirSegments unused — opencode overrides getSessionDir()
    // with XDG_CONFIG_HOME / APPDATA logic
    super([".config", platform]);
    this.platform = platform;
  }

  // ── Configuration ──────────────────────────────────────

  getSettingsPath(): string {
    if (this.settingsPath) return this.settingsPath;
    // Edge case (#849): writeSettings() called without a prior readSettings()
    // (which is what populates this.settingsPath). Never create a `.json` that
    // would shadow an existing `.jsonc` — OpenCode merges the project-root
    // `.jsonc` LAST, so it is the authoritative config
    // (refs/platforms/opencode/packages/opencode/src/config/config.ts:406-408
    // + paths.ts:15-22). Prefer the existing `.jsonc` as the write target.
    const jsoncPath = resolve(`${this.platform}.jsonc`);
    if (existsSync(jsoncPath)) return jsoncPath;
    return resolve(`${this.platform}.json`);
  }

  private paths(): string[] {
    // `.jsonc` is listed BEFORE `.json` so it is selected as the write target
    // when both exist (#849). OpenCode loads the project-root `.json` then
    // `.jsonc` and merges `.jsonc` last — scalars override-last, arrays concat
    // (refs/platforms/opencode/packages/opencode/src/config/config.ts:406-408,
    // 258-260 + paths.ts:15-22). The `.jsonc` is therefore the authoritative
    // file holding the user's real config; a `.json` is often an empty/auto-
    // generated placeholder. Writing into the placeholder would create a
    // file that shadows the user's real `.jsonc`. Preferring `.jsonc` for the
    // write target avoids that silent config destruction. Read order is
    // irrelevant for the plugin early-return (hasContextModePlugin) path.
    return [
      resolve("opencode.jsonc"),
      resolve("opencode.json"),
      resolve(".opencode", "opencode.jsonc"),
      resolve(".opencode", "opencode.json"),
      join(homedir(), ".config", "opencode", "opencode.jsonc"),
      join(homedir(), ".config", "opencode", "opencode.json"),
    ];
  }

  getSessionDir(): string {
    // Issue #649: honor OPEN_CONTEXT_MODE_DATA_DIR universal storage override
    // ahead of OpenCode/Kilo's XDG-rooted default. opencode.json + plugin
    // discovery stay under getConfigDir() so OpenCode itself sees its own
    // config in the expected location.
    return resolveContextModeSessionDir(this.getConfigDir());
  }

  /**
   * OpenCode/KiloCode honor XDG_CONFIG_HOME on POSIX and APPDATA on Windows.
   * Falls back to ~/.config/<platform> (or %APPDATA%\<platform>).
   * Always absolute. `_projectDir` is accepted for interface symmetry but
   * unused — config is home/XDG-rooted, never project-scoped.
   */
  getConfigDir(_projectDir?: string): string {
    return opencodeConfigDir();
  }

  getInstructionFiles(): string[] {
    return ["AGENTS.md"];
  }

  generateHookConfig(_pluginRoot: string): HookRegistration {
    // OpenCode uses TS plugin paradigm — hooks are registered via plugin array
    // in opencode.json, not via command-based hook entries.
    // Return the hook name mapping for documentation purposes.
    return {
      [OPENCODE_HOOK_NAMES.BEFORE]: [
        {
          matcher: "",
          hooks: [
            {
              type: "plugin",
              command: "open-context-mode",
            },
          ],
        },
      ],
      [OPENCODE_HOOK_NAMES.AFTER]: [
        {
          matcher: "",
          hooks: [
            {
              type: "plugin",
              command: "open-context-mode",
            },
          ],
        },
      ],
      [OPENCODE_HOOK_NAMES.COMPACTING]: [
        {
          matcher: "",
          hooks: [
            {
              type: "plugin",
              command: "open-context-mode",
            },
          ],
        },
      ],
    };
  }

  readSettings(): Record<string, unknown> | null {
    this.settingsPath = undefined;
    const configPaths = this.paths();
    const globalPaths = new Set(configPaths.filter((p) => p.includes(homedir())));
    let firstValidSettings: Record<string, unknown> | null = null;
    let firstValidPath: string | undefined;

    for (const configPath of configPaths) {
      try {
        const raw = readFileSync(configPath, "utf-8");
        // OpenCode V2 writes opencode.json itself (plugin installs append npm
        // specifiers to the `plugins` array) and its loader is JSONC-tolerant,
        // so the on-disk file can carry trailing commas that strict JSON.parse
        // rejects — every v2 install then reads as "Could not read opencode.json"
        // in doctor. parseJsonc tries strict JSON first, then retries with
        // comment/trailing-comma stripping (#787).
        const settings = parseJsonc<Record<string, unknown>>(raw);
        if (!settings) continue;

        if (!firstValidSettings) {
          firstValidSettings = settings;
          firstValidPath = configPath;
        }

        const isGlobalConfig = globalPaths.has(configPath);

        if (this.hasContextModePlugin(settings) || isGlobalConfig) {
          this.settingsPath = configPath;
          return settings;
        }
      } catch {
        continue;
      }
    }

    if (firstValidSettings) {
      this.settingsPath = firstValidPath;
      return firstValidSettings;
    }
    return null;
  }

  writeSettings(settings: Record<string, unknown>): void {
    // Write to opencode.json(c)/kilo.json(c) in current directory
    writeFileSync(this.getSettingsPath(), JSON.stringify(settings, null, 2) + "\n", "utf-8");
  }

  // ── Diagnostics (doctor) ─────────────────────────────────

  validateHooks(_pluginRoot: string): DiagnosticResult[] {
    const results: DiagnosticResult[] = [];
    const settings = this.readSettings();

    if (!settings) {
      results.push({
        check: "Plugin configuration",
        status: "fail",
        message: `Could not read ${this.platform}.json or ${this.platform}.jsonc`,
        fix: "npm install (reinstall the plugin to reconfigure hooks)",
      });
      return results;
    }

    // Check for "open-context-mode" in plugin array
    const hasPlugin = this.hasContextModePlugin(settings);
    if (Array.isArray(settings.plugin) || Array.isArray(settings.plugins)) {
      results.push({
        check: "Plugin registration",
        status: hasPlugin ? "pass" : "fail",
        message: hasPlugin
          ? "open-context-mode registered (config entry or plugins/ discovery)"
          : "open-context-mode not found in plugin array nor plugins/ directory",
        fix: hasPlugin ? undefined : "npm install (reinstall the plugin to reconfigure hooks)",
      });
    } else if (hasPlugin) {
      // OpenCode 2.x installs by plugins/ discovery and needs no plugin
      // array at all — a missing array with a discovered plugin file is a
      // healthy v2 install, not a failure.
      results.push({
        check: "Plugin registration",
        status: "pass",
        message: "open-context-mode registered (plugins/ discovery — no plugin array on OpenCode 2.x)",
      });
    } else {
      results.push({
        check: "Plugin registration",
        status: "fail",
        message: `No plugin array found in ${this.platform}.json or ${this.platform}.jsonc`,
        fix: "npm install (reinstall the plugin to reconfigure hooks)",
      });
    }

    if (this.hasLegacyContextModeMcp(settings)) {
      results.push({
        check: "Legacy MCP registration",
        status: "warn",
        message: "mcp.open-context-mode is redundant: open_ctx_* tools are now provided by the plugin",
        fix: "npm install (reinstall the plugin to reconfigure hooks) (removes only mcp.open-context-mode; preserves other MCP servers)",
      });
    }

    // Note: SessionStart handled via experimental.chat.system.transform surrogate
    results.push({
      check: "SessionStart hook",
      status: "pass",
      message: `SessionStart via experimental.chat.system.transform surrogate (native hook pending #14808, #5409)`,
    });

    return results;
  }

  checkPluginRegistration(): DiagnosticResult {
    const settings = this.readSettings();
    if (!settings) {
      return {
        check: "Plugin registration",
        status: "warn",
        message: `Could not read ${this.platform}.json or ${this.platform}.jsonc`,
      };
    }

    if (this.hasContextModePlugin(settings)) {
      return {
        check: "Plugin registration",
        status: "pass",
        message: "open-context-mode found in plugin/plugins array",
      };
    }

    return {
      check: "Plugin registration",
      status: "fail",
      message: `open-context-mode not found in ${this.platform}.json(c) plugin/plugins array`,
      fix: "npm install (reinstall the plugin to reconfigure hooks)",
    };
  }

  getInstalledVersion(): string {
    // Check ~/.cache/opencode/node_modules/ for open-context-mode
    try {
      const pkgPath = resolve(homedir(), ".cache", this.platform, "node_modules", "open-context-mode", "package.json");
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      if (typeof pkg.version === "string") return pkg.version;
    } catch {
      /* not found */
    }
    return "not installed";
  }

  // ── Upgrade ────────────────────────────────────────────

  configureAllHooks(_pluginRoot: string): string[] {
    const settings = this.readSettings() ?? {};
    const changes: string[] = [];

    // OpenCode 2.x does not read the plugin array the way v1 did: the key
    // resolves npm specifiers only, so a "open-context-mode" entry makes opencode
    // install the UNPORTED upstream package from npm, and local plugins
    // load by discovery from <config>/plugins/ instead. Writing the entry
    // on upgrade would reintroduce a broken install on every machine.
    // KiloCode still runs the v1 API and reads the array, so it keeps the
    // legacy write until the kilo decision lands.
    if (this.platform === "opencode") {
      const plugins = (settings.plugin ?? []) as string[];
      const withoutUs = plugins.filter((p) => !p.includes("open-context-mode"));
      if (withoutUs.length !== plugins.length) {
        if (withoutUs.length === 0) delete settings.plugin;
        else settings.plugin = withoutUs;
        changes.push("Removed stale open-context-mode plugin entry (OpenCode 2.x loads plugins/ by discovery)");
      } else {
        changes.push("OpenCode 2.x: plugin array entry not written (plugins/ discovery is the install path)");
      }
    } else {
      const plugins = (settings.plugin ?? []) as string[];
      if (!plugins.some((p) => p.includes("open-context-mode"))) {
        plugins.push("open-context-mode");
        changes.push("Added open-context-mode to plugin array");
      } else {
        changes.push("open-context-mode already in plugin array");
      }

      settings.plugin = plugins;
    }

    const mcp = settings.mcp;
    if (mcp && typeof mcp === "object" && !Array.isArray(mcp)) {
      const servers = mcp as Record<string, unknown>;
      if (Object.prototype.hasOwnProperty.call(servers, "open-context-mode")) {
        delete servers["open-context-mode"];
        changes.push("Removed legacy open-context-mode MCP block (plugin-native tools)");
      }
      if (Object.keys(servers).length === 0) delete settings.mcp;
    }

    this.writeSettings(settings);
    return changes;
  }

  backupSettings(): string | null {
    const check = this.checkPluginRegistration();

    if (!this.settingsPath) return null;

    if (check.status === "pass") {
      return this.settingsPath;
    } else {
      try {
        accessSync(this.settingsPath, constants.R_OK);
        const backupPath = this.settingsPath + ".bak";
        copyFileSync(this.settingsPath, backupPath);
        return backupPath;
      } catch {
        return null;
      }
    }
  }

  setHookPermissions(_pluginRoot: string): string[] {
    // OpenCode uses TS plugin paradigm — no shell scripts to chmod
    return [];
  }

  updatePluginRegistry(_pluginRoot: string, _version: string): void {
    // OpenCode manages plugins through npm/opencode.json — no separate registry
  }

  // ── Internal helpers ───────────────────────────────────

  /**
   * Check whether a settings object has the open-context-mode plugin registered.
   */
  private hasContextModePlugin(settings: Record<string, unknown>): boolean {
    // Two config shapes exist (V2 schema accepts both, #55524): V1/KiloCode
    // uses `plugin`, OpenCode V2 uses `plugins` with npm specifiers
    // ("open-context-mode@latest"). Accept either key so a healthy v2
    // npm-specifier install is not reported as "not registered".
    for (const key of ["plugin", "plugins"] as const) {
      const entries = settings[key];
      if (Array.isArray(entries) && entries.some((p: unknown) => typeof p === "string" && p.includes("open-context-mode"))) {
        return true;
      }
    }
    // OpenCode 2.x resolves `plugin` config entries as npm specifiers only —
    // a filesystem path there is ignored without an error. Local plugins load
    // by DISCOVERY from <config-dir>/plugins/ and <project>/.opencode/plugins/,
    // so a config-only check reports a false negative for every v2 install.
    return this.hasDiscoveredContextModePlugin();
  }

  /** True when a open-context-mode plugin file sits in a discovery directory. */
  private hasDiscoveredContextModePlugin(): boolean {
    const dirs = new Set<string>();
    if (this.settingsPath) {
      dirs.add(join(dirname(this.settingsPath), "plugins"));
    }
    dirs.add(join(homedir(), ".config", this.platform, "plugins"));
    dirs.add(join(process.cwd(), ".opencode", "plugins"));

    for (const dir of dirs) {
      try {
        if (readdirSync(dir).some((name) => name.includes("context-mode"))) {
          return true;
        }
      } catch {
        continue; // directory absent — not an error
      }
    }
    return false;
  }

  private hasLegacyContextModeMcp(settings: Record<string, unknown>): boolean {
    const mcp = settings.mcp;
    return !!(mcp && typeof mcp === "object" && !Array.isArray(mcp) && Object.prototype.hasOwnProperty.call(mcp, "open-context-mode"));
  }
}
