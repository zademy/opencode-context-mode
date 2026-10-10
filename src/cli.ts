#!/usr/bin/env node
/**
 * open-context-mode CLI
 *
 * Usage:
 *   open-context-mode                              → Start MCP server (stdio)
 *   open-context-mode doctor                       → Diagnose runtime issues, hooks, FTS5, version
 *   open-context-mode hook <platform> <event>      → Dispatch a hook script (used by platform hook configs)
 *   OPEN_CONTEXT_MODE_DIR=/abs/path open-context-mode   → Override sessions/content storage root
 *     Empty/whitespace is ignored; non-empty values must be absolute.
 *
 * Platform auto-detection: CLI detects which platform is running
 * (Claude Code, Gemini CLI, OpenCode, etc.) and uses the appropriate adapter.
 */

import * as p from "@clack/prompts";
import color from "picocolors";
import { execFileSync, execSync, execFile as nodeExecFile, type ExecSyncOptions } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  cpSync,
  accessSync,
  existsSync,
  readdirSync,
  rmSync,
  closeSync,
  openSync,
  chmodSync,
  mkdirSync,
  lstatSync,
  realpathSync,
  statSync,
  unlinkSync,
  constants,
} from "node:fs";
import { request as httpsRequest } from "node:https";
import { resolve, dirname, join, sep, basename, isAbsolute } from "node:path";
import { tmpdir, devNull, homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { detectRuntimes, getRuntimeSummary, hasBunRuntime, getAvailableLanguages } from "./runtime.js";
import { getHookScriptPaths } from "./util/hook-config.js";
import { startDashboardServer } from "./dashboard/server.js";
import {
  ensureWritableStorageDir,
  formatStorageDirectoryError,
  resolveContentStorageDir,
  resolveSessionStorageDir,
  resolveStatsStorageDir,
  StorageDirectoryError,
  type ResolvedStorageDir,
} from "./session/db.js";
import { composeSourceLabel, ContentStore } from "./store.js";
import { readToolDenyPatterns, evaluateFilePath } from "./security.js";
// v1.0.128 — Issue #559 sibling MCP kill helpers (see PR-559-560-FIX-DESIGN.md).
import { discoverSiblingMcpPids, killSiblingMcpServers } from "./util/sibling-mcp.js";
// v1.0.119 — Issue #523 Layer 5 heal: post-bump assertion on .claude-plugin/plugin.json
// @ts-expect-error — JS module, no TS declarations
import { detectWindowsVsYear } from "../scripts/heal-better-sqlite3.mjs";
// Private 16-LOC copy of browserOpenArgv. Canonical version lives in src/server.ts;
// duplicated here so the cli bundle does not pull server.ts top-level boot side effects.
// Keep in sync — pure data, no I/O.
function browserOpenArgv(url: string, platform: NodeJS.Platform): readonly { cmd: string; args: readonly string[] }[] {
  if (platform === "darwin") return [{ cmd: "open", args: [url] }];
  if (platform === "win32") {
    return [{ cmd: "cmd", args: ["/c", "start", "", url] }];
  }
  return [
    { cmd: "xdg-open", args: [url] },
    { cmd: "sensible-browser", args: [url] },
  ];
}

// ── Adapter imports ──────────────────────────────────────
import { detectPlatform } from "./platforms/detect.js";
import { OpenCodeAdapter } from "./platforms/opencode/index.js";
import { isInProcessPluginPlatform } from "./platforms/types.js";
import { charSafePrefix } from "./truncate.js";

/* -------------------------------------------------------
 * Hook dispatcher — `open-context-mode hook <platform> <event>`
 * ------------------------------------------------------- */

/* -------------------------------------------------------
 * Entry point
 * ------------------------------------------------------- */

const args = process.argv.slice(2);

/**
 * The one config block every MCP client needs. `npx -y open-context-mode` resolves
 * the published bin, which starts the stdio server — no plugin, no hooks, no
 * client-specific wrapper. OpenCode does not need this file at all: it loads
 * the plugin and gets the tools in-process.
 */
export const MCP_CLIENT_CONFIG_BLOCK = `${JSON.stringify(
  {
    mcpServers: {
      "open-context-mode": { command: "npx", args: ["-y", "open-context-mode"] },
    },
  },
  null,
  2,
)}`;

function printHelp(): void {
  console.log(
    [
      "Usage:",
      "  open-context-mode                         Start MCP server (stdio)",
      "  open-context-mode index <path>            Index a file or directory into the FTS5 knowledge base",
      "  open-context-mode search <query...>       Search the current project's FTS5 knowledge base",
      "  open-context-mode doctor                  Diagnose runtime issues, hooks, FTS5, version",
      "  open-context-mode mcp                     Print the MCP server block for a client config",
      "  open-context-mode dashboard               Live local dashboard of your SQLite data (Ctrl+C to stop)",
      "",
      "Index options:",
      "  --source <label>                     Source label (default: project:<directory-name> or path)",
      "  --project <path>                     Project identity for the content DB (default: indexed dir or cwd)",
      "  --max-depth <n>                      Directory recursion depth (default: 5)",
      "  --max-files <n>                      Directory file cap (default: 200)",
      "  --ext <.ts,.md>                      Comma-separated extension allowlist",
      "  --include <glob>                     Directory include pattern (repeatable)",
      "  --exclude <glob>                     Directory exclude pattern (repeatable)",
      "  --no-gitignore                       Do not apply .gitignore during directory walks",
      "  --follow-symlinks                    Follow directory symlinks inside the root",
      "",
      "Search options:",
      "  --project <path>                     Project identity for the content DB (default: cwd)",
      "  --source <label>                     Filter to a source label (partial match)",
      "  --limit <n>                          Results to show (default: 3)",
      "  --type <code|prose>                  Filter by content type",
      "",
      "Environment:",
      "  OPEN_CONTEXT_MODE_DIR=/absolute/path      Override sessions/content storage root; empty is ignored, non-empty must be absolute",
    ].join("\n"),
  );
}

if (args[0] === "--help" || args[0] === "-h" || args[0] === "help") {
  printHelp();
} else if (args[0] === "index") {
  indexCommand(args.slice(1)).then((code) => process.exit(code));
} else if (args[0] === "search") {
  searchCommand(args.slice(1)).then((code) => process.exit(code));
} else if (args[0] === "doctor") {
  doctor().then((code) => process.exit(code));
} else if (args[0] === "mcp") {
  console.log(MCP_CLIENT_CONFIG_BLOCK);
} else if (args[0] === "insight") {
  insight();
} else if (args[0] === "dashboard") {
  dashboardCommand(args.slice(1));
} else {
  // Default: start MCP server
  import("./server.js");
}

/* -------------------------------------------------------
 * Shared helpers
 * ------------------------------------------------------- */

/** Normalize Windows backslash paths to forward slashes for Bash (MSYS2) compatibility. */
export function toUnixPath(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * Windows-safe npm execution. On Windows:
 * - "npm" → "npm.cmd" (Node won't resolve via PATHEXT in execFile)
 * - shell: true required (Node v20+ CVE-2024-27980 mitigation)
 * See: https://github.com/mksglu/open-context-mode/issues/344
 */
const isWin = process.platform === "win32";

export function npmExecFile(args: string[], opts: Record<string, unknown> = {}): void {
  execFileSync(isWin ? "npm.cmd" : "npm", args, {
    ...opts,
    ...(isWin ? { shell: true } : {}),
  });
}

export function npmExec(command: string, opts: Record<string, unknown> = {}): void {
  // Issue #511: use top-level static import (line 17) — never inline `require("node:...")`
  // in ESM-bundled sources. esbuild rewrites them to a `__require` shim that throws
  // `Dynamic require of "node:child_process" is not supported` under Node ESM/Bun.
  // Cast preserves the prior `require()`-as-`any` shape; `shell: true` is the documented
  // Node behavior even though @types/node typed `shell` as `string | undefined`.
  const execOpts = {
    ...opts,
    ...(isWin ? { shell: true } : {}),
  } as unknown as ExecSyncOptions;
  execSync(isWin ? command.replace(/^npm /, "npm.cmd ") : command, execOpts);
}

/**
 * Open a URL in the user's default browser without invoking a shell.
 *
 * Uses `execFile` with an arg array so the URL cannot be interpreted as
 * shell metacharacters.  Original code used `execSync(`open "${url}"`)`
 * which would shell-interpolate the URL — fragile if the URL ever
 * becomes attacker-controlled (remote, weak port-validation, etc).
 *
 * Best-effort: if the OS opener is missing the function logs a copyable
 * URL hint and returns; it never throws.  `runner` is injectable for
 * tests; default is `child_process.execFile` (callback form, fire-and-
 * forget).
 */
export type ExecFileFn = (file: string, args: readonly string[], opts?: Record<string, unknown>) => unknown;

export function openInBrowser(
  url: string,
  platform: NodeJS.Platform = process.platform,
  runner: ExecFileFn = nodeExecFile as unknown as ExecFileFn,
): void {
  const opts = { stdio: "ignore" as const };
  const hint = () => console.error(`\nCould not auto-open browser. Open manually: ${url}`);

  // Platform→argv mapping is canonical in src/server.ts; mirrored privately
  // above to avoid pulling server boot side effects into the cli bundle.
  const attempts = browserOpenArgv(url, platform);
  let opened = false;
  for (const { cmd, args } of attempts) {
    try {
      runner(cmd, args as string[], opts);
      opened = true;
      break;
    } catch {
      /* try next fallback */
    }
  }
  if (!opened) hint();
}

function defaultPluginRoot(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  // build/cli.js or src/cli.ts → go up one level; cli.bundle.mjs at project root → stay here
  if (__dirname.endsWith("/build") || __dirname.endsWith("\\build") || __dirname.endsWith("/src") || __dirname.endsWith("\\src")) {
    return resolve(__dirname, "..");
  }
  return __dirname;
}

// Opencode/Kilocode install plugins from npm into a per-package cache folder.
// Layout (changed silently in late 2024 — see PR #376 / KiloCode#9503):
//   POSIX  : ~/.cache/<platform>/packages/open-context-mode@latest/node_modules/open-context-mode
//   Windows: %LOCALAPPDATA%\<platform>\packages\open-context-mode@latest\node_modules\open-context-mode
function cachePluginRoot(platform: string): string {
  const subPath = ["packages", "open-context-mode@latest", "node_modules", "open-context-mode"];
  if (process.platform === "win32") {
    const localApp = process.env.LOCALAPPDATA;
    if (localApp) return resolve(localApp, platform, ...subPath);
    return resolve(homedir(), "AppData", "Local", platform, ...subPath);
  }
  return resolve(homedir(), ".cache", platform, ...subPath);
}

function getPluginRoot(): string {
  const platform = detectPlatform().platform;
  if (isInProcessPluginPlatform(platform)) {
    return cachePluginRoot(platform);
  }
  return defaultPluginRoot();
}

function getLocalVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(getPluginRoot(), "package.json"), "utf-8"));
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

async function fetchLatestVersion(): Promise<string> {
  // Use node:https instead of global fetch to avoid a Windows libuv assertion
  // (UV_HANDLE_CLOSING) caused by undici's connection-pool background threads
  // racing with process.exit() teardown on Node.js v24+.
  return new Promise((resolve) => {
    const req = httpsRequest("https://registry.npmjs.org/open-context-mode/latest", { headers: { Connection: "close" } }, (res) => {
      let raw = "";
      res.on("data", (chunk: Buffer) => {
        raw += chunk;
      });
      res.on("end", () => {
        try {
          const data = JSON.parse(raw) as { version?: string };
          resolve(data.version ?? "unknown");
        } catch {
          resolve("unknown");
        }
      });
    });
    req.on("error", () => resolve("unknown"));
    req.setTimeout(5000, () => {
      req.destroy();
      resolve("unknown");
    });
    req.end();
  });
}

/* -------------------------------------------------------
 * Doctor — adapter-aware diagnostics
 * ------------------------------------------------------- */

function describeStorageSource(dir: ResolvedStorageDir): string {
  return dir.envVar ? dir.envVar : "adapter default";
}

interface ParsedFlags {
  positional: string[];
  flags: Record<string, string | boolean | string[]>;
}

function parseFlags(argv: string[]): ParsedFlags {
  const positional: string[] = [];
  const flags: Record<string, string | boolean | string[]> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--") || arg === "--") {
      positional.push(arg);
      continue;
    }

    const raw = arg.slice(2);
    const eq = raw.indexOf("=");
    const key = eq >= 0 ? raw.slice(0, eq) : raw;
    const inlineValue = eq >= 0 ? raw.slice(eq + 1) : undefined;
    const next = argv[i + 1];
    const value = inlineValue !== undefined ? inlineValue : next && !next.startsWith("--") ? (i++, next) : true;

    if (key === "include" || key === "exclude") {
      const prev = flags[key];
      flags[key] = Array.isArray(prev) ? [...prev, String(value)] : [String(value)];
    } else {
      flags[key] = value;
    }
  }

  return { positional, flags };
}

