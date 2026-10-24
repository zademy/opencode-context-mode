#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createRequire } from "node:module";
import {
  existsSync,
  unlinkSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  writeSync,
  renameSync,
  rmSync,
  mkdirSync,
  cpSync,
  statSync,
  symlinkSync,
  lstatSync,
  realpathSync,
} from "node:fs";
import { spawnSync, type SpawnSyncOptions, type SpawnSyncReturns } from "node:child_process";
import { join, dirname, resolve, sep, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, tmpdir, cpus, platform } from "node:os";
import { request as httpsRequest } from "node:https";
import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import { PolyglotExecutor } from "./executor.js";
import { runPool, type PoolJob } from "./runPool.js";
import {
  ContentStore,
  composeSourceLabel,
  cleanupStaleDBs,
  cleanupStaleContentDBs,
  cleanupStaleSessionFiles,
  type SearchResult,
  type IndexResult,
} from "./store.js";
import { composeFetchCacheKey } from "./fetch-cache.js";
import {
  readBashPolicies,
  evaluateCommandDenyOnly,
  extractShellCommands,
  readToolDenyPatterns,
  readToolPermissionPatterns,
  evaluateFilePath,
  evaluateProjectContainment,
  denyPatternReason,
} from "./security.js";
import { detectRuntimes, getRuntimeSummary, getAvailableLanguages, hasBunRuntime, type Language } from "./runtime.js";
import { createCtxToolPipeline, INTENT_AUTO_INDEX_PROSE, tracked, wireProgress, type ToolArgs } from "./tool-pipeline.js";
import { startLifecycleGuard, noteMcpActivity, noteRequestStart, noteRequestEnd, attachMcpActivityTap } from "./lifecycle.js";
import { charSafePrefix, charSafeSlice } from "./truncate.js";
import {
  describeStorageDirectorySource,
  ensureWritableStorageDir,
  formatStorageDirectoryError,
  hashProjectDirCanonical,
  hashProjectDirLegacy,
  resolveContentStorePath,
  resolveContentStorageDir,
  resolveDefaultSessionDir,
  resolveSessionDbPath,
  resolveSessionPath,
  resolveSessionStorageDir,
  resolveStatsStorageDir,
  SessionDB,
  StorageDirectoryError,
} from "./session/db.js";
import { purgeSession } from "./session/purge.js";
import { emitCacheHitEvent, emitIndexWriteEvent, emitSandboxExecuteEvent } from "./session/event-emit.js";
import { persistToolCallCounter, restoreSessionStats } from "./session/persist-tool-calls.js";
import { appendRetrievalBytes } from "./session/retrieval-marker.js";
import { searchAllSources, type UnifiedSearchResult } from "./search/unified.js";
import { buildCtxSearchInputSchema, CTX_SEARCH_SHARED_MODE, resolveProjectScope } from "./search/open_ctx-search-schema.js";
import { FloodGuard } from "./search/flood-guard.js";
import { buildNodeCommand, type HookAdapter, type PlatformId, isInProcessPluginPlatform } from "./platforms/types.js";
import { detectPlatform } from "./platforms/detect.js";
import { OpenCodeAdapter, opencodeConfigDir } from "./platforms/opencode/index.js";
import { isContextModeToolEnabled, readContextModeToolsAllowlist } from "./util/tools-allowlist.js";
import { stripJsonComments } from "./util/jsonc.js";
import { resolveProjectDir } from "./util/project-dir.js";
import { loadDatabase } from "./db-base.js";
import {
  AnalyticsEngine,
  getConversationStats,
  getContentBytesAllSessions,
  getConversationWindowStats,
  getLifetimeStats,
  getMultiAdapterLifetimeStats,
  getRealBytesStats,
} from "./session/analytics-query.js";
import { pricePerToken } from "./session/analytics-metrics.js";
import { formatReport } from "./session/analytics-render.js";
import { readLifetimeTokenSnapshot, writeLifetimeTokenSnapshot } from "./session/lifetime-snapshot.js";
const __pkg_dir = dirname(fileURLToPath(import.meta.url));
const VERSION: string = (() => {
  for (const rel of ["../package.json", "./package.json"]) {
    const p = resolve(__pkg_dir, rel);
    if (existsSync(p)) {
      try {
        return JSON.parse(readFileSync(p, "utf8")).version;
      } catch {}
    }
  }
  return "unknown";
})();

function getPackageRoot(): string {
  return existsSync(resolve(__pkg_dir, "package.json")) ? __pkg_dir : dirname(__pkg_dir);
}

function getRuntimeAwarePackageRoot(): string {
  return getPackageRoot();
}

// Prevent silent MCP server death from unhandled async errors.
//
// Guarded for plugin-native OpenCode/Kilo imports (#574): when server.js is
// imported only to reuse the open_ctx_* tool registry, these handlers would become
// process-wide OpenCode/Kilo host handlers. In Node, adding an
// `uncaughtException` listener changes default crash behavior, so only the
// standalone MCP process may install them.
if (process.env.OPEN_CONTEXT_MODE_EMBEDDED_PLUGIN_TOOLS !== "1") {
  process.on("unhandledRejection", (err) => {
    process.stderr.write(`[open-context-mode] unhandledRejection: ${err}\n`);
  });
  process.on("uncaughtException", (err) => {
    try {
      writeSync(2, `[open-context-mode] uncaughtException: ${err?.message ?? err}\n`);
    } finally {
      process.exit(1);
    }
  });
}

const runtimes = detectRuntimes();
const available = getAvailableLanguages(runtimes);
export const server = new McpServer({
  name: "open-context-mode",
  version: VERSION,
});

export interface RegisteredCtxTool {
  name: string;
  config: Record<string, unknown>;
  handler: (args: Record<string, unknown>, extra?: { signal?: AbortSignal }) => Promise<unknown> | unknown;
}

export const REGISTERED_CTX_TOOLS: RegisteredCtxTool[] = [];

export function shouldSuppressMcpToolsForNativePluginHost(
  opts: { embedded?: string; platform?: PlatformId; settings?: Record<string, unknown> | null } = {},
): boolean {
  const embedded = opts.embedded ?? process.env.OPEN_CONTEXT_MODE_EMBEDDED_PLUGIN_TOOLS;
  if (embedded === "1") return false;
  const platform = opts.platform ?? detectPlatform().platform;
  if (platform !== "opencode" && platform !== "kilo") return false;
  const settings = opts.settings ?? readNativePluginHostSettings(platform);
  return settingsHasContextModePlugin(settings) && settingsHasLegacyContextModeMcp(settings);
}

function readNativePluginHostSettings(platform: PlatformId): Record<string, unknown> | null {
  const base = platform === "kilo" ? "kilo" : "opencode";
  const paths = [
    resolve(`${base}.json`),
    resolve(`${base}.jsonc`),
    resolve(`.${base}`, `${base}.json`),
    resolve(`.${base}`, `${base}.jsonc`),
    join(homedir(), ".config", base, `${base}.json`),
    join(homedir(), ".config", base, `${base}.jsonc`),
  ];
  for (const p of paths) {
    try {
      if (!existsSync(p)) continue;
      return JSON.parse(stripJsonComments(readFileSync(p, "utf8"))) as Record<string, unknown>;
    } catch {
      /* try next config path */
    }
  }
  return null;
}

function settingsHasContextModePlugin(settings: Record<string, unknown> | null | undefined): boolean {
  const plugins = settings?.plugin;
  return Array.isArray(plugins) && plugins.some((p) => typeof p === "string" && p.includes("open-context-mode"));
}

function settingsHasLegacyContextModeMcp(settings: Record<string, unknown> | null | undefined): boolean {
  const mcp = settings?.mcp;
  return !!(mcp && typeof mcp === "object" && !Array.isArray(mcp) && Object.prototype.hasOwnProperty.call(mcp, "open-context-mode"));
}

const suppressMcpToolsForNativePluginHost = shouldSuppressMcpToolsForNativePluginHost();

/**
 * Issue #623 — surface why open_ctx_* tools/list is empty on suppressed legacy MCP
 * children. When a user upgrades OpenCode/Kilo from v1.0.136 → v1.0.137+ without
 * running `open-context-mode upgrade`, their opencode.json still has BOTH the legacy
 * mcp.open-context-mode block AND the plugin entry. The plugin path registers the
 * tools natively, but the legacy MCP child runs in parallel and used to expose
 * duplicate tools — v1.0.137 suppressed those duplicates. The suppression was
 * silent, leaving any MCP client that inspected the child via tools/list with
 * an empty list and no diagnostic. Emit one stderr line per process so an
 * operator running the child directly (or any non-plugin MCP host) sees the
 * exact reason and the `open-context-mode upgrade` fix.
 *
 * Exported for test (suppression-diagnostic regression guard).
 */
let __suppressionDiagnosticEmitted = false;
export function emitSuppressionDiagnostic(opts: { platform?: string; write?: (chunk: string) => void } = {}): void {
  if (__suppressionDiagnosticEmitted) return;
  __suppressionDiagnosticEmitted = true;
  const write =
    opts.write ??
    ((c: string) => {
      process.stderr.write(c);
    });
  const platform = opts.platform ?? "opencode/kilo";
  write(
    `[open-context-mode] open_ctx_* tools/list intentionally empty on this MCP child: ` +
      `legacy mcp.open-context-mode block coexists with plugin: ["open-context-mode"] in ` +
      `${platform}.json — plugin-native tools are the supported path (#623). ` +
      `Run \`npm install\` in the plugin root to remove the legacy block (preserves other ` +
      `MCP servers).\n`,
  );
}
/** Test-only: reset the one-shot emission flag so suites can re-exercise. */
export function __resetSuppressionDiagnosticForTests(): void {
  __suppressionDiagnosticEmitted = false;
}

/**
 * Issue #637 — register an explicit empty `tools/list` handler on the McpServer.
 *
 * Background: when `suppressMcpToolsForNativePluginHost` is true, every
 * `server.registerTool()` call is short-circuited (returns `undefined` above).
 * The MCP SDK only installs the SDK-default `tools/list` handler when at least
 * one `registerTool()` reaches `setToolRequestHandlers()` internally
 * (mcp.js:56-67). Suppressing every registration leaves `tools/list`
 * unregistered, and the framework's RPC layer answers it with
 * `-32601 "Method not found"`.
 *
 * The reporter of #637 (SquirrelRat) inspected the suppressed child via
 * `tools/list` and read the JSON-RPC error as "the plugin never registers any
 * open_ctx_* tools" — when in fact the plugin DOES register all 11 tools natively
 * (verified at `src/platforms/opencode/plugin.ts:469` and
 * `tests/opencode-plugin.test.ts:88`). The misleading -32601 is the seed of
 * the #637 perception.
 *
 * This helper installs an explicit handler that returns `{tools: []}` — a
 * spec-compliant empty list. Paired with the existing #623 stderr diagnostic,
 * an operator now sees:
 *   - wire response: `{tools: []}` (matches expectation, no JSON-RPC error)
 *   - stderr: `[open-context-mode] open_ctx_* tools/list intentionally empty… (#623)`
 *
 * Idempotent: throws inside SDK if called twice on the same server because
 * `assertCanSetRequestHandler` (mcp.js:60) rejects duplicate registrations;
 * we therefore install the SDK's default tool handlers FIRST (via a no-op
 * registerTool of a fake tool, immediately removed) only if needed. To keep
 * the public surface minimal, we just call `server.server.setRequestHandler`
 * directly — that is the same low-level call used for prompts/resources at
 * server.ts:259-261 and avoids the SDK guard entirely.
 *
 * Exported for test (#637 in-memory regression guard).
 */
export function registerEmptyToolsListHandler(target: McpServer = server): void {
  target.server.registerCapabilities({ tools: { listChanged: false } });
  target.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
}

const originalRegisterTool = server.registerTool.bind(server);
(server as unknown as { registerTool: (...args: unknown[]) => unknown }).registerTool = (...args: unknown[]) => {
  const [name, config, handler] = args as [
    string,
    Record<string, unknown>,
    (toolArgs: Record<string, unknown>, extra?: unknown) => Promise<unknown> | unknown,
  ];
  if (suppressMcpToolsForNativePluginHost) {
    emitSuppressionDiagnostic();
    return undefined;
  }
  if (!isContextModeToolEnabled(name, readContextModeToolsAllowlist())) {
    return undefined;
  }
  const wrappedHandler = wrapToolHandler(name, handler);
  REGISTERED_CTX_TOOLS.push({ name, config, handler: wrappedHandler });
  args[2] = wrappedHandler;
  return (originalRegisterTool as unknown as (...callArgs: unknown[]) => unknown)(...args);
};

function wrapToolHandler(
  name: string,
  handler: (toolArgs: Record<string, unknown>, extra?: unknown) => Promise<unknown> | unknown,
): (toolArgs: Record<string, unknown>, extra?: unknown) => Promise<unknown> {
  return async (toolArgs: Record<string, unknown>, extra?: unknown) => {
    // #854: mark a tool call in-flight so the bridge-child idle reaper never
    // shuts the server down mid-execution during a long open_ctx_execute/batch that
    // emits no further inbound messages. Symmetric end in finally (success+error).
    noteRequestStart();
    try {
      // The MCP SDK invokes registered tool handlers with (args, extra), where
      // extra.signal carries request cancellation from the host. Forward it —
      // dropping it silently disabled the executor-level abort wiring (#83aefee):
      // every handler saw extra === {} so no running execution could be cancelled.
      return await handler(toolArgs, extra);
    } catch (err) {
      const result = storageErrorResult(err);
      if (result) {
        try {
          return trackResponse(name, result);
        } catch (trackErr) {
          if (trackErr instanceof StorageDirectoryError) return result;
          throw trackErr;
        }
      }
      throw err;
    } finally {
      noteRequestEnd();
    }
  };
}

// Issue #637 — when suppression is active, install the empty tools/list handler
// once at module-init time so the suppressed MCP child responds with
// `{tools: []}` instead of JSON-RPC `-32601 Method not found`. Pair with the
// #623 stderr diagnostic that explains WHY the list is empty. Skipped for the
// embedded plugin-import path because the embedded process is not the stdio
// MCP child an operator would inspect — it lives inside the OpenCode/Kilo
// host and never speaks JSON-RPC over stdio.
if (suppressMcpToolsForNativePluginHost && process.env.OPEN_CONTEXT_MODE_EMBEDDED_PLUGIN_TOOLS !== "1") {
  registerEmptyToolsListHandler(server);
}

type ToolContextOverride = { projectDir: string; sessionId?: string };
const projectDirOverride = new AsyncLocalStorage<ToolContextOverride>();

export async function withProjectDirOverride<T>(projectDir: string | ToolContextOverride, fn: () => Promise<T>): Promise<T> {
  const ctx = typeof projectDir === "string" ? { projectDir } : projectDir;
  return projectDirOverride.run(ctx, fn);
}

// Register empty prompts/resources handlers so MCP clients don't get -32601 (#168).
// OpenCode calls listPrompts()/listResources() unconditionally — the error can poison
// the SDK transport layer, causing subsequent listTools() calls to fail permanently.
import {
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
server.server.registerCapabilities({ prompts: { listChanged: false }, resources: { listChanged: false } });
server.server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [] }));
server.server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }));
server.server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: [] }));

// ── Strict-client (Gemini function-calling) schema compatibility ──────────────
// Gemini's function-calling API — used by Antigravity CLI (`agy`) and Gemini CLI
// — rejects JSON Schema `const` and `additionalProperties`. A rejected parameter
// schema makes the host SILENTLY DROP that tool from the model's function list,
// so the agent never sees our open_ctx_* tools and falls back to hand-rolling the MCP
// protocol through its Bash tool. Sanitize the EMITTED tools/list schema:
//   • `const: X`  →  `enum: [X]`   — an identical single-value constraint
//   • drop `additionalProperties`  — advisory only; every open_ctx_* handler parses
//     args with Zod (which strips unknown keys server-side), so removing it
//     changes no validation and no call behavior.
// Both transforms are behavior-preserving for every other client (Claude Code,
// Copilot, Cursor, …): `const` and a one-value `enum` are equivalent, and no
// model sends undeclared properties. Only the wire schema changes — never
// validation or how any tool is invoked.
export function sanitizeSchemaForStrictClients(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitizeSchemaForStrictClients);
  if (node === null || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === "additionalProperties") continue;
    if (key === "const") {
      out.enum = [value];
      continue;
    }
    out[key] = sanitizeSchemaForStrictClients(value);
  }
  return out;
}

// Wrap the SDK-installed tools/list handler so its generated schemas pass through
// the sanitizer above. Best-effort by design: if the MCP SDK's internals shift,
// the original handler is left untouched (no regression — strict clients stay as
// they were, every other client unaffected). Must run AFTER all registerTool()
// calls so the SDK's default tools/list handler already exists.
export function installStrictClientSchemaCompat(target: McpServer = server): void {
  try {
    const low = target.server as unknown as {
      _requestHandlers?: Map<string, (req: unknown, extra: unknown) => Promise<unknown>>;
    };
    const original = low._requestHandlers?.get("tools/list");
    if (typeof original !== "function") return;
    target.server.setRequestHandler(ListToolsRequestSchema, async (req, extra) => {
      const result = (await original(req as unknown, extra as unknown)) as { tools?: Array<{ inputSchema?: unknown }> } | undefined;
      if (result && Array.isArray(result.tools)) {
        for (const tool of result.tools) {
          if (!tool || tool.inputSchema == null) continue;
          try {
            tool.inputSchema = sanitizeSchemaForStrictClients(tool.inputSchema);
          } catch {
            /* leave this tool's schema unchanged */
          }
        }
      }
      return result as never;
    });
  } catch {
    /* best-effort — never break tools/list */
  }
}

const executor = new PolyglotExecutor({
  runtimes,
  projectRoot: () => getProjectDir(),
});

// ─────────────────────────────────────────────────────────
// FS read tracking preload for open_ctx_batch_execute
// ─────────────────────────────────────────────────────────
// NODE_OPTIONS is denied by the executor's #buildSafeEnv (security).
// Instead, we set it at the top of each batch command's shell script.
// This temp file is loaded via --require when batch commands spawn Node processes.
const CM_FS_PRELOAD = join(tmpdir(), `cm-fs-preload-${process.pid}.js`);
// Bytes that count toward bytesSandboxed for one read/response payload.
// Binary payloads (NUL byte in the first 8000 bytes, the same probe git uses)
// count as 0: an ordinary command would never print them into model context,
// so reporting them as saved tokens inflates the savings (#1151).
const CM_TEXT_BYTES_JS = `function __cm_tb(d){if(typeof d==='string')return Buffer.byteLength(d);var u=d instanceof ArrayBuffer?new Uint8Array(d):d;if(!u||typeof u.length!=='number')return 0;return u.subarray(0,8000).indexOf(0)===-1?u.length:0;}`;
// #1068: the counter is reported on a side file next to this preload, NEVER on
// stderr. NODE_OPTIONS is inherited by every descendant, so a grandchild's
// stderr marker landed in the stream its own parent was asserting on — seven
// CLI-shim suites went red on the harness's own telemetry — and whenever an
// intermediate process did capture it, those bytes never reached
// formatCommandOutput at all. The side file is also the only channel where the
// descendant tree's bytes can be summed: the out path is derived from the
// preload's own filename, so no env var and no shell-specific quoting.
export const CM_FS_PRELOAD_SRC = `(function(){${CM_TEXT_BYTES_JS}var __cm_fs=0;var __cm_out=__filename.replace(/cm-fs-preload-(\\d+)\\.js$/,'cm-fs-out-$1.txt');process.on('exit',function(){if(__cm_fs>0)try{require('fs').appendFileSync(__cm_out,'__CM_FS__:'+__cm_fs+'\\n')}catch(e){}});try{var f=require('fs');var ors=f.readFileSync;f.readFileSync=function(){var r=ors.apply(this,arguments);__cm_fs+=__cm_tb(r);return r;};}catch(e){}})();\n`;
/** Side channel the preload appends its byte counts to. One per server pid. */
export const CM_FS_OUT = CM_FS_PRELOAD.replace(/cm-fs-preload-(\d+)\.js$/, "cm-fs-out-$1.txt");
/**
 * Sum every `__CM_FS__:<n>` marker the preload appended since the last drain,
 * then delete the file. Called once per open_ctx_batch_execute, after the commands
 * have exited, so a crash between the two only costs the file (removed by the
 * exit cleanup below), never a wrong count.
 */
export function drainFsPreloadBytes(): number {
  let raw = "";
  try {
    raw = readFileSync(CM_FS_OUT, "utf-8");
  } catch {
    /* no child instrumented anything */
  }
  try {
    unlinkSync(CM_FS_OUT);
  } catch {
    /* already gone */
  }
  let total = 0;
  for (const m of raw.matchAll(/__CM_FS__:(\d+)/g)) total += Number.parseInt(m[1], 10);
  return total;
}
/**
 * Write the preload file if it is not on disk, and return its path.
 *
 * The file lives in the OS temp dir, which periodic cleaners (macOS
 * $TMPDIR purge, systemd-tmpfiles) can empty while this server process is
 * still alive. If we keep injecting `NODE_OPTIONS=--require <missing file>`
 * after that, every node/npm/npx child dies at preload with MODULE_NOT_FOUND
 * (#951) — so callers must re-check existence at injection time, not rely on
 * the write at module load.
 */
export function ensureFsPreload(): string {
  if (!existsSync(CM_FS_PRELOAD)) writeFileSync(CM_FS_PRELOAD, CM_FS_PRELOAD_SRC);
  return CM_FS_PRELOAD;
}
ensureFsPreload();
// In the stdio MCP path, main() also removes this file during graceful
// shutdown. Plugin-native OpenCode/Kilo imports skip main() (#574), so
// register a top-level best-effort cleanup too to avoid leaking preload
// snippets under /tmp when the host process exits.
process.on("exit", () => {
  for (const p of [CM_FS_PRELOAD, CM_FS_OUT]) {
    try {
      unlinkSync(p);
    } catch {
      /* best effort */
    }
  }
});

// Map of dbPath -> ContentStore. Lazy singletons — no DB overhead
// unless index/search is used; one per project store (#888).
const _stores = new Map<string, ContentStore>();

/**
 * Build the FK-attribution object passed to every ContentStore.index*() call
 * in this process. CLAUDE_SESSION_ID is the only MCP-side handle we have on
 * the current session — eventId stays undefined because MCP tool invocations
 * are not paired with PostToolUse event rows at index time (the hook fires
 * AFTER the tool returns). Empty-string fallback inside #insertChunks keeps
 * legacy unattributed rows readable.
 */
export function currentAttribution(): { sessionId?: string } | undefined {
  const override = projectDirOverride.getStore();
  if (override?.sessionId) return { sessionId: override.sessionId };

  // Claude Code's caller session is resolved from the per-process session
  // file first (it tracks /clear and resume); env vars may be stale snapshots.
  // Cross-adapter resolution: every adapter (15 of them) sets *_PROJECT_DIR env
  // and writes session_events via hooks. Read the most-recent session_id from
  // THIS project's session DB. Works for claude-code/cursor/gemini-cli/codex/
  // kiro/opencode/zed/kilo/openclaw/qwen-code/vscode-copilot/jetbrains-copilot/
  // omp/pi/antigravity — no adapter-specific transcript path required.
  const sessionId = resolveSessionIdFromSessionDB();
  if (!sessionId) return undefined;
  return { sessionId };
}

let __cachedSessionId: { sid: string; checkedAt: number } | undefined;
/** v1.0.134 SLICE A: opts injection for testability. Production callers pass nothing. */
export function resolveSessionIdFromSessionDB(opts?: {
  projectDir?: string;
  sessionsDir?: string;
  bypassCache?: boolean;
}): string | undefined {
  // 2s cache — open_ctx_fetch_and_index can fire 5+ chunks/sec; DB open cost adds up.
  const now = Date.now();
  if (!opts?.bypassCache && __cachedSessionId && now - __cachedSessionId.checkedAt < 2000) {
    return __cachedSessionId.sid;
  }
  try {
    const projectDir = opts?.projectDir ?? process.env.CLAUDE_PROJECT_DIR ?? process.env.OPEN_CONTEXT_MODE_PROJECT_DIR;
    if (!projectDir) return undefined;
    const sessionsDir = opts?.sessionsDir ?? getSessionDir();
    const dbPath = resolveSessionDbPath({ projectDir, sessionsDir });
    if (!existsSync(dbPath)) return undefined;
    const Database = loadDatabase();
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const row = db.prepare("SELECT session_id FROM session_events ORDER BY created_at DESC LIMIT 1").get() as
        | { session_id?: string }
        | undefined;
      const sid = row?.session_id;
      if (sid) __cachedSessionId = { sid, checkedAt: now };
      return sid;
    } finally {
      try {
        db.close();
      } catch {
        /* best-effort */
      }
    }
  } catch {
    return undefined;
  }
}

/**
 * Auto-index the session events file written by the SessionStart hook.
 *
 * Scoped to THIS project only (issue #1214). The previous implementation
 * glob-scanned every `*-events.md` in the shared sessions directory, indexed
 * them all into whichever project's store happened to be open, and unlinked
 * them. On a machine running several projects that meant one project's session
 * events were indexed into another project's context, and the rightful project
 * never received them because the file had already been consumed.
 *
 * The old comment said CLAUDE_PROJECT_DIR is unavailable to MCP servers. That
 * is true of the env var but not of the server: `getProjectDir()` below has a
 * full resolution chain, and `getStorePath()` already uses it to hash the
 * content DB path. The events filename carries the same project hash, so
 * `resolveSessionPath` (the generalised resolver that also powers `.db` and
 * `.cleanup`) gives us exactly one path, and hooks and server cannot drift.
 *
 * The file is consumed (deleted) after indexing to prevent double-indexing.
 * Called on every getStore(); one existsSync is cheaper than the old readdir.
 */
export function maybeIndexSessionEvents(store: ContentStore): void {
  try {
    const sessionsDir = getSessionDir();
    if (!existsSync(sessionsDir)) return;
    const filePath = resolveSessionPath({
      projectDir: getProjectDir(),
      sessionsDir,
      ext: "-events.md",
    });
    if (!existsSync(filePath)) return;
    try {
      store.index({ path: filePath, source: "session-events", attribution: currentAttribution() });
      unlinkSync(filePath);
    } catch {
      /* best-effort — a bad events file never blocks tools */
    }
  } catch {
    /* best-effort — session continuity never blocks tools */
  }
}

// ── Platform-aware paths ──────────────────────────────────────────────────
// Every session path resolves under OpenCode's config dir, whichever client
// asked. Nothing here detects a platform to find a location.

/**
 * Resolve the Claude Code config root, honoring `CLAUDE_CONFIG_DIR` (incl.
 * leading `~`) before falling back to `~/.claude`. Mirrors
 * `hooks/session-helpers.mjs::resolveConfigDir` and
 * `ClaudeCodeAdapter.getConfigDir` so the pre-detection path agrees with
 * hooks/adapter on where Claude Code session data lives. See issue #453.
 *
 * Issue #460 round-3: delegates to the canonical util so empty/whitespace
 * env values fall back instead of poisoning downstream `join()` calls.
 */
