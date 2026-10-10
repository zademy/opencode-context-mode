/**
 * platforms/types — Platform adapter interface for multi-platform hook support.
 *
 * Defines the contract that each platform adapter must implement.
 * Three paradigms exist across supported platforms:
 *   A) JSON stdin/stdout — Claude Code, Gemini/Qwen family CLIs, Copilot/Codex/Kimi,
 *      Cursor, Kiro, Antigravity CLI (`agy`)
 *   B) TS Plugin Functions — OpenCode, KiloCode, OpenClaw
 *   C) MCP-only (no hooks) — Antigravity IDE, Zed, Pi/OMP MCP-only paths
 *
 * The MCP server layer is 100% portable and needs no adapter.
 * Only the hook layer requires platform-specific adapters.
 */

// ─────────────────────────────────────────────────────────
// Hook paradigm
// ─────────────────────────────────────────────────────────

import { resolveHookRuntime } from "../runtime.js";

// ─────────────────────────────────────────────────────────
// Hook config types
// ─────────────────────────────────────────────────────────

/** A single hook entry in platform configuration. */
export interface HookEntry {
  /** Tool matcher pattern (empty = match all). */
  matcher: string;
  /** Hook commands/handlers to execute. */
  hooks: Array<{
    type: string;
    command: string;
  }>;
}

/** Hook registration map — maps hook types to their entries. */
export type HookRegistration = Record<string, HookEntry[]>;

// ─────────────────────────────────────────────────────────
// Adapter interface
// ─────────────────────────────────────────────────────────

/**
 * HookAdapter — contract for platform-specific hook implementations.
 *
 * Each supported platform (Claude Code, Gemini CLI, OpenCode, etc.)
 * provides an adapter that normalizes its hook I/O into a common format.
 */
export interface HookAdapter {
  /** Human-readable platform name (e.g., "Claude Code", "Gemini CLI"). */
  readonly name: string;

  // ── Configuration ──────────────────────────────────────

  /** Path to the platform's settings file (e.g., ~/.claude/settings.json). */
  getSettingsPath(): string;

  /**
   * Directory where session data is stored.
   *
   * NOTE — C2 narrowing (2026-05): this is the ONLY storage-path concern an
   * adapter exposes. Per-project DB paths are derived by callers via
   * `resolveSessionDbPath({ projectDir, sessionsDir: adapter.getSessionDir() })`
   * (see `src/session/db.ts`). Per-project events.md paths follow the same
   * `<sessionDir>/<hash><suffix>-events.md` shape and are computed inline at
   * the small number of call sites that need them (server.ts, hooks).
   */
  getSessionDir(): string;

  /**
   * Platform config directory.
   *
   * Contract: ALWAYS returns an absolute path. Never returns a relative
   * segment, never returns an empty string. This eliminates the leaky-seam
   * where callers could not tell whether the return needed further resolution.
   *
   * Resolution rules:
   *   - Home-rooted platforms (claude-code, codex, qwen, gemini, antigravity,
   *     zed, opencode, …) return paths under `homedir()` / XDG / APPDATA.
   *   - Project-scoped platforms (cursor → `.cursor`, vscode-copilot &
   *     jetbrains-copilot → `.github`, kiro → `.kiro`, openclaw → project root)
   *     resolve their segment against the supplied `projectDir`. When
   *     `projectDir` is omitted, `process.cwd()` is used as the fallback.
   *
   * @param projectDir Optional project root used to resolve project-scoped
   *                   adapters. Ignored by home-rooted adapters.
   */
  getConfigDir(projectDir?: string): string;

  /**
   * Names of platform-native instruction/rule files that act as the
   * project's "user CLAUDE.md equivalent" (e.g., ["CLAUDE.md"],
   * ["AGENTS.md"], ["GEMINI.md"]). Auto-memory scans for these in the
   * project root and config dir, and rule-detection emits "rule" events
   * when they are read.
   */
  getInstructionFiles(): string[];

  /**
   * Directory where persistent per-user memory is stored
   * (e.g., ~/.claude/memory, ~/.codex/memories). Auto-memory scans
   * *.md files in this directory.
   *
   * When `projectDir` is supplied, the path MUST be project-scoped (issue
   * #663) so two projects running in parallel cannot read each other's
   * memory. Adapters scope via `hashProjectDirCanonical(projectDir)`.
   * Callers that pre-date this contract may omit `projectDir`; in that
   * case the unscoped legacy path is returned.
   */
  getMemoryDir(projectDir?: string): string;

  /** Generate hook registration config for this platform. */
  generateHookConfig(pluginRoot: string): HookRegistration;

  /** Read current platform settings. */
  readSettings(): Record<string, unknown> | null;

  /** Write platform settings. */
  writeSettings(settings: Record<string, unknown>): void;

  // ── Diagnostics (doctor) ───────────────────────────────

  /** Validate that hooks are properly configured for this platform. */
  validateHooks(pluginRoot: string): DiagnosticResult[];