function stringFlag(flags: ParsedFlags["flags"], key: string): string | undefined {
  const v = flags[key];
  if (typeof v === "string" && v.length > 0) return v;
  return undefined;
}

function boolFlag(flags: ParsedFlags["flags"], key: string): boolean {
  return flags[key] === true || flags[key] === "true";
}

function stringListFlag(flags: ParsedFlags["flags"], key: string): string[] | undefined {
  const v = flags[key];
  if (Array.isArray(v)) return v.filter(Boolean);
  if (typeof v === "string" && v.length > 0) return [v];
  return undefined;
}

function numberFlag(flags: ParsedFlags["flags"], key: string, opts: { min?: number } = {}): number | undefined {
  const raw = stringFlag(flags, key);
  if (!raw) return undefined;
  const n = Number(raw);
  const min = opts.min ?? 1;
  if (!Number.isInteger(n) || n < min) throw new Error(`--${key} must be an integer >= ${min}`);
  return n;
}

function extFlag(flags: ParsedFlags["flags"]): string[] | undefined {
  const raw = stringFlag(flags, "ext") ?? stringFlag(flags, "extensions");
  if (!raw) return undefined;
  const exts = raw
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => (x.startsWith(".") ? x : `.${x}`));
  return exts.length > 0 ? exts : undefined;
}

