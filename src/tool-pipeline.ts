/**
 * Deep module owning the shell every open_ctx_* MCP tool runs inside.
 *
 * Before this module, each of the 11 `server.registerTool()` handlers in
 * server.ts restated the same pipeline by hand: security gates → try/catch
 * error normalization → the sandbox output ladder → `trackResponse()`
 * accounting. `createCtxToolPipeline()` collapses that shell into one
 * registration function so a tool definition supplies only what is unique
 * (config, gates, error wording, run body).
 *
 * Ownership:
 *   1. gate dispatch — def.gate runs before run(); its (pre-accounted)
 *      result short-circuits the call verbatim, exactly like the inline
 *      `if (denied) return denied;` checks it replaces.
 *   2. error normalization — def.error renders
 *      `${lead}${title}: ${message}` from any thrown value.
 *   3. accounting — every run() result passes through trackResponse once;
 *      run() never calls it manually. Mid-run pre-accounted results (deny
 *      re-checks, short-circuits produced by helpers that already tracked)
 *      are returned wrapped in `tracked()` and passed through verbatim.
 *   4. progress wiring — wireProgress() binds the executor's onOutput
 *      stream to the MCP notifications/progress channel.
 *   5. the sandbox output ladder — executionOutcome() owns the
 *      timedOut / backgrounded / exit≠0+intent / exit≠0+large / ok+intent /
 *      ok+large / ok-plain decision tree shared by open_ctx_execute and
 *      open_ctx_execute_file (~100 duplicated lines before extraction).
 *
 * Registration flows through the monkey-patched `server.registerTool`
 * (suppression + allowlist + wrapToolHandler idle/cancellation/storage-error
 * wrapping) supplied by server.ts via CtxToolEnv — this module never touches
 * the McpServer instance itself.
 */

import { classifyNonZeroExit } from "./exit-classify.js";

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

export type ToolArgs = Record<string, unknown>;

export type ToolExtra = { signal?: AbortSignal };

export type ProgressReporter = { report: (chunk: string) => void; flush: () => Promise<void> };

/** Prose twin of the ladder's 5KB auto-index threshold — keep in sync. */
export const INTENT_AUTO_INDEX_PROSE = "outputs over ~5KB are auto-indexed";

// Ladder thresholds (bytes). ~80-100 lines / 100KB auto-index into FTS5.
const INTENT_SEARCH_THRESHOLD = 5_000;
const LARGE_OUTPUT_THRESHOLD = 102_400;

/** The 7-copy `err instanceof Error ? err.message : String(err)` idiom, once. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── Pre-accounted result marker ─────────────────────────────────────────────
//
// Gate results (deny helpers, legacy-arg checks) already ran trackResponse
// internally — the pipeline must return them verbatim or the call would be
// counted twice. Mid-run short-circuits with the same property (e.g.
// open_ctx_index's symlink re-deny) wrap their result in tracked() so the
// pipeline knows to pass it through without accounting again.

const TRACKED = Symbol("open_ctx-tool.tracked");

export interface TrackedToolResult {
  readonly [TRACKED]: ToolResult;
}

export function tracked(result: ToolResult): TrackedToolResult {
  return { [TRACKED]: result };
}

function trackedResult(value: unknown): ToolResult | undefined {
  return typeof value === "object" && value !== null && TRACKED in value ? (value as TrackedToolResult)[TRACKED] : undefined;
}

// ── Progress wiring ─────────────────────────────────────────────────────────

function createProgressReporter(
  progressToken: string | number | undefined,
  send: (progressToken: string | number, message: string, progress: number) => Promise<void>,
): ProgressReporter {
  if (typeof progressToken !== "string" && typeof progressToken !== "number") {
    return { report: () => {}, flush: async () => {} };
  }
  let buffered = "";
  let progress = 0;
  let timer: NodeJS.Timeout | undefined;
  const flush = async () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (!buffered) return;
    const message = buffered;
    buffered = "";
    try {
      await send(progressToken, message, ++progress);
    } catch {}
  };
  return {
    report: (chunk) => {
      buffered += chunk;
      if (!timer) timer = setTimeout(() => void flush(), 100);
    },
    flush,
  };
}

/**
 * Bind an executor's onOutput stream to the MCP progress channel carried on
 * the handler's `extra`. No-ops when the host sent no progress token.
 */