/** The adapter every diagnostic reads through — there is only one. */
async function getDiagnosticAdapter(): Promise<HookAdapter | null> {
  return new OpenCodeAdapter();
}

/**
 * Get the platform-specific sessions directory from the detected adapter.
 * Falls back to the detected platform config root before adapter detection.
 */
function getDefaultSessionDir(): string {
  return resolveDefaultSessionDir({ configDir: opencodeConfigDir() });
}

function getSessionDir(): string {
  return ensureWritableStorageDir(resolveSessionStorageDir(getDefaultSessionDir));
}

/**
 * Project directory detection across supported platforms.
 *
 * Priority:
 *   1. Platform-specific env var (set by host IDE before MCP server spawn)
 *   2. OPEN_CONTEXT_MODE_PROJECT_DIR (set by start.mjs for ALL platforms — universal)
 *   3. process.cwd() (last resort)
 *
 * OPEN_CONTEXT_MODE_PROJECT_DIR guarantees correct projectDir even for platforms
 * that don't set their own env var (Cursor, OpenClaw, Codex, Kiro, Zed).
 */
export function getProjectDir(): string {
  const override = projectDirOverride.getStore();
  if (override) return override.projectDir;

  // Delegated to the shared resolver so the env-var chain rejects plugin
  // install paths (set by a prior MCP boot's start.mjs after `/open_ctx-upgrade`)
  // and prefers the shell-set PWD before the chdir'd cwd. v1.0.115 adds
  // the Claude Code transcript heuristic — read `cwd` from the most-recently-
  // modified `~/.claude/projects/<encoded>/<session>.jsonl` to recover the
  // real project dir when MCP was launched from a non-project cwd (desktop-
  // app launch, /open_ctx-upgrade respawn). See src/util/project-dir.ts.
  //
  // Issue #521 (v1.0.119): the transcript heuristic ONLY applies on Claude
  // Code. Other platforms (Cursor, OpenCode, Codex, ...) either have no
  // transcript at that path or use a different schema without `cwd`. Worse,
  // a Cursor user who also runs Claude Code would pick up the most-recently-
  // modified Claude Code session's cwd — wrong project entirely. Gate the
  // path on detected platform so non-Claude hosts skip the heuristic and
  // fall through to PWD/cwd cleanly.
  //
  // The Claude heuristic must also be fresh. Hosts such as Pi can be
  // misdetected as Claude Code solely because ~/.claude exists; without a
  // freshness guard an old Claude transcript can globally hijack ctx shell cwd
  // after reboot. Active Claude sessions update their transcript as the user
  // interacts, so stale transcripts should fall through to PWD/cwd.
  //
  // Issue #545 (v1.0.124): pass strictPlatform for ALL adapters so the
  // env-var cascade is built ALGORITHMICALLY from the platform's own
  // workspace vars + universal escape hatch — foreign workspace vars (e.g.
  // CLAUDE_PROJECT_DIR leaked into Pi's MCP child env from the user's shell)
  // cannot win, regardless of cascade order. start.mjs intentionally does
  // NOT pass strictPlatform — host detection is unreliable at the entrypoint
  // and the legacy literal cascade is preserved there for semver safety.
  let transcriptsRoot: string | undefined;
  let strictPlatform: PlatformId | undefined;
  let codexHome: string | undefined;
  try {
    const detected = detectPlatform().platform;
    strictPlatform = detected;
    if (detected === "claude-code") {
      transcriptsRoot = join(homedir(), ".claude", "projects");
    }
    // Issue #45 — Codex publishes no workspace env var, so the resolver
    // reads `meta.cwd` from the most-recently-modified session.jsonl under
    // `${codexHome}/sessions/`. Wire codexHome at the call site so the
    // resolver can be exercised under test without process-level mutation.
    if (detected === "codex") {
      codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
    }
  } catch {
    /* detection failure — leave undefined, resolver uses legacy cascade */
  }
  return resolveProjectDir({
    env: process.env,
    cwd: process.cwd(),
    pwd: process.env.PWD,
    transcriptsRoot,
    transcriptMaxAgeMs: 5 * 60 * 1000,
    strictPlatform,
    codexHome,
  });
}

/**
 * Resolve a possibly-relative path against the project directory (full env cascade),
 * not the MCP server's process.cwd(). MCP server is spawned by the host and its cwd
 * is unrelated to where the user is working.
 */
function resolveProjectPath(filePath: string): string {
  return isAbsolute(filePath) ? filePath : resolve(getProjectDir(), filePath);
}

/**
 * Resolve the per-project SessionDB path. Delegates to
 * {@link resolveSessionDbPath} so casing-only variants of the same
 * physical worktree on macOS / Windows hit ONE DB, not two — and any
 * pre-existing legacy raw-casing DB gets migrated in place on first
 * resolve. Linux is a no-op.
 */
function getSessionDbPath(): string {
  return resolveSessionDbPath({
    projectDir: getProjectDir(),
    sessionsDir: getSessionDir(),
  });
}

/**
 * Compute a per-project, per-platform persistent path for the ContentStore.
 * Derives content dir from the adapter's session dir so each platform
 * has its own isolated FTS5 DB — no cross-platform data sharing.
 *
 * Layout: ~/<configDir>/open-context-mode/content/<hash>.db
 *   e.g.  ~/.claude/open-context-mode/content/87c28c41ddb64d38.db
 *         ~/.cursor/open-context-mode/content/87c28c41ddb64d38.db
 */
function getStorePath(): string {
  const dir = ensureWritableStorageDir(resolveContentStorageDir(getDefaultSessionDir));
  // Delegate to resolveContentStorePath: same case-fold + one-shot legacy
  // rename behavior as resolveSessionDbPath. On macOS / Windows, an
  // existing legacy raw-casing FTS5 db (with -wal/-shm sidecars) is
  // migrated in place on first call. On Linux it's a no-op.
  return resolveContentStorePath({ projectDir: getProjectDir(), contentDir: dir });
}

function getStore(): ContentStore {
  const dbPath = getStorePath();
  let _store = _stores.get(dbPath);
  if (!_store) {
    // Content DB cleanup on fresh start is handled by SessionStart hook.
    // Server just opens whatever DB exists (or creates new if hook deleted it).
    _store = new ContentStore(dbPath);
    _stores.set(dbPath, _store);
    // #985: keep the shared content-store WAL bounded even on a hard exit that
    // never reaches close()'s TRUNCATE checkpoint. PASSIVE never blocks and adds
    // no locking (ADR 0001-safe). Default 60s; OPEN_CONTEXT_MODE_WAL_CHECKPOINT_MS
    // tunes it, 0 disables.
    {
      const raw = process.env.OPEN_CONTEXT_MODE_WAL_CHECKPOINT_MS;
      _store.startCheckpointTimer(raw === undefined ? 60000 : Number(raw));
    }

    // Wire deny-policy hook: store re-checks the Read deny list before
    // re-reading any file_path during auto-refresh. Catches policy edits
    // made after a file was originally indexed. See #442 round-3.
    _store.setDenyChecker((filePath: string) => {
      try {
        const projectDir = getProjectDir();
        const denyGlobs = readToolDenyPatterns("Read", projectDir);
        const r = evaluateFilePath(filePath, denyGlobs, process.platform === "win32", projectDir);
        return r.denied;
      } catch {
        // Fail-closed for refresh: skip on error rather than re-read.
        return true;
      }
    });

    // One-time startup cleanup: remove stale content DBs (>14 days)
    try {
      // The store was opened above, into this very directory — never sweep the
      // DB this process is holding.
      const contentDir = dirname(dbPath);
      cleanupStaleContentDBs(contentDir, 14, { exclude: [dbPath] });
      _store.cleanupStaleSources(14);
      // Also clean legacy shared dir from before platform isolation. 14, not 0:
      // a zero maxAge meant "cutoff == now", unlinking every legacy DB on every
      // boot regardless of who owned it (#1024).
      const legacyDir = join(homedir(), ".open-context-mode", "content");
      if (existsSync(legacyDir)) cleanupStaleContentDBs(legacyDir, 14, { exclude: [dbPath] });
      // sessions/ mirrors the same retention window — without it, per-session
      // stats-*.json files and idle per-project session DBs grow without
      // bound (#949: 5k+ files / 331MB on a two-month install).
      cleanupStaleSessionFiles(getSessionDir(), 14);
    } catch {
      /* best-effort */
    }

    // Also clean old PID-based DBs from migration
    cleanupStaleDBs();
  }
  maybeIndexSessionEvents(_store);
  return _store;
}

// ─────────────────────────────────────────────────────────
// Session stats — track context consumption per tool
// ─────────────────────────────────────────────────────────

const sessionStats = {
  calls: {} as Record<string, number>,
  bytesReturned: {} as Record<string, number>,
  bytesIndexed: 0,
  bytesSandboxed: 0, // network I/O consumed inside sandbox (never enters context)
  cacheHits: 0,
  cacheMisses: 0, // open_ctx_fetch_and_index calls that bypassed the TTL cache
  cacheBytesSaved: 0, // bytes avoided by TTL cache hits
  sessionStart: Date.now(),
};

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function storageErrorResult(err: unknown): ToolResult | null {
  if (!(err instanceof StorageDirectoryError)) return null;
  return {
    content: [{ type: "text", text: formatStorageDirectoryError(err) }],
    isError: true,
  };
}
// ── Version outdated warning ──────────────────────────────────────────────
// Non-blocking npm check at startup. trackResponse prepends warning
// using a burst cadence: 3 warnings → 1h silent → 3 warnings → repeat.

let _latestVersion: string | null = null;
let _warningBurstCount = 0;
let _lastBurstStart = 0;
const VERSION_BURST_SIZE = 3;
const VERSION_SILENT_MS = 60 * 60 * 1000; // 1 hour

async function fetchLatestVersion(): Promise<string> {
  return new Promise((res) => {
    const req = httpsRequest("https://registry.npmjs.org/open-context-mode/latest", { headers: { Connection: "close" } }, (resp) => {
      let raw = "";
      resp.on("data", (chunk: Buffer) => {
        raw += chunk;
      });
      resp.on("end", () => {
        try {
          const data = JSON.parse(raw) as { version?: string };
          res(data.version ?? "unknown");
        } catch {
          res("unknown");
        }
      });
    });
    req.on("error", () => res("unknown"));
    req.setTimeout(5000, () => {
      req.destroy();
      res("unknown");
    });
    req.end();
  });
}

function getUpgradeHint(): string {
  // This fork tracks git, not npm — `npm update -g open-context-mode` would
  // downgrade to the last published 1.0.x and overwrite local work.
  return "git pull && npm run build (in the repo)";
}

function semverNewer(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return true;
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return false;
  }
  return false;
}

function isOutdated(): boolean {
  if (!_latestVersion || _latestVersion === "unknown") return false;
  return semverNewer(_latestVersion, VERSION);
}

function shouldShowVersionWarning(): boolean {
  if (!isOutdated()) return false;
  const now = Date.now();
  // Start of a new burst?
  if (_warningBurstCount >= VERSION_BURST_SIZE) {
    if (now - _lastBurstStart < VERSION_SILENT_MS) return false; // still silent
    _warningBurstCount = 0; // silence over, reset burst
  }
  if (_warningBurstCount === 0) _lastBurstStart = now;
  _warningBurstCount++;
  return true;
}

function trackResponse(toolName: string, response: ToolResult): ToolResult {
  // #854: a response is activity too — refresh the bridge-child idle clock so a
  // chatty/streaming call keeps its server alive even between inbound frames.
  noteMcpActivity();
  // Prepend version outdated warning if needed
  if (shouldShowVersionWarning() && response.content.length > 0) {
    const hint = getUpgradeHint();
    response.content[0].text =
      `⚠️ open-context-mode v${VERSION} outdated → v${_latestVersion} available. Upgrade: ${hint}\n\n` + response.content[0].text;
  }

  const bytes = response.content.reduce((sum, c) => sum + Buffer.byteLength(c.text), 0);
  sessionStats.calls[toolName] = (sessionStats.calls[toolName] || 0) + 1;
  sessionStats.bytesReturned[toolName] = (sessionStats.bytesReturned[toolName] || 0) + bytes;

  // Persist a sidecar JSON snapshot for the statusline — read at ~3-5 Hz by
  // bin/statusline.mjs (and any external dashboard) so they don't have to
  // open the SQLite database. Throttled inside persistStats() (500ms) so
  // it's safe to call on every response.
  persistStats();

  // Persist to SessionDB so counters survive process restart, --continue,
  // upgrade. Re-introduces the write path 4742160 added and b392c2f dropped.
  // setImmediate keeps this off the response hot path; the helper itself
  // is best-effort (never throws).
  setImmediate(() => persistToolCallCounter(getSessionDbPath(), toolName, bytes));

  // D2 Phase 5/7 — sandbox-execute event emission. Tracks the bytes the
  // user actually saw from sandboxed runs so getRealBytesStats() can
  // replace the conservative `events × 256` estimate. Best-effort and
  // off the hot path, same shape as persistToolCallCounter above.
  if (toolName === "open_ctx_execute" || toolName === "open_ctx_execute_file" || toolName === "open_ctx_batch_execute") {
    setImmediate(() =>
      emitSandboxExecuteEvent({
        sessionDbPath: getSessionDbPath(),
        toolName,
        bytesReturned: bytes,
      }),
    );
  }

  // Retrieval ("With open-context-mode") bridge — open_ctx_search / open_ctx_fetch_and_index
  // response bytes are the kept-out content the model paid to access. The
  // PostToolUse hook never fires for the plugin's OWN MCP tools, so the
  // hook-side extractMcpToolCall can never see these calls (bytes_retrieved
  // was 0/124454 in prod). Drop the count into a marker keyed by the session
  // DB; the next ordinary-tool PostToolUse consumes it and emits a forwardable
  // bytes_retrieved event. Off the hot path; never throws.
  if (toolName === "open_ctx_search" || toolName === "open_ctx_fetch_and_index") {
    setImmediate(() => appendRetrievalBytes(getSessionDbPath(), bytes));
  }

  return response;
}

function trackIndexed(bytes: number, source: string = "unknown"): void {
  sessionStats.bytesIndexed += bytes;
  persistStats();
  // D2 Phase 5/7 — index-write event emission. `bytes_avoided` because
  // these are bytes that would have flooded context if the user had
  // Read'd the source instead of indexing.
  if (bytes > 0) {
    setImmediate(() =>
      emitIndexWriteEvent({
        sessionDbPath: getSessionDbPath(),
        source,
        bytesAvoided: bytes,
      }),
    );
  }
}

// ─────────────────────────────────────────────────────────
// Stats persistence — written after every tool call so
// external readers (status line scripts, dashboards, hooks)
// can see real-time savings without spawning an MCP client.
// ─────────────────────────────────────────────────────────

const STATS_PERSIST_THROTTLE_MS = 500;
// Schema version for the persisted stats payload (~/.claude/open-context-mode/sessions/stats-*.json).
// Bump when a field is added/renamed/removed. Statusline reads `schemaVersion ?? 0` and warns when
// it sees a future schema, so legacy bundles degrade gracefully on upgrade rather than silently
// rendering missing fields (PR #401 architect review P1.3).
// v2: added tokens_saved_lifetime + dollars_saved_lifetime.
const STATS_SCHEMA_VERSION = 2;
// pricePerToken() intentionally NOT defined here — single source in
// src/session/analytics-metrics.ts imported above. (P1.1 — pricing constant dedup,
// PR #401 architect + ops 2-vote convergence.)
const LIFETIME_REFRESH_MS = 30_000;
// Matches the conversion factor in src/session/analytics-render.ts renderBottomLine:
// ~1KB per session event ÷ 4 bytes/token = 256 tokens/event.
const TOKENS_PER_EVENT = 256;
let _lastStatsPersist = 0;
let _lifetimeCache: { tokens: number; computedAt: number } | undefined;

/**
 * Resolve the per-session stats file path.
 *
 * The session id mirrors the Claude Code adapter contract
 * (`pid-<parent pid>`), so a status line script can derive
 * the same id from `$PPID` without coupling to MCP.
 */
// CLAUDE_SESSION_ID flows from the hosting process (Claude Code, pi, etc.)
// straight into a path.join, and path.join collapses ".." into the result,
// so a host env CLAUDE_SESSION_ID=../../evil writes "stats-evil.json" two
// levels above statsDir. The env var is not under direct MCP-tool-caller
// control, but in CI / multi-tenant contexts where the host env is partly
// influenceable this is an arbitrary-write primitive within the MCP server
// process's filesystem permissions. Constrain to a UUID-shaped charset
// before splicing into the stats filename.
const SESSION_ID_RE = /^[A-Za-z0-9._-]+$/;
function sanitizeSessionId(raw: string): string {
  return SESSION_ID_RE.test(raw) ? raw : `pid-${process.ppid}`;
}

function getStatsStorageDir(): string {
  return ensureWritableStorageDir(resolveStatsStorageDir(getDefaultSessionDir));
}

function getStatsFilePath(): string {
  const raw = process.env.CLAUDE_SESSION_ID || `pid-${process.ppid}`;
  const sessionId = sanitizeSessionId(raw);
  return join(getStatsStorageDir(), `stats-${sessionId}.json`);
}

/**
 * Derive the persisted savings figures from the raw session counters.
 *
 * Bytes returned to the model were already counted when their source was
 * indexed, so adding them again to the kept-out total counted the same
 * universe twice — inflating total_processed and, worse, letting
 * tokens_saved claim bytes the agent actually received (#1025). Netting
 * them out makes total_processed the real universe and leaves tokens_saved
 * counting only bytes that never reached the model.
 *
 * Exported so the formula is directly testable. The alternative — asserting
 * on the source text — passes no matter what the arithmetic does.
 */
export function computeSavings(counters: {
  bytesIndexed: number;
  bytesSandboxed: number;
  cacheBytesSaved: number;
  bytesReturned: number;
}): {
  keptOut: number;
  totalProcessed: number;
  reductionPct: number;
  tokensSaved: number;
} {
  const universe = counters.bytesIndexed + counters.bytesSandboxed + counters.cacheBytesSaved;
  const keptOut = Math.max(0, universe - counters.bytesReturned);
  const totalProcessed = keptOut + counters.bytesReturned;
  return {
    keptOut,
    totalProcessed,
    reductionPct: totalProcessed > 0 ? Math.round((1 - counters.bytesReturned / totalProcessed) * 100) : 0,
    tokensSaved: Math.round(keptOut / 4),
  };
}