function resolveCliProjectDir(projectFlag: string | undefined, fallback: string): string {
  if (projectFlag) return resolve(projectFlag);
  return resolve(fallback);
}

async function openCliContentStore(projectDir: string): Promise<{ store: ContentStore; dbPath: string; contentDir: string }> {
  const adapter = new OpenCodeAdapter();
  const contentStorage = resolveContentStorageDir(() => adapter.getSessionDir());
  const contentDir = ensureWritableStorageDir(contentStorage);
  const { resolveContentStorePath } = await import("./session/db.js");
  const dbPath = resolveContentStorePath({ projectDir, contentDir });
  return { store: new ContentStore(dbPath), dbPath, contentDir };
}

function defaultSourceForPath(absPath: string): string {
  try {
    if (statSync(absPath).isDirectory()) return `project:${basename(absPath) || absPath}`;
  } catch {
    /* path errors are reported by the index command */
  }
  return absPath;
}

function assertReadAllowed(path: string, projectDir: string): void {
  const denyGlobs = readToolDenyPatterns("Read", projectDir);
  const denied = evaluateFilePath(path, denyGlobs, process.platform === "win32", projectDir);
  if (denied.denied) {
    throw new Error(`Read denied by policy: ${path}`);
  }
}

async function indexCommand(argv: string[]): Promise<number> {
  try {
    const parsed = parseFlags(argv);
    const target = parsed.positional[0];
    if (!target || target === "-h" || target === "--help") {
      console.log(
        "Usage: open-context-mode index <path> [--source label] [--project path] [--max-files n] [--max-depth n] [--ext .ts,.md]",
      );
      return target ? 0 : 1;
    }

    const absPath = isAbsolute(target) ? resolve(target) : resolve(process.cwd(), target);
    if (!existsSync(absPath)) throw new Error(`Path does not exist: ${absPath}`);

    const st = statSync(absPath);
    const projectDir = resolveCliProjectDir(stringFlag(parsed.flags, "project"), st.isDirectory() ? absPath : dirname(absPath));
    // Issue #914 — an explicit --source is a GROUP label, exactly like the one
    // handed to indexDirectory. Without composition a single-file index stored
    // the bare label, so `open_ctx_search` printed `Source: obsidian` with no file
    // and two files of the same group collided on the label dedup. With no
    // --source the label IS the absolute path already, so leave it alone.
    const groupSource = stringFlag(parsed.flags, "source");
    const source = groupSource ?? defaultSourceForPath(absPath);
    const { store, dbPath } = await openCliContentStore(projectDir);

    // What actually landed in `sources.label` — differs from `source` only on
    // the single-file + explicit --source path (#914).
    let storedSource: string | undefined;
    try {
      assertReadAllowed(absPath, projectDir);
      if (st.isDirectory()) {
        const denyGlobs = readToolDenyPatterns("Read", projectDir);
        const result = store.indexDirectory({
          path: absPath,
          source,
          include: stringListFlag(parsed.flags, "include"),
          exclude: stringListFlag(parsed.flags, "exclude"),
          maxDepth: numberFlag(parsed.flags, "max-depth", { min: 0 }),
          maxFiles: numberFlag(parsed.flags, "max-files"),
          extensions: extFlag(parsed.flags),
          respectGitignore: !boolFlag(parsed.flags, "no-gitignore"),
          followSymlinks: boolFlag(parsed.flags, "follow-symlinks"),
          perFileDeny: (filePath) => {
            try {
              return evaluateFilePath(filePath, denyGlobs, process.platform === "win32", projectDir).denied;
            } catch {
              return false;
            }
          },
        });
        const cap = result.capped ? ` (cap reached at ${result.filesIndexed} files)` : "";
        const denied = result.denied > 0 ? `; ${result.denied} denied` : "";
        const failed = result.failed > 0 ? `; ${result.failed} failed` : "";
        console.log(`Indexed ${result.filesIndexed} files (${result.totalChunks} sections) from ${absPath}${cap}${denied}${failed}`);
      } else {
        const fileSource = groupSource ? composeSourceLabel(groupSource, absPath) : source;
        const result = store.index({ path: absPath, source: fileSource });
        console.log(`Indexed ${result.totalChunks} sections (${result.codeChunks} with code) from ${absPath}`);
        storedSource = fileSource;
      }
      console.log(`Source: ${storedSource ?? source}`);
      console.log(`Project: ${projectDir}`);
      console.log(`DB: ${dbPath}`);
      return 0;
    } finally {
      store.close();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`open-context-mode index: ${message}`);
    return 1;
  }
}