export function wireProgress(extra: unknown): ProgressReporter {
  const e = extra as { _meta?: { progressToken?: unknown }; sendNotification?: (n: unknown) => Promise<void> } | undefined;
  const progressToken = e?._meta?.progressToken as string | number | undefined;
  const sendNotification = e?.sendNotification;
  return createProgressReporter(progressToken, (token, message, value) =>
    sendNotification!({
      method: "notifications/progress",
      params: { progressToken: token, progress: value, message },
    }),
  );
}

// ── Registration pipeline ───────────────────────────────────────────────────

/** Server-side hooks this module needs; supplied by server.ts (no import cycle). */
export interface CtxToolEnv {
  /** The monkey-patched server.registerTool — suppression/allowlist/wrapping stay in force. */
  registerTool(name: string, config: Record<string, unknown>, handler: (args: ToolArgs, extra?: ToolExtra) => unknown): unknown;
  trackResponse(toolName: string, response: ToolResult): ToolResult;
  trackIndexed(bytes: number, source?: string): void;
  intentSearch(stdout: string, intent: string, source: string): string;
  indexStdout(stdout: string, source: string): { content: Array<{ type: "text"; text: string }> };
}

export interface CtxToolDef {
  /**
   * Pre-run security/validation gates (deny policies, legacy-arg checks).
   * Results are already accounted for by their helpers — returned verbatim.
   */
  gate?: (args: ToolArgs) => ToolResult | null;
  /**
   * Catch-all error normalization: renders `${lead}${title}: ${message}`.
   * Omit to let throws propagate (pre-pipeline behavior for tools without
   * a try/catch — wrapToolHandler still converts StorageDirectoryError).
   */
  error?: { title: string; lead?: (args: ToolArgs) => string };
  /** Unique tool logic. Plain results are accounted by the pipeline. */
  run: (args: ToolArgs, extra?: ToolExtra) => ToolResult | TrackedToolResult | Promise<ToolResult | TrackedToolResult>;
}

/** Tool config exactly as `server.registerTool` receives it. */
export interface CtxToolConfig {
  title: string;
  annotations: Record<string, unknown>;
  description: string;
  inputSchema: unknown;
}

// ── Sandbox output ladder ───────────────────────────────────────────────────

export interface ExecutionOutcomeInput {
  /** Source-code echo prepended to every branch (buildExecuteEcho output). */
  echo: string;
  language: string;
  intent: string | undefined;
  /** FTS5 source label for indexed output ("execute:<language>" / "file:<path>"). */
  source: string;
  /** open_ctx_execute_file: names the file in the timeout error. */
  path?: string;
  /** open_ctx_execute: enables the partial-output timeout branches and their wording. */
  background: boolean;
  effTimeout: number | undefined;
  /** Executor result (stdout/stderr/exitCode/timedOut always present on ExecResult). */
  result: { stdout: string; stderr: string; exitCode: number; timedOut: boolean; backgrounded?: boolean };
}

/**
 * The shared open_ctx_execute / open_ctx_execute_file decision tree:
 * timedOut (backgrounded → partial → error) / exit≠0 (intent → large → plain)
 * / ok (intent → large+indexed → plain). Byte-identical to the two inline
 * ladders it replaced.
 */