function persistStats(): void {
  const now = Date.now();
  if (now - _lastStatsPersist < STATS_PERSIST_THROTTLE_MS) return;
  _lastStatsPersist = now;

  try {
    const totalReturned = Object.values(sessionStats.bytesReturned).reduce((a, b) => a + b, 0);
    const totalCalls = Object.values(sessionStats.calls).reduce((a, b) => a + b, 0);
    const { keptOut, totalProcessed, reductionPct, tokensSaved } = computeSavings({
      bytesIndexed: sessionStats.bytesIndexed,
      bytesSandboxed: sessionStats.bytesSandboxed,
      cacheBytesSaved: sessionStats.cacheBytesSaved,
      bytesReturned: totalReturned,
    });

    // Lifetime aggregation is explicitly requested through open_ctx_stats and
    // published once for every bridge sharing this adapter's stats directory.
    // Heartbeats only read that O(1) snapshot; they never discover or open DBs.
    let lifetimeTokens = _lifetimeCache?.tokens ?? 0;
    if (!_lifetimeCache || now - _lifetimeCache.computedAt > LIFETIME_REFRESH_MS) {
      const snapshot = readLifetimeTokenSnapshot(getStatsStorageDir());
      lifetimeTokens = snapshot?.tokens ?? lifetimeTokens;
      _lifetimeCache = { tokens: lifetimeTokens, computedAt: now };
    }

    const payload = {
      schemaVersion: STATS_SCHEMA_VERSION,
      version: VERSION,
      updated_at: now,
      session_start: sessionStats.sessionStart,
      uptime_ms: now - sessionStats.sessionStart,
      total_calls: totalCalls,
      bytes_returned: totalReturned,
      bytes_indexed: sessionStats.bytesIndexed,
      bytes_sandboxed: sessionStats.bytesSandboxed,
      cache_hits: sessionStats.cacheHits,
      cache_bytes_saved: sessionStats.cacheBytesSaved,
      kept_out: keptOut,
      total_processed: totalProcessed,
      reduction_pct: reductionPct,
      tokens_saved: tokensSaved,
      // statusline-facing $ values — pre-computed at the current per-token
      // rate (dynamic when PI_OPEN_CONTEXT_MODE_PRICE_OUTPUT_PER_TOKEN is set by a
      // Pi host; Opus $15/1M otherwise). Resolved on every persist via
      // pricePerToken() so the env override picks up without an MCP restart.
      dollars_saved_session: +(tokensSaved * pricePerToken()).toFixed(2),
      tokens_saved_lifetime: lifetimeTokens,
      dollars_saved_lifetime: +(lifetimeTokens * pricePerToken()).toFixed(2),
      by_tool: Object.fromEntries(
        Object.keys({ ...sessionStats.calls, ...sessionStats.bytesReturned }).map((t) => [
          t,
          {
            calls: sessionStats.calls[t] || 0,
            bytes: sessionStats.bytesReturned[t] || 0,
          },
        ]),
      ),
    };

    const filePath = getStatsFilePath();
    const tmpPath = `${filePath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(payload));
    renameSync(tmpPath, filePath);
  } catch {
    // best-effort — never break tool calls because of stats persistence
  }
}

// ==============================================================================
// Security: server-side deny firewall
// ==============================================================================

/**
 * Check a shell command against Bash deny patterns.
 * Returns an error ToolResult if denied, or null if allowed.
 */
function checkDenyPolicy(command: string, toolName: string): ToolResult | null {
  try {
    const policies = readBashPolicies(process.env.CLAUDE_PROJECT_DIR);
    const result = evaluateCommandDenyOnly(command, policies);
    if (result.decision === "deny") {
      return trackResponse(toolName, {
        content: [
          {
            type: "text" as const,
            text: denyPatternReason({ lead: "Command", pattern: result.matchedPattern }),
          },
        ],
        isError: true,
      });
    }
  } catch {
    // Security check failed — allow through (fail-open for server,
    // hooks are the primary enforcement layer)
  }
  return null;
}

/**
 * Check non-shell code for shell-escape calls against deny patterns.
 */
function checkNonShellDenyPolicy(code: string, language: string, toolName: string): ToolResult | null {
  try {
    const commands = extractShellCommands(code, language);
    if (commands.length === 0) return null;
    const policies = readBashPolicies(process.env.CLAUDE_PROJECT_DIR);
    for (const cmd of commands) {
      const result = evaluateCommandDenyOnly(cmd, policies);
      if (result.decision === "deny") {
        return trackResponse(toolName, {
          content: [
            {
              type: "text" as const,
              text: denyPatternReason({ lead: "Command", subject: `embedded shell command "${cmd}"`, pattern: result.matchedPattern }),
            },
          ],
          isError: true,
        });
      }
    }
  } catch {
    // Fail-open
  }
  return null;
}

/**
 * Issue #852 — project-boundary containment for `open_ctx_execute_file`.
 *
 * The harness sandbox (Claude Code, etc.) cannot inspect MCP input params, so a
 * user approving a `open_ctx_execute_file` call cannot see that its `path` escapes
 * the workspace. This guard refuses a `path` that resolves outside the project
 * root (absolute escape, `../` traversal, or symlink-out), restoring the
 * boundary the host believes it is enforcing.
 *
 * Escape hatch — NO bespoke opt-out env. A deliberate out-of-project read is
 * expressed in the SAME host config the user already maintains: a
 * `permissions.allow` rule like `Read(/var/log/**)`. This reuses the exact
 * mechanism Claude Code uses to whitelist a path outside its sandbox, so the
 * grant lives in one place and stays meaningful instead of rotting into a
 * open-context-mode-only env flag nobody sets.
 *
 * Fail-open on resolver failure (consistent with the other deny checks): if the
 * project root cannot be resolved, containment evaluates as "inside" and the
 * path is allowed through rather than spuriously blocking legitimate work.
 */
function checkProjectBoundary(filePath: string, toolName: string): ToolResult | null {
  try {
    const projectDir = getProjectDir();
    const allowGlobs = readToolPermissionPatterns("Read", "allow", projectDir);
    const verdict = evaluateProjectContainment(filePath, projectDir, allowGlobs);
    if (verdict.allowed) return null;
    return trackResponse(toolName, {
      content: [
        {
          type: "text" as const,
          text:
            `File access blocked: "${filePath}" resolves outside the project root ` +
            `(${projectDir}). open-context-mode confines ${toolName} to the workspace so it ` +
            `cannot be used to bypass the host's sandbox/permission controls (issue #852). ` +
            `To intentionally process a file outside the project, add a host allow rule, ` +
            `e.g. "permissions": { "allow": ["Read(${filePath})"] } in your settings.`,
        },
      ],
      isError: true,
    });
  } catch {
    // Fail-open — resolver failure must not block legitimate in-project work.
  }
  return null;
}

/**
 * Check a file path against Read deny patterns.
 * Returns an error ToolResult if denied, or null if allowed.
 */
function checkFilePathDenyPolicy(filePath: string, toolName: string): ToolResult | null {
  try {
    const projectDir = getProjectDir();
    const denyGlobs = readToolDenyPatterns("Read", projectDir);
    const result = evaluateFilePath(filePath, denyGlobs, process.platform === "win32", projectDir);
    if (result.denied) {
      return trackResponse(toolName, {
        content: [
          {
            type: "text" as const,
            text: denyPatternReason({ lead: "File access", subject: "path", read: true, pattern: result.matchedPattern }),
          },
        ],
        isError: true,
      });
    }
  } catch {
    // Fail-open
  }
  return null;
}

// Build description dynamically based on detected runtimes
const langList = available.join(", ");
const bunNote = hasBunRuntime() ? " (Bun detected — JS/TS runs 3-5x faster)" : "";

// ─────────────────────────────────────────────────────────
// Helper: smart snippet extraction — returns windows around
// matching query terms instead of dumb truncation
//
// When `highlighted` is provided (from FTS5 `highlight()` with
// STX/ETX markers), match positions are derived from the markers.
// This is the authoritative source — FTS5 uses the exact same
// tokenizer that produced the BM25 match, so stemmed variants
// like "configuration" matching query "configure" are found
// correctly. Falls back to indexOf on raw terms when highlighted
// is absent (non-FTS codepath).
// ─────────────────────────────────────────────────────────

const STX = "\x02";
const ETX = "\x03";

/**
 * Parse FTS5 highlight markers to find match positions in the
 * original (marker-free) text. Returns character offsets into the
 * stripped content where each matched token begins.
 */
export function positionsFromHighlight(highlighted: string): number[] {
  const positions: number[] = [];
  let cleanOffset = 0;

  let i = 0;
  while (i < highlighted.length) {
    if (highlighted[i] === STX) {
      // Record position of this match in the clean text
      positions.push(cleanOffset);
      i++; // skip STX
      // Advance through matched text until ETX
      while (i < highlighted.length && highlighted[i] !== ETX) {
        cleanOffset++;
        i++;
      }
      if (i < highlighted.length) i++; // skip ETX
    } else {
      cleanOffset++;
      i++;
    }
  }

  return positions;
}

/** Strip STX/ETX markers to recover original content. */
function stripMarkers(highlighted: string): string {
  return highlighted.replaceAll(STX, "").replaceAll(ETX, "");
}

export function extractSnippet(content: string, query: string, maxLen = 1500, highlighted?: string): string {
  if (content.length <= maxLen) return content;

  // Derive match positions from FTS5 highlight markers when available
  const positions: number[] = [];

  if (highlighted) {
    for (const pos of positionsFromHighlight(highlighted)) {
      positions.push(pos);
    }
  }

  // Fallback: indexOf on raw query terms (non-FTS codepath)
  if (positions.length === 0) {
    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 2);
    const lower = content.toLowerCase();

    for (const term of terms) {
      let idx = lower.indexOf(term);
      while (idx !== -1) {
        positions.push(idx);
        idx = lower.indexOf(term, idx + 1);
      }
    }
  }

  // No matches at all — return prefix
  if (positions.length === 0) {
    return charSafePrefix(content, maxLen) + "\n…";
  }

  // Sort positions, merge overlapping windows
  positions.sort((a, b) => a - b);
  const WINDOW = 300;
  const windows: Array<[number, number]> = [];

  for (const pos of positions) {
    const start = Math.max(0, pos - WINDOW);
    const end = Math.min(content.length, pos + WINDOW);
    if (windows.length > 0 && start <= windows[windows.length - 1][1]) {
      windows[windows.length - 1][1] = end;
    } else {
      windows.push([start, end]);
    }
  }

  // Collect windows until maxLen
  const parts: string[] = [];
  let total = 0;
  for (const [start, end] of windows) {
    if (total >= maxLen) break;
    const part = charSafeSlice(content, start, Math.min(end, start + (maxLen - total)));
    parts.push((start > 0 ? "…" : "") + part + (end < content.length ? "…" : ""));
    total += part.length;
  }

  return parts.join("\n\n");
}

export type BatchQueryScope = "batch" | "global";

// The batch-scope tip is identical on every non-global open_ctx_batch_execute call,
// so it is emitted once per server process (the first non-global batch) instead
// of repeated on every call. resetBatchFooterState() restores the initial state
// so tests are deterministic under vitest's shared fork pool.
let batchScopeTipShown = false;

export function resetBatchFooterState(): void {
  batchScopeTipShown = false;
}

/**
 * Render one section per query over the batch's indexed chunks.
 *
 * `deadline` (#947) is the caller's wall-clock budget as an absolute
 * `Date.now()`. Indexing and FTS search are synchronous SQLite, so a JS timer
 * cannot interrupt a query already in flight — the check runs BETWEEN queries
 * instead, which is what turns "120s requested, 257 minutes spent" into "120s
 * requested, one more query, then an answer that says what it skipped".
 * `stats.budgetExhausted` reports that for the caller's summary line.
 */
export function formatBatchQueryResults(
  store: ContentStore,
  queries: string[],
  source: string,
  maxOutput = 80 * 1024,
  scope: BatchQueryScope = "batch",
  stats?: { anyMiss: boolean; budgetExhausted?: boolean; searched?: number },
  deadline?: number,
): string[] {
  const sections: string[] = [];
  let outputSize = 0;

  // When scope is "global", searchWithFallback receives `undefined` for the
  // source filter, which makes it query the entire persistent index instead
  // of only the chunks just produced by this batch's commands. Default
  // remains "batch" to preserve the historical behavior.
  const searchSource = scope === "global" ? undefined : source;

  for (const query of queries) {
    if (deadline !== undefined && Date.now() >= deadline) {
      if (stats) stats.budgetExhausted = true;
      sections.push(`## ${query}\n(search budget spent — run open_ctx_search(queries: ["${query}"]) on its own)\n`);
      continue;
    }

    if (outputSize > maxOutput) {
      sections.push(`## ${query}\n(output cap reached — use open_ctx_search(queries: ["${query}"]) for details)\n`);
      continue;
    }

    if (stats) stats.searched = (stats.searched ?? 0) + 1;
    const results = store.searchWithFallback(query, 3, searchSource, undefined, "exact");
    sections.push(`## ${query}`);
    sections.push("");
    if (results.length > 0) {
      for (const result of results) {
        const snippet = extractSnippet(result.content, query, 3000, result.highlighted);
        sections.push(`### ${result.title}`);
        sections.push(snippet);
        sections.push("");
        outputSize += snippet.length + result.title.length;
      }
      continue;
    }

    if (stats) stats.anyMiss = true;
    sections.push("No matching sections found.");
    sections.push("");
  }

  if (scope === "global") {
    sections.push(`\n> **Scope:** Queries searched the entire persistent index (query_scope: "global").`);
  } else if (!batchScopeTipShown) {
    batchScopeTipShown = true;
    sections.push(
      `\n> **Tip:** Results are scoped to this batch only. To search across all indexed sources, use \`open_ctx_search(queries: [...])\` or call open_ctx_batch_execute with \`query_scope: "global"\`.`,
    );
  }

  return sections;
}

/**
 * Cross-query dedup for a multi-query open_ctx_search call. A chunk that matches
 * more than one query would otherwise print verbatim under each query's
 * section. Results carry no stable chunk id (see SearchResult /
 * UnifiedSearchResult), so identity is the query-independent
 * `source title content` tuple; the emitted snippet is windowed per query
 * and cannot be used as a key. `seen` is shared across the call's queries and
 * mutated in place, so the first occurrence of a chunk is kept and later
 * repeats are dropped.
 */
export function dedupeAcrossQueries<T extends { source: string; title: string; content: string }>(results: T[], seen: Set<string>): T[] {
  return results.filter((r) => {
    const key = [r.source, r.title, r.content].join(" ");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ─────────────────────────────────────────────────────────
// batch_execute runner — used by open_ctx_batch_execute handler
// ─────────────────────────────────────────────────────────

export interface BatchCommand {
  label: string;
  command: string;
}

export interface BatchRunResult {
  outputs: string[];
  timedOut: boolean;
}

export interface BatchRunOptions {
  /**
   * Milliseconds. Total budget (concurrency=1, shared) or per-command (concurrency>1).
   * When `undefined`, no server-side timer fires and the host is left to
   * bound the call (Issue #406) — which not every host does, see
   * {@link HOST_DEFAULT_EXEC_TIMEOUT_MS}.
   */
  timeout: number | undefined;
  /**
   * Whether `timeout` is a budget the CALLER asked for. A budget that only
   * came from {@link HOST_DEFAULT_EXEC_TIMEOUT_MS} is a per-command backstop
   * against one hung command, not a promise about total batch duration, so
   * spending it across commands would silently truncate a long batch nobody
   * put a deadline on. Defaults to true, preserving the historical shared
   * budget for an explicit `timeout`.
   */
  callerBudget?: boolean;
  concurrency: number;
  nodeOptsPrefix: string;
  cwd?: string;
  signal?: AbortSignal;
  onFsBytes?: (bytes: number) => void;
}

interface BatchExecutor {
  execute(input: {
    language: "shell";
    code: string;
    timeout: number | undefined;
    cwd?: string;
    signal?: AbortSignal;
  }): Promise<{ stdout: string; timedOut?: boolean }>;
}

function quotePosixSingle(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function quotePowerShellSingle(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Wrap open_ctx_execute JS/TS code with FS and network byte instrumentation.
 * Exported so tests can run the real wrapper instead of grepping the source.
 *
 * The second parameter is the keep-alive flag, not the raw `background`:
 * this fork gates the no-op setInterval on an effective timeout existing
 * (#975), so the caller passes `background && effTimeout !== undefined`.
 */
export function buildJsInstrumentedCode(code: string, keepAlive: boolean): string {
  // Wrap user code in a closure that shadows CJS require with http/https interceptor.
  // globalThis.require does NOT work because CJS require is module-scoped, not global.
  // The closure approach (function(__cm_req){ var require=...; })(require) correctly
  // shadows the CJS require for all code inside, including __cm_main().
  return `
${CM_TEXT_BYTES_JS}
// FS read instrumentation — count text bytes read via fs.readFileSync/readFile
let __cm_fs=0;
process.on('exit',()=>{if(__cm_fs>0)try{process.stderr.write('__CM_FS__:'+__cm_fs+'\\n')}catch{}});
(function(){
  try{
    var f=typeof require!=='undefined'?require('fs'):null;
    if(!f)return;
    var ors=f.readFileSync;
    f.readFileSync=function(){var r=ors.apply(this,arguments);__cm_fs+=__cm_tb(r);return r;};
    var orf=f.readFile;
    if(orf)f.readFile=function(){var a=Array.from(arguments),cb=a.pop();orf.apply(this,a.concat([function(e,d){if(!e&&d)__cm_fs+=__cm_tb(d);cb(e,d);}]));};
  }catch{}
})();
let __cm_net=0;
// Report network bytes on process exit — works with both promise and callback patterns.
// process.on('exit') fires after all I/O completes, unlike .finally() which fires
// when __cm_main() resolves (immediately for callback-based http.get without await).
process.on('exit',()=>{if(__cm_net>0)try{process.stderr.write('__CM_NET__:'+__cm_net+'\\n')}catch{}});
;(function(__cm_req){
// Intercept globalThis.fetch
const __cm_f=globalThis.fetch;
globalThis.fetch=async(...a)=>{const r=await __cm_f(...a);
try{const cl=r.clone();const b=await cl.arrayBuffer();__cm_net+=__cm_tb(b)}catch{}
return r};
// Shadow CJS require with http/https network tracking.
// A response is classified once, from its first chunk.
function __cm_track(res){let bin=null;res.on('data',function(c){if(bin===null)bin=__cm_tb(c)===0&&c.length>0;if(!bin)__cm_net+=c.length});}
const __cm_hc=new Map();
const __cm_hm=new Set(['http','https','node:http','node:https']);
function __cm_wf(m,origFn){return function(...a){
  const li=a.length-1;
  if(li>=0&&typeof a[li]==='function'){const oc=a[li];a[li]=function(res){
    __cm_track(res);oc(res);};}
  const req=origFn.apply(m,a);
  const oOn=req.on.bind(req);
  req.on=function(ev,cb,...r){
    if(ev==='response'){return oOn(ev,function(res){
      __cm_track(res);cb(res);
    },...r);}
    return oOn(ev,cb,...r);
  };
  return req;
}}
var require=__cm_req?function(id){
  const m=__cm_req(id);
  if(!__cm_hm.has(id))return m;
  const k=id.replace('node:','');
  if(__cm_hc.has(k))return __cm_hc.get(k);
  const w=Object.create(m);
  if(typeof m.get==='function')w.get=__cm_wf(m,m.get);
  if(typeof m.request==='function')w.request=__cm_wf(m,m.request);
  __cm_hc.set(k,w);return w;
}:__cm_req;
if(__cm_req){if(__cm_req.resolve)require.resolve=__cm_req.resolve;
if(__cm_req.cache)require.cache=__cm_req.cache;}
async function __cm_main(){
${code}
}
__cm_main().catch(e=>{console.error(e);process.exitCode=1});${keepAlive ? "\nsetInterval(()=>{},2147483647);" : ""}
})(typeof require!=='undefined'?require:null);`;
}

export function buildBatchNodeOptionsPrefix(shellPath: string, preloadPath: string): string {
  const option = `--require ${preloadPath}`;
  const shell = shellPath.toLowerCase();
  const base = shell.split(/[\\/]/).pop() ?? shell;

  if (shell.includes("powershell") || shell.includes("pwsh")) {
    return `$env:NODE_OPTIONS=${quotePowerShellSingle(option)}; `;
  }

  if (base === "cmd" || base === "cmd.exe") {
    return `set "NODE_OPTIONS=${option.replace(/"/g, '""')}" && `;
  }

  // `export …;` rather than an inline `NODE_OPTIONS=… cmd` assignment: an
  // inline assignment is a syntax error before compound commands (`for`,
  // `while`, `if`, `{ … }`) and only reaches the first command of a `&&` or
  // `|` chain (#1117). Each batch command runs in its own shell, so the export
  // does not leak between commands.
  return `export NODE_OPTIONS=${quotePosixSingle(option)}; `;
}

/**
 * Per-section budget for the echoed `$ <command>` line so a 50KB heredoc
 * payload cannot dominate the response body. The full command always reaches
 * the executor — only the echo is clipped (Issues #717 + #736).
 *
 * Tunable via OPEN_CONTEXT_MODE_COMMAND_ECHO_MAX. Hosts that already render the
 * tool input alongside the result show the command twice, so `0` drops the
 * echo for them; every other host keeps the default.
 */
export const DEFAULT_COMMAND_ECHO_MAX = 500;

/**
 * Read an echo budget from the environment. Unlike readPositiveEnv, `0` is a
 * meaningful value (echo suppressed), so the parse is strict: only a run of
 * digits counts. Empty, whitespace-only, negative and non-numeric input falls
 * back to the default rather than silently suppressing the echo.
 */
function resolveEchoBudget(name: string, defaultValue: number): number {
  const raw = process.env[name]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return defaultValue;
  return Number(raw);
}

function commandEchoBudget(): number {
  return resolveEchoBudget("OPEN_CONTEXT_MODE_COMMAND_ECHO_MAX", DEFAULT_COMMAND_ECHO_MAX);
}

function truncateCommandForEcho(command: string, budget: number): string {
  const cleaned = command.replace(/\s+/g, " ").trim();
  if (cleaned.length <= budget) return cleaned;
  return cleaned.slice(0, budget) + "…";
}

/**
 * Default execution timeout (ms) applied ONLY under Antigravity CLI (`agy`).
 * agy does not enforce an MCP RPC timeout, so a open_ctx_execute with a runaway or
 * blocking script hangs forever — the host never kills it and the user must
 * interrupt. Every other host enforces its own RPC timeout, so we keep the
 * no-server-timer behavior there (Issue #406 — long builds need an unbounded
 * run). A caller can still pass an explicit `timeout` to override on any host.
 *
 * Some hosts' RPC timeouts are effectively unbounded in practice — Claude Code
 * stdio before v2.1.203 exempted stdio MCP servers from the idle timeout, so a
 * hung open_ctx_execute blocked the agent until manual interruption (#936).
 * OPEN_CONTEXT_MODE_DEFAULT_EXEC_TIMEOUT_MS lets users opt into a bounded default on
 * any host; an explicit per-call `timeout` still wins, and under agy the
 * platform-specific OPEN_CONTEXT_MODE_AGY_EXEC_TIMEOUT_MS takes precedence over it.
 */
export const AGY_DEFAULT_EXEC_TIMEOUT_MS = 120_000;
/**
 * Default execution timeout (ms) under Pi (Issue #959).
 *
 * Pi's bridge deliberately forwards `tools/call` with
 * `Number.POSITIVE_INFINITY` (#643, so long builds are not cut off at the
 * transport), and its registered-tool callback does not yet propagate Pi's
 * AbortSignal — so with no server-side timer a hung child is unbounded at
 * EVERY layer and Esc cannot clear it. Measured: a `grep -rn` over a large
 * tree ran 75 minutes on Pi 0.84.x and only ended when the session was killed;
 * independently reported on macOS, Linux and Windows in #959.
 *
 * Deliberately far more generous than the agy budget: #643 removed the
 * bridge's 120s ceiling precisely because real open_ctx_execute calls (test
 * suites, `npm run build`, `cargo test`) legitimately run 2—5 minutes. 10
 * minutes clears those by a wide margin while still bounding a true hang.
 * Longer jobs remain expressible with an explicit `timeout`, or with
 * `background: true` to detach instead of being killed.
 */
export const PI_DEFAULT_EXEC_TIMEOUT_MS = 600_000;

/**
 * Per-host fallback execution budget, applied only when the caller passes no
 * explicit `timeout` and OPEN_CONTEXT_MODE_DEFAULT_EXEC_TIMEOUT_MS is unset (#936
 * opt-in still wins on every host).
 *
 * A host belongs here when nothing outside the executor bounds an in-flight
 * tool call, so "no timeout" means "hang until the user intervenes".
 *
 * Hosts absent from this table keep today's unbounded behavior. #406 asked for
 * a server-enforced default everywhere and was declined because "server-side
 * timeout enforcement is the wrong layer "every MCP host already enforces its
 * own RPC timeout". That reasoning holds wherever the premise does; this table
 * is only for the hosts where it does not.
 */
/** Backstop for an MCP client that does not bound an in-flight call. */
export const MCP_DEFAULT_EXEC_TIMEOUT_MS = 300_000;

/**
 * Largest delay `setTimeout` represents (2^31-1 ms, ~24.8 days). Node wraps
 * anything larger back to a 1ms delay with a TimeoutOverflowWarning, so a
 * value above this fires almost immediately — a bigger number producing
 * harsher behavior. Such a value is treated as unusable rather than honored.
 */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * Parse an env-supplied execution budget, returning `undefined` when the value
 * cannot be honored as written: unset, blank, non-numeric, non-integer, zero,
 * negative, or beyond {@link MAX_TIMER_DELAY_MS}. Callers fall back to the host
 * default, so neither a typo nor an over-large "effectively unlimited" value
 * can resurrect the hang or collapse the budget to ~1ms.
 */
function parseExecTimeoutEnv(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  const value = Number(trimmed);
  if (!Number.isInteger(value)) return undefined;
  if (value <= 0 || value > MAX_TIMER_DELAY_MS) return undefined;
  return value;
}
export function resolveExecTimeout(timeoutMs: number | undefined): number | undefined {
  if (timeoutMs !== undefined) return timeoutMs;
  // #936 opt-in: the generic var applies on EVERY host — strict parse, so
  // a typo'd or over-large value falls through instead of resurrecting the
  // hang (#1147) or collapsing the budget to ~1ms.
  const generic = parseExecTimeoutEnv(process.env.OPEN_CONTEXT_MODE_DEFAULT_EXEC_TIMEOUT_MS);
  if (generic !== undefined) return generic;
  // OpenCode bounds its own RPC calls. A generic MCP client may not, so it
  // gets a backstop against one hung command (#406, #1147).
  return detectPlatform().platform === "opencode" ? undefined : MCP_DEFAULT_EXEC_TIMEOUT_MS;
}

interface LegacyTimeoutArguments {
  readonly timeoutMs?: number;
  readonly timeout?: unknown;
}

/**
 * Issue #1081 — `timeout` was renamed to `timeoutMs`. Zod strips unknown keys,
 * so a caller still sending `timeout` would get no deadline at all: a caller
 * that meant two minutes gets an unbounded run instead. The three sandbox tools
 * declare `.passthrough()` so the legacy key survives parsing and reaches this
 * guard, which fails the call. The value is never read as a deadline, so
 * `timeout` is not an alias.
 */
export function checkLegacyTimeoutArg(args: LegacyTimeoutArguments, toolName: string): ToolResult | null {
  if (!Object.hasOwn(args, "timeout")) return null;
  return trackResponse(toolName, {
    content: [
      {
        type: "text" as const,
        text:
          `Input validation error: Invalid arguments for tool ${toolName}: ` +
          "`timeout` was renamed to `timeoutMs` and is no longer accepted. " +
          "Resend with `timeoutMs` in milliseconds — timeoutMs: 120000 is two minutes.",
      },
    ],
    isError: true,
  });
}

/**
 * Per-call budget for the source-code echo prepended by `open_ctx_execute` and
 * `open_ctx_execute_file` (Issues #717 + #736). The full code always reaches the
 * sandbox — only the echo is clipped so massive payloads don't dominate
 * the response. Multi-line preserved (unlike command echo) so the user
 * sees the actual program shape.
 *
 * Tunable via OPEN_CONTEXT_MODE_CODE_ECHO_MAX — see DEFAULT_COMMAND_ECHO_MAX.
 */
export const DEFAULT_CODE_ECHO_MAX = 2000;

function codeEchoBudget(): number {
  return resolveEchoBudget("OPEN_CONTEXT_MODE_CODE_ECHO_MAX", DEFAULT_CODE_ECHO_MAX);
}

function truncateCodeForEcho(code: string, budget: number): string {
  if (code.length <= budget) return code;
  return code.slice(0, budget) + "\n… (truncated)";
}

/**
 * Build the source-code preamble surfaced before tool stdout. Provenance
 * survives in indexed chunks (FTS5 sees the fenced block) so later
 * open_ctx_search hits remember what ran. A zero budget drops the preamble for
 * hosts that already render the tool input.
 */
function buildExecuteEcho(language: string, code: string, path?: string): string {
  const budget = codeEchoBudget();
  if (budget === 0) return "";
  const header = path ? `path=${path}\n` : "";
  const fenced = `\`\`\`${language}\n${truncateCodeForEcho(code, budget)}\n\`\`\``;
  return `${header}${fenced}\n\n`;
}

function formatCommandOutput(label: string, command: string, raw: string, onFsBytes?: (bytes: number) => void): string {
  let output = raw || "(no output)";
  // Belt: the preload reports on a side file since #1068, so a `__CM_FS__`
  // marker can no longer reach here from it. Kept because a command can still
  // print one itself (or a child can, via an inherited NODE_OPTIONS from an
  // older preload still on disk) — stripping it keeps harness telemetry out of
  // the agent's context window either way.
  const fsMatches = output.matchAll(/__CM_FS__:(\d+)/g);
  let cmdFsBytes = 0;
  for (const m of fsMatches) cmdFsBytes += parseInt(m[1]);
  if (cmdFsBytes > 0) {
    onFsBytes?.(cmdFsBytes);
    output = output.replace(/__CM_FS__:\d+\n?/g, "");
  }
  // Echo the executed command below the section heading so per-chunk
  // indexed content retains provenance for later open_ctx_search hits
  // (Issues #717 + #736).
  const budget = commandEchoBudget();
  const echo = budget === 0 ? "" : `$ ${truncateCommandForEcho(command, budget)}\n\n`;
  return `# ${label}\n\n${echo}${output}\n`;
}

function combineExecOutput(result: { stdout?: string; stderr?: string }): string {
  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  if (!stderr) return stdout;
  if (!stdout) return stderr;
  return `${stdout}${stdout.endsWith("\n") ? "" : "\n"}${stderr}`;
}

/**
 * Execute batch commands. concurrency=1 preserves the legacy serial path
 * (shared timeout budget + cascading skip-on-timeout). concurrency>1 runs
 * commands concurrently with at most N in flight; each command receives the
 * full timeout, output is collated by input index, and per-command timeouts
 * record `(timed out)` blocks without skipping siblings.
 */
export async function runBatchCommands(commands: BatchCommand[], opts: BatchRunOptions, executor: BatchExecutor): Promise<BatchRunResult> {
  const { timeout, concurrency, nodeOptsPrefix, cwd, signal, onFsBytes, callerBudget = true } = opts;
  // A host-default budget applies per command (like the parallel path below);
  // only a caller-supplied budget is shared across the batch.
  const sharedBudget = callerBudget ? timeout : undefined;

  if (concurrency <= 1) {
    // Serial path — shared timeout budget, cascading skip on timeout.
    // When `timeout` is undefined, no shared budget is enforced; each
    // command runs to completion (Issue #406).
    const outputs: string[] = [];
    const startTime = Date.now();
    let timedOut = false;
    for (let i = 0; i < commands.length; i++) {
      const cmd = commands[i];
      let perCmdTimeout: number | undefined = timeout;
      if (sharedBudget !== undefined) {
        const elapsed = Date.now() - startTime;
        const remaining = sharedBudget - elapsed;
        if (remaining <= 0) {
          outputs.push(`# ${cmd.label}\n\n(skipped — batch timeout exceeded)\n`);
          timedOut = true;
          continue;
        }
        perCmdTimeout = remaining;
      }
      const result = await executor.execute({
        language: "shell",
        code: `${nodeOptsPrefix}${cmd.command}`,
        timeout: perCmdTimeout,
        cwd,
        signal,
      });
      outputs.push(formatCommandOutput(cmd.label, cmd.command, combineExecOutput(result), onFsBytes));
      if (result.timedOut) {
        timedOut = true;
        for (let j = i + 1; j < commands.length; j++) {
          outputs.push(`# ${commands[j].label}\n\n(skipped — batch timeout exceeded)\n`);
        }
        break;
      }
    }
    return { outputs, timedOut };
  }

  // Parallel path — delegated to the shared runPool primitive.
  // Each job returns { output, timedOut }; runPool handles in-flight cap,
  // throw isolation (Promise.allSettled semantics), and order preservation.
  const jobs: PoolJob<{ output: string; timedOut: boolean }>[] = commands.map((cmd) => ({
    run: async () => {
      const result = await executor.execute({
        language: "shell",
        code: `${nodeOptsPrefix}${cmd.command}`,
        timeout,
        cwd,
        signal,
      });
      // Always route partial output through formatCommandOutput so __CM_FS__
      // markers are stripped + counted, even when the command timed out.
      const formatted = formatCommandOutput(cmd.label, cmd.command, combineExecOutput(result), onFsBytes);
      const output = result.timedOut ? formatted.replace(/\n$/, "") + `\n(timed out after ${timeout ?? "?"}ms)\n` : formatted;
      return { output, timedOut: !!result.timedOut };
    },
  }));

  const { settled } = await runPool(jobs, { concurrency });
  const outputs: string[] = new Array(commands.length);
  let timedOut = false;
  for (let i = 0; i < settled.length; i++) {
    const r = settled[i];
    if (r.status === "fulfilled") {
      outputs[i] = r.value.output;
      if (r.value.timedOut) timedOut = true;
    } else {
      // Isolated executor throw (spawn EAGAIN, ENOMEM, EMFILE, …) — siblings keep running.
      const message = r.reason instanceof Error ? r.reason.message : String(r.reason);
      outputs[i] = `# ${commands[i].label}\n\n(executor error: ${message})\n`;
    }
  }
  return { outputs, timedOut };
}

// ─────────────────────────────────────────────────────────
// Tool pipeline — the shared registration shell (src/tool-pipeline.ts).
// registerCtxTool owns gate dispatch, error normalization, accounting and
// progress wiring; executionOutcome owns the open_ctx_execute/_file output ladder.
// Routing through the patched server.registerTool keeps suppression,
// allowlisting and wrapToolHandler wrapping in force.
// ─────────────────────────────────────────────────────────
const { registerCtxTool, executionOutcome } = createCtxToolPipeline({
  registerTool: (name, config, handler) =>
    (server as unknown as { registerTool: (...args: unknown[]) => unknown }).registerTool(name, config, handler),
  trackResponse,
  trackIndexed,
  intentSearch,
  indexStdout,
});

// ─────────────────────────────────────────────────────────
// Tool: execute
// ─────────────────────────────────────────────────────────
registerCtxTool(
  "open_ctx_execute",
  {
    // #852: surface code execution in the host approval prompt's title (the
    // only server-controlled field the MCP permission UI renders besides args).
    title: "Run code in a sandbox (executes the supplied code)",
    // #846: runs arbitrary code in a sandbox with full network access.
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    description: `Run code in a sandboxed subprocess.${bunNote} Languages: ${langList}.

Only what you console.log() enters your conversation — the bytes your code processes stay in the sandbox.

WHEN:
  - You intend to derive an answer FROM data (filter, count, aggregate, parse, compare) — print only the answer
  - Output shape or size cannot be predicted before execution (recursive finds, repo-wide greps, list endpoints, log scans)
  - You would read raw output then mentally compute — that compute belongs here, where its inputs stay out
  - You need a long-running process kept alive (dev server, watcher, daemon) — pass \`background: true\` to detach on timeout
  - Output may be large but you want recall-by-topic later — pass \`intent\`; ${INTENT_AUTO_INDEX_PROSE} and only section titles + previews come back

WHEN NOT:
  - Single short observational command you will consume verbatim (whoami, pwd, git status on a clean tree) — Bash is simpler
  - File mutations (Edit/Write) or navigation (cd/ls) — Bash is the right surface

RETURNS:
  Only what your code prints. Wrap risky calls in try/catch — uncaught errors go to stderr. Drill in via open_ctx_search(queries: [...]).

EXAMPLE: open_ctx_execute(language: "javascript", code: "const out = require('child_process').execSync('npm test', {encoding:'utf8', stdio:['ignore','pipe','pipe']}); console.log(out.split('\\\\n').filter(l => /(FAIL|✗|×|Error:|Tests +.*(failed|passed))/i.test(l)).slice(0, 60).join('\\\\n'))")`,
    inputSchema: z
      .object({
        language: z
          .enum(["javascript", "typescript", "python", "shell", "ruby", "go", "rust", "php", "perl", "r", "elixir", "csharp"])
          .describe("Runtime language"),
        code: z
          .string()
          .describe(
            "Source code to execute. Use console.log (JS/TS), print (Python/Ruby/Perl/R), echo (Shell), echo (PHP), fmt.Println (Go), IO.puts (Elixir), or Console.WriteLine (C#) to output a summary to context.",
          ),
        timeoutMs: z.coerce
          .number()
          .optional()
          .describe(
            "Max execution time in MILLISECONDS — timeoutMs: 120000 is two minutes, timeoutMs: 120 is 0.12 seconds. When omitted, the host's own RPC timeout governs where it has one; on hosts that do not bound a call (Pi, Antigravity CLI) a generous server-side default applies instead. Pass an explicit value for long-running builds (Gradle/Maven/SBT), or background: true to detach.",
          ),
        // background: wrapped in coerceBoolean preprocessor so the literal
        // strings "true"/"false" arriving from OpenCode's native plugin
        // bridge (and several LLM providers' tool-call JSON) parse as the
        // boolean the handler expects. z.coerce.boolean() is unsafe here —
        // Boolean("false") is true. Fixes #627.
        background: z
          .preprocess(coerceBoolean, z.boolean())
          .optional()
          .default(false)
          .describe(
            "Keep process running after timeout (for servers/daemons). Returns partial output without killing the process. IMPORTANT: Do NOT add setTimeout/self-close timers in background scripts — the process must stay alive until the timeout detaches it. For server+fetch patterns, prefer putting both server and fetch in ONE open_ctx_execute call instead of using background.",
          ),
        cwd: z
          .string()
          .optional()
          .describe("Optional working directory for shell commands. Non-shell languages still execute from their sandbox temp directory."),
        intent: z
          .string()
          .optional()
          .describe(
            "What you're looking for in the output. When provided and output is large (>5KB), " +
              "indexes output into knowledge base and returns section titles + previews — not full content. " +
              "Use open_ctx_search(queries: [...]) to retrieve specific sections. Example: 'failing tests', 'HTTP 500 errors'." +
              "\n\nTIP: Use specific technical terms, not just concepts. Check 'Searchable terms' in the response for available vocabulary.",
          ),
      })
      .passthrough(),
    // #1081: keeps the legacy `timeout` key visible to the handler so it can
    // be rejected instead of silently stripped. The emitted tools/list schema
    // is unchanged — installStrictClientSchemaCompat() drops
    // `additionalProperties` before it reaches the wire.
  },
  {
    gate: (args: ToolArgs) => {
      const legacyTimeout = checkLegacyTimeoutArg(args, "open_ctx_execute");
      if (legacyTimeout) return legacyTimeout;
      const { language, code } = args as { language: Language; code: string };

      // Security: deny-only firewall
      if (language === "shell") {
        const denied = checkDenyPolicy(code, "execute");
        if (denied) return denied;
      } else {
        const denied = checkNonShellDenyPolicy(code, language, "execute");
        if (denied) return denied;
      }
      return null;
    },
    error: {
      title: "Runtime error",
      lead: (args) => {
        const { language, code } = args as { language: string; code: string };
        return buildExecuteEcho(language, code);
      },
    },
    run: async (rawArgs, extra) => {
      const { language, code, timeoutMs, background, cwd, intent } = rawArgs as {
        language: Language;
        code: string;
        timeoutMs?: number;
        background: boolean;
        cwd?: string;
        intent?: string;
      };
      // For JS/TS: wrap in async IIFE with fetch + http/https interceptors to track network bytes
      let instrumentedCode = code;
      const effTimeout = resolveExecTimeout(timeoutMs);
      const progress = wireProgress(extra);
      if (language === "javascript" || language === "typescript") {
        // #1151: binary payloads count 0 — see buildJsInstrumentedCode.
        instrumentedCode = buildJsInstrumentedCode(code, background && effTimeout !== undefined);
      }
      const result = await executor.execute({
        language,
        code: instrumentedCode,
        timeout: effTimeout,
        background,
        cwd,
        signal: extra?.signal,
        onOutput: progress.report,
      });
      await progress.flush();

      // Echo the executed source code before stdout so users can audit
      // and tooling can block command patterns (Issues #717 + #736).
      // Built from the user-supplied `code`, NOT the instrumented variant.
      const echo = buildExecuteEcho(language, code);

      // Parse sandbox network metrics from stderr
      const netMatch = result.stderr?.match(/__CM_NET__:(\d+)/);
      if (netMatch) {
        sessionStats.bytesSandboxed += parseInt(netMatch[1]);
        // Clean the metric line from stderr
        result.stderr = result.stderr.replace(/\n?__CM_NET__:\d+\n?/g, "");
      }

      // Parse sandbox FS read metrics from stderr
      const fsMatch = result.stderr?.match(/__CM_FS__:(\d+)/);
      if (fsMatch) {
        sessionStats.bytesSandboxed += parseInt(fsMatch[1]);
        result.stderr = result.stderr.replace(/\n?__CM_FS__:\d+\n?/g, "");
      }

      return executionOutcome({ echo, language, intent, source: `execute:${language}`, background: true, effTimeout, result });
    },
  },
);

// ─────────────────────────────────────────────────────────
// Helper: index stdout into FTS5 knowledge base
// ─────────────────────────────────────────────────────────

function indexStdout(stdout: string, source: string): { content: Array<{ type: "text"; text: string }> } {
  const store = getStore();
  trackIndexed(Buffer.byteLength(stdout));
  const indexed = store.index({ content: stdout, source, attribution: currentAttribution() });
  return {
    content: [
      {
        type: "text" as const,
        text: `Indexed ${indexed.totalChunks} sections (${indexed.codeChunks} with code) from: ${indexed.label}\nUse open_ctx_search(queries: ["..."]) to query this content. Use source: "${indexed.label}" to scope results.`,
      },
    ],
  };
}

// ─────────────────────────────────────────────────────────
// Helper: intent-driven search on execution output
// ─────────────────────────────────────────────────────────

// Auto-index thresholds live in src/tool-pipeline.ts (executionOutcome ladder).

function intentSearch(stdout: string, intent: string, source: string, maxResults: number = 5): string {
  const totalLines = stdout.split("\n").length;
  const totalBytes = Buffer.byteLength(stdout);

  // Index into the PERSISTENT store so user can open_ctx_search() later
  const persistent = getStore();
  const indexed = persistent.indexPlainText(stdout, source, undefined, currentAttribution());

  // Search the persistent store directly (porter → trigram → fuzzy)
  const results = persistent.searchWithFallback(intent, maxResults, source);

  // Extract distinctive terms as vocabulary hints for the LLM
  const distinctiveTerms = persistent.getDistinctiveTerms(indexed.sourceId);

  if (results.length === 0) {
    const lines = [
      `Indexed ${indexed.totalChunks} sections from "${source}" into knowledge base.`,
      `No sections matched intent "${intent}" in ${totalLines}-line output (${(totalBytes / 1024).toFixed(1)}KB).`,
    ];
    if (distinctiveTerms.length > 0) {
      lines.push("");
      lines.push(`Searchable terms: ${distinctiveTerms.join(", ")}`);
    }
    lines.push("");
    lines.push("Use open_ctx_search(queries: [...]) to explore the indexed content.");
    return lines.join("\n");
  }

  // Return ONLY titles + first-line previews — not full content
  const lines = [
    `Indexed ${indexed.totalChunks} sections from "${source}" into knowledge base.`,
    `${results.length} sections matched "${intent}" (${totalLines} lines, ${(totalBytes / 1024).toFixed(1)}KB):`,
    "",
  ];

  for (const r of results) {
    const preview = charSafePrefix(r.content.split("\n")[0], 120);
    lines.push(`  - ${r.title}: ${preview}`);
  }

  if (distinctiveTerms.length > 0) {
    lines.push("");
    lines.push(`Searchable terms: ${distinctiveTerms.join(", ")}`);
  }

  lines.push("");
  lines.push("Use open_ctx_search(queries: [...]) to retrieve full content of any section.");

  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────
// Tool: execute_file
// ─────────────────────────────────────────────────────────

registerCtxTool(
  "open_ctx_execute_file",
  {
    // #852: the host's MCP approval prompt renders only the tool name/title +
    // raw args — the title is the one server-controlled signal, so make it
    // unambiguously announce code execution + file read for the reviewer.
    title: "Run code over a file (executes code, reads the given path)",
    // #846: runs arbitrary code over a file in a sandbox with full network access.
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    description: `Read a file into a sandboxed FILE_CONTENT variable and run code on it. Only what you console.log() enters your conversation — the file bytes stay in the sandbox. Same principle as open_ctx_execute, scoped to one file.

WHEN:
  - You want to KNOW SOMETHING ABOUT a file (line count, matches of a pattern, parsed structure, statistical aggregate) without needing to SEE all of it
  - The file is structured (CSV, JSON, log, code) and a code-level derivation is cheaper than reading verbatim
  - The file is large enough that reading it would burn conversation memory you need for the actual work
  - The derivation may itself be large and you want recall-by-topic later — pass \`intent\`; ${INTENT_AUTO_INDEX_PROSE} and only matching sections come back, retrievable via open_ctx_search

WHEN NOT:
  - You intend to EDIT the file — use Read so the subsequent Edit can match the exact text
  - You only need one specific line and you know its offset — Read with offset/limit is the simplest path
  - The file is small AND you will consume all of it — Read directly

RETURNS:
  Only what your code prints. FILE_CONTENT holds the raw bytes in the sandbox; nothing else leaves. Auto-indexed output returns searchable section titles + previews instead of stdout.

EXAMPLE: open_ctx_execute_file(path: "huge.log", language: "javascript", code: "const errs = FILE_CONTENT.split('\\\\n').filter(l => /ERROR|FATAL/.test(l)); console.log(\`\${errs.length} error lines\`); console.log(errs.slice(-5).join('\\\\n'))")`,
    inputSchema: z
      .object({
        path: z.string().describe("Absolute file path or relative to project root"),
        language: z
          .enum(["javascript", "typescript", "python", "shell", "ruby", "go", "rust", "php", "perl", "r", "elixir", "csharp"])
          .describe("Runtime language"),
        code: z
          .string()
          .describe(
            "Code to process FILE_CONTENT (file_content in Elixir). Print summary via console.log/print/echo/IO.puts/Console.WriteLine.",
          ),
        timeoutMs: z.coerce
          .number()
          .optional()
          .describe(
            "Max execution time in MILLISECONDS — timeoutMs: 120000 is two minutes, timeoutMs: 120 is 0.12 seconds. When omitted, the host's own RPC timeout governs where it has one; on hosts that do not bound a call (Pi, Antigravity CLI) a generous server-side default applies instead.",
          ),
        intent: z
          .string()
          .optional()
          .describe(
            "What you're looking for in the output. When provided and output is large (>5KB), " +
              "returns only matching sections via BM25 search instead of truncated output.",
          ),
      })
      .passthrough(), // #1081 — see open_ctx_execute
  },
  {
    gate: (args: ToolArgs) => {
      const legacyTimeout = checkLegacyTimeoutArg(args, "open_ctx_execute_file");
      if (legacyTimeout) return legacyTimeout;
      const { path, language, code } = args as { path: string; language: Language; code: string };

      // Security (#852): confine the processed file to the project root so
      // open_ctx_execute_file cannot be used to escape the host's sandbox/permission
      // controls. Runs before the deny-glob check — boundary first, then policy.
      const boundaryDenied = checkProjectBoundary(path, "open_ctx_execute_file");
      if (boundaryDenied) return boundaryDenied;

      // Security: check file path against Read deny patterns
      const pathDenied = checkFilePathDenyPolicy(path, "open_ctx_execute_file");
      if (pathDenied) return pathDenied;

      // Security: check code parameter against Bash deny patterns
      if (language === "shell") {
        const codeDenied = checkDenyPolicy(code, "execute_file");
        if (codeDenied) return codeDenied;
      } else {
        const codeDenied = checkNonShellDenyPolicy(code, language, "execute_file");
        if (codeDenied) return codeDenied;
      }
      return null;
    },
    error: {
      title: "Runtime error",
      lead: (args) => {
        const { language, code, path } = args as { language: string; code: string; path: string };
        return buildExecuteEcho(language, code, path);
      },
    },
    run: async (rawArgs, extra) => {
      const { path, language, code, timeoutMs, intent } = rawArgs as {
        path: string;
        language: Language;
        code: string;
        timeoutMs?: number;
        intent?: string;
      };
      const effTimeout = resolveExecTimeout(timeoutMs);
      const progress = wireProgress(extra);
      const result = await executor.executeFile({
        path,
        language,
        code,
        timeout: effTimeout,
        signal: extra?.signal,
        onOutput: progress.report,
      });
      await progress.flush();

      // Echo path + executed source code before stdout for audit/debug
      // (Issues #717 + #736).
      const echo = buildExecuteEcho(language, code, path);

      return executionOutcome({ echo, language, intent, source: `file:${path}`, path, background: false, effTimeout, result });
    },
  },
);

// ─────────────────────────────────────────────────────────
// Tool: index
// ─────────────────────────────────────────────────────────

registerCtxTool(
  "open_ctx_index",
  {
    title: "Index Content",
    // #846: writes content into the local FTS5 store (additive, not destructive;
    // re-indexing the same content adds rows, so not idempotent). No network.
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    description: `Store content in a searchable knowledge base (BM25 over FTS5). Splits markdown by headings, keeps code blocks intact, persists the raw chunks. The full content stays in storage — retrieve any section on-demand via open_ctx_search; nothing is summarized or truncated.

WHEN:
  - Documentation from Context7, Skills, or MCP tools (API docs, framework guides, code examples)
  - API references (endpoint details, parameter specs, response schemas)
  - MCP tools/list output (exact tool signatures and descriptions)
  - Skill prompts and instructions too large to keep verbatim in conversation
  - README files, migration guides, changelog entries

WHEN NOT:
  - Log files, test output, CSV, or build output — use open_ctx_execute_file, which processes in-sandbox without persisting bytes
  - Single-use ephemeral content you will not query later — keep it inline if it fits, or open_ctx_execute_file it

RETURNS:
  Indexing metadata: chunk counts, source label, and the exact open_ctx_search call shape. Raw content is NOT echoed back. With \`path\`, a content hash lets open_ctx_search auto-flag staleness later.

EXAMPLE: open_ctx_index(content: "# React useEffect\\n\\nThe Effect Hook lets you ...", source: "react-useeffect-docs")
EXAMPLE: open_ctx_index(path: "/path/to/large-spec.md", source: "openapi-v2-spec")`,
    inputSchema: z.object({
      content: z.string().optional().describe("Raw text/markdown to index. Provide this OR path, not both."),
      path: z
        .string()
        .optional()
        .describe(
          "File OR directory path to read and index (content never enters context). Provide this OR content. Directory paths trigger a bounded recursive walk (#687).",
        ),
      source: z.string().optional().describe("Label for the indexed content (e.g., 'Context7: React useEffect', 'Skill: frontend-design')"),
      include: z.array(z.string()).optional().describe("Directory-only: glob patterns to include (default: all matching extensions)."),
      exclude: z
        .array(z.string())
        .optional()
        .describe(
          "Directory-only: glob patterns to exclude. Merged with defaults (node_modules, .git, dist, build, .next, coverage, .venv, __pycache__, .DS_Store).",
        ),
      maxDepth: z.number().int().min(0).optional().describe("Directory-only: max recursion depth from root (default: 5)."),
      maxFiles: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Directory-only: hard cap on files indexed (default: 200) — FTS5 blow-up guard."),
      extensions: z
        .array(z.string())
        .optional()
        .describe("Directory-only: allowed file extensions (default: .md .mdx .txt .json .yaml .yml .ts .tsx .js .jsx .py .rs .go .sh)."),
      respectGitignore: z.boolean().optional().describe("Directory-only: apply nearest .gitignore (default: true)."),
      followSymlinks: z
        .boolean()
        .optional()
        .describe("Directory-only: follow directory symlinks (default: false — cycle hazard + escape risk)."),
    }),
  },
  {
    gate: (args: ToolArgs) => {
      const { content, path } = args as { content?: string; path?: string };
      if (!content && !path) {
        return trackResponse("open_ctx_index", {
          content: [
            {
              type: "text" as const,
              text: "Error: Either content or path must be provided",
            },
          ],
          isError: true,
        });
      }

      // Apply Read deny-policy to prevent indexing sensitive files into the
      // FTS5 store, which would otherwise be queryable via open_ctx_search and
      // exfiltrate content into the model's context (issue #442). Mirrors the
      // check open_ctx_execute_file already performs.
      if (path) {
        const pathDenied = checkFilePathDenyPolicy(path, "open_ctx_index");
        if (pathDenied) return pathDenied;
      }
      return null;
    },
    error: { title: "Index error" },
    run: async (rawArgs) => {
      const { content, path, source, include, exclude, maxDepth, maxFiles, extensions, respectGitignore, followSymlinks } = rawArgs as {
        content?: string;
        path?: string;
        source?: string;
        include?: string[];
        exclude?: string[];
        maxDepth?: number;
        maxFiles?: number;
        extensions?: string[];
        respectGitignore?: boolean;
        followSymlinks?: boolean;
      };

      const resolvedPath = path ? resolveProjectPath(path) : undefined;

      // Directory dispatch (#687, reported by @matiasduartee). When the
      // resolved path is a directory, walk it bounded and re-enter `index()`
      // per-file so the security gate at store.ts:845 (TOCTOU defense from
      // #442 round-3) keeps running for every file.
      //
      // Root-level symlink defense: the deny-glob check above ran on the
      // user-supplied `path`. If `path` is a symlink whose target lands in
      // a sensitive directory (e.g. `/tmp/link -> /etc`), statSync would
      // happily report directory and walkDirectoryDetailed would
      // realpathSync internally, walking /etc with the user's deny globs
      // bound to /tmp/link instead of the real target. Detect the symlink
      // with lstatSync, follow it once, and re-apply the deny check
      // against the realpath so the user's deny globs see the actual
      // walk root.
      if (resolvedPath && existsSync(resolvedPath)) {
        const lst = lstatSync(resolvedPath);
        if (lst.isSymbolicLink()) {
          let realTarget: string;
          try {
            realTarget = realpathSync(resolvedPath);
          } catch {
            return tracked({
              content: [{ type: "text" as const, text: "Error: symlink target could not be resolved." }],
            });
          }
          if (realTarget !== resolvedPath) {
            const realDenied = checkFilePathDenyPolicy(realTarget, "open_ctx_index");
            if (realDenied) return tracked(realDenied);
          }
        }
      }
      if (resolvedPath && existsSync(resolvedPath) && statSync(resolvedPath).isDirectory()) {
        const store = getStore();
        const projectDir = getProjectDir();
        const denyGlobs = readToolDenyPatterns("Read", projectDir);
        const isWin32 = process.platform === "win32";
        const perFileDeny = (absPath: string): boolean => {
          try {
            return evaluateFilePath(absPath, denyGlobs, isWin32, projectDir).denied;
          } catch {
            return false; // fail-open consistent with checkFilePathDenyPolicy
          }
        };
        const dirResult = store.indexDirectory({
          path: resolvedPath,
          source: source ?? resolvedPath,
          attribution: currentAttribution(),
          perFileDeny,
          include,
          exclude,
          maxDepth,
          maxFiles,
          extensions,
          respectGitignore,
          followSymlinks,
        });
        const capNote = dirResult.capped
          ? ` (cap reached — only first ${dirResult.filesIndexed} of ${dirResult.totalSeen}+ files; raise maxFiles to index more)`
          : "";
        const denyNote =
          dirResult.denied > 0 ? ` (${dirResult.denied} file${dirResult.denied === 1 ? "" : "s"} blocked by Read deny policy)` : "";
        const failNote = dirResult.failed > 0 ? ` (${dirResult.failed} file${dirResult.failed === 1 ? "" : "s"} failed to read)` : "";
        return {
          content: [
            {
              type: "text" as const,
              text: `Indexed ${dirResult.filesIndexed} file${dirResult.filesIndexed === 1 ? "" : "s"} (${dirResult.totalChunks} sections) from directory: ${dirResult.label}${capNote}${denyNote}${failNote}\nUse open_ctx_search(queries: ["..."]) to query this content.`,
            },
          ],
        };
      }

      // Track the raw bytes being indexed (content or file)
      if (content) trackIndexed(Buffer.byteLength(content));
      else if (resolvedPath) {
        try {
          const fs = await import("fs");
          trackIndexed(fs.readFileSync(resolvedPath).byteLength);
        } catch {
          /* ignore — file read errors handled by store */
        }
      }
      const store = getStore();
      // #914: the caller-supplied label must be composed with the file, exactly as the
      // CLI does. A bare label makes index() dedupe every file in the group onto
      // one source key, so the second file indexed DELETES the first one's chunks.
      // No path means raw content: there is no file to qualify the label with,
      // so the caller's label stands on its own.
      const indexSource =
        typeof source === "string" && resolvedPath !== undefined ? composeSourceLabel(source, resolvedPath) : (source ?? resolvedPath);
      const result = store.index({
        content,
        path: resolvedPath,
        source: indexSource,
        attribution: currentAttribution(),
      });

      return {
        content: [
          {
            type: "text" as const,
            text: `Indexed ${result.totalChunks} sections (${result.codeChunks} with code) from: ${result.label}\nUse open_ctx_search(queries: ["..."]) to query this content. Use source: "${result.label}" to scope results.`,
          },
        ],
      };
    },
  },
);

// ─────────────────────────────────────────────────────────
// Tool: search — progressive throttling
// ─────────────────────────────────────────────────────────

// Track search calls per N-second window for progressive throttling.
// Defaults preserve the historical behavior (60s window, soft-cap at 3
// calls, hard-block at 8). All three thresholds are overridable via env
// vars so users can loosen or tighten the policy without forking. Invalid
// values (non-positive numbers, NaN) fall back to the default to avoid
// silently disabling the protection.
function readPositiveEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

const SEARCH_WINDOW_MS = readPositiveEnv("OPEN_CONTEXT_MODE_SEARCH_WINDOW_MS", 60_000);
const SEARCH_MAX_RESULTS_AFTER = readPositiveEnv("OPEN_CONTEXT_MODE_SEARCH_MAX_RESULTS_AFTER", 3); // after N calls: 1 result per query

// After N calls in the rolling window: REFUSE and tell the agent to batch its
// questions into one open_ctx_search. The default moved from 8 to 20 because a hard
// refusal is a routing dead end — open_ctx_search is the tool the whole redirect
// strategy points at, so blocking it pushes the agent back onto Bash/Read,
// which is the flood this project exists to prevent (#issue 1212 class).
// 20/min still bounds a runaway loop; it just stops cutting off a legitimate
// research session mid-thread.
//
// The soft taper above is deliberately NOT widened: it trades result count
// for bytes, and widening it spends bytes to solve a problem this change
// already avoids by not refusing.
const SEARCH_BLOCK_AFTER = readPositiveEnv("OPEN_CONTEXT_MODE_SEARCH_BLOCK_AFTER", 20); // after N calls: refuse, demand batching

// #1097: opt-in override of the per-query result cap. The flood-guard default
// stays at 2; OPEN_CONTEXT_MODE_MAX_LIMIT lets an operator widen it for deep dives.
// Clamped to [2, 50] so a typo cannot request thousands of chunks per query.
const SEARCH_MAX_PER_QUERY = Math.min(50, Math.max(2, readPositiveEnv("OPEN_CONTEXT_MODE_MAX_LIMIT", 2)));

// #769: progressive throttle bucketed PER agent-context, not machine-global.
// Concurrent subagents share ONE MCP server process; a single global counter
// summed their independent searches into one budget and hard-blocked
// legitimate parallel fan-out. The guard keys each actor's window separately
// so single-actor flood protection is preserved while fan-out is not starved.
const searchFloodGuard = new FloodGuard({
  windowMs: SEARCH_WINDOW_MS,
  softCapAfter: SEARCH_MAX_RESULTS_AFTER,
  blockAfter: SEARCH_BLOCK_AFTER,
});

/**
 * Per-agent flood-guard key. Each concurrent subagent in a Claude Code
 * Task/Workflow fan-out runs under its own session id (written to SessionDB
 * via hooks), so currentAttribution().sessionId is the per-agent discriminator
 * already available MCP-side. Falls back to a single shared bucket when no
 * identity is resolvable (preserves today's single-threaded behaviour).
 */
function searchFloodGuardKey(): string {
  try {
    return currentAttribution()?.sessionId ?? "__default__";
  } catch {
    return "__default__";
  }
}

/**
 * Defensive coercion: parse stringified JSON arrays, AND lift a bare
 * non-empty string into a single-element array.
 *
 * Two shapes show up from the wild:
 *   1. `"[\"a\",\"b\"]"` — Claude Code double-serialization bug
 *      (https://github.com/anthropics/claude-code/issues/34520).
 *   2. `"single query"` — some LLM providers / OpenCode's native plugin
 *      bridge deliver a single string when the schema expects `string[]`
 *      (issue #627). v1.0.139 (#621) made the bridge run the Zod schema,
 *      so this now surfaces as `Expected array, received string`. The
 *      ergonomic recovery is to treat it as `["single query"]`.
 *
 * An empty string is intentionally NOT lifted — empty input should still
 * fail Zod's `.min(1)` check rather than masquerade as `[""]`.
 */
function coerceJsonArray(val: unknown): unknown {
  if (typeof val === "string") {
    const trimmed = val.trim();
    if (trimmed.length === 0) return val; // let zod produce "non-empty" error
    try {
      const parsed = JSON.parse(val);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      /* fall through — not JSON, treat as bare-string lift */
    }
    // Bare-string lift (#627): single query delivered as a plain string.
    return [val];
  }
  return val;
}

/**
 * Defensive coercion: accept the string literals "true"/"false" as
 * booleans. The OpenCode native plugin bridge (and several LLM providers'
 * tool-call JSON) stringifies primitives — `background:"false"` instead
 * of `background:false`, `confirm:"true"` instead of `confirm:true`.
 *
 * We deliberately do NOT use `z.coerce.boolean()` for boolean fields:
 * `Boolean("false")` is `true`, so Zod's coerce path silently flips the
 * meaning. This helper recognises only the documented literal forms and
 * passes anything else through untouched so Zod surfaces the right error.
 *
 * Fixes #627.
 */
function coerceBoolean(val: unknown): unknown {
  if (typeof val === "string") {
    const t = val.trim().toLowerCase();
    if (t === "true") return true;
    if (t === "false") return false;
  }
  return val;
}

/**
 * Coerce commands array: handles double-serialization AND the case where
 * the model passes plain command strings instead of {label, command} objects.
 */
function coerceCommandsArray(val: unknown): unknown {
  const arr = coerceJsonArray(val);
  if (Array.isArray(arr)) {
    return arr.map((item, i) => (typeof item === "string" ? { label: `cmd_${i + 1}`, command: item } : item));
  }
  return arr;
}

/** Redirect shown when open_ctx_search runs before anything is indexed. */
function emptyIndexRedirect(): { content: Array<{ type: "text"; text: string }>; isError: boolean } {
  return {
    content: [
      {
        type: "text" as const,
        text:
          "Knowledge base is empty — no content has been indexed yet.\n\n" +
          "open_ctx_search is a follow-up tool that queries previously indexed content. " +
          "To gather and index content first, use:\n" +
          "  • open_ctx_batch_execute(commands, queries) — run commands, auto-index output, and search in one call\n" +
          "  • open_ctx_fetch_and_index(url) — fetch a URL, index it, then search with open_ctx_search\n" +
          "  • open_ctx_index(content, source) — manually index text content\n\n" +
          "After indexing, open_ctx_search becomes available for follow-up queries.",
      },
    ],
    isError: true,
  };
}

/** Refusal shown once the per-window hard block trips (#769). */
function searchBlockedResponse(
  callCount: number,
  windowStart: number,
  now: number,
): { content: Array<{ type: "text"; text: string }>; isError: boolean } {
  return {
    content: [
      {
        type: "text" as const,
        text:
          `BLOCKED: ${callCount} search calls in ${Math.round((now - windowStart) / 1000)}s. ` +
          "You're flooding context. STOP making individual search calls. " +
          "Use open_ctx_batch_execute(commands, queries) for your next research step.",
      },
    ],
    isError: true,
  };
}

/**
 * Open the SessionDB open_ctx_search needs, if any. Timeline mode reads it
 * directly; relevance mode with a string `projectScope` needs it to
 * translate `project_dir` into the session-id allow-set the ContentStore
 * filter uses (#737). Returns `{ db: null, allowSet: undefined }` when
 * neither applies or the DB cannot be opened — search then covers
 * ContentStore and auto-memory only.
 */
function openSearchSessionDb(
  sort: string,
  projectScope: string | null | undefined,
): { db: InstanceType<typeof SessionDB> | null; allowSet: Set<string> | undefined } {
  if (sort !== "timeline" && typeof projectScope !== "string") return { db: null, allowSet: undefined };

  let db: InstanceType<typeof SessionDB> | null = null;
  try {
    const sessionsDir = getSessionDir();
    const projectDir = getProjectDir();
    const dbFile = resolveSessionDbPath({ projectDir, sessionsDir });
    if (existsSync(dbFile)) db = new SessionDB({ dbPath: dbFile });
  } catch {
    /* SessionDB unavailable — search ContentStore + auto-memory only */
  }

  // Empty allow-set is preserved (means "no events for this project"), which
  // surfaces only legacy `session_id=''` chunks via the post-filter.
  if (typeof projectScope !== "string" || !db) return { db, allowSet: undefined };
  try {
    return { db, allowSet: new Set(db.getSessionIdsForProject(projectScope)) };
  } catch {
    /* best-effort */
    return { db, allowSet: undefined };
  }
}

/** Render one query's results as `--- [origin | ts | source] ---` sections. */
function formatSearchSection<T extends SearchResult | UnifiedSearchResult>(results: T[], query: string): string {
  return results
    .map((r) => {
      const origin = (r as any).origin || "current-session";
      const ts = (r as any).timestamp ? (r as any).timestamp.slice(0, 16).replace("T", " ") : "";
      const header = `--- [${origin}${ts ? " | " + ts : ""} | ${r.source}] ---`;
      const heading = `### ${r.title}`;
      const snippet = extractSnippet(r.content, query, 1500, r.highlighted);
      return `${header}\n${heading}\n\n${snippet}`;
    })
    .join("\n\n");
}

/**
 * Throttle trailer, always surfaced so agents can pace themselves instead of
 * discovering the limit only after results are already truncated. Soft
 * warning after SEARCH_MAX_RESULTS_AFTER calls; gentle informational line
 * before that.
 */
function searchThrottleTrailer(searchCallCount: number, effectiveLimit: number): string {
  const remaining = Math.max(0, SEARCH_BLOCK_AFTER - searchCallCount);
  if (searchCallCount >= SEARCH_MAX_RESULTS_AFTER) {
    return (
      `\n\n⚠ search call #${searchCallCount}/${SEARCH_BLOCK_AFTER} in this window. ` +
      `Results limited to ${effectiveLimit}/query. ${remaining} call(s) remaining before block. ` +
      `Batch queries: open_ctx_search(queries: ["q1","q2","q3"]) or use open_ctx_batch_execute.`
    );
  }
  return (
    `\n\n> Throttle: search call #${searchCallCount} this window. ` +
    `Soft cap (fewer results/query) at call #${SEARCH_MAX_RESULTS_AFTER}, hard block at #${SEARCH_BLOCK_AFTER}. ` +
    `Prefer open_ctx_search(queries: [...]) array form; it counts as one call.`
  );
}

registerCtxTool(
  "open_ctx_search",
  {
    title: "Search Indexed Content",
    // #846: read-only query over the local FTS5 store. No mutation, no network.
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    description: `Search the unified knowledge base: indexed content plus auto-captured session memory (decisions, errors, blockers, plans, prompts, compaction guides — 26 categories). Stemming, trigram and typo-tolerant matchers rank each query.

WHEN:
  - You want to recall something already in storage instead of re-reading raw sources
  - You have several related questions about one body of knowledge — batch them into one call
  - You want one labelled source (pass \`source\` — partial match is fine) or a cross-session view (pass \`sort: "timeline"\`)
  - You want to filter by content shape (\`contentType: "code"\` or \`"prose"\`)

WHEN NOT:
  - The data was never indexed and no session memory surrounds it — capture first, then query
  - You have one ad-hoc question about unindexed data — run code in the sandbox tool instead

RETURNS:
  Per-query ranked sections with extracted snippets. Use 2-4 technical terms per query. Labels: \`decision\`, \`error\`, \`blocker\`, \`plan\`, \`user-prompt\`, \`compaction\`. Results taper in a rolling time window and block after the hard cap (OPEN_CONTEXT_MODE_SEARCH_WINDOW_MS).

EXAMPLE: open_ctx_search(queries: ["root cause", "proposed fix"], source: "issue-#683")`,
    // Schema construction is centralised in `src/search/open_ctx-search-schema.ts`
    // so the conditional `project` field (only registered when the host runs
    // in shared-DB mode, `OPEN_CONTEXT_MODE_PROJECT_DIR` set at module load) is a
    // hard property of the tool surface — not a runtime hint. Fixes #737.
    inputSchema: buildCtxSearchInputSchema(CTX_SEARCH_SHARED_MODE),
  },
  {
    error: { title: "Search error" },
    run: async (params) => {
      const store = getStore();
      const sort = ((params as Record<string, unknown>).sort as string) || "relevance";

      // Guard: redirect when the index is empty — open_ctx_search is a follow-up
      // tool that requires prior indexing. Skip for timeline mode (SessionDB/auto-memory may have data).
      if (sort !== "timeline" && store.getStats().chunks === 0) {
        return emptyIndexRedirect();
      }

      const raw = params as Record<string, unknown>;

      // Normalize: accept both query (string) and queries (array)
      const queryList: string[] = [];
      if (Array.isArray(raw.queries) && raw.queries.length > 0) {
        queryList.push(...(raw.queries as string[]));
      } else if (typeof raw.query === "string" && raw.query.length > 0) {
        queryList.push(raw.query as string);
      }

      if (queryList.length === 0) {
        return {
          content: [{ type: "text" as const, text: "Error: provide query or queries." }],
          isError: true,
        };
      }

      const {
        limit = 3,
        source,
        contentType,
        project,
      } = params as {
        limit?: number;
        source?: string;
        contentType?: "code" | "prose";
        project?: string;
      };

      // Resolve the per-project scope (#737). When shared-DB mode is off the
      // resolver returns `undefined` and `project` is silently ignored — the
      // per-project DB is naturally isolated by directory hash, so there is
      // nothing for an in-process filter to do.
      const projectScope = resolveProjectScope(project, CTX_SEARCH_SHARED_MODE, () => getProjectDir());

      // Progressive throttling: track calls per agent-context window (#769).
      const now = Date.now();
      const flood = searchFloodGuard.record(searchFloodGuardKey(), now);
      const searchCallCount = flood.count;

      // After SEARCH_BLOCK_AFTER calls (for THIS agent): refuse
      if (flood.blocked) {
        return searchBlockedResponse(searchCallCount, flood.windowStart, now);
      }

      // Determine per-query result limit based on throttle level
      const effectiveLimit = flood.softCapped
        ? 1 // after soft cap: only 1 result per query
        : Math.min(limit, SEARCH_MAX_PER_QUERY); // normal: capped per query (default 2; OPEN_CONTEXT_MODE_MAX_LIMIT overrides)

      const MAX_TOTAL = 40 * 1024; // 40KB total cap
      let totalSize = 0;
      const sections: string[] = [];

      // Open SessionDB once before the loop (Blocker 4: avoid open/close per query).
      // Issue #737: also open in relevance mode when a string `projectScope`
      // is in play — the 2-step IN-clause needs SessionDB to translate
      // `project_dir` → allow-set of session ids for the ContentStore filter.
      // The allow-set resolves once for the relevance-mode path —
      // searchAllSources resolves its own copy for timeline mode. Empty set
      // is preserved (means "no events for this project"), which surfaces
      // only legacy `session_id=''` chunks via the post-filter.
      const { db: timelineDB, allowSet: relevanceAllowSet } = openSearchSessionDb(sort, projectScope);

      const configDir = opencodeConfigDir();
      const adapter = new OpenCodeAdapter();

      // #921: track chunks already emitted by an earlier query so a chunk
      // matching multiple queries prints once (multi-query calls only).
      const seenChunks = new Set<string>();

      try {
        for (const q of queryList) {
          if (totalSize > MAX_TOTAL) {
            sections.push(`## ${q}\n(output cap reached)\n`);
            continue;
          }

          let results;
          if (sort === "timeline") {
            results = searchAllSources({
              query: q,
              limit: effectiveLimit,
              store,
              sort,
              source,
              contentType,
              sessionDB: timelineDB,
              projectDir: getProjectDir(),
              configDir,
              adapter,
              projectScope,
            });
          } else {
            results = store.searchWithFallback(q, effectiveLimit, source, contentType, "like", relevanceAllowSet);
          }

          if (results.length === 0) {
            sections.push(`## ${q}\nNo results found.`);
            continue;
          }

          // For multi-query calls, drop chunks already shown under an earlier
          // query so the same chunk never prints twice. Single-query output is
          // left byte-identical.
          let emitResults: Array<SearchResult | UnifiedSearchResult> = results;
          if (queryList.length > 1) {
            emitResults = dedupeAcrossQueries<SearchResult | UnifiedSearchResult>(results, seenChunks);
            if (emitResults.length === 0) {
              sections.push(`## ${q}\n(all matches already shown above)`);
              continue;
            }
          }

          const formatted = formatSearchSection(emitResults, q);

          sections.push(`## ${q}\n\n${formatted}`);
          totalSize += formatted.length;
        }
      } finally {
        try {
          timelineDB?.close();
        } catch {}
      }

      let output = sections.join("\n\n---\n\n");

      // Report auto-refreshed stale sources
      if (store.lastRefreshCount > 0) {
        output =
          `> Auto-refreshed ${store.lastRefreshCount} stale source${store.lastRefreshCount > 1 ? "s" : ""} (file changed since indexing).\n\n` +
          output;
      }

      // Throttle counter — always surfaced so agents can pace themselves
      // proactively instead of discovering the limit only after results are
      // already truncated.
      output += searchThrottleTrailer(searchCallCount, effectiveLimit);

      if (output.trim().length === 0) {
        const sources = store.listSources();
        const sourceList =
          sources.length > 0 ? `\nIndexed sources: ${sources.map((s) => `"${s.label}" (${s.chunkCount} sections)`).join(", ")}` : "";
        return {
          content: [{ type: "text" as const, text: `No results found.${sourceList}` }],
        };
      }

      return {
        content: [{ type: "text" as const, text: output }],
      };
    },
  },
);

// ─────────────────────────────────────────────────────────
// Turndown path resolution (external dep, like better-sqlite3)
// ─────────────────────────────────────────────────────────

let _turndownPath: string | null = null;
let _gfmPluginPath: string | null = null;

function resolveTurndownPath(): string {
  if (!_turndownPath) {
    const require = createRequire(import.meta.url);
    _turndownPath = require.resolve("turndown");
  }
  return _turndownPath;
}

function resolveGfmPluginPath(): string {
  if (!_gfmPluginPath) {
    const require = createRequire(import.meta.url);
    _gfmPluginPath = require.resolve("turndown-plugin-gfm");
  }
  return _gfmPluginPath;
}

// ─────────────────────────────────────────────────────────
// Tool: fetch_and_index
// ─────────────────────────────────────────────────────────

// Subprocess code that fetches a URL, detects Content-Type, and outputs a
// __CM_CT__:<type> marker on the first line so the handler can route to the
// appropriate indexing strategy.  HTML is converted to markdown via Turndown.
export function buildFetchCode(url: string, outputPath: string): string {
  const turndownPath = JSON.stringify(resolveTurndownPath());
  const gfmPath = JSON.stringify(resolveGfmPluginPath());
  const escapedOutputPath = JSON.stringify(outputPath);
  // Embed classifyIp into the subprocess so the connect-time DNS lookup is
  // re-validated with the same policy as ssrfGuard. Without this, an attacker
  // can serve a public IP for the parent's pre-flight ssrfGuard lookup and
  // then a blocked IP (e.g. 169.254.169.254 IMDS) for the subprocess fetch's
  // own lookup — classic DNS rebinding across the parent/child boundary.
  //
  // CRITICAL: bundlers (esbuild) rename top-level identifiers — `classifyIp`
  // becomes e.g. `_h` in server.bundle.mjs. `classifyIp.toString()` returns
  // the renamed source `function _h(t){...}`, but the embedded subprocess
  // template references the literal name `classifyIp` (and the function's
  // own internal recursion is also `_h(...)`). Result: the subprocess sees
  // `function _h(t){...; return _h(...)}` injected, then references to
  // `classifyIp` blow up with `ReferenceError: classifyIp is not defined`.
  //
  // Fix: emit `var <fnName> = <fn-expr>; var classifyIp = <fnName>;`. The
  // named function expression preserves recursion under whatever name the
  // bundler chose, and the alias re-exposes the canonical `classifyIp`
  // identifier the rest of the embedded script depends on.
  const classifyIpInner = classifyIp.toString();
  const classifyIpFnName = classifyIp.name || "classifyIp";
  const classifyIpSrc =
    classifyIpFnName === "classifyIp"
      ? `var classifyIp = ${classifyIpInner};`
      : `var ${classifyIpFnName} = ${classifyIpInner};\nvar classifyIp = ${classifyIpFnName};`;
  const strictMode = process.env.CTX_FETCH_STRICT === "1";
  // Default strips proxy env so the connect-time rebinding guard runs (#476/#1039).
  // Opt-in is exact string "1" only (any other value keeps the strip path).
  const allowProxy = process.env.CTX_FETCH_ALLOW_PROXY === "1";
  const proxyEnvBlock = allowProxy
    ? `// Proxy env vars preserved under CTX_FETCH_ALLOW_PROXY=1 (issue #1039).`
    : `// Strip proxy env by default so DNS rebinding guard sees connect-time IPs (#1039).
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
delete process.env.ALL_PROXY;
delete process.env.http_proxy;
delete process.env.https_proxy;
delete process.env.all_proxy;
delete process.env.npm_config_proxy;
delete process.env.npm_config_https_proxy;`;
  return `
const TurndownService = require(${turndownPath});
const { gfm } = require(${gfmPath});
const fs = require('fs');
const dns = require('no' + 'de:dns');
const dnsPromises = require('no' + 'de:dns/promises');
const url = ${JSON.stringify(url)};
const outputPath = ${escapedOutputPath};

// Proxy env handling for this subprocess only. By default every proxy var is
// stripped, because a configured outbound proxy (HTTP_PROXY / HTTPS_PROXY /
// ALL_PROXY) routes the fetch through an arbitrary target: DNS then resolves at
// the proxy and the in-subprocess rebinding guard never sees the rebound IP.
// CTX_FETCH_ALLOW_PROXY=1 opts out for corporate egress — which also disables
// that guard, since the IP is no longer resolved here. The parent's ssrfGuard
// still runs on the requested URL.
${proxyEnvBlock}

${classifyIpSrc}

const STRICT = ${JSON.stringify(strictMode)};

// SSRF rebinding defense: every dns.lookup call inside this subprocess
// (including the one undici performs to connect the fetch socket) is
// re-validated against the same policy ssrfGuard runs in the parent.
// Even if a hostname rebinds between the parent's pre-flight check and
// the subprocess's actual connect, the connect-time lookup re-classifies
// every returned record and aborts before TCP if any verdict is "block".
const _origLookup = dns.lookup;
dns.lookup = function patchedLookup(hostname, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  if (typeof options === 'number') { options = { family: options }; }
  const wantAll = options && options.all;
  const opts = Object.assign({}, options || {}, { all: true, verbatim: true });
  _origLookup(hostname, opts, function(err, records) {
    if (err) return callback(err);
    if (!Array.isArray(records)) {
      records = [{ address: records, family: (options && options.family) || 4 }];
    }
    for (var i = 0; i < records.length; i++) {
      var verdict = classifyIp(records[i].address);
      if (verdict === 'block' || (STRICT && verdict === 'private')) {
        return callback(new Error(
          'SSRF blocked at connect-time: ' + hostname +
          ' resolves to ' + records[i].address +
          ' (' + verdict + ')'
        ));
      }
    }
    if (wantAll) callback(null, records);
    else callback(null, records[0].address, records[0].family);
  });
};

// dns/promises is a separate function reference. Patching dns.lookup does
// NOT affect dnsPromises.lookup. Today undici's connect path uses callback
// dns.lookup so default fetch is covered, but the invariant is fragile —
// any future undici switch (or user code calling dnsPromises.lookup
// directly) would bypass the guard. Patch both to keep the contract.
const _origPromisesLookup = dnsPromises.lookup;
dnsPromises.lookup = async function patchedPromisesLookup(hostname, options) {
  const opts = Object.assign({}, options || {}, { all: true, verbatim: true });
  const records = await _origPromisesLookup(hostname, opts);
  const list = Array.isArray(records) ? records : [records];
  for (var i = 0; i < list.length; i++) {
    var verdict = classifyIp(list[i].address);
    if (verdict === 'block' || (STRICT && verdict === 'private')) {
      throw new Error(
        'SSRF blocked at connect-time: ' + hostname +
        ' resolves to ' + list[i].address + ' (' + verdict + ')'
      );
    }
  }
  return options && options.all
    ? list
    : { address: list[0].address, family: list[0].family };
};

// dns.resolve4 / dns.resolve6 use a different code path (no getaddrinfo,
// no /etc/hosts) than dns.lookup — they must be patched separately or the
// guard is trivially bypassed by any caller using dns.resolve* directly.
['resolve4', 'resolve6'].forEach(function patchResolve(name) {
  const _origResolve = dns[name];
  dns[name] = function patchedResolve(hostname, options, cb) {
    if (typeof options === 'function') { cb = options; options = undefined; }
    _origResolve.call(dns, hostname, options || {}, function(err, addrs) {
      if (err) return cb(err);
      var withTtl = options && options.ttl;
      for (var i = 0; i < addrs.length; i++) {
        var ip = withTtl ? addrs[i].address : addrs[i];
        var v = classifyIp(ip);
        if (v === 'block' || (STRICT && v === 'private')) {
          return cb(new Error(
            'SSRF blocked at connect-time: ' + hostname +
            ' resolves to ' + ip + ' (' + v + ')'
          ));
        }
      }
      cb(null, addrs);
    });
  };
});

// Generic dns.resolve is a polymorphic dispatcher (rrtype-driven). Internally
// Node delegates to dns.resolve4/dns.resolve6 for A/AAAA, but the patches
// above hook the *exported* references — Node's internal dispatcher holds
// captured originals and bypasses our patch. Patch the wrapper explicitly:
// classify A/AAAA records the same way; pass through CNAME/MX/TXT/SRV/etc.
const _origResolveGeneric = dns.resolve;
dns.resolve = function patchedResolveGeneric(hostname, rrtype, cb) {
  if (typeof rrtype === 'function') { cb = rrtype; rrtype = 'A'; }
  _origResolveGeneric.call(dns, hostname, rrtype, function(err, records) {
    if (err) return cb(err);
    if ((rrtype === 'A' || rrtype === 'AAAA') && Array.isArray(records)) {
      for (var i = 0; i < records.length; i++) {
        var ip = records[i];
        var v = classifyIp(ip);
        if (v === 'block' || (STRICT && v === 'private')) {
          return cb(new Error(
            'SSRF blocked at connect-time: ' + hostname +
            ' resolves to ' + ip + ' (' + v + ')'
          ));
        }
      }
    }
    cb(null, records);
  });
};

function emit(ct, content) {
  // Write content to file to bypass executor stdout truncation (100KB limit).
  // Only the content-type marker goes to stdout.
  fs.writeFileSync(outputPath, content);
  console.log('__CM_CT__:' + ct);
}

// Manual redirect handling: a 3xx Location header can rebind the subprocess
// fetch to an alternate host the parent's pre-flight ssrfGuard never saw.
// Even with the connect-time DNS patch, a redirect target that is a literal
// IP (e.g. http://169.254.169.254/) skips getaddrinfo entirely. Walk the
// chain manually so every hop runs through classifyIp before the next fetch.
const MAX_REDIRECTS = 5;
async function fetchWithManualRedirect(initialUrl) {
  let currentUrl = initialUrl;
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
    const resp = await fetch(currentUrl, { redirect: 'manual' });
    if (resp.status < 300 || resp.status >= 400) return resp;
    const location = resp.headers.get('location') || resp.headers.get('Location');
    if (!location) return resp;
    if (redirectCount === MAX_REDIRECTS) {
      throw new Error('SSRF blocked: redirect chain exceeded ' + MAX_REDIRECTS + ' hops');
    }
    let nextParsed;
    try { nextParsed = new URL(location, currentUrl); } catch (e) {
      throw new Error('SSRF blocked: invalid redirect Location: ' + location);
    }
    if (nextParsed.protocol !== 'http:' && nextParsed.protocol !== 'https:') {
      throw new Error('SSRF blocked: redirect to non-http(s) scheme ' + nextParsed.protocol);
    }
    // If the redirect target is a literal IP, classify it directly — no DNS
    // lookup will fire and the connect-time guard would never see it.
    const hostname = nextParsed.hostname.replace(/^\[|\]$/g, '');
    const isIpLiteral = /^[0-9.]+$/.test(hostname) || hostname.includes(':');
    if (isIpLiteral) {
      const verdict = classifyIp(hostname);
      if (verdict === 'block' || (STRICT && verdict === 'private')) {
        throw new Error('SSRF blocked: redirect to ' + hostname + ' (' + verdict + ')');
      }
    } else {
      // Hostname target: resolve and classify every record. The patched
      // dns.lookup also fires on the next fetch's connect, but checking
      // here gives a clearer error and short-circuits before TCP setup.
      const records = await dnsPromises.lookup(hostname, { all: true, verbatim: true });
      for (const rec of records) {
        const verdict = classifyIp(rec.address);
        if (verdict === 'block' || (STRICT && verdict === 'private')) {
          throw new Error(
            'SSRF blocked: redirect target ' + hostname +
            ' resolves to ' + rec.address + ' (' + verdict + ')'
          );
        }
      }
    }
    currentUrl = nextParsed.toString();
  }
  throw new Error('SSRF blocked: redirect chain exceeded ' + MAX_REDIRECTS + ' hops');
}

// Subprocess response-body size cap. A malicious or unexpectedly large
// endpoint reachable through open_ctx_fetch_and_index would otherwise stream
// gigabytes into resp.text(), then into outputPath, then into the parent
// MCP server's heap via readFileSync. 50 MB is far above typical web
// page / API response sizes (~1-5 MB) but bounded enough to keep parent
// heap survivable. Cap both early via Content-Length and after the read.
const MAX_FETCH_BYTES = 50 * 1024 * 1024;
async function safeText(resp) {
  const cl = parseInt(resp.headers.get('content-length') || '0', 10);
  if (cl > MAX_FETCH_BYTES) {
    throw new Error('Response too large: Content-Length ' + cl + ' exceeds ' + MAX_FETCH_BYTES);
  }
  const text = await resp.text();
  if (text.length > MAX_FETCH_BYTES) {
    throw new Error('Response too large: ' + text.length + ' bytes exceeds ' + MAX_FETCH_BYTES);
  }
  return text;
}

async function main() {
  const resp = await fetchWithManualRedirect(url);
  if (!resp.ok) { console.error("HTTP " + resp.status); process.exit(1); }
  const contentType = resp.headers.get('content-type') || '';

  // --- JSON responses ---
  if (contentType.includes('application/json') || contentType.includes('+json')) {
    const text = await safeText(resp);
    try {
      const pretty = JSON.stringify(JSON.parse(text), null, 2);
      emit('json', pretty);
    } catch {
      emit('text', text);
    }
    return;
  }

  // --- HTML responses (default for text/html, application/xhtml+xml) ---
  if (contentType.includes('text/html') || contentType.includes('application/xhtml')) {
    const html = await safeText(resp);
    const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
    td.use(gfm);
    // turndown-plugin-gfm assumes every TABLE has at least one row and crashes
    // otherwise (reading .parentNode of undefined), killing the whole fetch
    // conversion. Let Turndown preserve any non-row content instead.
    td.addRule("emptyTable", {
      filter: (node) => node.nodeName === "TABLE" && node.rows.length === 0,
      replacement: (content) => content,
    });
    td.remove(['script', 'style', 'nav', 'header', 'footer', 'noscript']);
    emit('html', td.turndown(html));
    return;
  }

  // --- Everything else: plain text, CSV, XML, etc. ---
  const text = await safeText(resp);
  emit('text', text);
}
main().catch((err) => {
  console.error(err?.cause?.message ?? err?.message ?? String(err));
  process.exitCode = 1;
});
`;
}

// ─────────────────────────────────────────────────────────
// fetch_and_index helpers — split into parallel-safe fetch and serial-only index
// ─────────────────────────────────────────────────────────

const FETCH_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const FETCH_PREVIEW_LIMIT = 3072;

function formatFetchTtl(ttlMs: number): string {
  if (ttlMs === 0) return "0ms";
  const day = 24 * 60 * 60 * 1000;
  const hour = 60 * 60 * 1000;
  const minute = 60 * 1000;
  if (ttlMs % day === 0) return `${ttlMs / day}d`;
  if (ttlMs % hour === 0) return `${ttlMs / hour}h`;
  if (ttlMs % minute === 0) return `${ttlMs / minute}m`;
  return `${ttlMs}ms`;
}

type FetchOneResult =
  | { kind: "cached"; label: string; chunkCount: number; estimatedBytes: number; ageStr: string; ttlStr: string }
  | { kind: "fetched"; url: string; source?: string; markdown: string; header: string }
  | { kind: "fetch_error"; url: string; error: string; reason: "exit" | "read" | "empty" | "throw" };

/**
 * Pure fetch step — TTL cache check + subprocess fetch. SAFE TO RUN IN PARALLEL.
 * Performs zero SQLite writes (only reads source meta). Caller must funnel
 * fetched results through `indexFetched` serially to avoid FTS5 WAL contention.
 */
/**
 * SSRF guard for open_ctx_fetch_and_index: validate URL scheme + resolve target IP +
 * block link-local / IMDS / multicast / reserved IP ranges. Returns null if
 * safe; returns a FetchOneResult fetch_error if blocked.
 *
 * Policy (PR #401 ops review, developer-friendly default):
 *
 * **HARD BLOCK** (no legitimate dev workflow):
 *   - file://, gopher://, javascript:, data: schemes (only http: and https:)
 *   - 169.254.0.0/16 link-local (INCLUDES 169.254.169.254 = AWS/GCP/Azure IMDS
 *     cloud credential endpoint — high-value target for indirect prompt injection)
 *   - IPv6 link-local fe80::/10
 *   - Multicast (224+ IPv4, ff00::/8 IPv6) and reserved (0.0.0.0/8) ranges
 *
 * **ALLOW by default** (legitimate developer use cases dominate):
 *   - localhost, 127.x.x.x, ::1 (local dev servers — Next.js, Vite, Postgres, …)
 *   - 10.x, 172.16-31.x, 192.168.x RFC1918 private (developer's internal network)
 *
 * **STRICT MODE** opt-in via env var: `CTX_FETCH_STRICT=1`
 *   - Blocks loopback + RFC1918 too
 *   - For hosted/CI environments where the runtime isn't the user's own machine
 *
 * DNS resolution is performed against the resolved IP (not just URL parse) so a
 * hostname like `evil.com` pointing to 169.254.169.254 is rejected — defends
 * against attacker-controlled DNS records and DNS rebinding.
 */
async function ssrfGuard(rawUrl: string): Promise<FetchOneResult | null> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { kind: "fetch_error", url: rawUrl, error: "invalid URL", reason: "exit" };
  }

  // 1. Scheme allowlist — http and https only
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      kind: "fetch_error",
      url: rawUrl,
      error: `URL scheme "${parsed.protocol}" not allowed (only http: and https:)`,
      reason: "exit",
    };
  }

  const strict = process.env.CTX_FETCH_STRICT === "1";

  // 2. DNS resolve + check IP ranges (hard-block + optional strict-mode block)
  try {
    const { lookup } = await import("node:dns/promises");
    const records = await lookup(parsed.hostname, { all: true, verbatim: true });
    for (const rec of records) {
      const verdict = classifyIp(rec.address);
      if (verdict === "block") {
        return {
          kind: "fetch_error",
          url: rawUrl,
          error: `URL "${parsed.hostname}" resolves to ${rec.address} — blocked (link-local / IMDS / multicast / reserved)`,
          reason: "exit",
        };
      }
      if (verdict === "private" && strict) {
        return {
          kind: "fetch_error",
          url: rawUrl,
          error: `URL "${parsed.hostname}" resolves to private IP ${rec.address} — blocked under CTX_FETCH_STRICT=1`,
          reason: "exit",
        };
      }
    }
  } catch (err) {
    // libuv DNS error codes that typically indicate the resolver itself can't
    // reach a nameserver — common when the MCP host process is running under
    // a sandbox that blocks outbound network, OR a transient upstream DNS
    // hiccup. Append an imperative retry hint so the agent does not capitulate
    // to training data on the FIRST transient failure (PR #654 substitute —
    // sibling-tool consistency with hooks/core/routing.mjs WebFetch wording).
    const errCode = (err as NodeJS.ErrnoException | undefined)?.code ?? "";
    const isTransientDns =
      errCode === "ETIMEOUT" || errCode === "ETIMEDOUT" || errCode === "EAI_AGAIN" || errCode === "ENETUNREACH" || errCode === "EPERM";
    const baseMsg = err instanceof Error ? err.message : String(err);
    const hint = isTransientDns
      ? " — transient DNS error; retry once before falling back. If it keeps failing, the MCP host may be running under a network sandbox; restart the host with network access enabled."
      : "";
    return {
      kind: "fetch_error",
      url: rawUrl,
      error: `DNS lookup failed for "${parsed.hostname}": ${baseMsg}${hint}`,
      reason: "exit",
    };
  }

  return null; // safe to fetch
}

/**
 * Classify an IP address.
 *   - "block":    always blocked (link-local/IMDS/multicast/reserved/malformed)
 *   - "private":  loopback or RFC1918 — allowed by default, blocked in strict mode
 *   - "public":   safe to fetch
 *
 * Exported (via the function name) so SSRF tests can exercise the matcher directly.
 */
export function classifyIp(rawIp: string): "block" | "private" | "public" {
  // RFC 6874 zone identifiers (`fe80::1%eth0`, URL-encoded `%25eth0`) must
  // be stripped BEFORE any prefix/equality classification. Without the strip,
  // a loopback `::1%eth0` no longer matches `lower === "::1"` and falls
  // through to "public" — silently bypassing the SSRF guard. Strip first,
  // classify second.
  const pctIdx = rawIp.indexOf("%");
  const ip = pctIdx === -1 ? rawIp : rawIp.slice(0, pctIdx);
  const lower = ip.toLowerCase();

  // IPv6 takes priority — check for `:` first so IPv4-mapped addresses
  // (`::ffff:127.0.0.1`) don't get incorrectly routed through the IPv4 parser.
  if (lower.includes(":")) {
    // IPv4-mapped IPv6 (`::ffff:127.0.0.1`) — recurse through IPv4 classifier
    const v4MappedMatch = lower.match(/^::ffff:([\d.]+)$/);
    if (v4MappedMatch) return classifyIp(v4MappedMatch[1]);
    // Hard-block
    if (lower === "::") return "block"; // unspecified
    if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) return "block"; // fe80::/10 link-local
    if (lower.startsWith("ff")) return "block"; // ff00::/8 multicast
    // Private (loopback + ULA)
    if (lower === "::1") return "private";
    if (lower.startsWith("fc") || lower.startsWith("fd")) return "private"; // fc00::/7 ULA
    return "public";
  }

  // IPv4 (or non-IP string — malformed = block)
  if (!ip.includes(".")) return "block"; // not an IP at all
  const parts = ip.split(".").map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) return "block";
  const [a, b] = parts;
  // Hard-block (no legitimate use)
  if (a === 169 && b === 254) return "block"; // link-local incl. 169.254.169.254 (IMDS)
  if (a === 0) return "block"; // 0.0.0.0/8 (current network)
  if (a >= 224) return "block"; // 224.0.0.0+ multicast/reserved
  // Private (loopback + RFC1918) — allow by default
  if (a === 127) return "private"; // 127.0.0.0/8 loopback
  if (a === 10) return "private"; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return "private"; // 172.16.0.0/12
  if (a === 192 && b === 168) return "private"; // 192.168.0.0/16
  return "public";
}

async function fetchOneUrl(
  url: string,
  source: string | undefined,
  force: boolean | undefined,
  ttl: number | undefined,
): Promise<FetchOneResult> {
  // SSRF guard — reject file://, javascript:, loopback, RFC1918, IMDS, link-local
  // BEFORE any cache lookup or subprocess spawn. Even cached entries shouldn't
  // serve a previously-poisoned source label.
  const ssrfBlock = await ssrfGuard(url);
  if (ssrfBlock) return ssrfBlock;

  if (!force && ttl !== 0) {
    const store = getStore();
    // Cache key composes (source, url) so two distinct URLs sharing the same
    // `source` label do not collide — they each get their own cache slot
    // (commit 1f1243e regression test enforced).
    const cacheKey = composeFetchCacheKey(source, url);
    const meta = store.getSourceMeta(cacheKey);
    if (meta) {
      const indexedAt = new Date(meta.indexedAt + "Z"); // SQLite datetime is UTC without Z
      const ageMs = Date.now() - indexedAt.getTime();
      const cacheTtlMs = ttl ?? FETCH_TTL_MS;
      if (ageMs < cacheTtlMs) {
        const ageHours = Math.floor(ageMs / (60 * 60 * 1000));
        const ageMin = Math.floor(ageMs / (60 * 1000));
        const ageStr = ageHours > 0 ? `${ageHours}h ago` : ageMin > 0 ? `${ageMin}m ago` : "just now";
        const estimatedBytes = meta.chunkCount * 1600; // ~1.6KB/chunk avg
        return {
          kind: "cached",
          label: meta.label,
          chunkCount: meta.chunkCount,
          estimatedBytes,
          ageStr,
          ttlStr: formatFetchTtl(cacheTtlMs),
        };
      }
      // Stale — fall through to re-fetch silently
    }
  }

  const outputPath = join(tmpdir(), `open_ctx-fetch-${Date.now()}-${Math.random().toString(36).slice(2)}.dat`);
  try {
    const fetchCode = buildFetchCode(url, outputPath);
    const result = await executor.execute({
      language: "javascript",
      code: fetchCode,
      timeout: 30_000,
    });
    if (result.exitCode !== 0) {
      // Subprocess fetch failure — undici / fetch can surface EAI_AGAIN /
      // ETIMEDOUT / ENETUNREACH in stderr when the resolver is overloaded
      // or the network is briefly unavailable. Append the same retry hint
      // ssrfGuard's pre-flight DNS path emits so the agent doesn't capitulate
      // to training data on the first transient failure (PR #654 substitute —
      // sibling-tool consistency with hooks/core/routing.mjs WebFetch wording).
      const raw = result.stderr || result.stdout || "unknown error";
      const isTransientDns = /\b(EAI_AGAIN|ETIMEDOUT|ETIMEOUT|ENETUNREACH|EPERM|getaddrinfo)\b/.test(raw);
      const hint = isTransientDns
        ? " — transient DNS error; retry once before falling back. If it keeps failing, the MCP host may be running under a network sandbox; restart the host with network access enabled."
        : "";
      return { kind: "fetch_error", url, error: `${raw}${hint}`, reason: "exit" };
    }
    const header = (result.stdout || "").trim();
    let markdown: string;
    try {
      // Parent-side defense-in-depth on the subprocess output size. The
      // embedded safeText() in buildFetchCode already caps before writing,
      // but a torn write (subprocess killed mid-write, fs cache desync,
      // etc.) could still leave an oversized file. Bail before slurping
      // multiple gigabytes into the long-running MCP server's heap.
      const MAX_FETCH_OUTPUT_BYTES = 50 * 1024 * 1024;
      const fileSize = statSync(outputPath).size;
      if (fileSize > MAX_FETCH_OUTPUT_BYTES) {
        return {
          kind: "fetch_error",
          url,
          error: `subprocess output ${fileSize} bytes exceeds cap ${MAX_FETCH_OUTPUT_BYTES}`,
          reason: "read",
        };
      }
      markdown = readFileSync(outputPath, "utf-8").trim();
    } catch {
      return { kind: "fetch_error", url, error: "could not read subprocess output", reason: "read" };
    }
    if (markdown.length === 0) {
      return { kind: "fetch_error", url, error: "empty content", reason: "empty" };
    }
    return { kind: "fetched", url, source, markdown, header };
  } catch (err: unknown) {
    return {
      kind: "fetch_error",
      url,
      error: err instanceof Error ? err.message : String(err),
      reason: "throw",
    };
  } finally {
    try {
      rmSync(outputPath);
    } catch {
      /* already gone */
    }
  }
}

interface IndexedFetchResult {
  label: string;
  totalChunks: number;
  totalBytes: number;
  preview: string;
}

/**
 * Serial-only indexing step — single FTS5 write per call. Caller loops over
 * fetched results and calls this one-at-a-time to avoid SQLite WAL contention
 * (PRD finding E).
 */
function indexFetched(f: { url: string; source?: string; markdown: string; header: string }): IndexedFetchResult {
  const store = getStore();
  // Storage label composed via composeFetchCacheKey so two URLs sharing a
  // `source` label do not overwrite each other (commit 1f1243e). open_ctx_search()
  // still finds both via LIKE-mode source filter on the `source` substring.
  const storageLabel = composeFetchCacheKey(f.source, f.url);
  const attribution = currentAttribution();
  let indexed: IndexResult;
  if (f.header === "__CM_CT__:json") {
    indexed = store.indexJSON(f.markdown, storageLabel, undefined, attribution);
  } else if (f.header === "__CM_CT__:text") {
    indexed = store.indexPlainText(f.markdown, storageLabel, undefined, attribution);
  } else {
    indexed = store.index({ content: f.markdown, source: storageLabel, attribution });
  }
  // Track AFTER the FTS5 write succeeds — failed indexes shouldn't inflate the counter.
  trackIndexed(Buffer.byteLength(f.markdown));
  const preview =
    f.markdown.length > FETCH_PREVIEW_LIMIT
      ? charSafePrefix(f.markdown, FETCH_PREVIEW_LIMIT) + "\n\n…[truncated — use open_ctx_search() for full content]"
      : f.markdown;
  return {
    label: indexed.label,
    totalChunks: indexed.totalChunks,
    totalBytes: Buffer.byteLength(f.markdown),
    preview,
  };
}

/** One URL's outcome after the serial index drain, normalized for rendering. */
type FetchFinalized =
  | { kind: "cached"; label: string; chunkCount: number; ageStr: string; ttlStr: string }
  | { kind: "fetched"; indexed: IndexedFetchResult }
  | { kind: "fetch_error"; url: string; error: string; reason: "exit" | "read" | "empty" | "throw" }
  | { kind: "job_error"; url: string; error: string };

/**
 * Serial index drain. Workers race on fetch, but store.index* runs one at a
 * time (FTS5 WAL contention), so fetched results funnel through indexFetched
 * here. Also maintains the cache hit/miss counters open_ctx_stats reports and
 * emits the D2 Phase 5/7 cache-hit events off the hot path.
 */
function finalizeFetchResults(
  settled: PromiseSettledResult<FetchOneResult>[],
  batch: { url: string; source?: string }[],
): FetchFinalized[] {
  const finalized: FetchFinalized[] = [];
  for (let i = 0; i < settled.length; i++) {
    const r = settled[i];
    if (r.status === "rejected") {
      const message = r.reason instanceof Error ? r.reason.message : String(r.reason);
      finalized.push({ kind: "job_error", url: batch[i].url, error: message });
      continue;
    }
    const v = r.value;
    if (v.kind === "cached") {
      sessionStats.cacheHits++;
      sessionStats.cacheBytesSaved += v.estimatedBytes;
      // D2 Phase 5/7 — cache-hit event emission. `bytes_avoided` is the
      // size of the cached payload that would have re-entered context
      // had the TTL window missed. Best-effort, off the hot path.
      const cachedBytes = v.estimatedBytes;
      const cachedLabel = v.label;
      setImmediate(() =>
        emitCacheHitEvent({
          sessionDbPath: getSessionDbPath(),
          source: cachedLabel,
          bytesAvoided: cachedBytes,
        }),
      );
      finalized.push({ kind: "cached", label: v.label, chunkCount: v.chunkCount, ageStr: v.ageStr, ttlStr: v.ttlStr });
    } else if (v.kind === "fetch_error") {
      finalized.push({ kind: "fetch_error", url: v.url, error: v.error, reason: v.reason });
    } else {
      // Serial FTS5 write here — no parallel store.index calls.
      // Cache miss: the URL was not in the TTL window so we paid the
      // network round-trip + re-indexed. Counted here so open_ctx_stats can
      // report nominal cache_hit_rate alongside the existing hit metrics.
      sessionStats.cacheMisses++;
      finalized.push({ kind: "fetched", indexed: indexFetched(v) });
    }
  }
  return finalized;
}

/**
 * Backward-compat single-URL (`{url: "..."}`) response shape. The EXACT
 * original wording is load-bearing — callers and tests match on it — so
 * this is a move, not a rewrite.
 */
function legacySingleFetchResponse(r: FetchFinalized): { content: Array<{ type: "text"; text: string }>; isError?: boolean } {
  if (r.kind === "cached") {
    return {
      content: [
        {
          type: "text" as const,
          text: `Cached: **${r.label}** — ${r.chunkCount} sections, indexed ${r.ageStr} (fresh, TTL: ${r.ttlStr}).\nTo refresh: call open_ctx_fetch_and_index again with \`force: true\`.\n\nYou MUST call open_ctx_search() to answer questions about this content — this cached response contains no content.\nUse: open_ctx_search(queries: [...], source: "${r.label}")`,
        },
      ],
    };
  }
  if (r.kind === "fetched") {
    const totalKB = (r.indexed.totalBytes / 1024).toFixed(1);
    const text = [
      `Fetched and indexed **${r.indexed.totalChunks} sections** (${totalKB}KB) from: ${r.indexed.label}`,
      `Full content indexed in sandbox — use open_ctx_search(queries: [...], source: "${r.indexed.label}") for specific lookups.`,
      "",
      "---",
      "",
      r.indexed.preview,
    ].join("\n");
    return {
      content: [{ type: "text" as const, text }],
    };
  }
  // fetch_error / job_error — preserve original error wording per reason
  const text =
    r.kind === "fetch_error"
      ? r.reason === "empty"
        ? `Fetched ${r.url} but got empty content`
        : r.reason === "read"
          ? `Fetched ${r.url} but could not read subprocess output`
          : r.reason === "exit"
            ? `Failed to fetch ${r.url}: ${r.error}`
            : /* throw */ `Fetch error: ${r.error}`
      : `Fetch error: ${r.error}`;
  return {
    content: [{ type: "text" as const, text }],
    isError: true,
  };
}

/**
 * Batch summary line: counts + sections + size, then one bullet per URL and
 * tightly-capped per-URL previews so an 8-URL batch doesn't undo the
 * context-savings the tool exists to deliver (PRD review finding G1).
 * isError only when EVERY URL failed.
 */
function formatFetchBatchResult(
  finalized: FetchFinalized[],
  batch: { url: string }[],
  effectiveConcurrency: number,
  capped: boolean,
): { content: Array<{ type: "text"; text: string }>; isError: boolean } {
  const FETCH_BATCH_PREVIEW_LIMIT = 384; // ~3KB total for 8-URL batches
  const lines: string[] = [];
  let totalSections = 0;
  let totalBytes = 0;
  let cachedCount = 0;
  let fetchedCount = 0;
  let errorCount = 0;
  const snippets: string[] = [];
  for (const r of finalized) {
    if (r.kind === "cached") {
      cachedCount++;
      lines.push(`- [cache] ${r.label} — ${r.chunkCount} sections (${r.ageStr}, TTL: ${r.ttlStr})`);
    } else if (r.kind === "fetched") {
      fetchedCount++;
      totalSections += r.indexed.totalChunks;
      totalBytes += r.indexed.totalBytes;
      const kb = (r.indexed.totalBytes / 1024).toFixed(1);
      lines.push(`- [new]   ${r.indexed.label} — ${r.indexed.totalChunks} sections (${kb}KB)`);
      const snippet =
        r.indexed.preview.length > FETCH_BATCH_PREVIEW_LIMIT
          ? r.indexed.preview.slice(0, FETCH_BATCH_PREVIEW_LIMIT).trimEnd() + "…"
          : r.indexed.preview;
      snippets.push(`### ${r.indexed.label}\n\n${snippet}`);
    } else {
      errorCount++;
      lines.push(`- [err]   ${r.url}: ${r.error}`);
    }
  }

  const totalKB = (totalBytes / 1024).toFixed(1);
  const cappedNote = capped ? ` cap=${effectiveConcurrency}/${cpus().length}cpu` : "";
  // Status line: counts + sections + size, with singular/plural agreement
  // (count=1 → "1 error" not "1 errors") so the line stays grammatical.
  const fmt = (n: number, sing: string, plur: string) => `${n} ${n === 1 ? sing : plur}`;
  const headerLine =
    `fetched ${batch.length} c=${effectiveConcurrency}${cappedNote}. ` +
    `ok=${fetchedCount} cache=${cachedCount} err=${errorCount}. ` +
    `${fmt(totalSections, "section", "sections")} ${totalKB}KB.`;

  const text = [
    headerLine,
    "",
    ...lines,
    "",
    `open_ctx_search(queries: [...], source: "<label>") for full content.`,
    ...(snippets.length > 0 ? ["", "---", "", ...snippets] : []),
  ].join("\n");

  return {
    content: [{ type: "text" as const, text }],
    isError: errorCount === batch.length, // only mark error if every URL failed
  };
}

registerCtxTool(
  "open_ctx_fetch_and_index",
  {
    title: "Fetch & Index URL(s)",
    // #846: fetches external URLs (open world) and writes them into the store.
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    description: `Fetches URL content, converts HTML to markdown (JSON chunked by key paths, plain text indexed directly), persists it in a knowledge base, returns a small preview per source. Raw page bytes never enter your conversation — they live in storage, retrievable via open_ctx_search. Every fetch is cached on disk for 24h by default; override per-call with \`ttl\`.

WHEN:
  - You need web content (docs, changelogs, API references, spec pages) and the raw bytes should NOT enter your conversation
  - Multi-URL research (library evaluation, migration scans, doc comparisons): pass the \`requests\` array and \`concurrency\` 2-8 for parallel I/O
  - You want repeat lookups against the same URL to be cheap (cache hits return only a hint, no re-fetch)
  - You want a guaranteed-fresh fetch (\`ttl: 0\` or \`force: true\`)

WHEN NOT:
  - You already have the content locally — store it via the inline index tool
  - The page is SPA-rendered (JavaScript-required) — this is a plain HTTP fetch, no headless browser

RETURNS:
  Per-source preview windows around indexable headings plus indexing metadata (chunk counts, source labels, cache). Raw content is NOT echoed back. \`concurrency\` parallelizes the fetch phase only — FTS5 is single-writer, so index writes always serialize. Use 4-8 for I/O-bound batches; lower it under per-IP rate limits.

EXAMPLE: open_ctx_fetch_and_index(
  requests: [{url: "https://react.dev/...", source: "react"}, {url: "https://vuejs.org/...", source: "vue"}],
  concurrency: 5
)`,
    inputSchema: z.object({
      url: z.string().optional().describe("Single URL to fetch and index (legacy single-shape)"),
      source: z
        .string()
        .optional()
        .describe(
          "Label for the indexed content when using single `url` (e.g., 'React useEffect docs', 'Supabase Auth API'). For batch, put source in each requests entry.",
        ),
      requests: z
        .preprocess(
          coerceJsonArray,
          z
            .array(
              z.object({
                url: z.string().describe("URL to fetch"),
                source: z.string().optional().describe("Label for this URL's indexed content"),
              }),
            )
            .min(1),
        )
        .optional()
        .describe(
          "Batch shape: array of {url, source?} entries. Use with concurrency>1 for parallel fetch. " +
            "Each request indexed under its own source label. Output preserves input order.",
        ),
      concurrency: z.coerce
        .number()
        .int()
        .min(1)
        .max(8)
        .optional()
        .default(1)
        .describe(
          "Max URLs to fetch in parallel (1-8, default: 1). " +
            "Use 4-8 for I/O-bound multi-URL batches (library docs, changelogs, pricing pages). " +
            "Capped by os.cpus().length on small machines (response notes when capped). " +
            "Indexing is always serial regardless — only fetches race.",
        ),
      force: z.preprocess(coerceBoolean, z.boolean()).optional().describe("Skip cache and re-fetch even if content was recently indexed"),
      ttl: z.coerce
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
          "Override the cache freshness window for this call, in milliseconds. " +
            "`ttl: 0` bypasses the cache like `force: true`; omit to use the default 24h TTL.",
        ),
    }),
  },
  {
    run: async (rawArgs) => {
      const { url, source, requests, concurrency, force, ttl } = rawArgs as {
        url?: string;
        source?: string;
        requests?: { url: string; source?: string }[];
        concurrency?: number;
        force?: boolean;
        ttl?: number;
      };
      // Normalize input: legacy {url} or new {requests: [...]}.
      // requests wins when both are provided (explicit batch intent).
      const batch: { url: string; source?: string }[] = requests ? requests : url ? [{ url, source }] : [];

      if (batch.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "open_ctx_fetch_and_index requires either `url` (single) or `requests: [{url, source?}, ...]` (batch).",
            },
          ],
          isError: true,
        };
      }

      const isLegacySingle = !requests && batch.length === 1;
      const requestedConcurrency = concurrency ?? 1;

      // Parallel fetch via shared runPool primitive. capByCpuCount only for batch
      // — single-URL doesn't need the cap (only one job, executor is one subprocess).
      const jobs: PoolJob<FetchOneResult>[] = batch.map((req) => ({
        run: () => fetchOneUrl(req.url, req.source, force, ttl),
      }));
      const { settled, effectiveConcurrency, capped } = await runPool(jobs, {
        concurrency: requestedConcurrency,
        capByCpuCount: !isLegacySingle && requestedConcurrency > 1,
      });

      const finalized = finalizeFetchResults(settled, batch);

      if (isLegacySingle) return legacySingleFetchResponse(finalized[0]);

      return formatFetchBatchResult(finalized, batch, effectiveConcurrency, capped);
    },
  },
);