async function searchCommand(argv: string[]): Promise<number> {
  try {
    const parsed = parseFlags(argv);
    const query = parsed.positional.join(" ").trim();
    if (!query || query === "-h" || query === "--help") {
      console.log("Usage: open-context-mode search <query...> [--source label] [--project path] [--limit n] [--type code|prose]");
      return query ? 0 : 1;
    }

    const projectDir = resolveCliProjectDir(stringFlag(parsed.flags, "project"), process.cwd());
    const { store, dbPath } = await openCliContentStore(projectDir);
    try {
      const limit = numberFlag(parsed.flags, "limit") ?? 3;
      const type = stringFlag(parsed.flags, "type");
      if (type && type !== "code" && type !== "prose") throw new Error("--type must be code or prose");

      const results = store.searchWithFallback(query, limit, stringFlag(parsed.flags, "source"), type as "code" | "prose" | undefined);
      if (results.length === 0) {
        console.log(`No matches for: ${query}`);
        console.log(`Project: ${projectDir}`);
        console.log(`DB: ${dbPath}`);
        return 0;
      }
      for (const [i, r] of results.entries()) {
        const content = r.content.replace(/\s+/g, " ").trim();
        const snippet = content.length > 500 ? `${charSafePrefix(content, 500)}...` : content;
        console.log(`## ${i + 1}. ${r.title}`);
        console.log(`Source: ${r.source}`);
        console.log(`Type: ${r.contentType}`);
        console.log(snippet);
        console.log("");
      }
      return 0;
    } finally {
      store.close();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`open-context-mode search: ${message}`);
    return 1;
  }
}

