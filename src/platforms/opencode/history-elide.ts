/**
 * history-elide — Cap oversized native tool results in the outbound message list.
 *
 * OpenCode 2.x `session.hook("context")` hands a plugin a MUTABLE
 * `messages: Array<Message>` (`SessionContext` in @opencode/plugin). Every
 * `tool-result` part in that array carries the raw bytes the native tool
 * produced, and the whole transcript is replayed on every subsequent turn of
 * the session. Those bytes are therefore paid for again and again, forever,
 * for a result the model read once and moved on from.
 *
 * open-context-mode already solves this for its own tools: the output ladder in
 * src/tool-pipeline.ts auto-indexes anything past 100 KB and returns a short
 * summary. Native tools (`bash`, `view`, `grep`, `list`) bypass that ladder
 * entirely, so their output lands in the transcript whole.
 *
 * This pass closes that gap. It is two-phase on purpose:
 *   1. findElidableToolResults() reports candidates — pure, no mutation.
 *   2. The caller indexes each candidate, then applyElision() rewrites the
 *      transcript with a pointer to the indexed source.
 *
 * Two-phase is what makes the pass fail-safe. A pointer is only ever written
 * for bytes that are already in the content store, so the marker can never
 * lie about recoverability. If indexing fails, nothing is elided and the
 * worst outcome is no reduction — never data loss.
 *
 * Measurement vocabulary follows CONTEXT.md: the result is reported as
 * *avoided bytes*, and the config field is `minBytes`/`capBytes` rather than a
 * token count, because a byte ratio is the only honest claim here.
 */

import { charSafePrefix, charSafeSlice } from "../../truncate.js";

// ── Config ────────────────────────────────────────────────

export type ElideConfig = {
  /**
   * Tool results at or above this many bytes are candidates. Below it the
   * bookkeeping costs more than the replay saves, so small results are left
   * alone. Default 4 KB — below the 5 KB intent-search threshold, so this
   * pass never competes with the output ladder for the same result.
   */
  minBytes: number;
  /**
   * Byte budget for each elided result: head bytes + tail bytes + the marker.
   * Head+tail (not head-only) because test and build output puts the
   * actionable part — the failure summary — at the end. Default 2 KB.
   */
  capBytes: number;
  /**
   * How many trailing messages are never touched. The model is actively
   * reasoning about the most recent exchange; rewriting a result it is
   * reading right now is how you break a turn. Default 8.
   */
  keepRecent: number;
  /**
   * Master switch. `OPEN_CONTEXT_MODE_ELIDE=0` turns the pass off without
   * touching the thresholds, for operators who would rather keep the full
   * transcript.
   */
  enabled: boolean;
};

export const DEFAULT_ELIDE_CONFIG: ElideConfig = {
  minBytes: 4096,
  capBytes: 2048,
  keepRecent: 8,
  enabled: true,
};

function positiveEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function elideConfig(): ElideConfig {
  return {
    minBytes: positiveEnv("OPEN_CONTEXT_MODE_ELIDE_MIN_BYTES", DEFAULT_ELIDE_CONFIG.minBytes),
    capBytes: positiveEnv("OPEN_CONTEXT_MODE_ELIDE_CAP_BYTES", DEFAULT_ELIDE_CONFIG.capBytes),
    keepRecent: positiveEnv("OPEN_CONTEXT_MODE_ELIDE_KEEP_RECENT", DEFAULT_ELIDE_CONFIG.keepRecent),
    enabled: process.env.OPEN_CONTEXT_MODE_ELIDE !== "0",
  };
}

// ── Message shape (structurally typed, not imported) ─────
//
// The `Message` / `ToolResultPart` types come from @opencode/ai, which is a
// peer of the plugin host and not a runtime dependency of open-context-mode's
// server graph. Only the three fields this pass reads are declared, and every
// write goes through a cast — a v2 host that renames a field simply makes
// that write a no-op instead of a crash.

type ToolResultValueShape = { type?: string; value?: unknown };
type ToolResultPartShape = {
  type?: string;
  id?: string;
  name?: string;
  providerExecuted?: boolean;
  result?: ToolResultValueShape;
};
type MessageShape = { role?: string; content?: unknown[] };

export type ElisionCandidate = {
  messageIndex: number;
  partIndex: number;
  part: ToolResultPartShape;
  /** The full original text, for the caller to index. */
  text: string;
  /** Stable content-store label; also the handle the model gets back. */
  label: string;
};

export type ElideReport = {
  /** Transcript parts rewritten in place. */
  elided: number;
  /** Bytes no longer replayed on each subsequent turn. */
  avoidedBytes: number;
};

// ── Text extraction ──────────────────────────────────────

/**
 * The text form of a `tool-result` payload, or null when the payload is not
 * text-shaped.
 *
 * Deliberately narrow. `json` and `error` results are left alone: rewriting
 * them into a `text` result would change what the model is told happened, and
 * an error the agent has to read is not dead weight. A `content` array counts
 * only when every entry is text — one `file` entry means the result carries a
 * file reference the model may need, and that reference is small anyway.
 */
export function toolResultText(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const r = result as ToolResultValueShape;
  if (r.type === "text") return typeof r.value === "string" ? r.value : null;
  if (r.type !== "content" || !Array.isArray(r.value)) return null;
  const entries: unknown[] = r.value;
  const texts: string[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") return null;
    const e = entry as { type?: string; text?: string };
    if (e.type !== "text" || typeof e.text !== "string") return null;
    texts.push(e.text);
  }
  return texts.join("\n");
}