// ─────────────────────────────────────────────────────────
// Tool: batch_execute
// ─────────────────────────────────────────────────────────

registerCtxTool(
  "open_ctx_batch_execute",
  {
    title: "Batch Execute & Search",
    // #846: runs arbitrary shell commands (with network) and indexes output.
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    description: `Run multiple commands in ONE call. Every command's output is auto-indexed into the knowledge base; pass \`queries\` and the matching sections come back in the same round trip. Concurrency parallelizes the fetch phase only — derivation still belongs in code, so add a processing command that consumes indexed output and prints just the answer.

WHEN:
  - You have 3+ related commands you would otherwise run sequentially (multi-issue lookups, git log + diff + blame, multi-file reads, multi-region cloud queries)
  - You want to gather AND query in one round trip — pass \`queries\` so matching sections come back inline
  - You want to parallelize I/O-bound work — pass \`concurrency\` 2-8 (network calls, gh CLI, cloud APIs, multi-repo git reads)
  - Combined output is large enough that a later open_ctx_search pass would itself be expensive

WHEN NOT:
  - Single command with no follow-up query — run it in the sandbox tool directly
  - CPU-bound or stateful commands — keep concurrency at 1 (npm test, build, lint, port-binding servers, lock-file holders, anything racing on the same resource)

RETURNS:
  Auto-indexed section list per command label, plus top matches per query. Raw output is NOT echoed in full.

EXAMPLE: open_ctx_batch_execute(
  commands: [
    {label: "issue 1", command: "gh issue view 1"},
    {label: "issue 2", command: "gh issue view 2"}
  ],
  queries: ["root cause", "proposed fix"],
  concurrency: 2
)`,
    inputSchema: z
      .object({
        commands: z.preprocess(
          coerceCommandsArray,
          z
            .array(
              z.object({
                label: z.string().describe("Section header for this command's output (e.g., 'README', 'Package.json', 'Source Tree')"),
                command: z.string().describe("Shell command to execute"),
              }),
            )
            .min(1)
            .describe(
              "Commands to execute as a batch. Output is labeled with the section header. " +
                "Default order is sequential; pass concurrency>1 to run in parallel (output stays in input order).",
            ),
        ),
        queries: z.preprocess(
          coerceJsonArray,
          z
            .array(z.string())
            .min(1)
            .describe(
              "Search queries to extract information from indexed output. Use 5-8 comprehensive queries. " +
                "Each returns top 5 matching sections with full content. " +
                "This is your ONLY chance — put ALL your questions here. No follow-up calls needed.",
            ),
        ),
        timeoutMs: z.coerce
          .number()
          .optional()
          .describe(
            "Max execution time in MILLISECONDS — timeoutMs: 120000 is two minutes, timeoutMs: 120 is 0.12 seconds. When omitted, the host's own RPC timeout governs where it has one; on hosts that do not bound a call (Pi, Antigravity CLI) a generous server-side default applies per command. With concurrency=1, a value you pass is a shared budget across commands; with concurrency>1, it is applied per-command.",
          ),
        concurrency: z.coerce
          .number()
          .int()
          .min(1)
          .max(8)
          .optional()
          .default(1)
          .describe(
            "Max commands to run in parallel (1-8, default: 1). " +
              "Use 4-8 for I/O-bound batches (network, gh, curl, multi-repo git reads). " +
              "Keep at 1 for CPU-bound (npm test, build, lint) or stateful commands (ports, locks). " +
              ">1 switches to per-command timeouts (no shared budget) and " +
              "individual `(timed out)` blocks instead of cascading skip.",
          ),
        cwd: z.string().optional().describe("Optional working directory for all shell commands in this batch."),
        query_scope: z
          .enum(["batch", "global"])
          .optional()
          .default("batch")
          .describe(
            "Scope for `queries` (default: `batch`). " +
              "`batch` searches ONLY the chunks produced by this batch's commands " +
              "— useful when you want answers about the just-fetched output. " +
              "`global` searches the entire persistent index (same scope as open_ctx_search) " +
              "— useful when you want the batch commands to enrich context and " +
              "the queries to also surface related prior knowledge in one round trip.",
          ),
      })
      .passthrough(), // #1081 — see open_ctx_execute
  },
  {
    gate: (args: ToolArgs) => {
      const legacyTimeout = checkLegacyTimeoutArg(args, "open_ctx_batch_execute");
      if (legacyTimeout) return legacyTimeout;
      const { commands } = args as { commands: { label: string; command: string }[] };

      // Security: check each command against deny patterns
      for (const cmd of commands) {
        const denied = checkDenyPolicy(cmd.command, "batch_execute");
        if (denied) return denied;
      }
      return null;
    },
    error: { title: "Batch execution error" },
    run: async (rawArgs, extra) => {
      const { commands, queries, timeoutMs, concurrency, cwd, query_scope } = rawArgs as {
        commands: { label: string; command: string }[];
        queries: string[];
        timeoutMs?: number;
        concurrency: number;
        cwd?: string;
        query_scope: "batch" | "global";
      };

      // Inject NODE_OPTIONS for FS read tracking in spawned Node processes.
      // The executor denies NODE_OPTIONS in its env (security), so we set it
      // at the top of each command's shell script. This only affects child `node` invocations.
      // ensureFsPreload re-creates the temp file if an OS temp cleaner removed
      // it since startup — injecting a missing --require kills every node
      // child with MODULE_NOT_FOUND (#951).
      const nodeOptsPrefix = buildBatchNodeOptionsPrefix(runtimes.shell, ensureFsPreload());

      // Full stdout is preserved per-command and indexed into FTS5 (Issue #61, #197).
      // Concurrency>1 switches to a worker pool with per-command timeouts.
      const effTimeout = resolveExecTimeout(timeoutMs);
      // #947: an explicit `timeoutMs` is the budget for the WHOLE handler, not
      // just the command phase. Indexing, the section inventory and the
      // per-query FTS search that follow are synchronous SQLite, and nothing
      // here can interrupt one already in flight — so the deadline is polled
      // between those phases: the running one finishes, nothing new starts.
      // Before this, a call that asked for 120s stayed in flight for 257
      // minutes behind a bloated index (oversized chunks are #878's half).
      // A host default (HOST_DEFAULT_EXEC_TIMEOUT_MS) stays a per-command
      // backstop and does NOT bound the handler — same rule as
      // BatchRunOptions.callerBudget, so nothing that relied on unbounded
      // indexing changes behavior.
      // ponytail: one search over a single 36MB chunk still runs to
      // completion; bounding that needs an interruptible cursor in store.ts,
      // not a timer here.
      const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
      const budgetSpent = () => deadline !== undefined && Date.now() >= deadline;
      const { outputs: perCommandOutputs, timedOut } = await runBatchCommands(
        commands,
        {
          timeout: effTimeout,
          callerBudget: timeoutMs !== undefined,
          concurrency,
          nodeOptsPrefix,
          cwd,
          signal: extra?.signal,
          onFsBytes: (bytes) => {
            sessionStats.bytesSandboxed += bytes;
          },
        },
        executor,
      );

      // #1068: the preload reports on a side file, so the descendant tree's
      // fs-read bytes are summed here instead of arriving as stderr markers
      // that only the direct child's stream could attribute.
      sessionStats.bytesSandboxed += drainFsPreloadBytes();

      const stdout = perCommandOutputs.join("\n");
      const totalBytes = Buffer.byteLength(stdout);
      const totalLines = stdout.split("\n").length;

      if (timedOut && perCommandOutputs.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Batch timed out after ${effTimeout}ms. No output captured.`,
            },
          ],
          isError: true,
        };
      }

      // Track indexed bytes (raw data that stays in sandbox)
      trackIndexed(totalBytes);

      // Index into knowledge base — markdown heading chunking splits by # labels
      const store = getStore();
      const source = `batch:${commands
        .map((c) => c.label)
        .join(",")
        .slice(0, 80)}`;
      const skippedPhases: string[] = [];
      const indexed = budgetSpent() ? null : store.index({ content: stdout, source, attribution: currentAttribution() });
      if (!indexed) skippedPhases.push("indexing");

      // Commands inventory — list what the agent actually ran so the
      // response itself documents intent, not just per-section echoes.
      // Placed before "## Indexed Sections" so it scans top-down with
      // the human asking "what just happened" (Issues #717 + #736).
      const commandEchoMax = commandEchoBudget();
      const commandsInventory: string[] = [];
      if (commandEchoMax > 0) {
        commandsInventory.push("## Commands", "");
        for (const c of commands) {
          commandsInventory.push(`- ${c.label}: \`${truncateCommandForEcho(c.command, commandEchoMax)}\``);
        }
        commandsInventory.push("");
      }

      // Build section inventory — direct query by source_id (no FTS5 MATCH needed)
      const allSections = indexed ? store.getChunksBySource(indexed.sourceId) : [];
      const inventory: string[] = ["## Indexed Sections", ""];
      const sectionTitles: string[] = [];
      for (const s of allSections) {
        const bytes = Buffer.byteLength(s.content);
        inventory.push(`- ${s.title} (${(bytes / 1024).toFixed(1)}KB)`);
        sectionTitles.push(s.title);
      }

      // Run all search queries — default scope is batch-local (legacy behavior).
      // When the caller passes query_scope: "global", searches reach the entire
      // persistent index in the same round trip. Cross-source search remains
      // available via explicit open_ctx_search() as well.
      const batchStats: { anyMiss: boolean; budgetExhausted?: boolean; searched?: number } = { anyMiss: false };
      const queryResults = formatBatchQueryResults(store, queries, source, undefined, query_scope, batchStats, deadline);

      // Searchable terms help the agent reformulate after a miss. Surface them
      // only when at least one query returned nothing (the follow-up case),
      // not on the common all-hit path, to keep the batch footer lean.
      const distinctiveTerms =
        batchStats.anyMiss && indexed && store.getDistinctiveTerms ? store.getDistinctiveTerms(indexed.sourceId) : [];

      // A cut batch must not read like a complete one: `timedOut` was
      // previously surfaced only when NOTHING ran, so a killed or skipped
      // command in the middle looked like a command with no output.
      const cutNotice = timedOut
        ? ` Cut short: at least one command hit the ${effTimeout}ms limit — sections marked ` +
          "(timed out …) or (skipped …) are incomplete."
        : "";
      // #947: the budget is a promise, so a call that spent it says which
      // phases it dropped instead of returning a thin answer that reads
      // complete.
      const budgetNotice =
        skippedPhases.length > 0 || batchStats.budgetExhausted
          ? `\n> **Budget:** the ${timeoutMs}ms budget ran out during this call — skipped ${[
              ...skippedPhases,
              ...(batchStats.budgetExhausted ? ["the remaining queries"] : []),
            ].join(", ")}. The command output above is complete; re-run with a larger \`timeoutMs\` or query it with \`open_ctx_search()\`.`
          : "";
      const output = [
        `Executed ${commands.length} commands (${totalLines} lines, ${(totalBytes / 1024).toFixed(1)}KB). ` +
          `Indexed ${indexed ? indexed.totalChunks : 0} sections. ` +
          `Searched ${batchStats.searched ?? 0} of ${queries.length} queries.${cutNotice}`,
        "",
        ...commandsInventory,
        ...inventory,
        "",
        ...queryResults,
        budgetNotice,
        distinctiveTerms.length > 0 ? `\nSearchable terms for follow-up: ${distinctiveTerms.join(", ")}` : "",
      ].join("\n");

      return {
        content: [{ type: "text" as const, text: output }],
      };
    },
  },
);