function logStorageDir(dir: ResolvedStorageDir): number {
  try {
    ensureWritableStorageDir(dir);
    p.log.success(color.green(`Storage ${dir.kind}: PASS`) + color.dim(` — ${dir.path} (${describeStorageSource(dir)})`));
    return 0;
  } catch (err) {
    if (err instanceof StorageDirectoryError) {
      p.log.error(color.red(`Storage ${dir.kind}: FAIL`) + color.dim(` — ${formatStorageDirectoryError(err)}`));
      return 1;
    }
    throw err;
  }
}

async function doctor(): Promise<number> {
  if (process.stdout.isTTY) console.clear();

  // Detect platform
  const detection = detectPlatform();
  const adapter = new OpenCodeAdapter();

  p.intro(color.bgMagenta(color.white(" open-context-mode doctor ")));
  p.log.info(`Platform: ${color.cyan(adapter.name)}` + color.dim(` (${detection.confidence} confidence — ${detection.reason})`));

  let criticalFails = 0;

  try {
    const sessionDir = resolveSessionStorageDir(() => adapter.getSessionDir());
    const contentDir = resolveContentStorageDir(() => sessionDir.path);
    const statsDir = resolveStatsStorageDir(() => sessionDir.path);

    p.note(
      [
        `sessions: ${sessionDir.path} (${describeStorageSource(sessionDir)})`,
        `content:  ${contentDir.path} (${describeStorageSource(contentDir)})`,
        `stats:    ${statsDir.path} (${describeStorageSource(statsDir)})`,
      ].join("\n"),
      "Storage paths",
    );
    criticalFails += logStorageDir(sessionDir);
    criticalFails += logStorageDir(contentDir);
    criticalFails += logStorageDir(statsDir);
  } catch (err) {
    if (err instanceof StorageDirectoryError) {
      criticalFails++;
      p.log.error(color.red(`Storage ${err.kind}: FAIL`) + color.dim(` — ${formatStorageDirectoryError(err)}`));
    } else {
      throw err;
    }
  }

  const s = p.spinner();
  s.start("Running diagnostics");

  let runtimes: ReturnType<typeof detectRuntimes>;
  let available: string[];
  try {
    runtimes = detectRuntimes();
    available = getAvailableLanguages(runtimes);
  } catch {
    s.stop("Diagnostics partial");
    p.log.warn(color.yellow("Could not detect runtimes") + color.dim(" — module may be missing, restart session after upgrade"));
    p.outro(color.yellow("Doctor could not fully run — try again after restarting"));
    return 1;
  }

  s.stop("Diagnostics complete");

  // Runtime check
  p.note(getRuntimeSummary(runtimes), "Runtimes");

  // ── Issue #564 — Linux + Node < 22.5 + no Bun is unsafe ────────────
  // V8's madvise(MADV_DONTNEED) can corrupt better-sqlite3's native addon
  // `.got.plt` on Linux, causing sporadic SIGSEGV (1-4/hour). The 22.5
  // gate (`hasModernSqlite()` in src/db-base.ts:226-244) is the contract:
  // at or above it we use node:sqlite (built-in, no native addon, no
  // .got.plt to corrupt); below it we fall through to better-sqlite3
  // which WILL crash. engines.node + a hard-fail postinstall guard this
  // at install time, but doctor() surfaces it for already-installed users
  // (and for adapters whose MCP host swallows stderr during install).
  // Refs:
  //   - https://github.com/nodejs/node/issues/62515
  //   - https://github.com/mksglu/open-context-mode/issues/564
  {
    const { hasModernSqlite } = await import("./db-base.js");
    if (process.platform === "linux" && !hasModernSqlite() && !hasBunRuntime()) {
      criticalFails++;
      p.log.error(
        color.red("Node version: FAIL") +
          ` — Linux + Node ${process.versions.node} is unsafe (SIGSEGV)` +
          color.dim(
            "\n  open-context-mode requires Node.js >= 22.5 (or Bun) on Linux to avoid the" +
              "\n  V8 madvise(MADV_DONTNEED) SIGSEGV in better-sqlite3 (1-4/hour)." +
              "\n  Refs: https://github.com/nodejs/node/issues/62515" +
              "\n        https://github.com/mksglu/open-context-mode/issues/564" +
              "\n  Fix:  nvm install 22.5 && nvm use 22.5 && npm install -g open-context-mode" +
              "\n  Or:   curl -fsSL https://bun.sh/install | bash && bun add -g open-context-mode",
          ),
      );
    }
  }

  // Speed tier
  if (hasBunRuntime()) {
    p.log.success(color.green("Performance: FAST") + " — Bun detected for JS/TS execution");
  } else {
    p.log.warn(color.yellow("Performance: NORMAL") + " — Using Node.js (install Bun for 3-5x speed boost)");
  }

  // Language coverage
  const total = 11;
  const pct = ((available.length / total) * 100).toFixed(0);
  if (available.length < 2) {
    criticalFails++;
    p.log.error(
      color.red(`Language coverage: ${available.length}/${total} (${pct}%)`) +
        " — too few runtimes detected" +
        color.dim(` — ${available.join(", ") || "none"}`),
    );
  } else {
    p.log.info(`Language coverage: ${available.length}/${total} (${pct}%)` + color.dim(` — ${available.join(", ")}`));
  }

  // Server test
  p.log.step("Testing server initialization...");
  try {
    const { PolyglotExecutor } = await import("./executor.js");
    const executor = new PolyglotExecutor({ runtimes });
    const result = await executor.execute({
      language: "javascript",
      code: 'console.log("ok");',
      timeout: 5000,
    });
    if (result.exitCode === 0 && result.stdout.trim() === "ok") {
      p.log.success(color.green("Server test: PASS"));
    } else {
      criticalFails++;
      const detail = result.stderr?.trim() ? ` (${charSafePrefix(result.stderr.trim(), 200)})` : "";
      p.log.error(color.red("Server test: FAIL") + ` — exit ${result.exitCode}${detail}`);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("Cannot find module") || message.includes("MODULE_NOT_FOUND")) {
      p.log.warn(color.yellow("Server test: SKIP") + color.dim(" — module not available (restart session after upgrade)"));
    } else {
      criticalFails++;
      p.log.error(color.red("Server test: FAIL") + ` — ${message}`);
    }
  }

  // Hooks — adapter-aware validation
  p.log.step(`Checking ${adapter.name} hooks configuration...`);
  const pluginRoot = getPluginRoot();
  const hookResults = adapter.validateHooks(pluginRoot);

  for (const result of hookResults) {
    if (result.status === "pass") {
      p.log.success(color.green(`${result.check}: PASS`) + ` — ${result.message}`);
    } else if (result.status === "warn") {
      p.log.warn(color.yellow(`${result.check}: WARN`) + ` — ${result.message}` + (result.fix ? color.dim(`\n  Run: ${result.fix}`) : ""));
    } else {
      p.log.error(color.red(`${result.check}: FAIL`) + ` — ${result.message}` + (result.fix ? color.dim(`\n  Run: ${result.fix}`) : ""));
    }
  }

  // OpenCode loads the plugin in-process, so there is no .mjs hook script on
  // disk to verify — the registration check below is the whole story.
  p.log.success(color.green("Hook scripts: N/A") + color.dim(" — in-process plugin, no script registration"));

  // Plugin registration — adapter-aware
  p.log.step(`Checking ${adapter.name} plugin registration...`);
  const pluginCheck = adapter.checkPluginRegistration();
  if (pluginCheck.status === "pass") {
    p.log.success(color.green("Plugin enabled: PASS") + color.dim(` — ${pluginCheck.message}`));
  } else {
    p.log.warn(color.yellow("Plugin enabled: WARN") + ` — ${pluginCheck.message}`);
  }

  // ── Issue #613 — proactive Tier C absolute-path detection ───────────
  // PR #620 fixed `buildHookCommand` for vscode-copilot + jetbrains-copilot
  // so future writes are CLI-dispatcher-shape. But users who ran
  // /open_ctx-upgrade on v1.0.136 or earlier are still carrying poisoned
  // committable files in their workspace:
  //   - `.github/hooks/open-context-mode.json`      (vscode-copilot, team-shared)
  //   - `.jetbrains/copilot/hooks.json`        (jetbrains-copilot, team-shared)
  //   - `.cursor/hooks.json`                   (cursor, team-shared)
  // Per ISSUE-613-VERDICT §6.1 these are Tier C — workspace-committed
  // cross-machine config. Doctor scans them for absolute paths and
  // fnm_multishells shims; if found, FAIL with `open_ctx_upgrade` remediation.
  // Per ISSUE-604-VERDICT §11 ("silent-green doctor while hooks are dead
  // is itself a P0 trust bug") — surface poison BEFORE the user hits a
  // runtime failure.
  p.log.step("Checking team-shared hook configs in your workspace...");
  {
    const projectDir = process.cwd();
    const tierCFiles = [".github/hooks/open-context-mode.json", ".cursor/hooks.json", ".jetbrains/copilot/hooks.json"];
    let tierCFails = 0;
    let tierCChecked = 0;

    // Detect absolute-path patterns that should never appear in a
    // workspace-committed config. Per Mert's standing Windows-safety rule:
    // handle both `/` and `\\` separators.
    function isAbsoluteOrShimPath(s: string): boolean {
      // unix absolute
      if (s.startsWith("/")) return true;
      // Windows drive-letter absolute (e.g. C:/, C:\)
      if (/^[A-Za-z]:[/\\]/.test(s)) return true;
      // Windows UNC or escaped-backslash absolute fragments
      if (s.includes("\\\\")) return true;
      // fnm shim hint — issue #613 reporter's exact stderr shape
      if (s.includes("fnm_multishells")) return true;
      // process.execPath literal baked into JSON
      if (s.includes("process.execPath")) return true;
      return false;
    }

    function recurseStrings(node: unknown, hit: (s: string) => void): void {
      if (typeof node === "string") {
        hit(node);
      } else if (Array.isArray(node)) {
        for (const item of node) recurseStrings(item, hit);
      } else if (node && typeof node === "object") {
        for (const v of Object.values(node)) recurseStrings(v, hit);
      }
    }

    for (const rel of tierCFiles) {
      const abs = resolve(projectDir, rel);
      if (!existsSync(abs)) continue; // missing config → SKIP, no false fail
      tierCChecked++;
      try {
        const parsed = JSON.parse(readFileSync(abs, "utf-8"));
        const offenders: string[] = [];
        recurseStrings(parsed, (s) => {
          if (isAbsoluteOrShimPath(s)) offenders.push(s);
        });
        if (offenders.length > 0) {
          criticalFails++;
          tierCFails++;
          // Truncate to one example to keep output readable; show count.
          const example = offenders[0].length > 100 ? offenders[0].slice(0, 97) + "..." : offenders[0];
          p.log.error(
            color.red(`Hook config: FAIL`) +
              ` — ${rel} has your machine's local paths baked in` +
              color.dim(
                "\n  This file is committed to git, so teammates and CI will get your path and the hooks will break for them." +
                  `\n  Found ${offenders.length} hard-coded path(s), e.g.: ${example}` +
                  "\n  Fix: reinstall the plugin (npm install in the plugin root) — postinstall rewrites the file to a portable form that works on every machine." +
                  "\n  Details: https://github.com/mksglu/open-context-mode/issues/613",
              ),
          );
        } else {
          p.log.success(color.green("Hook config: PASS") + color.dim(` — ${rel} is portable (no hard-coded paths)`));
        }
      } catch (err: unknown) {
        // Malformed JSON should not crash doctor; warn and move on.
        const msg = err instanceof Error ? err.message : String(err);
        p.log.warn(
          color.yellow(`Hook config: WARN`) +
            ` — ${rel} is not valid JSON` +
            color.dim(
              "\n  Doctor cannot scan it for portability issues until the file parses." +
                "\n  Fix: open the file and check it in a JSON validator, or delete it and reinstall the plugin to regenerate." +
                `\n  Parser said: ${msg.slice(0, 160)}`,
            ),
        );
      }
    }
    if (tierCChecked === 0) {
      p.log.info(color.dim("Hook config: SKIP — no team-shared hook configs found in this workspace"));
    } else if (tierCFails === 0) {
      // already individual PASS messages above; no need for a summary
    }
  }


  // FTS5 / SQLite
  p.log.step("Checking FTS5 / SQLite...");
  try {
    const Database = (await import("./db-base.js")).loadDatabase();
    const db = new Database(":memory:");
    db.exec("CREATE VIRTUAL TABLE fts_test USING fts5(content)");
    db.exec("INSERT INTO fts_test(content) VALUES ('hello world')");
    const row = db.prepare("SELECT * FROM fts_test WHERE fts_test MATCH 'hello'").get() as { content: string } | undefined;
    db.close();
    if (row && row.content === "hello world") {
      p.log.success(color.green("FTS5 / SQLite: PASS") + " — native module works");
    } else {
      criticalFails++;
      p.log.error(color.red("FTS5 / SQLite: FAIL") + " — query returned unexpected result");
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    // Distinguish package-missing from binding-missing (#514). Both
    // throw with similar shapes from `import("better-sqlite3")` but the
    // recovery commands differ:
    //   - package-missing → `npm install better-sqlite3 --no-optional`
    //     (npm@7+ silently drops optionalDependencies on engine
    //     mismatch, e.g. Node 26 vs better-sqlite3@12.x — we name the
    //     package explicitly + flip the optional filter to recover)
    //   - binding-missing → `npm rebuild better-sqlite3` (#408 flow,
    //     Windows + missing prebuild-install shim)
    const pluginRootForDoctor = getPluginRoot();
    const bsqPackageDir = resolve(pluginRootForDoctor, "node_modules", "better-sqlite3");
    const packageMissing = !existsSync(bsqPackageDir);

    if (packageMissing) {
      criticalFails++;
      p.log.error(
        color.red("FTS5 / better-sqlite3: FAIL") +
          color.dim(" — package-missing") +
          color.dim(
            `\n  Path: ${bsqPackageDir}` +
              "\n  Root cause: npm silently skipped better-sqlite3 because the package's `engines` field excluded the running Node (issue #514, e.g. Node 26 vs better-sqlite3@12.x)." +
              `\n  Try (primary): cd "${pluginRootForDoctor}" && npm install better-sqlite3 --no-optional` +
              "\n  Then restart your session so the repaired module is loaded.",
          ),
      );
    } else if (message.includes("Cannot find module") || message.includes("MODULE_NOT_FOUND")) {
      p.log.warn(color.yellow("FTS5 / better-sqlite3: SKIP") + color.dim(" — module not available (restart session after upgrade)"));
    } else {
      criticalFails++;
      // Detect better-sqlite3 native bindings-missing pattern (issue #408).
      // The `bindings` package throws "Could not locate the bindings file"
      // when better_sqlite3.node failed to install — typical on Windows
      // when prebuild-install was not on PATH so install fell through to
      // node-gyp without an MSVC toolchain.
      const isBindingsMissing =
        /Could not locate the bindings file/i.test(message) || /bindings\.node/i.test(message) || /\bbindings\b/i.test(message);
      if (isBindingsMissing && process.platform === "win32") {
        p.log.error(
          color.red("FTS5 / better-sqlite3: FAIL") +
            ` — ${message}` +
            color.dim(
              "\n  Root cause: prebuild-install was likely not on PATH, so install fell through to node-gyp without an MSVC toolchain (Windows)." +
                "\n  Try (primary): npm install better-sqlite3   # re-resolves the dep tree and re-links the prebuild-install bin shim to fetch a prebuilt binary" +
                "\n  Try (fallback): npm rebuild better-sqlite3",
            ),
        );
      } else {
        p.log.error(color.red("FTS5 / better-sqlite3: FAIL") + ` — ${message}` + color.dim("\n  Try: npm rebuild better-sqlite3"));
      }
    }
  }

  // Version check — adapter-aware
  p.log.step("Checking versions...");
  const localVersion = getLocalVersion();
  const latestVersion = await fetchLatestVersion();
  const installedVersion = adapter.getInstalledVersion();

  if (latestVersion === "unknown") {
    p.log.warn(color.yellow("npm (MCP): WARN") + ` — local v${localVersion}, could not reach npm registry`);
  } else if (localVersion === latestVersion) {
    p.log.success(color.green("npm (MCP): PASS") + ` — v${localVersion}`);
  } else {
    p.log.warn(
      color.yellow("npm (MCP): WARN") +
        ` — local v${localVersion}, latest v${latestVersion}` +
        color.dim("\n  Update: this fork tracks git, not npm — run `git pull && npm run build` in the repo."),
    );
  }

  if (installedVersion === "standalone") {
    p.log.info(color.dim(`${adapter.name}: standalone MCP mode`) + " — no platform plugin version to compare");
  } else if (installedVersion === "not installed") {
    p.log.info(color.dim(`${adapter.name}: not installed`) + " — using standalone MCP mode");
  } else if (latestVersion !== "unknown" && installedVersion === latestVersion) {
    p.log.success(color.green(`${adapter.name}: PASS`) + ` — v${installedVersion}`);
  } else if (latestVersion !== "unknown") {
    p.log.warn(
      color.yellow(`${adapter.name}: WARN`) +
        ` — v${installedVersion}, latest v${latestVersion}` +
        color.dim("\n  Update: this fork tracks git, not npm — run `git pull && npm run build` in the repo."),
    );
  } else {
    p.log.info(`${adapter.name}: v${installedVersion}` + color.dim(" — could not verify against npm registry"));
  }

  // Summary
  if (criticalFails > 0) {
    p.outro(color.red(`Diagnostics failed — ${criticalFails} critical issue(s) found`));
    return 1;
  }

  p.outro(
    available.length >= 4 ? color.green("Diagnostics complete!") : color.yellow("Some checks need attention — see above for details"),
  );
  return 0;
}

/* -------------------------------------------------------
 * Insight — hosted analytics dashboard
 * ------------------------------------------------------- */

// Insight pivoted from a locally-built dashboard to the hosted product at
// open-context-mode.com/insight (the landing page is the single source of truth).
// The command now just opens that URL in the default browser.
async function insight() {
  const url = "https://open-context-mode.com/insight";
  console.log(`\n  open-context-mode Insight\n  ${url}\n`);
  // Open browser — execFile with arg array, no shell interpolation.
  openInBrowser(url);
}

/* -------------------------------------------------------
 * Dashboard — ephemeral local server (ADR 0005)
 * ------------------------------------------------------- */

// Serves a read-only live view of the local SQLite stores on a random
// 127.0.0.1 port and opens it in the browser. The server holds no state on
// disk and dies with this process, so nothing here needs sweeping on upgrade.
function dashboardCommand(argv: string[]): void {
  const portIdx = argv.indexOf("--port");
  const portArg = portIdx >= 0 && argv[portIdx + 1] ? parseInt(argv[portIdx + 1], 10) : 0;
  const noOpen = argv.includes("--no-open");

  startDashboardServer({ port: Number.isInteger(portArg) ? portArg : 0 })
    .then(({ port }) => {
      const url = `http://127.0.0.1:${port}`;
      console.log(`\n  open-context-mode dashboard\n  ${url}\n  Read-only. Ctrl+C to stop.\n`);
      if (!noOpen) openInBrowser(url);
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(color.red(`Dashboard failed to start: ${message}`));
      process.exit(1);
    });
}

/* -------------------------------------------------------
 * uninstall — undo the host state the plugin deployed
 * ------------------------------------------------------- */

/* -------------------------------------------------------
 * statusline — forward to bin/statusline.mjs
 * ------------------------------------------------------- */