  /**
   * Adapter-defined per-platform health checks (Algo-D1).
   *
   * OPTIONAL. Adapters that don't override return nothing — they don't
   * have this class of check today. claude-code overrides with hook-script
   * existence checks that join `pluginRoot + scriptName` directly via
   * `existsSync`, so doctor never round-trips through a regex on a hook
   * command (the #548 root cause).
   *
   * Adapter #16 with hook scripts inherits the contract by overriding;
   * adapter #17 without hook scripts simply doesn't override. The doctor
   * iterates `adapter.getHealthChecks?.(pluginRoot) ?? []` and renders
   * each — no per-adapter wiring in the doctor body.
   */
  getHealthChecks?(pluginRoot: string): readonly HealthCheck[];

  /** Check if the plugin is registered/enabled on this platform. */
  checkPluginRegistration(): DiagnosticResult;

  /**
   * Get the installed version from this platform's registry/marketplace, or
   * "standalone" when no platform-owned plugin version exists.
   */
  getInstalledVersion(): string;

  // ── Upgrade ────────────────────────────────────────────

  /** Configure all hooks for this platform. Returns change descriptions. */
  configureAllHooks(pluginRoot: string): string[];

  /** Backup platform settings before modification. Returns backup path or null. */
  backupSettings(): string | null;

  /** Set executable permissions on hook scripts. Returns paths that were set. */
  setHookPermissions(pluginRoot: string): string[];

  /** Update platform's plugin registry to point to given path and version. */
  updatePluginRegistry(pluginRoot: string, version: string): void;
}

// ─────────────────────────────────────────────────────────
// Diagnostic result
// ─────────────────────────────────────────────────────────

/** Result from a platform-specific diagnostic check. */
export interface DiagnosticResult {
  /** What was checked. */
  check: string;
  /** Pass, fail, or warning. */
  status: "pass" | "fail" | "warn";
  /** Human-readable message. */
  message: string;
  /** Suggested fix command (if applicable). */
  fix?: string;
}

/**
 * Adapter-defined health check (Algo-D1).
 *
 * Lighter-weight than `DiagnosticResult`: adapters declare a name and a
 * synchronous `check()` thunk. The doctor renders the result. The
 * thunk-style intentionally avoids forcing adapters into async — the
 * existsSync probe used by claude-code is sync and the doctor invokes it
 * directly without an `await`. Adapters needing async work return a
 * pre-resolved status (the check ran at thunk-creation time) or extend
 * `validateHooks()` instead.
 */
export interface HealthCheck {
  /** Human-readable check title (e.g. "Hook script exists: pretooluse.mjs"). */
  readonly name: string;
  /** Synchronous check thunk. Returns OK or FAIL with optional detail. */
  check(): { status: "OK" | "FAIL"; detail?: string };
}

// ─────────────────────────────────────────────────────────
// Platform detection
// ─────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────
// Cross-platform command helpers (#369, #372)
// ─────────────────────────────────────────────────────────

/**
 * Build a cross-platform `node <script>` command string.
 *
 * Fixes two Windows bugs:
 *   #369 — Bare `node` fails on Windows Git Bash (MSYS) because PATH
 *          resolution is unreliable. Uses `process.execPath` instead.
 *   #372 — MSYS rewrites absolute paths on non-C: drives (e.g.
 *          `C:\Users\...` → `D:\c\Users\...`). Forward slashes +
 *          double-quoting prevents the translation.
 *
 * Safe on macOS/Linux — quoting and forward slashes are no-ops there.
 */
export function buildNodeCommand(scriptPath: string, opts?: { platform?: string; jsRuntime?: string }): string {
  let nodePath = process.execPath.replace(/\\/g, "/");
  if (isInProcessPluginPlatform(opts?.platform)) {
    const base = nodePath
      .split("/")
      .pop()!
      .replace(/\.exe$/i, "");
    if (!JS_RUNTIMES.has(base)) {
      nodePath = opts?.jsRuntime?.replace(/\\/g, "/") ?? "node";
    }
  }
  const safePath = scriptPath.replace(/\\/g, "/");
  return `"${nodePath}" "${safePath}"`;
}

/** Known JS runtime binary names (base filename without extension). */
export const JS_RUNTIMES: ReadonlySet<string> = new Set(["node", "bun", "deno"]);

/** Platforms where open-context-mode runs as an in-process TS plugin (not MCP stdio). */
export const IN_PROCESS_PLUGIN_PLATFORMS: ReadonlySet<string> = new Set(["opencode"]);

export function isInProcessPluginPlatform(p: string | undefined): boolean {
  return !!p && IN_PROCESS_PLUGIN_PLATFORMS.has(p);
}

/**
 * The label stored in the `platform` column. "opencode" is the only
 * integration, "mcp" the fallback for a client that named itself nothing
 * useful; anything else is a sanitized client name we observed, and the rest
 * are rows written before those integrations were removed.
 */
export type PlatformId = KnownPlatformId | (string & {});

/** The platforms with an integration in this repo. */
export type KnownPlatformId = "opencode" | "mcp";

/** Detection signal used to identify which platform is running. */
export interface DetectionSignal {
  /** Platform identifier. */
  platform: PlatformId;
  /** Confidence: env var match > config dir match > fallback. */
  confidence: "high" | "medium" | "low";
  /** How it was detected. */
  reason: string;
}
