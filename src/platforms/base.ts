/**
 * BaseAdapter — shared implementation for methods identical across all adapters.
 *
 * Each concrete adapter extends this and provides platform-specific logic.
 *
 * Shared methods:
 *   - getSessionDir()       — builds session dir from sessionDirSegments
 *   - backupSettings()      — copies settings file to .bak
 *
 * Adapters with custom logic override the relevant method:
 *   - vscode-copilot: overrides getSessionDir (checks .github dir)
 *   - opencode: overrides getSessionDir (XDG_CONFIG_HOME / APPDATA)
 *              and backupSettings (calls checkPluginRegistration first)
 *   - openclaw: overrides backupSettings (searches 3 config paths)
 *
 * NOTE — C2 narrowing (2026-05): `getSessionDBPath` and `getSessionEventsPath`
 * were removed. Both were SHALLOW pure derivatives of `getSessionDir() +
 * projectDir` (interface complexity == implementation complexity). All
 * adapter-storage path computation now flows through ONE site:
 * `resolveSessionDbPath({ projectDir, sessionsDir: adapter.getSessionDir() })`
 * in `src/session/db.ts`. Adapters expose only `getSessionDir()` for
 * storage-related path concerns.
 *
 * Issue #649 — `OPEN_CONTEXT_MODE_DATA_DIR` universal storage override. Many
 * adapters (Pi, OMP, Gemini CLI, Codex, Cursor, …) had storage hardcoded to
 * `~/.<platform>/open-context-mode/sessions/` with no env-var escape hatch. CI
 * runners on NFS homes, dev containers, and shared-workspace setups need to
 * point open-context-mode storage at a writable volume without patching source or
 * abusing the host platform's own config-dir variable. The override applies
 * only to open-context-mode-owned state (`getSessionDir`, `getMemoryDir`) — never
 * to platform-native config (`getConfigDir`, `getSettingsPath`), which must
 * stay where the host platform's own tooling expects it. Adapters that
 * override `getSessionDir`/`getMemoryDir` directly (claude-code, codex,
 * opencode, vscode-copilot) honor the override by routing through
 * `resolveContextModeDataRoot()` at the top of their override.
 */

import { join } from "node:path";
import { accessSync, copyFileSync, constants, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { hashProjectDirCanonical } from "../session/db.js";
import { resolveTildePath } from "./shared/paths.js";

/**
 * Universal storage-root override. Returns the resolved absolute path when
 * `OPEN_CONTEXT_MODE_DATA_DIR` is set to a non-blank value, otherwise `null` so
 * callers fall back to their platform-native default.
 *
 * Mirrors the `resolveClaudeConfigDir` contract for env-var handling
 * (whitespace guard, tilde expansion, relative-path resolution) so users
 * get one consistent set of rules across every override site.
 */
export function resolveContextModeDataRoot(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.OPEN_CONTEXT_MODE_DATA_DIR;
  if (!raw || raw.trim() === "") return null;
  return resolveTildePath(raw);
}

/**
 * Context-mode-owned session dir: `<DATA_DIR>/open-context-mode/sessions` when the
 * #649 override is set, else `<platformRoot>/open-context-mode/sessions`. The ONE
 * shared implementation of the override idiom every getSessionDir override
 * uses — adapters pass their platform-native root (usually
 * `this.getConfigDir()`); BaseAdapter passes its home-joined segments.
 */
export function resolveContextModeSessionDir(platformRoot: string): string {
  const dir = join(resolveContextModeDataRoot() ?? platformRoot, "open-context-mode", "sessions");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Context-mode-owned memory dir: `<DATA_DIR>/open-context-mode/<folder>` under the
 * #649 override, else `<platformRoot>/<folder>` (`"memory"`, or `"memories"`
 * for codex). With `projectDir`, scoped by its canonical hash (#663) so
 * parallel projects never share auto-memory contents.
 */
export function resolveContextModeMemoryDir(platformRoot: string, folder: string, projectDir?: string): string {
  const override = resolveContextModeDataRoot();
  const base = override ? join(override, "open-context-mode", folder) : join(platformRoot, folder);
  if (!projectDir) return base;
  return join(base, hashProjectDirCanonical(projectDir));
}

export abstract class BaseAdapter {
  constructor(protected readonly sessionDirSegments: string[]) {}

  getSessionDir(): string {
    // Deliberately home-joined, NOT this.getConfigDir(): several adapters
    // (cursor, jetbrains-copilot, openclaw) override getConfigDir() to a
    // project-scoped platform-config location while inheriting this
    // home-rooted session storage.
    return resolveContextModeSessionDir(join(homedir(), ...this.sessionDirSegments));
  }

  /**
   * Default: build config dir from sessionDirSegments rooted at $HOME.
   *
   * Contract: ALWAYS returns an absolute path. Adapters with project-scoped
   * or non-home-rooted config dirs (cursor, vscode-copilot, jetbrains-copilot,
   * openclaw, opencode) override this and resolve their segments against
   * `projectDir` (or `process.cwd()` when omitted).
   *
   * NOT relocated by `OPEN_CONTEXT_MODE_DATA_DIR` (#649). The platform owns its
   * settings.json / hooks.json / config.toml location — relocating that
   * would silently fork platform behaviour from the platform's own tooling.
   * Use `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `XDG_CONFIG_HOME`, etc. to move
   * platform-native config; use `OPEN_CONTEXT_MODE_DATA_DIR` to move open-context-mode
   * storage independently.
   *
   * @param _projectDir Unused by the home-rooted default — accepted so
   *                    project-scoped overrides honor the same signature.
   */
  getConfigDir(_projectDir?: string): string {
    return join(homedir(), ...this.sessionDirSegments);
  }

  /**
   * Default: Claude Code convention. Most adapters override with their
   * own platform-specific instruction file name (AGENTS.md, GEMINI.md, ...).
   */
  getInstructionFiles(): string[] {
    return ["CLAUDE.md"];
  }

  /**
   * Default: <configDir>/memory/<projectHash>. Always absolute (configDir is
   * absolute by contract). Adapters with a different memory dir name (e.g.,
   * codex uses "memories" plural) override this.
   *
   * Issue #649: when `OPEN_CONTEXT_MODE_DATA_DIR` is set, memory follows storage
   * to `<DATA_DIR>/open-context-mode/memory/` since persistent memory is
   * open-context-mode-owned state, not platform-native config.
   *
   * Issue #663: when `projectDir` is supplied the path is scoped via
   * `hashProjectDirCanonical(projectDir)` so two projects running in
   * parallel never share auto-memory contents. When omitted (legacy
   * callers), the unscoped path is returned for backwards compatibility.
   */
  getMemoryDir(projectDir?: string): string {
    return resolveContextModeMemoryDir(this.getConfigDir(), "memory", projectDir);
  }

  backupSettings(): string | null {
    const settingsPath = this.getSettingsPath();
    try {
      accessSync(settingsPath, constants.R_OK);
      return this.backupFile(settingsPath);
    } catch {
      return null;
    }
  }

  /**
   * Copy `filePath` to `<path>.bak` (or `<path><suffix>-<timestamp>.bak` with
   * a suffix, for pre-write quarantine of malformed files). Shared by
   * backupSettings and the codex/kimi `.broken`-backup flows.
   */
  protected backupFile(filePath: string, suffix = ""): string {
    const backupPath = suffix ? `${filePath}${suffix}-${new Date().toISOString().replace(/[:.]/g, "-")}.bak` : `${filePath}.bak`;
    copyFileSync(filePath, backupPath);
    return backupPath;
  }

  abstract getSettingsPath(): string;
}