/**
 * Pi byte accounting: patch lifetime.totalEvents from bytes_sandboxed
 * in stats-*.json files instead of the default events × 256 heuristic.
 * Only active for Pi adapter — other platforms use getLifetimeStats() as-is.
 */
function patchPiLifetimeFromStatsFiles(lifetime: ReturnType<typeof getLifetimeStats>, sessionsDir: string): void {
  if (!existsSync(sessionsDir)) return;
  let sandboxedBytes = 0;
  try {
    for (const f of readdirSync(sessionsDir)) {
      if (!f.startsWith("stats-") || !f.endsWith(".json")) continue;
      try {
        const raw = JSON.parse(readFileSync(join(sessionsDir, f), "utf-8"));
        sandboxedBytes += (raw?.bytes_sandboxed ?? 0) + (raw?.bytes_indexed ?? 0);
      } catch {
        /* corrupt file — skip */
      }
    }
  } catch {
    /* never block open_ctx_stats on stats file I/O */
  }
  if (sandboxedBytes > 0) {
    const rescueTokens = (lifetime.rescueBytes ?? 0) / 4;
    lifetime.totalEvents = Math.round((sandboxedBytes / 4 + rescueTokens) / 256);
  }
}

// ─────────────────────────────────────────────────────────
// Tool: stats
// ─────────────────────────────────────────────────────────