/** Content-store labels must survive round-tripping through FTS5 lookups. */
function sanitizeLabelSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 80) || "x";
}

export function elisionLabel(name: string, id: string): string {
  return `cm-elide/${sanitizeLabelSegment(name)}/${sanitizeLabelSegment(id)}`;
}

// ── Phase 1: find ─────────────────────────────────────────

/**
 * Report the tool results that are worth replacing. Pure — reads the array,
 * writes nothing.
 *
 * Two tools are exempt:
 *   - `open_ctx_*`: already budget-controlled by the output ladder. Eliding them
 *     fights the pipeline that just made them small.
 *   - Anything without a stable `id`: the label is the recovery handle, so a
 *     part we cannot address is a part we cannot point at.
 */
export function findElidableToolResults(messages: unknown, cfg: ElideConfig): ElisionCandidate[] {
  if (!cfg.enabled) return [];
  if (!Array.isArray(messages)) return [];

  // The tail of the transcript is what the model is reasoning about right now.
  const boundary = Math.max(0, messages.length - cfg.keepRecent);
  if (boundary === 0) return [];

  const out: ElisionCandidate[] = [];
  for (let mi = 0; mi < boundary; mi++) {
    const message = messages[mi] as MessageShape | null;
    const content = message?.content;
    if (!Array.isArray(content)) continue;
    for (let pi = 0; pi < content.length; pi++) {
      const part = content[pi] as ToolResultPartShape | null;
      if (!part || part.type !== "tool-result") continue;
      if (part.providerExecuted) continue;
      const name = typeof part.name === "string" ? part.name : "";
      // Server-side tool calls (providerExecuted) carry provider-authored
      // payloads; a open_ctx_* result is already small by construction.
      if (name.startsWith("open_ctx_")) continue;
      const id = typeof part.id === "string" ? part.id : "";
      if (!id) continue;
      const text = toolResultText(part.result);
      if (text === null) continue;
      if (Buffer.byteLength(text, "utf8") < cfg.minBytes) continue;
      out.push({ messageIndex: mi, partIndex: pi, part, text, label: elisionLabel(name, id) });
    }
  }
  return out;
}

// ── Phase 2: apply ────────────────────────────────────────

function marker(label: string, elidedBytes: number, shownBytes: number): string {
  return (
    `[open-context-mode] ${formatBytes(elidedBytes)} of this tool result was elided from the transcript and indexed as source "${label}". ` +
    `Retrieve it with open_ctx_search(queries: ["<what you need>"], source: "${label}"). ` +
    `${formatBytes(shownBytes)} kept (head and tail).`
  );
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${n}B`;
}

/**
 * Replace one candidate's payload with head + tail + a pointer, and report how
 * many bytes that keeps out of every future replay.
 *
 * Call this ONLY after the candidate's text is in the content store. The
 * marker names a source label, and a name that resolves to nothing is worse
 * than no reduction at all — the model would go looking for bytes that are
 * not there.
 */
export function applyElision(candidate: ElisionCandidate, cfg: ElideConfig): number {
  const originalBytes = Buffer.byteLength(candidate.text, "utf8");
  // 60/40 head/tail: build and test output puts the summary — where the actual
  // failure is — at the end, so a head-only cut keeps the part nobody wants.
  const headBytes = Math.max(0, Math.floor(cfg.capBytes * 0.6));
  const tailBytes = Math.max(0, cfg.capBytes - headBytes);

  const head = charSafePrefix(candidate.text, headBytes);
  const tail = tailBytes > 0 ? charSafeSlice(candidate.text, candidate.text.length - tailBytes) : "";
  const keptText = tail ? `${head}\n…[${originalBytes} bytes elided]…\n${tail}` : head;

  const note = marker(candidate.label, originalBytes - Buffer.byteLength(keptText, "utf8"), Buffer.byteLength(keptText, "utf8"));
  const replacement = `${keptText}\n\n${note}`;

  const result = candidate.part.result as ToolResultValueShape | undefined;
  if (result) {
    // A `content` result is an array the host maps over on every later turn.
    // Writing a bare string there breaks the session for good ("value.map is
    // not a function"), so keep the array shape and swap in one text entry.
    if (result.type === "content") result.value = [{ type: "text", text: replacement }];
    else result.value = replacement;
  }

  return Math.max(0, originalBytes - Buffer.byteLength(replacement, "utf8"));
}

// ── Convenience (test surface) ────────────────────────────

/**
 * Run both phases with an injected indexer. `index` must resolve to true only
 * once the bytes are durably in the content store; a false return, a rejected
 * promise, or a throw all leave the transcript untouched. The hook is async
 * because the real indexer goes through the open_ctx_index tool handler, but
 * `applyElision` itself stays synchronous and the search phase stays pure.
 */
export async function elideToolResults(
  messages: unknown,
  cfg: ElideConfig,
  index: (candidate: ElisionCandidate) => boolean | Promise<boolean>,
): Promise<ElideReport> {
  const candidates = findElidableToolResults(messages, cfg);
  let elided = 0;
  let avoidedBytes = 0;
  for (const candidate of candidates) {
    let stored = false;
    try {
      stored = (await index(candidate)) === true;
    } catch {
      stored = false;
    }
    if (!stored) continue;
    avoidedBytes += applyElision(candidate, cfg);
    elided++;
  }
  return { elided, avoidedBytes };
}