function executionOutcomeWith(env: CtxToolEnv) {
  return function executionOutcome(o: ExecutionOutcomeInput): ToolResult {
    const { echo, result } = o;
    if (result.timedOut) {
      const partialOutput = result.stdout?.trim();
      if (o.background && result.backgrounded && partialOutput) {
        // Background mode: process is still running, return partial output as success
        return {
          content: [{ type: "text", text: `${echo}${partialOutput}\n\n_(process backgrounded after ${o.effTimeout}ms — still running)_` }],
        };
      }
      if (o.background && partialOutput) {
        // Timeout with partial output — return as success with note
        return {
          content: [
            { type: "text", text: `${echo}${partialOutput}\n\n_(timed out after ${o.effTimeout}ms — partial output shown above)_` },
          ],
        };
      }
      if (o.path !== undefined) {
        return {
          content: [{ type: "text", text: `${echo}Timed out processing ${o.path} after ${o.effTimeout}ms` }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: `${echo}Execution timed out after ${o.effTimeout}ms\n\nstderr:\n${result.stderr}` }],
        isError: true,
      };
    }

    if (result.exitCode !== 0) {
      const { isError, output } = classifyNonZeroExit({
        language: o.language,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      });
      if (o.intent && o.intent.trim().length > 0 && Buffer.byteLength(output) > INTENT_SEARCH_THRESHOLD) {
        env.trackIndexed(Buffer.byteLength(output));
        return {
          content: [{ type: "text", text: `${echo}${env.intentSearch(output, o.intent, isError ? `${o.source}:error` : o.source)}` }],
          isError,
        };
      }
      // Auto-index large error output into FTS5 — no data loss
      if (Buffer.byteLength(output) > LARGE_OUTPUT_THRESHOLD) {
        env.trackIndexed(Buffer.byteLength(output));
        return {
          content: [
            {
              type: "text",
              text: `${echo}${env.intentSearch(output, "errors failures exceptions", isError ? `${o.source}:error` : o.source)}`,
            },
          ],
          isError,
        };
      }
      return { content: [{ type: "text", text: `${echo}${output}` }], isError };
    }

    const stdout = result.stdout || "(no output)";

    // Intent-driven search: if intent provided and output is large enough
    if (o.intent && o.intent.trim().length > 0 && Buffer.byteLength(stdout) > INTENT_SEARCH_THRESHOLD) {
      env.trackIndexed(Buffer.byteLength(stdout));
      return { content: [{ type: "text", text: `${echo}${env.intentSearch(stdout, o.intent, o.source)}` }] };
    }

    // Auto-index large stdout into FTS5 — return pointer, not raw content
    if (Buffer.byteLength(stdout) > LARGE_OUTPUT_THRESHOLD) {
      const indexed = env.indexStdout(stdout, o.source);
      // Prepend echo to the first text content so provenance still surfaces
      return {
        ...indexed,
        content: indexed.content.map((c, i) => (i === 0 && c.type === "text" ? { ...c, text: `${echo}${c.text}` } : c)),
      };
    }

    return { content: [{ type: "text", text: `${echo}${stdout}` }] };
  };
}

/**
 * Build the pipeline. `env` supplies the server-side hooks (registration
 * sink, accounting, indexing) so this module stays import-cycle-free.
 */
export function createCtxToolPipeline(env: CtxToolEnv): {
  registerCtxTool: (name: string, config: CtxToolConfig, def: CtxToolDef) => void;
  executionOutcome: (o: ExecutionOutcomeInput) => ToolResult;
} {
  const executionOutcome = executionOutcomeWith(env);
  function registerCtxTool(name: string, config: CtxToolConfig, def: CtxToolDef): void {
    env.registerTool(name, { ...config }, async (args: ToolArgs, extra?: ToolExtra) => {
      const gated = def.gate?.(args) ?? null;
      if (gated) return gated;
      try {
        const raw = await def.run(args, extra);
        const preAccounted = trackedResult(raw);
        return preAccounted ?? env.trackResponse(name, raw as ToolResult);
      } catch (err: unknown) {
        if (!def.error) throw err;
        const lead = def.error.lead?.(args) ?? "";
        return env.trackResponse(name, {
          content: [{ type: "text", text: `${lead}${def.error.title}: ${errorMessage(err)}` }],
          isError: true,
        });
      }
    });
  }
  return { registerCtxTool, executionOutcome };
}