/**
 * Create a minimal in-memory DB adapter for when the session DB is unavailable.
 * All queries return empty results so AnalyticsEngine.queryAll() still works.
 */
/** Share an explicitly requested lifetime aggregation with status heartbeats. */
function publishLifetimeTokenSnapshot(lifetime: ReturnType<typeof getLifetimeStats>): void {
  const now = Date.now();
  const tokens = Math.max(0, lifetime.totalEvents * TOKENS_PER_EVENT);
  _lifetimeCache = { tokens, computedAt: now };
  try {
    writeLifetimeTokenSnapshot(getStatsStorageDir(), tokens, now);
  } catch {
    // best-effort — open_ctx_stats reporting must not depend on snapshot persistence
  }
}

/** #1111 fork adaptation: cold-start the shared snapshot once at boot so a
 * user who never calls open_ctx_stats still gets real numbers in the statusline
 * (upstream leaves lifetime at zero until the first explicit open_ctx_stats).
 * One scan at startup; heartbeats stay O(1) forever after. */
async function ensureLifetimeSnapshot(): Promise<void> {
  try {
    if (readLifetimeTokenSnapshot(getStatsStorageDir())) return;
    const life = getLifetimeStats({ sessionsDir: getSessionDir() });
    if (life) publishLifetimeTokenSnapshot(life);
  } catch {
    // best-effort — heartbeats fall back to cache/0
  }
}

function createMinimalDb(): import("./session/analytics-query.js").DatabaseAdapter {
  return {
    prepare: () => ({
      run: () => undefined,
      get: (..._args: unknown[]) => ({ cnt: 0, compact_count: 0, minutes: null, rate: 0, avg: 0, outcome: "exploratory" }),
      all: () => [],
    }),
  };
}

/**
 * Conversation kit open_ctx_stats feeds formatReport so the narrative 5-section
 * layout (timeline, ladder, receipt, example cost, auto-memory) renders
 * instead of the legacy active-session header. Resolves the caller's
 * session id, falling back to the most-recent UUID session_id in `sdb`.
 * Best-effort: returns undefined when no session can be resolved —
 * formatReport then falls back to the legacy header.
 */
async function resolveConversationKit(
  sdb: InstanceType<ReturnType<typeof loadDatabase>>,
  dbHash: string,
): Promise<
  | {
      conversation: ReturnType<typeof getConversationStats>;
      realBytes: {
        conversation: ReturnType<typeof getConversationWindowStats>;
        lifetime: ReturnType<typeof getRealBytesStats>;
      };
    }
  | undefined
> {
  try {
    const row = sdb
      .prepare(
        "SELECT session_id FROM session_events WHERE session_id LIKE '________-____-____-____-____________' ORDER BY created_at DESC LIMIT 1",
      )
      .get() as { session_id: string } | undefined;
    const sid = row?.session_id;
    if (!sid) return undefined;

    const conversation = getConversationStats({ sessionId: sid, sessionsDir: getSessionDir(), worktreeHash: dbHash });
    // v1.0.133 Slice 3: pass contentDbPath so getRealBytesStats can
    // join chunks WHERE session_id = sid and fold the indexed
    // content bytes into the per-conversation bar. Without this,
    // Mert's session showed ~200B (event metadata only) even with
    // 49 MB of indexed content sitting in the content DB.
    // Render-time read-only — no DB mutation, no backfill.
    const contentDbPath = getStorePath();
    // v1.0.148 Bug E+F: a conversation typically spans many
    // session_ids (resume cycles, /compact rebirths, PID
    // sub-process sessions launched by open_ctx_execute). Scoping
    // per-session loses sandbox-burst bytes_avoided that the
    // PID-sessions own. Look up THIS session's project_dir
    // from META and aggregate via META subquery so all
    // sibling sessions in the same cwd attribute together.
    // Fallback to sessionId scope if the META lookup fails
    // (best-effort — the original metric is still defensible).
    let convReal;
    try {
      const Database = loadDatabase();
      const dbFiles = (await import("node:fs"))
        .readdirSync(getSessionDir())
        .filter((f) => f.endsWith(".db") && (!dbHash || f.startsWith(dbHash)));
      let projectDirForSid: string | undefined;
      for (const file of dbFiles) {
        try {
          const db = new Database((await import("node:path")).join(getSessionDir(), file), { readonly: true });
          try {
            const r = db.prepare("SELECT project_dir FROM session_meta WHERE session_id = ?").get(sid) as
              | { project_dir: string }
              | undefined;
            if (r?.project_dir) {
              projectDirForSid = r.project_dir;
              break;
            }
          } finally {
            db.close();
          }
        } catch {
          /* skip unreadable DB */
        }
      }
      // Section 1 "Where you are now" = the LIVE conversation window.
      // Sub-agents + open_ctx_execute sub-process sessions write to this
      // SAME worktree DB (same worktreeHash = sha256(cwd)) under their
      // own session_ids; their retrieval hit their own disposable
      // windows, not yours. getConversationWindowStats credits the
      // whole worktree's kept-out bytes while counting only THIS
      // session's retrieval as "With open-context-mode", and the
      // worktreeHash scope keeps the user's OTHER parallel worktrees
      // out. projectDirForSid is intentionally dropped — it
      // under-counted (missed empty-project_dir sub-process sessions)
      // and could not separate sub-agent retrieval from the window's.
      void projectDirForSid;
      convReal = getConversationWindowStats({
        sessionId: sid,
        worktreeHash: dbHash,
        sessionsDir: getSessionDir(),
        contentDbPath,
      });
    } catch {
      convReal = getConversationWindowStats({
        sessionId: sid,
        worktreeHash: dbHash,
        sessionsDir: getSessionDir(),
        contentDbPath,
      });
    }
    const lifeRealBase = getRealBytesStats({ sessionsDir: getSessionDir() });
    // Honest-savings fix (#952, reverts the v1.0.134 SLICE C fold):
    // indexed chunks are content captured for recall — the bulk of it
    // entered past context windows through the original tool results,
    // so counting it as "kept out" double-counts. Chunks stay visible
    // as contentBytes; bytesAvoided counts only recorded redirects.
    const lifeContentBytes = getContentBytesAllSessions(contentDbPath);
    const lifetime = {
      ...lifeRealBase,
      contentBytes: lifeRealBase.contentBytes + lifeContentBytes,
      bytesAvoided: lifeRealBase.bytesAvoided,
      totalSavedTokens: Math.floor(lifeRealBase.bytesAvoided / 4),
    };
    return { conversation, realBytes: { conversation: convReal, lifetime } };
  } catch {
    /* never block open_ctx_stats */
    return undefined;
  }
}

registerCtxTool(
  "open_ctx_stats",
  {
    title: "Session Statistics",
    // #846: read-only diagnostics. Was cancelled by Codex when unannotated.
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    description:
      "Returns context consumption statistics for the current session. " +
      "Shows total bytes returned to context, breakdown by tool, call counts, " +
      "estimated token usage, and context savings ratio.",
    inputSchema: z.object({}),
  },
  {
    run: async () => {
      // ONE call, ONE source — AnalyticsEngine.queryAll()
      let text: string;
      try {
        const projectDir = getProjectDir();
        // Canonical hash + migration-aware path. The downstream
        // getConversationStats / getRealBytesStats reconstruct the DB
        // filename from worktreeHash; pass the SAME canonical hash that
        // resolveSessionDbPath used so they hit the same file.
        const dbHash = hashProjectDirCanonical(projectDir);
        const sessionDbPath = resolveSessionDbPath({
          projectDir,
          sessionsDir: getSessionDir(),
        });

        if (existsSync(sessionDbPath)) {
          const Database = loadDatabase();
          const sdb = new Database(sessionDbPath, { readonly: true });
          try {
            const engine = new AnalyticsEngine(sdb);
            const report = engine.queryAll(sessionStats);
            // MCP usage is read-only and cheap; only available when DB exists.
            const mcpUsage = engine.getMcpToolUsage();
            // Lifetime stats span every project's SessionDB + auto-memory dir
            // (Bugs #3/#4); failures are absorbed inside getLifetimeStats so a
            // corrupt sidecar can never break open_ctx_stats.
            // B3b Slice 3.1: scope to active adapter via getSessionDir() so
            // non-Claude platforms (Cursor, OpenCode, JetBrains, ...) read
            // from THEIR sessions dir — not the hardcoded ~/.claude/ default.
            // Mirrors the statusline contract at src/server.ts:540.
            const lifetime = getLifetimeStats({ sessionsDir: getSessionDir() });
            // B3b Slices 3.2-3.6: cross-adapter aggregation so the renderer
            // can show "Where it came from" + the "across N AI tools"
            // headline. Best-effort — failures absorbed so a corrupt
            // sidecar in any adapter dir cannot break open_ctx_stats.
            let multiAdapter;
            try {
              multiAdapter = getMultiAdapterLifetimeStats();
            } catch {
              /* never block open_ctx_stats */
            }
            // F1: wire conversation + realBytes opts so formatReport renders the
            // narrative 5-section "kitap gibi" layout (timeline, ladder, receipt,
            // example cost, auto-memory). Without these, formatReport falls back
            // to the legacy active-session header. Best-effort — failures absorbed.
            // Resolve the caller's session before the most-recent fallback:
            // UUID session_id from session_events in this DB.
            // narrative 5-section "kitap gibi" layout (timeline, ladder, receipt,
            // example cost, auto-memory). Without these, formatReport falls back
            // to the legacy active-session header. Best-effort — failures absorbed.
            const kit = await resolveConversationKit(sdb, dbHash);
            const conversation = kit?.conversation;
            const realBytes = kit?.realBytes;

            publishLifetimeTokenSnapshot(lifetime);
            // v1.0.117: pass projectDir as cwd so the narrative renderer's
            // "started in <path>" line matches the user's actual project.
            // Snapshot the persistent store so the renderer can show
            // total_chunks / last_indexed_at without callers having to query
            // separately. Best-effort — getStore() is process-local and may
            // be unavailable on cold paths; failures are absorbed.
            let indexState;
            try {
              indexState = getStore().getIndexState();
            } catch {
              /* never block open_ctx_stats */
            }
            text = formatReport(report, VERSION, _latestVersion, {
              lifetime,
              mcpUsage,
              multiAdapter,
              conversation,
              realBytes,
              indexState,
              cwd: projectDir,
            });
          } finally {
            sdb.close();
          }
        } else {
          // No session DB — build a minimal report from runtime stats only.
          // Lifetime still meaningful (other projects, auto-memory) so include it.
          const engine = new AnalyticsEngine(createMinimalDb());
          const report = engine.queryAll(sessionStats);
          const lifetime = getLifetimeStats({ sessionsDir: getSessionDir() });
          publishLifetimeTokenSnapshot(lifetime);
          let multiAdapter;
          try {
            multiAdapter = getMultiAdapterLifetimeStats();
          } catch {
            /* never block open_ctx_stats */
          }
          let indexState;
          try {
            indexState = getStore().getIndexState();
          } catch {
            /* never block open_ctx_stats */
          }
          text = formatReport(report, VERSION, _latestVersion, { lifetime, multiAdapter, indexState });
        }
      } catch {
        // Session DB not available or incompatible — build minimal report from runtime stats
        const engine = new AnalyticsEngine(createMinimalDb());
        const report = engine.queryAll(sessionStats);
        let lifetime;
        try {
          lifetime = getLifetimeStats({ sessionsDir: getSessionDir() });
        } catch {
          /* never block open_ctx_stats */
        }
        if (lifetime) publishLifetimeTokenSnapshot(lifetime);
        let multiAdapter;
        try {
          multiAdapter = getMultiAdapterLifetimeStats();
        } catch {
          /* never block open_ctx_stats */
        }
        text = formatReport(report, VERSION, _latestVersion, lifetime || multiAdapter ? { lifetime, multiAdapter } : undefined);
      }

      return {
        content: [{ type: "text" as const, text }],
      };
    },
  },
);

// ── open_ctx-doctor: diagnostics (server-side) ─────────────────────────────────
registerCtxTool(
  "open_ctx_doctor",
  {
    title: "Run Diagnostics",
    // #846: read-only diagnostics (runs an internal self-test, mutates nothing).
    // Was cancelled by Codex when unannotated.
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    description:
      "Diagnose open-context-mode installation. Runs all checks server-side and " +
      "returns a plain-text status report with [OK]/[FAIL]/[WARN] prefixes " +
      "(renderer-safe across MCP clients). No CLI execution needed.",
    inputSchema: z.object({}),
  },
  {
    run: async () => {
      // Renderer-safe output (Mickey #3 — Z.ai GLM 4.7 ReferenceError):
      // Z.ai's MCP renderer mounts a custom React component for GitHub-flavored
      // markdown task-list syntax (`- [x]` / `- [ ]` / `- [-]`) that depends on
      // a missing `client` context, throwing `ReferenceError: client is not
      // defined`. We avoid both task-list syntax AND `## ` h2 headings to stay
      // safe across all MCP renderers — using plain-text status prefixes
      // (`[OK]` / `[FAIL]` / `[WARN]`) instead.
      const lines: string[] = ["open-context-mode doctor", ""];
      let currentPlatform: PlatformId | undefined;
      try {
        currentPlatform = detectPlatform(server.server.getClientVersion() ?? undefined).platform;
      } catch {
        currentPlatform = detectPlatform().platform;
      }
      // __pkg_dir is build/ for tsc, plugin root for bundle — resolve to plugin root.
      // Codex is special: when plugin-manager runtime root differs from the
      // current package root, diagnose the root Codex will actually execute.
      const pluginRoot = getRuntimeAwarePackageRoot();

      // Runtimes
      const total = 11;
      const pct = ((available.length / total) * 100).toFixed(0);
      lines.push(`[OK] Runtimes: ${available.length}/${total} (${pct}%) — ${available.join(", ")}`);

      // Performance
      if (hasBunRuntime()) {
        lines.push("[OK] Performance: FAST (Bun)");
      } else {
        lines.push("[WARN] Performance: NORMAL — install Bun for 3-5x speed boost");
      }

      const sessionStorage = resolveSessionStorageDir(getDefaultSessionDir);
      const contentStorage = resolveContentStorageDir(getDefaultSessionDir);
      const statsStorage = resolveStatsStorageDir(getDefaultSessionDir);
      lines.push(`[OK] Storage sessions: ${sessionStorage.path} (${describeStorageDirectorySource(sessionStorage)})`);
      lines.push(`[OK] Storage content: ${contentStorage.path} (${describeStorageDirectorySource(contentStorage)})`);
      lines.push(`[OK] Storage stats: ${statsStorage.path} (${describeStorageDirectorySource(statsStorage)})`);

      // Server test — cleanup executor to prevent resource leaks (#247)
      lines.push(await doctorServerTestLine());

      // FTS5 / SQLite — close in finally to prevent GC segfault (#247)
      lines.push(doctorFts5Line());

      // Hooks
      lines.push(...(await doctorHookLines(pluginRoot)));

      // Version
      lines.push(`[OK] Version: v${VERSION}`);

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    },
  },
);

// ── open_ctx-purge: explicit knowledge base wipe ─────────────────────────────────
//
// Issue #520 — scoped purge.
// The schema is ADDITIVE: bare {confirm:true} preserves the legacy
// project-wide wipe verbatim (with a stderr deprecation warning so
// future callers migrate to explicit scope). When sessionId is given,
// only that session's rows + FTS5 chunks are removed; project-wide
// files (events.md, FTS5 store file, stats file) are preserved.
// Passing both sessionId AND scope:"project" is ambiguous (does the
// caller want a per-session wipe or a project-wide one?) and is
// rejected by an explicit check in the handler body — NOT a schema-level
// .refine(). MCP SDK's normalizeObjectSchema() reads `.shape` to project
// inputSchema → JSON Schema for tools/list; a ZodEffects (refine wrapper)
// has no `.shape`, so the SDK silently emits `properties: {}`, and Claude
// Code's strict-input-validation gate then rejects EVERY call to this
// tool with "input_schema does not support fields". Issue #563.
/** Doctor check: sandbox executor round-trip. Cleanup prevents resource leaks (#247). */
async function doctorServerTestLine(): Promise<string> {
  const testExecutor = new PolyglotExecutor({ runtimes });
  try {
    const result = await testExecutor.execute({ language: "javascript", code: 'console.log("ok");', timeout: 5000 });
    if (result.exitCode === 0 && result.stdout.trim() === "ok") {
      return "[OK] Server test: PASS";
    }
    const detail = result.stderr?.trim() ? ` (${charSafePrefix(result.stderr.trim(), 200)})` : "";
    return `[FAIL] Server test: FAIL — exit ${result.exitCode}${detail}`;
  } catch (err: unknown) {
    return `[FAIL] Server test: FAIL — ${err instanceof Error ? err.message : err}`;
  } finally {
    testExecutor.cleanupBackgrounded();
  }
}

/** Doctor check: FTS5 present and queryable in the loaded sqlite driver. */
function doctorFts5Line(): string {
  let testDb: (ReturnType<typeof loadDatabase> extends (...args: any[]) => infer R ? R : never) | undefined;
  try {
    const Database = loadDatabase();
    testDb = new Database(":memory:");
    testDb.exec("CREATE VIRTUAL TABLE fts_test USING fts5(content)");
    testDb.exec("INSERT INTO fts_test(content) VALUES ('hello world')");
    const row = testDb.prepare("SELECT * FROM fts_test WHERE fts_test MATCH 'hello'").get() as { content: string } | undefined;
    if (row && row.content === "hello world") {
      return "[OK] FTS5 / SQLite: PASS — native module works";
    }
    return "[FAIL] FTS5 / SQLite: FAIL — unexpected result";
  } catch (err: unknown) {
    return `[FAIL] FTS5 / SQLite: FAIL — ${err instanceof Error ? err.message : err}`;
  } finally {
    try {
      testDb?.close();
    } catch {
      /* best effort */
    }
  }
}

/**
 * Doctor check: the detected adapter's hook configuration and every direct
 * .mjs hook script path it declares. Adapter detection failing is a WARN,
 * not a FAIL — the server still works, hooks just cannot be verified.
 */
async function doctorHookLines(pluginRoot: string): Promise<string[]> {
  const lines: string[] = [];
  const diagnosticAdapter = await getDiagnosticAdapter();
  if (!diagnosticAdapter) {
    lines.push("[WARN] Hooks: adapter detection unavailable");
    return lines;
  }

  for (const result of diagnosticAdapter.validateHooks(pluginRoot)) {
    const prefix = result.status === "pass" ? "[OK]" : result.status === "warn" ? "[WARN]" : "[FAIL]";
    const fix = result.fix ? ` — fix: ${result.fix}` : "";
    lines.push(`${prefix} ${result.check}: ${result.message}${fix}`);
  }

  return lines;
}
registerCtxTool(
  "open_ctx_purge",
  {
    title: "Purge Knowledge Base",
    // #846: permanently deletes indexed content — destructive. Purging an
    // already-purged scope has no further effect (idempotent). No network.
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    description: `DESTRUCTIVE: permanently delete indexed content. Cannot be undone. Requires confirm:true and one scope.

WHEN:
  - User explicitly asks to clear a specific session ('purge this session', 'wipe this conversation')
  - User explicitly asks to reset the whole project ('reset everything', 'wipe the knowledge base')

WHEN NOT:
  - User says 'reset', 'clear', or 'wipe' without naming a scope -> ask which scope before calling
  - User wants to free memory -> recommend open_ctx_stats first

SCOPES (pass exactly one):
  - Per-session: open_ctx_purge(confirm: true, sessionId: "<uuid>") — deletes that session's events and chunks; siblings and stats preserved.
  - Per-project: open_ctx_purge(confirm: true, scope: "project") — wipes the FTS5 knowledge base, session DB rows, events markdown, and resets stats. Preview with open_ctx_stats first.

CONTRACT:
  - confirm:true is required; confirm:false returns 'purge cancelled'.
  - sessionId and scope:'project' together return 'ambiguous - pick one'.
  - scope:'session' without sessionId throws.
  - Bare {confirm:true} is deprecated: maps to scope:'project' with a warning.

RETURNS:
  A summary of removed rows + the resolved scope.

EXAMPLE: open_ctx_purge(confirm: true, sessionId: "7c8a-1234-5678-9abc-def012345678")`,
    // NOTE: schema MUST be a plain z.object — no .refine()/.transform()/
    // .superRefine() wrapper. See block comment above & issue #563. The
    // cross-field ambiguity check lives in the handler body below.
    inputSchema: z.object({
      // confirm: wrapped in coerceBoolean preprocessor — OpenCode's native
      // plugin bridge can deliver `confirm:"true"` / `confirm:"false"` as
      // string literals. Without this, v1.0.139's inputSchema.parse() path
      // rejects valid intent as "Expected boolean, received string" (#627).
      confirm: z.preprocess(coerceBoolean, z.boolean()).describe("MUST be true. Destructive operation; false returns 'purge cancelled'."),
      sessionId: z
        .string()
        .optional()
        .describe(
          "UUID of a single session. Pairs with confirm:true to wipe only that " +
            "session's events + per-session FTS5 chunks. Sibling sessions and the " +
            "stats file are preserved. MUST NOT be combined with scope:'project'.",
        ),
      scope: z
        .enum(["session", "project"])
        .optional()
        .describe(
          "Explicit scope selector. 'session' REQUIRES sessionId. 'project' wipes " +
            "the entire project (FTS5 + every session + stats). Omit only for the " +
            "deprecated bare-{confirm:true} back-compat path.",
        ),
    }),
  },
  {
    run: async (rawArgs) => {
      const { confirm, sessionId, scope } = rawArgs as { confirm: boolean; sessionId?: string; scope?: "session" | "project" };
      // Cross-field ambiguity check — formerly a schema .refine(), moved
      // into the handler so the inputSchema stays a plain ZodObject and
      // the MCP SDK can serialize `.shape` into JSON Schema (issue #563).
      // Same human-readable message as the original refine() preserved.
      if (sessionId && scope === "project") {
        return {
          content: [
            {
              type: "text" as const,
              text:
                "Ambiguous purge: sessionId implies scope:'session', cannot combine with scope:'project'. " +
                "Use scope:'project' WITHOUT sessionId for the legacy whole-project wipe.",
            },
          ],
          isError: true,
        };
      }
      if (!confirm) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Purge cancelled. Pass confirm: true to proceed.",
            },
          ],
        };
      }

      // Effective scope resolution:
      //   - explicit scope wins
      //   - else "session" iff sessionId is given
      //   - else "project" (back-compat — emit deprecation warning so
      //     callers migrate to the explicit form before a future major).
      const effectiveScope: "session" | "project" = scope ?? (sessionId ? "session" : "project");
      if (!scope && !sessionId) {
        console.warn(
          "[open-context-mode] open_ctx_purge: bare {confirm:true} is deprecated. " +
            "Pass scope:'project' for the whole-project wipe, or scope:'session' + sessionId " +
            "for a scoped wipe. See issue #520.",
        );
      }

      // Close the persistent FTS5 content store handle BEFORE delegating to
      // purgeSession so the store's lock is released on Windows. The handle
      // is recreated lazily on the next getStore() call.
      let storePathForPurge: string | undefined;
      try {
        storePathForPurge = getStorePath();
      } catch {
        /* best effort — store path may be unresolvable on fresh install */
      }
      if (storePathForPurge) {
        const store = _stores.get(storePathForPurge);
        if (store) {
          try {
            store.cleanup();
          } catch {
            /* best effort */
          }
          _stores.delete(storePathForPurge);
        }
      } else {
        for (const store of _stores.values()) {
          try {
            store.cleanup();
          } catch {
            /* best effort */
          }
        }
        _stores.clear();
      }

      // FTS5 store: pass contentDir so purgeSession sweeps BOTH canonical
      // and legacy raw-casing variants (dual-hash, mirrors session events).
      // storePath is also passed for the rare case where the resolver picked
      // an absolute path that differs from the dual-hash pair (e.g. caller
      // pre-migrated). Both paths are de-duped during unlink.
      const contentDir = storePathForPurge ? dirname(storePathForPurge) : undefined;
      const { deleted } = purgeSession({
        projectDir: getProjectDir(),
        sessionsDir: getSessionDir(),
        storePath: storePathForPurge,
        contentDir,
        legacyContentDir: join(homedir(), ".open-context-mode", "content"),
        // hashProjectDirLegacy mirrors the deployed (≤ v1.0.111) raw-casing
        // hash that named files under ~/.open-context-mode/content/. Using the
        // legacy hash here is correct: that pre-pre-legacy directory was
        // never migrated and still uses raw casing.
        contentHash: hashProjectDirLegacy(getProjectDir()),
        scope: effectiveScope,
        sessionId,
      });

      // Stats are PROJECT-scoped (one stats file per project, summing all
      // sessions). A scoped per-session purge MUST leave stats alone — they
      // still belong to other sessions in the same project. Stats reset
      // happens ONLY when scope === "project".
      if (effectiveScope === "project") {
        // Reset in-memory session stats
        sessionStats.calls = {};
        sessionStats.bytesReturned = {};
        sessionStats.bytesIndexed = 0;
        sessionStats.bytesSandboxed = 0;
        sessionStats.cacheHits = 0;
        sessionStats.cacheBytesSaved = 0;
        sessionStats.sessionStart = Date.now();
        deleted.push("session stats");

        // Also drop the persisted stats file so external readers see a fresh state
        try {
          const statsFile = getStatsFilePath();
          if (existsSync(statsFile)) unlinkSync(statsFile);
        } catch {
          /* best effort */
        }
      }

      const message =
        effectiveScope === "session"
          ? `Purged session ${sessionId}: ${deleted.length ? deleted.join(", ") : "no matching rows"}. ` +
            `Other sessions and project-wide stats preserved.`
          : `Purged: ${deleted.join(", ")}. All session data for this project has been permanently deleted.`;
      return {
        content: [
          {
            type: "text" as const,
            text: message,
          },
        ],
      };
    },
  },
);

// ── open_ctx_insight process helpers ──────────────────────────────────────────────
// Cross-platform process helpers used by open_ctx_insight (below) and the dashboard
// launcher in cli.ts. All entry points use argv arrays — never `sh -c <string>`
// — so caller-derived values cannot escape into shell context. See issue #441.
//
// `browserOpenArgv` is duplicated as a private 16-LOC copy in cli.ts to avoid
// pulling server.ts top-level boot side effects into the cli bundle.

export type SpawnSyncFn = (cmd: string, args: readonly string[], opts?: SpawnSyncOptions) => SpawnSyncReturns<string | Buffer>;

export type BrowserOpenResult = { ok: true; method: string } | { ok: false; method: "none"; reason: string };

export type KillResult = {
  killedPids: string[];
  attemptedPids: string[];
  errors: string[];
};

// Hard upper bound on every helper-internal spawnSync call. Caps tail-latency
// when an external binary hangs (xdg-open waiting for an X11 session, lsof
// stalling on /proc, taskkill blocking on an unresponsive process, etc.) so
// the MCP tool surfaces a diagnostic instead of blocking the agent loop.
// 5s is comfortably above the 99th-percentile completion of every command we
// invoke; anything past that is hung.
const HELPER_SPAWN_TIMEOUT_MS = 5000;

// Returns the argv attempts for opening `url` on `platform`, in fall-back order.
// Pure data — no I/O.
export function browserOpenArgv(url: string, platform: NodeJS.Platform): readonly { cmd: string; args: readonly string[] }[] {
  if (platform === "darwin") return [{ cmd: "open", args: [url] }];
  if (platform === "win32") {
    // `start` is a cmd.exe builtin; the empty title arg ("") prevents the URL
    // from being consumed as the window title.
    return [{ cmd: "cmd", args: ["/c", "start", "", url] }];
  }
  // linux/bsd: try xdg-open, then sensible-browser (Debian/Ubuntu).
  return [
    { cmd: "xdg-open", args: [url] },
    { cmd: "sensible-browser", args: [url] },
  ];
}

// Opens a browser synchronously, waiting for each attempt to complete.
// Returns a structured result so callers can surface auto-open failures
// to the user instead of falsely reporting success.
export function openBrowserSync(
  url: string,
  platform: NodeJS.Platform = process.platform,
  runner: SpawnSyncFn = spawnSync,
): BrowserOpenResult {
  const attempts = browserOpenArgv(url, platform);
  const errors: string[] = [];
  for (const { cmd, args } of attempts) {
    try {
      const r = runner(cmd, args, { stdio: "ignore", timeout: HELPER_SPAWN_TIMEOUT_MS });
      // Treat signal-kill (status === null) and any non-zero status as failure
      // so the next fallback fires.
      if (!r.error && r.status === 0) return { ok: true, method: cmd };
      const reason = r.error?.message ?? `status=${r.status === null ? "signaled" : r.status}`;
      errors.push(`${cmd}: ${reason}`);
    } catch (e) {
      errors.push(`${cmd}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { ok: false, method: "none", reason: errors.join("; ") };
}

/**
 * Windows lister for killProcessOnPort: the netstat parser is
 * locale-independent on purpose.
 *
 * The STATE column ("LISTENING" / "ESTABLISHED" / ...) is translated on
 * non-English Windows (Windows-FR shows "À l'écoute", Windows-DE
 * "ABHÖREN", etc.), but the REMOTE ADDRESS column is not. A listening TCP
 * socket always has remote "0.0.0.0:0" (IPv4) or "[::]:0" (IPv6); a
 * connected one has a real addr:port. We therefore key off the remote
 * column instead of the state string. This also rules out the pre-fix bug
 * where matching only the local port number cross-matched a remote :port
 * from an outbound connection and taskkill'd an unrelated process.
 */
function netstatPidsOnPort(port: number, runner: SpawnSyncFn): { pids: string[]; error?: string } {
  const r = runner("netstat", ["-ano"], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: HELPER_SPAWN_TIMEOUT_MS,
  });
  if (r.error) return { pids: [], error: `netstat: ${r.error.message}` };
  if (r.status !== 0 || typeof r.stdout !== "string") return { pids: [] };

  const portSuffix = `:${port}`;
  const pids = new Set<string>();
  for (const rawLine of r.stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const tokens = line.split(/\s+/);
    // netstat -ano LISTENING row (en-US): "TCP  0.0.0.0:4747  0.0.0.0:0  LISTENING  1234"
    // The STATE column is locale-translated and may itself contain spaces
    // (Windows-FR `À l'écoute` splits into two tokens), so we cannot index
    // STATE by position. PID is always the trailing column; PROTO/LOCAL/
    // REMOTE are the first three. We anchor on those + a remote-wildcard
    // check that's locale-independent.
    if (tokens.length < 5) continue;
    const proto = tokens[0];
    const local = tokens[1];
    const remote = tokens[2];
    const pid = tokens[tokens.length - 1];
    if (proto !== "TCP") continue;
    if (!local.endsWith(portSuffix)) continue;
    // Listening sockets carry a wildcard remote; anything else is a
    // connection (and matching it would kill an unrelated process).
    if (remote !== "0.0.0.0:0" && remote !== "[::]:0") continue;
    if (!/^\d+$/.test(pid)) continue;
    pids.add(pid);
  }
  return { pids: [...pids] };
}

/** POSIX lister for killProcessOnPort. lsof exits 1 with empty stdout when
 * the port is free — that is not an error, only a spawn failure is. */
function lsofPidsOnPort(port: number, runner: SpawnSyncFn): { pids: string[]; error?: string } {
  const r = runner("lsof", ["-ti", `:${port}`], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: HELPER_SPAWN_TIMEOUT_MS,
  });
  // ENOENT (lsof not installed) is a real diagnostic; surface it.
  if (r.error) return { pids: [], error: `lsof: ${r.error.message}` };
  if (r.status !== 0 || typeof r.stdout !== "string") return { pids: [] };
  return { pids: r.stdout.split(/\r?\n/).filter((p) => /^\d+$/.test(p)) };
}

/** Signal each pid, recording every attempt, kill and failure in `result`. */
function killPids(pids: readonly string[], command: string, extraArgs: readonly string[], result: KillResult, runner: SpawnSyncFn): void {
  for (const pid of pids) {
    result.attemptedPids.push(pid);
    try {
      const k = runner(command, [...extraArgs, pid], {
        stdio: "ignore",
        timeout: HELPER_SPAWN_TIMEOUT_MS,
      });
      if (k.error || k.status !== 0) {
        result.errors.push(`${command} ${pid}: ${k.error?.message ?? `status=${k.status}`}`);
      } else {
        result.killedPids.push(pid);
      }
    } catch (e) {
      result.errors.push(`${command} ${pid}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

// Kills any process listening on `port`. Returns a structured result so
// the caller can distinguish between (a) port was free, (b) kill succeeded,
// (c) kill failed (perms, missing binary, or per-pid failure mid-loop).
export function killProcessOnPort(port: number, platform: NodeJS.Platform = process.platform, runner: SpawnSyncFn = spawnSync): KillResult {
  const result: KillResult = { killedPids: [], attemptedPids: [], errors: [] };
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    result.errors.push(`invalid port: ${port}`);
    return result;
  }

  try {
    const win32 = platform === "win32";
    const { pids, error } = win32 ? netstatPidsOnPort(port, runner) : lsofPidsOnPort(port, runner);
    if (error) {
      result.errors.push(error);
      return result;
    }
    killPids(pids, win32 ? "taskkill" : "kill", win32 ? ["/F", "/PID"] : [], result, runner);
  } catch (e) {
    result.errors.push(e instanceof Error ? e.message : String(e));
  }
  return result;
}

// ── open_ctx-insight: open the hosted Insight dashboard ───────────────────────────
// Insight pivoted from a locally-built dashboard to the hosted B2B product at
// open-context-mode.com/insight (the landing page is the single source of truth).
// The tool now simply opens that URL in the user default browser via the same
// cross-platform helper (openBrowserSync) used elsewhere.
const INSIGHT_URL = "https://open-context-mode.com/insight";

registerCtxTool(
  "open_ctx_insight",
  {
    title: "Open Insight Dashboard",
    // #846: opens a hosted dashboard URL in the browser — an external side
    // effect (open world), not a read-only query; safe to repeat.
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    description:
      "Opens the open-context-mode Insight dashboard (https://open-context-mode.com/insight) in your " +
      "default browser — a dashboard launcher for the hosted analytics layer, not a Q&A engine. " +
      "Insight surfaces per-engineer productive rate, retry waste, blocker detection, and " +
      "role-narrowed views for CTO, EM, IC, CISO, FinOps, and DevOps. " +
      "For natural-language queries over your indexed content, use open_ctx_search.",
    inputSchema: z.object({}),
  },
  {
    run: async () => {
      const open = openBrowserSync(INSIGHT_URL);
      const text = open.ok
        ? `Opening Insight in your browser: ${INSIGHT_URL}`
        : `Could not auto-open your browser (${open.reason}).\nOpen Insight manually: ${INSIGHT_URL}`;
      return {
        content: [{ type: "text" as const, text }],
      };
    },
  },
);

// ─────────────────────────────────────────────────────────
// Server startup
// ─────────────────────────────────────────────────────────

async function main() {
  // Clean up stale DB files from previous sessions
  const cleaned = cleanupStaleDBs();
  if (cleaned > 0) {
    console.error(`Cleaned up ${cleaned} stale DB file(s) from previous sessions`);
  }

  // MCP readiness sentinel path (#230, #347)
  // Uses process.pid (not ppid) — hooks use directory-scan to find any live sentinel.
  // Hardcoded /tmp on Unix to avoid TMPDIR mismatch (#347).
  const mcpSentinelDir = process.platform === "win32" ? tmpdir() : "/tmp";
  const mcpSentinel = join(mcpSentinelDir, `open-context-mode-mcp-ready-${process.pid}`);
  // #1055: second line = host PID (the MCP client that launched us), so a
  // Claude Code hook can tell its own session's server from a sibling's.
  // start.mjs passes the real host when it re-execs us under Bun (#564).
  // Removed from env so sandboxed children never inherit a stale host.
  const mcpSentinelBody = `${process.pid}\n${process.env.OPEN_CONTEXT_MODE_HOST_PID || process.ppid}`;
  delete process.env.OPEN_CONTEXT_MODE_HOST_PID;
  // #844: handle to the periodic sentinel refresh timer (started after connect).
  // oxlint-disable-next-line prefer-const -- assigned after connect(); `const` would TDZ-crash the shutdown closure if a signal lands mid-handshake
  let sentinelRefresh: ReturnType<typeof setInterval> | undefined;

  // Clean up own DB + backgrounded processes + preload script on shutdown
  const shutdown = () => {
    executor.cleanupBackgrounded();
    for (const store of _stores.values()) {
      try {
        store.close(); // persist DB for --continue sessions
      } catch {
        /* best effort */
      }
    }
    try {
      unlinkSync(CM_FS_PRELOAD);
    } catch {
      /* best effort */
    }
    // Remove MCP readiness sentinel (#230)
    try {
      unlinkSync(mcpSentinel);
    } catch {
      /* best effort */
    }
    // #844: stop refreshing the sentinel mtime on shutdown.
    if (sentinelRefresh) clearInterval(sentinelRefresh);
  };
  const gracefulShutdown = async () => {
    // Final stats flush — bypass throttle so the last 0-500ms of
    // bytes_indexed / bytes_returned aren't silently lost on SIGTERM/SIGINT
    // (PR #401 grill-me review B1: persistStats early-returns inside throttle
    // window; gracefulShutdown previously did NOT bypass).
    try {
      _lastStatsPersist = 0;
      persistStats();
    } catch {
      /* best effort — never block shutdown */
    }
    shutdown();
    process.exit(0);
  };
  process.on("exit", shutdown);
  process.on("SIGINT", () => {
    gracefulShutdown();
  });
  process.on("SIGTERM", () => {
    gracefulShutdown();
  });

  // Lifecycle guard: detect parent death + stdin close to prevent orphaned processes (#103)
  startLifecycleGuard({ onShutdown: () => gracefulShutdown() });
  void ensureLifetimeSnapshot();

  // Detect platform adapter after MCP initialize. server.connect()
  // returns before the handshake, so getClientVersion() is empty on
  // that path. Wait for oninitialized so omp-coding-agent clientInfo
  // wins over ~/.claude config-dir fallback.
  server.server.oninitialized = () => {
    void (async () => {
      try {
        const clientInfo = server.server.getClientVersion();
        const signal = detectPlatform(clientInfo ?? undefined);
        if (clientInfo) {
          console.error(`MCP client: ${clientInfo.name} v${clientInfo.version} → ${signal.platform}`);
        }
      } catch {
        /* best effort */
      }
    })();
  };

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // #854: refresh the bridge-child idle clock on each inbound MCP message so an
  // abandoned bridge child (OPEN_CONTEXT_MODE_BRIDGE_DEPTH>0) self-terminates instead
  // of accumulating under a long-lived Pi/omp parent. Best-effort; no stdin touch.
  attachMcpActivityTap(transport as unknown as { onmessage?: (message: unknown, extra?: unknown) => unknown });

  // Write MCP readiness sentinel (#230)
  try {
    writeFileSync(mcpSentinel, mcpSentinelBody);
  } catch {
    /* best effort */
  }

  // #844: refresh the sentinel mtime while the server is alive so readiness
  // probes from a foreign PID namespace (shared /tmp) can trust a recent
  // sentinel even when process.kill(pid, 0) cannot see this PID. The reader's
  // freshness window is 90s (hooks/core/mcp-ready.mjs); refresh at 30s (3x).
  // unref() so this timer never keeps the event loop alive on its own.
  sentinelRefresh = setInterval(() => {
    try {
      writeFileSync(mcpSentinel, mcpSentinelBody);
    } catch {
      /* best effort */
    }
  }, 30_000);
  sentinelRefresh.unref();

  // Restore tool-call counters from SessionDB BEFORE the heartbeat fires
  // so the very first persistStats() carries the prior PID's totals into
  // the sidecar JSON the statusline reads. Otherwise `/open_ctx-upgrade` flashes
  // `0 calls / $0.00` until the user makes another MCP tool call. Wrapped
  // in try/catch — a stats-restore failure must never block server startup.
  try {
    const restored = restoreSessionStats(getSessionDbPath());
    if (restored) {
      for (const [tool, count] of Object.entries(restored.calls)) {
        sessionStats.calls[tool] = count;
      }
      for (const [tool, bytes] of Object.entries(restored.bytesReturned)) {
        sessionStats.bytesReturned[tool] = bytes;
      }
      // Anchor uptime_ms to the original session start so `/open_ctx-upgrade`
      // doesn't reset the "session age" the statusline shows.
      if (restored.sessionStart > 0) {
        sessionStats.sessionStart = restored.sessionStart;
      }
    }
  } catch {
    /* best effort — never block startup on a stats restore failure */
  }

  // Non-blocking version check — result stored for trackResponse warnings.
  // First fetch at startup, then refresh every hour so long-running sessions
  // (some users keep the MCP server alive 24h+) catch new releases without a
  // restart. `.unref()` lets the process exit normally on SIGTERM regardless
  // of pending intervals.
  fetchLatestVersion().then((v) => {
    if (v !== "unknown") _latestVersion = v;
  });
  setInterval(
    () => {
      fetchLatestVersion().then((v) => {
        if (v !== "unknown") _latestVersion = v;
      });
    },
    60 * 60 * 1000,
  ).unref();

  // Stats heartbeat — keep the statusline truthful while the user works in
  // tools other than MCP (Bash/Read/Edit during long sessions or post-/compact
  // pauses). Without this, stats.updated_at only advances on MCP tool calls,
  // so bin/statusline.mjs falsely flips to "stale — restart to resume saving"
  // even though the server is alive. Heartbeat refreshes updated_at every 60s;
  // statusline staleness threshold is 30min (cliff is 30 missed ticks away).
  setInterval(() => persistStats(), 60_000).unref();

  if (process.stdin.isTTY) {
    console.error(`Open Context Mode MCP server v${VERSION} running on stdio`);
    console.error(`Detected runtimes:\n${getRuntimeSummary(runtimes)}`);
    if (!hasBunRuntime()) {
      console.error("\nPerformance tip: Install Bun for 3-5x faster JS/TS execution");
      console.error("  curl -fsSL https://bun.sh/install | bash");
    }
  }
}

// Runs after every registerTool() above, so the SDK's default tools/list handler
// exists and can be wrapped. Makes open_ctx_* schemas safe for strict (Gemini
// function-calling) clients like Antigravity CLI (`agy`) / Gemini CLI.
installStrictClientSchemaCompat();

if (process.env.OPEN_CONTEXT_MODE_EMBEDDED_PLUGIN_TOOLS !== "1") {
  main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
