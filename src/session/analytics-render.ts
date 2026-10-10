/**
 * Analytics render layer — formatReport + narrative renderers + label tables.
 *
 * Pure presentation: turns the query layer's aggregates (analytics-query.ts)
 * and the savings formulas (analytics-metrics.ts) into the open_ctx_stats
 * dashboard string. No DB reads, no filesystem walks.
 */

import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { sep } from "node:path";
import { compressionRatio, pricePerToken, tokensToUsd } from "./analytics-metrics.js";
import type {
  ConversationStats,
  FullReport,
  LifetimeStats,
  McpToolUsageRow,
  MultiAdapterLifetimeStats,
  RealBytesStats,
} from "./analytics-query.js";

function semverNewer(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return true;
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return false;
  }
  return false;
}

/**
 * Index observability snapshot — point-in-time view of the persistent
 * content store. Optional input to `formatReport` so callers that don't
 * have store access (or don't want the extra DB hit) can omit it.
 */
export interface IndexState {
  totalChunks: number;
  totalSources: number;
  lastIndexedAt?: string; // ISO-8601 when available
}

// ─────────────────────────────────────────────────────────
// Category labels and hints for session continuity display
// ─────────────────────────────────────────────────────────

/**
 * Human-readable labels for event categories.
 *
 * Each label is a sentence-case phrase that reads like a benefit, not a
 * column name. The user shouldn't see raw schema words like "external-ref"
 * or "agent-finding" — those leak the database into the UX. When a new
 * category lands without an entry here, the renderer falls through to the
 * raw category id; that's a copy-debt signal, fix it here.
 */
export const categoryLabels: Record<string, string> = {
  // Code & filesystem
  file: "Files tracked",
  cwd: "Working directory",
  // Configuration & intent
  rule: "Project rules (CLAUDE.md)",
  prompt: "Your requests saved",
  intent: "Session intent",
  goal: "Session goal",
  role: "Behavior rules",
  constraint: "Constraints you set",
  // Tools & delegation
  mcp: "MCP tools called",
  skill: "Skills used",
  subagent: "Delegated work",
  // Knowledge & decisions
  decision: "Your decisions",
  "agent-finding": "Agent insights kept",
  "rejected-approach": "Approaches you rejected",
  "external-ref": "External docs indexed",
  data: "Data references",
  // System events
  git: "Git operations",
  env: "Environment setup",
  task: "Tasks in progress",
  error: "Errors caught",
  // Continuity proof
  compact: "Compactions weathered",
  resume: "Sessions resumed cleanly",
  snapshot: "Snapshots restored",
  cache: "Cache hits saved",
  // Operational
  latency: "Slow tools recorded",
  "user-prompt": "Your messages remembered",
  plan: "Plans drafted",
  "blocked-on": "Blockers logged",
};

/** Explains why each category matters for continuity. */
export const categoryHints: Record<string, string> = {
  file: "Restored after compact — no need to re-read",
  rule: "Your project instructions survive context resets",
  prompt: "Continues exactly where you left off",
  decision: "Applied automatically — won’t ask again",
  task: "Picks up from where it stopped",
  error: "Tracked and monitored across compacts",
  git: "Branch, commit, and repo state preserved",
  env: "Runtime config carried forward",
  mcp: "Tool usage patterns remembered",
  subagent: "Delegation history preserved",
  skill: "Skill invocations tracked",
};

/**
 * Marketing-grade labels for auto-memory file prefixes. The renderer sees raw
 * filename prefixes (`project_codex_hooks.md` → `project`) — without this map
 * the user gets schema words in the UI, which leaks the database into UX.
 */
export const autoMemoryLabels: Record<string, string> = {
  project: "What you're building",
  feedback: "How you work",
  user: "Who you are",
  reference: "Where to look",
  memory: "Long-term context",
  other: "Other notes",
};

/**
 * Marketing-grade labels for adapter ids surfaced by
 * {@link enumerateAdapterDirs} / {@link getMultiAdapterLifetimeStats}.
 * The renderer never shows raw IDs — UX uses the names users see in
 * each tool's own surface area.
 */
export const adapterLabels: Record<string, string> = {
  "claude-code": "Claude Code",
  "gemini-cli": "Gemini CLI",
  antigravity: "Antigravity",
  "antigravity-cli": "Antigravity CLI",
  openclaw: "Openclaw",
  codex: "Codex CLI",
  cursor: "Cursor",
  "vscode-copilot": "VS Code Copilot",
  "copilot-cli": "GitHub Copilot CLI",
  kiro: "Kiro",
  pi: "Pi",
  omp: "OMP",
  "qwen-code": "Qwen Code",
  kilo: "Kilo",
  opencode: "OpenCode",
  zed: "Zed",
  "jetbrains-copilot": "JetBrains",
};

/** Look up an adapter's marketing label. Falls back to the raw id. */
function adapterLabel(name: string): string {
  return adapterLabels[name] ?? name;
}

// ─────────────────────────────────────────────────────────
// formatReport — renders FullReport as sales-grade savings dashboard
// ─────────────────────────────────────────────────────────

/**
 * Format a byte count for the narrative dashboard.
 *
 * Single-unit auto-scale (Grafana / CloudWatch / Datadog convention).
 * Decimals shrink as the integer part grows so the number stays readable
 * at every magnitude. Max output width is 8 characters which fits the
 * existing `padStart(8)` callsites in Sections 1, 3, 4.
 *
 *   < 1 KB              → "X B"        e.g. "100 B"
 *   1 KB   – < 100 KB   → "X.Y KB"     e.g. "4.7 KB",   "92.8 KB"
 *   100 KB – < 1 MB     → "X KB"       e.g. "227 KB",   "976 KB"
 *   1 MB   – < 100 MB   → "X.Y MB"     e.g. "4.5 MB",   "11.6 MB"
 *   100 MB – < 1 GB     → "X MB"       e.g. "178 MB",   "906 MB"
 *   1 GB   – < 100 GB   → "X.YY GB"    e.g. "1.00 GB",  "11.36 GB"
 *   ≥ 100 GB            → "X.Y GB"     e.g. "216.6 GB"
 *
 * Replaced the dual-unit "X KB (0.YY MB)" form because the parenthetical
 * rounded to 0.00 / 0.01 in the common range and added noise without
 * information. Scale awareness comes from the unit jump between rows.
 */
export function kb(b: number): string {
  if (!Number.isFinite(b) || b <= 0) return "0 B";
  if (b < 1024) return `${Math.round(b)} B`;

  const KB = b / 1024;
  if (KB < 1024) {
    return KB < 100 ? `${KB.toFixed(1)} KB` : `${Math.round(KB)} KB`;
  }

  const MB = KB / 1024;
  if (MB < 1024) {
    return MB < 100 ? `${MB.toFixed(1)} MB` : `${Math.round(MB)} MB`;
  }

  const GB = MB / 1024;
  return GB < 100 ? `${GB.toFixed(2)} GB` : `${GB.toFixed(1)} GB`;
}

/** Format session uptime as human-readable duration. */
function formatDuration(uptimeMin: string): string {
  const min = parseFloat(uptimeMin);
  if (isNaN(min) || min < 1) return "< 1 min";
  if (min < 60) return `${Math.round(min)} min`;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

/**
 * Locale + IANA-timezone detection for the narrative renderer.
 *
 * Cascade (each level overrides the next):
 *   1. OPEN_CONTEXT_MODE_LOCALE / OPEN_CONTEXT_MODE_TZ env overrides
 *      (used by tests + by users who want to pin output regardless of OS).
 *   2. macOS `defaults read -g AppleLocale` → `en_TR` style → `en-TR`.
 *   3. Linux `LANG` / `LC_TIME` env vars.
 *   4. Fallback: `Intl.DateTimeFormat().resolvedOptions().locale`.
 *
 * Timezone always uses `Intl.DateTimeFormat().resolvedOptions().timeZone`
 * — that one's always available and correct regardless of platform.
 */
/**
 * Validate that a locale string is a usable BCP 47 tag.
 *
 * Ubuntu GHA runners default to `LANG=C.UTF-8`. The extractor below strips
 * that to `"C"` — a valid POSIX locale identifier but NOT a BCP 47 tag.
 * On macOS / Node 20, `new Intl.DateTimeFormat("C", …)` throws RangeError
 * outright. CI run 25887250971 caught this via the v1.0.134 SLICE B test.
 *
 * Earlier fix attempt used a permissive `supportedLocalesOf || construction`
 * OR check — that was wrong: on Linux + Node 22.5, `new Intl.DateTimeFormat
 * ("POSIX")` does NOT throw, it silently falls back to the root locale and
 * still emits garbage at format time. CI run 25904838577 surfaced that —
 * "POSIX" round-tripped through the validator unchanged.
 *
 * Strict gate: `Intl.DateTimeFormat.supportedLocalesOf(tag)` returns `[]` for
 * any tag that doesn't map to a real language (regardless of whether
 * construction with that tag throws). That's the contract we want — "is this
 * a BCP 47 tag the host actually has data for". Construction is an explicit
 * sanity check; both must pass.
 */
function isUsableBcp47Locale(raw: string): boolean {
  if (!raw) return false;
  try {
    if (Intl.DateTimeFormat.supportedLocalesOf(raw).length === 0) return false;
    // Belt: confirm construction doesn't throw on this host either.
    new Intl.DateTimeFormat(raw);
    return true;
  } catch {
    return false;
  }
}

export function detectLocaleAndTz(): { locale: string; tz: string } {
  const env = (process.env ?? {}) as Record<string, string | undefined>;
  let locale = env.OPEN_CONTEXT_MODE_LOCALE ?? "";
  if (locale && !isUsableBcp47Locale(locale)) locale = "";
  if (!locale) {
    if (process.platform === "darwin") {
      try {
        // Top-level import — `require()` throws "Dynamic require ... not
        // supported" under esbuild's ESM shim and pure ESM Node, which silently
        // dropped this branch and forced en-US fallback in production.
        const out = execFileSync("defaults", ["read", "-g", "AppleLocale"], {
          encoding: "utf8",
          timeout: 500,
        }).trim();
        if (out) locale = out.replace(/_/g, "-");
      } catch {
        /* defaults missing or sandbox */
      }
      if (locale && !isUsableBcp47Locale(locale)) locale = "";
    }
    if (!locale && (env.LC_TIME || env.LANG)) {
      const raw = (env.LC_TIME || env.LANG || "").split(".")[0];
      if (raw) locale = raw.replace(/_/g, "-");
      // POSIX locale identifiers (`C`, `POSIX`) survive the simple extraction
      // above but blow up `new Intl.DateTimeFormat(locale, ...)`. Drop and
      // fall through to the host-default branch below.
      if (locale && !isUsableBcp47Locale(locale)) locale = "";
    }
    if (!locale) {
      try {
        locale = new Intl.DateTimeFormat().resolvedOptions().locale;
      } catch {
        locale = "en-US";
      }
    }
  }

  let tz = env.OPEN_CONTEXT_MODE_TZ ?? "";
  if (!tz) {
    try {
      tz = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      tz = "UTC";
    }
  }
  // Final belt-and-suspenders: if the locale we settled on is somehow still
  // unusable (env mutation between detection and return, contributor adding
  // a new extraction path that skips the validator), fall back to en-US so
  // formatLocalDateTime / monthDay / weekdayCap never throw at render time.
  if (!isUsableBcp47Locale(locale)) locale = "en-US";
  return { locale, tz: tz || "UTC" };
}

/**
 * Format an absolute path as a human-friendly display string by
 * collapsing `$HOME` → `~`. Returns the input unchanged when no home
 * prefix matches (e.g. for paths outside $HOME on a CI box).
 */
function shortPath(abs: string): string {
  const home = homedir();
  if (!home) return abs;
  if (abs === home) return "~";
  // Use platform separator so `C:\Users\Mert\projects\x` collapses to `~\projects\x`
  // on Windows; previous `home + "/"` check was vacuously false on Windows and
  // left full absolute paths in the Section 1 narrative opener (round-5 finding).
  if (abs.startsWith(home + sep)) return "~" + abs.slice(home.length);
  return abs;
}

/**
 * Render the section-4 "For example: what would that cost?" block.
 *
 * Translates a lifetime token total into a relatable Opus-4 dollar figure
 * + 3 tangible comparisons (Cursor Pro / Claude Max / weekends of API
 * coding) + 10-dev team scale projection + alternate-model scale row,
 * capped with an EXAMPLES disclaimer. The renderer is intentionally
 * liberal with rounding (whole-month Cursor counts, integer weekends)
 * because this section is illustrative — the EXAMPLES line tells users
 * not to confuse it for a bill.
 *
 * Returns [] when there's nothing to scale (lifetimeTokens === 0) so
 * the section disappears cleanly on a fresh install.
 *
 * Math constants:
 *   Opus 4.7/4.8 = $5.00 per 1M input tokens (fallback when PI_OPEN_CONTEXT_MODE_PRICE_OUTPUT_PER_TOKEN not set)
 *   Sonnet 4.6   = $3.00 per 1M input tokens
 *   GPT-4o       = $2.50 per 1M input tokens
 *   Gemini 2     = $1.25 per 1M input tokens
 *   Haiku 4.5    = $1.00 per 1M input tokens
 *   Cursor Pro       = $20  / month  → "X months of Cursor Pro"
 *   Claude Max       = $200 / month  → "X.X months of Claude Max"
 *   Weekend coding   ≈ $73.67        → "X weekends of nonstop API coding"
 *   Team multiplier  = 10×           → "At a 10-dev team scale: ~$X over Y days, or ~$Z/year"
 */
export function renderCostExample(lifetimeBytes: number, lifetimeTokens: number, lifetimeDays: number): string[] {
  if (!Number.isFinite(lifetimeTokens) || lifetimeTokens <= 0) return [];

  const lifetimeUsd = lifetimeTokens * pricePerToken();
  const usdStr = (n: number, dp: number = 2): string => n.toFixed(dp);

  // Comparison units — kept locally so they're easy to tune without touching
  // the renderer logic. Cursor Pro & Claude Max are public list prices; the
  // weekend constant is an intentional approximation calibrated to make
  // $1399.73 → "19 weekends" line up with the demo target.
  const cursorMonths = Math.round(lifetimeUsd / 20);
  const claudeMaxMonths = (lifetimeUsd / 200).toFixed(1);
  const weekendCount = Math.round(lifetimeUsd / 73.67);
  const teamUsd = Math.round(lifetimeUsd * 10);
  const teamYearUsd = lifetimeDays > 0 ? Math.round(((lifetimeUsd * 10) / lifetimeDays) * 365) : 0;

  // Alternate-model scale row — same token count, different per-1M rates.
  // (Kept for internal reference but unreachable per Mert directive.)

  const _sonnetUsd = ((lifetimeTokens * 3.0) / 1_000_000).toFixed(2);

  const _gpt4oUsd = ((lifetimeTokens * 2.5) / 1_000_000).toFixed(2);

  const _geminiUsd = ((lifetimeTokens * 1.25) / 1_000_000).toFixed(2);

  const _haikuUsd = ((lifetimeTokens * 1.0) / 1_000_000).toFixed(2);

  const usingDynamicPrice = process.env.PI_OPEN_CONTEXT_MODE_PRICE_OUTPUT_PER_TOKEN !== undefined;
  const modelId = process.env.PI_OPEN_CONTEXT_MODE_MODEL_ID;

  // Mert: "daha marketing ve business value e vermeli, math hesaplamalari ile
  // kalabalik yapma" — collapse the old 4-block render into ONE headline
  // number, ONE relatable comparison, ONE team-scale callout.
  const out: string[] = [];

  if (usingDynamicPrice && modelId) {
    out.push(`  $${usdStr(lifetimeUsd)} of ${modelId} tokens your team didn't burn.`);
  } else if (usingDynamicPrice) {
    out.push(`  $${usdStr(lifetimeUsd)} of tokens your team didn't burn.`);
  } else {
    out.push(`  $${usdStr(lifetimeUsd)} of Opus 4.7 tokens your team didn't burn.`);
  }

  out.push(`  open-context-mode kept ${kb(lifetimeBytes)} out of context — that's ${cursorMonths} months of Cursor Pro paid for itself.`);
  if (teamUsd > 0 && teamYearUsd > 0) {
    out.push("");
    out.push(`  Scale across a 10-dev team and that's ~$${teamYearUsd.toLocaleString("en-US")}/year saved.`);
  }

  if (!usingDynamicPrice) {
    out.push("");
    out.push(`  (Opus rates shown for context. On cheaper models the dollar number drops; the savings ratio holds.)`);
  }
  return out;
}

/**
 * Render the full 5-section narrative ("kitap gibi") layout — the
 * Mert-approved screenshot format the production open_ctx_stats handler
 * produces for users with conversation + lifetime + multi-adapter data.
 *
 * Order:
 *   Opener
 *   Section 1 — Where you are now            (datetime, /compact, timeline)
 *   Section 2 — What this chat captured      (per-category bars)
 *   Section 3 — The receipt — getting wider  (this conv vs all-work)
 *   Section 4 — For example: what would that cost?
 *   Section 5 — What open-context-mode learned about how you work (auto-memory)
 *   Footer
 *
 * Pure renderer: every input arrives via the args object so this
 * function is trivially testable end-to-end without mocking process or
 * Date. The caller (formatReport) is responsible for choosing a `now`
 * value that matches the conversation's age math and a `cwd` that
 * matches the user's project — defaults are sensible for production.
 */
function renderNarrative5Section(args: {
  conversation: ConversationStats;
  lifetime?: LifetimeStats;
  multiAdapter?: MultiAdapterLifetimeStats;
  realBytes?: { lifetime?: RealBytesStats; conversation?: RealBytesStats };
  cwd: string;
  locale: string;
  tz: string;
  now: number;
  version?: string;
  latestVersion?: string | null;
}): string[] {
  const { conversation, lifetime, multiAdapter, realBytes, cwd, locale, tz, now, version, latestVersion } = args;
  const out: string[] = [];

  // ── Token math (same monotonic-growth invariant as the legacy branch).
  const convEventsTokens = conversation.events * TOKENS_PER_EVENT;
  const convRescueTokens = Math.round((conversation.snapshotBytes ?? 0) / 4);
  const convLegacyTokens = convEventsTokens + convRescueTokens;
  const convRealTokens = realBytes?.conversation?.totalSavedTokens ?? 0;
  const conversationTokens = Math.max(convLegacyTokens, convRealTokens);

  const lifetimeEventsTokens = (lifetime?.totalEvents ?? 0) * TOKENS_PER_EVENT;
  const lifetimeRescueTokens = Math.round((lifetime?.rescueBytes ?? 0) / 4);
  const lifetimeLegacyTokens = lifetimeEventsTokens + lifetimeRescueTokens;
  // Lifetime "with"/"without" — measured when available, else legacy fallback.
  // Honest definition (matches conversation bar below):
  //   "with"    = bytes_returned (what the model actually re-saw)
  //   "without" = bytes_returned + bytes_avoided
  // Honest-savings fix (#952): when measurement exists it is AUTHORITATIVE —
  // the old Math.max(legacy, real) let the events×256 heuristic (capture
  // volume, not savings) override real measurements and inflate the hero $.
  const lifeRet = realBytes?.lifetime?.bytesReturned ?? 0;
  const lifeAv = realBytes?.lifetime?.bytesAvoided ?? 0;
  const hasMeasured = lifeRet + lifeAv > 0;
  const lifetimeTokensWithout = hasMeasured ? Math.max(1, Math.floor((lifeRet + lifeAv) / 4)) : lifetimeLegacyTokens;
  const lifetimeTokensWith = hasMeasured ? Math.max(1, Math.floor(lifeRet / 4)) : Math.max(1, Math.round(lifetimeLegacyTokens * 0.02));

  // Bytes from realBytes when present, else derive from tokens (×4 — same
  // ratio Phase 8 uses everywhere). All-work bytes drives the opener tally
  // + the section-3 receipt + section-4 cost example.
  const lifetimeBytes = multiAdapter?.totalBytes && multiAdapter.totalBytes > 0 ? multiAdapter.totalBytes : lifetimeTokensWithout * 4;
  const convBytes = realBytes?.conversation
    ? realBytes.conversation.eventDataBytes + realBytes.conversation.bytesAvoided + realBytes.conversation.snapshotBytes
    : conversationTokens * 4;

  // ── Days alive of THE CONVERSATION (section 1).
  const convDays =
    conversation.daysAlive >= 1
      ? `${conversation.daysAlive.toFixed(1)} days alive · still going`
      : `${Math.max(1, Math.round(conversation.daysAlive * 24))} hr alive · still going`;

  // ── Lifetime span (opener + receipt) — across every adapter / DB on disk.
  const sinceMs = lifetime?.firstEventMs ?? multiAdapter?.perAdapter?.[0]?.firstMs ?? 0;
  const lifetimeDays = sinceMs > 0 ? Math.max(1, Math.round((now - sinceMs) / 86_400_000)) : 0;
  const totalConversations = multiAdapter?.totalSessions ?? lifetime?.totalSessions ?? 1;
  const realAdapterCount = multiAdapter?.perAdapter.filter((a) => a.isReal).length ?? 0;
  let where: string;
  if (multiAdapter && realAdapterCount >= 2) {
    where = `across ${realAdapterCount} AI tools`;
  } else if (multiAdapter && realAdapterCount === 1) {
    const onlyReal = multiAdapter.perAdapter.find((a) => a.isReal);
    where = `in ${onlyReal ? adapterLabel(onlyReal.name) : "Claude Code"}`;
  } else {
    where = "in Claude Code";
  }

  // ── Opener.
  if (lifetimeDays > 0) {
    out.push(`  Across ${lifetimeDays} days you ran ${fmtNum(totalConversations)} conversations ${where}.`);
  } else {
    out.push(`  You ran ${fmtNum(totalConversations)} conversations ${where}.`);
  }
  // Daily-average sub-line — never tease users with a tiny number when the
  // average is sub-MB (still informative); fall back to KB display.
  const dailyBytes = lifetimeDays > 0 ? lifetimeBytes / lifetimeDays : 0;
  out.push(`  open-context-mode kept ${kb(lifetimeBytes)} out of your context window — about ${kb(dailyBytes)} every single day.`);
  out.push("");
  out.push("");

  // ── Section 1 — Where you are now.
  out.push("  ─── 1. Where you are now ───");
  out.push("");
  const startedStr =
    conversation.firstEventMs && conversation.firstEventMs > 0 ? formatLocalDateTime(conversation.firstEventMs, locale, tz) : "";
  if (startedStr) {
    out.push(`  This conversation started ${startedStr} in ${shortPath(cwd)}.`);
  } else {
    out.push(`  This conversation lives in ${shortPath(cwd)}.`);
  }
  out.push(`  ${convDays}.`);
  if (conversation.snapshotsConsumed > 0 && conversation.snapshotBytes > 0) {
    const rescueAt =
      conversation.lastRescueMs && conversation.lastRescueMs > 0 ? formatLocalDateTime(conversation.lastRescueMs, locale, tz) : "";
    const rescueKb = Math.round(conversation.snapshotBytes / 1024);
    if (rescueAt) {
      out.push(`  On ${rescueAt}, /compact fired — ${rescueKb} KB rescued from snapshot.`);
    } else {
      out.push(`  /compact fired — ${rescueKb} KB rescued from snapshot.`);
    }
    out.push(`  Without that, you'd be re-explaining everything to a blank model right now.`);
  }
  out.push("");

  // Without/With bars — strict compression (v1.0.148, Bug G / ADR-0004).
  //
  // Honest definitions:
  //   Without = bytes the model WOULD have re-seen if open-context-mode
  //             had not diverted them
  //           = bytesAvoided + bytesReturned
  //   With    = bytes the model ACTUALLY re-saw after open-context-mode
  //           = max(1, bytesReturned)
  //
  // Why eventDataBytes is excluded from this ratio:
  //   `eventDataBytes` is the raw hook payload (tool args, prompt
  //   body) we captured for the knowledge base. Those bytes are
  //   analytics infrastructure — they NEVER enter the model context
  //   window. Including them on either side (as v1.0.134 SLICE B did
  //   to dodge a degenerate 100% bar) misrepresents context cost.
  //   SLICE B was an incidental fix that crushed the displayed
  //   percentage from ~95% (the true compression ratio) to ~56% on
  //   live conversations. eventDataBytes is rendered in Section 2
  //   (captures count), not in this Section 1 Without/With bar.
  //
  // Empty-state branch:
  //   If neither bytesAvoided nor bytesReturned has been measured yet
  //   (early in a session, schema-migration recovery in progress, or
  //   tool-heavy work that hasn't re-hit the index), we do NOT draw
  //   a degenerate 0% / 100% bar. We emit one honest hint line and
  //   skip the bar — honesty over decoration.
  const realConv = realBytes?.conversation;
  const measuredAvoided = realConv?.bytesAvoided ?? 0;
  const measuredReturned = realConv?.bytesReturned ?? 0;

  // The redirect measurement, and the only figure that may be called "kept out":
  // eventDataBytes is the raw hook payload and never reaches the model.
  // The formula itself lives in analytics-metrics.ts (ADR-0004), pure + tested.
  const convRatio = compressionRatio({ avoidedBytes: measuredAvoided, returnedBytes: measuredReturned });
  const convBytesWithout = convRatio?.withoutBytes ?? 0;

  if (!convRatio) {
    // No measurable redirect activity yet — captures may exist, but
    // nothing has been diverted from the model context window.
    out.push("  No measurable redirect activity captured yet — bars will appear once open-context-mode diverts its first payload.");
    out.push("");
  } else {
    // Nothing re-served yet is a real, common state, and the 100% that follows is
    // honest: every measured byte was diverted and none came back (ADR-0004,
    // v1.0.148 "Bug G"). The Math.max(1, …) floors around it were not honest —
    // they turned a zero into a fabricated 1-byte baseline and produced a duration
    // multiple of 498528x, neither of which any measurement produced (#950). The
    // ratio survives; the two artefacts derived from it do not.
    const withoutBar = dataBar(convRatio.withoutTokens, convRatio.withoutTokens, 32);
    const withBar = dataBar(convRatio.withTokens, convRatio.withoutTokens, 32);
    out.push(
      `  Without open-context-mode  ${kb(convRatio.withoutBytes).padStart(8)}  ${withoutBar}   ${fmtNum(convRatio.withoutTokens).padStart(7)} tokens`,
    );
    out.push(
      `  With open-context-mode     ${kb(convRatio.withBytes).padStart(8)}  ${withBar}   ${fmtNum(convRatio.withTokens).padStart(7)} tokens`,
    );
    out.push(
      `                          ${convRatio.pct.toFixed(1)}% kept out of context · ` +
        (convRatio.withTokens > 0
          ? `${convRatio.mult}× more data diverted from context window`
          : `nothing has been re-served yet, so no diversion ratio applies`),
    );
    out.push("");
  }

  // Timeline — drop-in if conversation has byDay.
  if (conversation.byDay && conversation.byDay.length > 0) {
    const totalConvDays =
      conversation.lastEventMs && conversation.firstEventMs
        ? Math.max(1, Math.round((conversation.lastEventMs - conversation.firstEventMs) / 86_400_000) + 1)
        : conversation.byDay.length;
    // Same numerator as the bar above. convBytes also carries eventDataBytes —
    // the raw hook payload, which is analytics infrastructure and never reaches
    // the model — so using it here made the caption disagree with the bar it
    // describes (#950).
    out.push(`  How that ${kb(convBytesWithout)} built up — ${totalConvDays} days, ${conversation.byDay.length} active:`);
    out.push("");
    out.push(...renderHorizontalTimeline(conversation.byDay, locale, tz));
  }
  out.push("");
  out.push("");

  // ── Section 2 — What this chat captured.
  out.push("  ─── 2. What this chat captured (used when you --continue or /resume here) ───");
  out.push("");
  const capturedTotal = conversation.byCategory.reduce((s, c) => s + c.count, 0);
  // Format with locale separator (en-* → "1,277"; en-TR → "1.277").
  const totalStr = capturedTotal.toLocaleString(locale);
  out.push(`  ${totalStr} things — files, errors, decisions, agent runs:`);
  out.push("");
  // ALL categories, no truncation (Slice 5).
  const max = conversation.byCategory[0]?.count ?? 1;
  for (const cat of conversation.byCategory) {
    out.push(`    ${cat.label.padEnd(26)} ${String(cat.count).padStart(5)}   ${dataBar(cat.count, max, 28)}`);
  }
  out.push("");
  out.push("");

  // ── Section 3 — Scope ladder, prose form (Mert: "cok daginik" → drop columns).
  // Two short sentences instead of a 4-column table — the same numbers framed
  // as "this chat" → "all your work" so the reader sees the scope getting wider
  // without being asked to scan a wide grid.
  out.push("  ─── 3. The scope, getting wider ───");
  out.push("");
  const convStartedYMD =
    conversation.firstEventMs && conversation.firstEventMs > 0
      ? new Intl.DateTimeFormat(locale, { timeZone: tz, year: "numeric", month: "short", day: "numeric" }).format(
          new Date(conversation.firstEventMs),
        )
      : "";
  const lifeStartedYMD =
    sinceMs > 0
      ? new Intl.DateTimeFormat(locale, { timeZone: tz, year: "numeric", month: "short", day: "numeric" }).format(new Date(sinceMs))
      : "";
  const distinctProj = lifetime?.distinctProjects ?? 0;
  const allCaps = lifetime?.totalEvents ?? multiAdapter?.totalEvents ?? 0;
  out.push(
    `  This chat: ${kb(convBytesWithout)} kept out · ${conversation.events.toLocaleString(locale)} captures${convStartedYMD ? ` · started ${convStartedYMD}` : ""}.`,
  );
  out.push(
    // Deliberately NOT labelled "kept out": multiAdapter.totalBytes is
    // SUM(LENGTH(data)) + rescueBytes and carries no bytes_avoided column,
    // while the per-chat line above is mostly bytes_avoided. Two figures from
    // disjoint columns cannot be compared, and printing them under the same
    // words is how a per-chat total came to exceed the all-work total (#950).
    // The honest fix is to thread bytes_avoided through the multi-adapter
    // aggregation; until then this line reports captured session bytes and
    // says so.
    `  All your work: ${kb(lifetimeBytes)} in session data · ${allCaps.toLocaleString(locale)} captures across ${distinctProj} project${distinctProj === 1 ? "" : "s"}${lifeStartedYMD ? ` · since ${lifeStartedYMD}` : ""}.`,
  );
  out.push("");
  out.push("");

  // ── Section 4 — Marketing-grade cost framing (Mert: "math hesaplamalari ile
  // kalabalik yapma" → less math, more business value). One headline, one
  // optional team-scale callout, no scaling table, no math footnotes.
  out.push("  ─── 4. The bottom line ───");
  out.push("");
  // Honest-savings fix (#952): the $ line advertises tokens NOT burned, so
  // it must use measured kept-out tokens (without − with), not capture volume.
  const lifetimeKeptTokens = Math.max(0, lifetimeTokensWithout - lifetimeTokensWith);
  out.push(...renderCostExample(lifetimeKeptTokens * 4, lifetimeKeptTokens, lifetimeDays));
  out.push("");
  out.push("");

  // ── Section 5 — What open-context-mode learned about how you work.
  out.push("  ─── 5. What open-context-mode learned about how you work ───");
  out.push("");
  if (lifetime && lifetime.autoMemoryCount > 0) {
    out.push(
      `  ${lifetime.autoMemoryCount} preferences picked up across ${lifetime.autoMemoryProjects} project${lifetime.autoMemoryProjects === 1 ? "" : "s"}:`,
    );
    const entries = Object.entries(lifetime.autoMemoryByPrefix).sort((a, b) => b[1] - a[1]);
    const maxAm = entries.length > 0 ? entries[0][1] : 1;
    for (const [prefix, count] of entries) {
      const label = autoMemoryLabels[prefix] ?? prefix;
      out.push(`    ${label.padEnd(26)} ${String(count).padStart(2)}   ${dataBar(count, maxAm, 20)}`);
    }
  } else {
    out.push("  No preferences learned yet — open-context-mode picks them up automatically.");
  }
  out.push("");
  out.push("");

  // ── Footer.
  out.push("  Your AI talks less, remembers more, costs less.");
  out.push(`  Locale ${locale} · timezone ${tz} · pricing examples for illustration only.`);
  out.push("");
  const versionStr = version ? `v${version}` : "open-context-mode";
  out.push(`  ${versionStr}`);
  if (version && latestVersion && latestVersion !== "unknown" && semverNewer(latestVersion, version)) {
    out.push(`  Update available: v${version} -> v${latestVersion}  |  git pull && npm run build`);
  }

  // Suppress consecutive blank lines / leading blanks for tidier output —
  // we use `push("")` liberally above as paragraph separators, easier to
  // collapse here than to track flag state inline.
  return collapseBlanks(out);
}

/** Drop runs of >2 consecutive blank strings so the renderer never emits visual gaps. */
function collapseBlanks(lines: string[]): string[] {
  const out: string[] = [];
  let blankRun = 0;
  for (const ln of lines) {
    if (ln === "") {
      blankRun++;
      if (blankRun <= 2) out.push(ln);
    } else {
      blankRun = 0;
      out.push(ln);
    }
  }
  // Trim trailing blanks.
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out;
}

/**
 * One day on the horizontal narrative timeline. `ms` is midnight-UTC of
 * the day (caller is responsible for normalising); `count` is captures
 * for that day; `rescueBytes` (when >0) overlays the ◆ /compact glyph.
 */
export interface TimelineDay {
  ms: number;
  count: number;
  rescueBytes?: number;
}

/**
 * Render the proportional-spacing horizontal day strip used in section 1
 * of the 5-section narrative. Returns the lines verbatim ready to splice
 * into the formatReport line buffer:
 *
 *     apr 28 ●──────────────────────●────█──────────────────────◆────● may 10
 *
 *       apr 28   277 captures
 *       may 4    438 captures  ← peak
 *       may 9    261 captures  ◆ /compact rescued 1552 KB
 *       may 10   100 captures
 *
 *     ●  active day      █  peak day      ◆  /compact rescue
 *
 * The strip body is exactly 56 chars wide. Day positions are computed as
 * `round((day - first) / (last - first) * 55)`. Glyph priority for a
 * column: rescue (◆) > peak (█) > active (●). Filler is the box-drawing
 * `─` character so the strip reads cleanly in monospace terminals.
 */
export function renderHorizontalTimeline(days: TimelineDay[], locale: string, tz: string): string[] {
  if (days.length === 0) return [];
  // Sort ascending so first/last bookends + bar positions are stable.
  const sorted = [...days].sort((a, b) => a.ms - b.ms);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const span = Math.max(1, last.ms - first.ms);

  // Locate the peak day (max count). Ties: earliest wins so the visual
  // pin matches the chronologically first big day.
  let peak = sorted[0];
  for (const d of sorted) if (d.count > peak.count) peak = d;

  // Build the 56-char strip body.
  const WIDTH = 56;
  const body = Array.from({ length: WIDTH }, () => "─");
  for (const d of sorted) {
    const col = Math.round(((d.ms - first.ms) / span) * (WIDTH - 1));
    let glyph = "●";
    if (d === peak) glyph = "█";
    if ((d.rescueBytes ?? 0) > 0) glyph = "◆"; // rescue beats peak
    body[col] = glyph;
  }

  // Lowercase short month names ("apr"/"may"/"jan") matching the target.
  const monthDay = (ms: number): string => {
    const dt = new Intl.DateTimeFormat(locale, {
      timeZone: tz,
      month: "short",
      day: "numeric",
    }).formatToParts(new Date(ms));
    const month = (dt.find((p) => p.type === "month")?.value ?? "").toLowerCase();
    const day = dt.find((p) => p.type === "day")?.value ?? "";
    return `${month} ${day}`;
  };

  const out: string[] = [];
  out.push(`  ${monthDay(first.ms)} ${body.join("")} ${monthDay(last.ms)}`);
  out.push("");

  // Daily detail rows — count + " ← peak" + "◆ /compact rescued N KB".
  for (const d of sorted) {
    const label = monthDay(d.ms).padEnd(7);
    const captures = `${d.count} captures`;
    const peakStr = d === peak ? "  ← peak" : "";
    const rescue = (d.rescueBytes ?? 0) > 0 ? `  ◆ /compact rescued ${Math.round((d.rescueBytes ?? 0) / 1024)} KB` : "";
    out.push(`    ${label}  ${captures}${peakStr}${rescue}`);
  }
  out.push("");
  out.push("  ●  active day      █  peak day      ◆  /compact rescue");
  return out;
}

/**
 * Render a UTC ms timestamp as a human-readable local datetime string in
 * the canonical Mert-approved format:
 *
 *   "28 Apr 2026 at 12:16 (Europe/Istanbul)"
 *
 * Used by the 5-section narrative renderer (formatReport) so users see
 * exactly when their conversation started + when /compact rescues fired
 * in their wall-clock timezone — never UTC, never ambiguous.
 *
 * - 24-hour clock with zero-padded minutes ("20:54", not "8:54 PM").
 * - Day is NOT zero-padded ("9 May", not "09 May") to match the target.
 * - IANA timezone is appended verbatim in parentheses regardless of
 *   locale so users never misread Istanbul-time as UTC.
 * - Returns "" for ms === 0 or NaN so callers can guard the rendered
 *   line ("started …") without an extra timestamp-validity check.
 */
export function formatLocalDateTime(ms: number, locale: string, tz: string): string {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "";
  // Intl.DateTimeFormat's "day"/"month"/"year" parts give us the locale's
  // ordering (en-* → "DD MMM YYYY"), and the explicit numeric hour/minute
  // forces 24-hour with leading zero on minute when in en-* with hour12=false.
  const dt = new Intl.DateTimeFormat(locale, {
    timeZone: tz,
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): string => dt.find((p) => p.type === type)?.value ?? "";
  const day = get("day");
  const month = get("month");
  const year = get("year");
  let hour = get("hour");
  const min = get("minute");
  // Some locales / some Node versions emit "24" for midnight under hour12=false.
  // Coerce back to "00" so the displayed time is always wall-clock-correct.
  if (hour === "24") hour = "00";
  return `${day} ${month} ${year} at ${hour}:${min} (${tz})`;
}

/** Format large numbers with K/M suffixes */
function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
/**
 * Build a proportional bar using █ chars, scaled to a fixed width.
 * Returns e.g. "████████████████████████████████████████" for full width.
 */
function dataBar(bytes: number, maxBytes: number, width: number = 40): string {
  if (maxBytes <= 0) return "░".repeat(width);
  const filled = Math.max(1, Math.round((bytes / maxBytes) * width));
  return "█".repeat(Math.min(filled, width)) + "░".repeat(Math.max(0, width - filled));
}

/**
 * Render project memory section with category bars.
 *
 * Shows persistent event data, and — when supplied — lifetime totals
 * across every project's SessionDB so users see the cumulative value
 * (Bug #3).
 *
 * Caps the category list at `topN` and prints "N more categories" with the
 * actual remaining count (Bug #5 — was hardcoded "9 more").
 */
function renderProjectMemory(
  pm: FullReport["projectMemory"],
  opts?: {
    lifetime?: LifetimeStats;
    topN?: number;
    sessionTokensSaved?: number;
    /**
     * B3b Slice 3.6 — when supplied, the "All your work" header is
     * promoted to "All your work everywhere" and the lifetime totals
     * use the multi-adapter sums (events / sessions / bytes aggregated
     * across every adapter dir on disk) instead of the single-dir
     * lifetime numbers. The category bars still come from the single-dir
     * lifetime.categoryCounts because the multi-adapter scan today does
     * not bucket categories.
     */
    multiAdapter?: MultiAdapterLifetimeStats;
  },
): string[] {
  const sessionTokensSaved = opts?.sessionTokensSaved ?? 0;
  // Render when EITHER disk has data OR current session has earnings.
  if (
    pm.total_events === 0 &&
    (opts?.lifetime?.totalEvents ?? 0) === 0 &&
    sessionTokensSaved === 0 &&
    (opts?.multiAdapter?.totalEvents ?? 0) === 0
  ) {
    return [];
  }
  // Slice 5 — Mert: "honest, no tease". Show ALL categories. The legacy
  // topN cap silently hid real data; users would screenshot a stats card
  // missing half their work. The opts.topN parameter stays in the signature
  // for back-compat with any external caller that explicitly passes a cap.
  const topN = opts?.topN ?? Number.POSITIVE_INFINITY;
  const out: string[] = [];
  out.push("");
  // Header switches based on whether we have rich lifetime data from the new
  // pipeline. With it: forward-leaning "All your work" framing. Without it:
  // legacy "Persistent memory" line for back-compat with older fixtures + tests.
  // Slice 3.6: promote to "All your work everywhere" when multi-adapter
  // aggregation is supplied so the receipt scope matches the rendered totals.
  const ma = opts?.multiAdapter;
  const realAdapters = ma?.perAdapter.filter((a) => a.isReal).length ?? 0;
  const lifeEvents = ma?.totalEvents ?? opts?.lifetime?.totalEvents ?? pm.total_events;
  const lifeSessions = ma?.totalSessions ?? opts?.lifetime?.totalSessions ?? pm.session_count;
  const distinctProj = opts?.lifetime?.distinctProjects;
  if (lifeEvents > 0 && distinctProj && distinctProj > 0) {
    const everywhere = realAdapters >= 2 ? " everywhere" : "";
    out.push(
      `  All your work${everywhere}  ·  ${fmtNum(lifeEvents)} events captured across ${distinctProj} project${distinctProj === 1 ? "" : "s"}  ·  ${fmtNum(lifeSessions)} conversations`,
    );
  } else {
    out.push("Persistent memory  ✓ preserved across compact, restart & upgrade");
    // Current session counts as 1 when no prior session has been recorded yet.
    const effectiveSessions = lifeSessions === 0 && sessionTokensSaved > 0 ? 1 : lifeSessions;
    const sessionLabel = effectiveSessions === 1 ? "1 session" : `${fmtNum(effectiveSessions)} sessions`;
    // Estimate lifetime savings: ~1KB per event → ~256 tokens/event at Opus rates,
    // plus current session's already-tracked token savings (in-memory).
    const lifetimeTokens = lifeEvents * 256 + sessionTokensSaved;
    out.push(`  ${fmtNum(lifeEvents)} events · ${sessionLabel} · ~${tokensToUsd(lifetimeTokens)} saved lifetime`);
  }
  out.push("");

  // Prefer lifetime categoryCounts (aggregated across every SessionDB) so
  // the bar block matches the lifetime header above. Falls back to the
  // project-local pm.by_category when lifetime data is absent (tests, older
  // callers) or when no sidecar has any events yet.
  const lifetimeCats = opts?.lifetime?.categoryCounts;
  let cats: Array<{ category: string; count: number; label: string }>;
  if (lifetimeCats && Object.keys(lifetimeCats).length > 0) {
    cats = Object.entries(lifetimeCats)
      .filter(([, c]) => c > 0)
      .map(([category, count]) => ({
        category,
        count,
        label: categoryLabels[category] || category,
      }))
      .sort((a, b) => b.count - a.count);
  } else {
    // Defensive: filter zero/null counts on the fallback path too — bumping
    // topN to 15 made any leaked empty rows visible as "label  0  ░░░░░░".
    cats = (pm.by_category ?? []).filter((c) => c && c.count > 0);
  }
  const visible = cats.slice(0, topN);
  const maxCount = visible.length > 0 ? visible[0].count : 1;
  for (const cat of visible) {
    out.push(`  ${cat.label.padEnd(26)} ${String(cat.count).padStart(5)}   ${dataBar(cat.count, maxCount, 30)}`);
  }

  // Bug #5: real overflow count, not hardcoded.
  const remaining = Math.max(0, cats.length - topN);
  if (remaining > 0) {
    out.push(`  ... ${remaining} more categor${remaining === 1 ? "y" : "ies"}`);
  }
  return out;
}

/**
 * Render the auto-memory section (Bug #4) — files Claude Code captured
 * under ~/.claude/projects/<project>/memory/ across the user's machine.
 */
function renderAutoMemory(lifetime: LifetimeStats | undefined): string[] {
  if (!lifetime || lifetime.autoMemoryCount === 0) return [];
  const out: string[] = [];
  out.push("");
  out.push(
    `  Preferences learned  ·  ${lifetime.autoMemoryCount} across ${lifetime.autoMemoryProjects} project${lifetime.autoMemoryProjects === 1 ? "" : "s"}`,
  );

  const entries = Object.entries(lifetime.autoMemoryByPrefix)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);
  // Top entry sets the bar scale so the visual stays proportional even when
  // the absolute counts are tiny. Entries are pre-sorted desc.
  const maxCount = entries.length > 0 ? entries[0][1] : 1;
  for (const [prefix, count] of entries) {
    const label = autoMemoryLabels[prefix] ?? prefix;
    out.push(`  ${label.padEnd(26)} ${String(count).padStart(2)}   ${dataBar(count, maxCount, 20)}`);
  }
  return out;
}

/** Render the closing "Bottom line" footer (Bug #8). */
function renderBottomLine(sessionTokensSaved: number, lifetime: LifetimeStats | undefined): string[] {
  const out: string[] = [];
  const sessionUsd = tokensToUsd(sessionTokensSaved);
  // Lifetime = disk-aggregated events × 256 tokens + current session's
  // in-memory token savings. Two pipelines unified at the render edge so
  // lifetime ≥ session always (never the surprising "$X session · $0 lifetime"
  // a fresh user sees pre-flush).
  const lifetimeTokens = (lifetime?.totalEvents ?? 0) * 256 + sessionTokensSaved;
  const lifetimeUsd = tokensToUsd(lifetimeTokens);
  out.push("");
  out.push("─".repeat(65));
  out.push("Your AI talks less, remembers more, costs less.");
  out.push(`${sessionUsd} this session  ·  ${lifetimeUsd} lifetime`);
  out.push("─".repeat(65));
  return out;
}

/**
 * Constant token-per-event used everywhere we estimate session/lifetime $.
 * Kept in lockstep with `bin/statusline.mjs`'s persisted lifetime conversion.
 */
const TOKENS_PER_EVENT = 256;

/**
 * Render the LIFETIME Without/With hero — the screenshottable receipt.
 *
 * Why lifetime and not session: the "$X saved this session" framing is
 * arbitrary (a fresh PID can show $0 even while the user has weeks of work
 * banked). Lifetime is real, accumulating, and the number worth screenshotting.
 * The current conversation's contribution still shows below as a sub-block.
 */
function renderHero(args: {
  lifetimeTokensWithout: number;
  lifetimeTokensWith: number;
  lifetimeUsd: string;
  lifetimeWithUsd: string;
  savedPct: number;
  totalConversations: number;
  firstDate?: string;
}): string[] {
  const { lifetimeTokensWithout, lifetimeTokensWith, lifetimeUsd, lifetimeWithUsd, savedPct, totalConversations, firstDate } = args;
  const out: string[] = [];
  const since = firstDate ? `  ·  since ${firstDate}` : "";
  out.push(`  ${lifetimeUsd} saved with open-context-mode  ·  ${savedPct.toFixed(1)}% reduction${since}`);
  out.push("");
  const withoutBar = dataBar(lifetimeTokensWithout, lifetimeTokensWithout, 32);
  const withBar = dataBar(lifetimeTokensWith, lifetimeTokensWithout, 32);
  out.push(`  Without open-context-mode  ${fmtNum(lifetimeTokensWithout).padStart(7)} tokens  ${withoutBar}   ${lifetimeUsd}`);
  out.push(`  With open-context-mode     ${fmtNum(lifetimeTokensWith).padStart(7)} tokens  ${withBar}   ${lifetimeWithUsd}`);
  const kept = lifetimeTokensWithout - lifetimeTokensWith;
  out.push(
    `                        ${fmtNum(kept).padStart(7)} tokens kept out  ·  across ${totalConversations.toLocaleString("en-US")} conversations`,
  );
  return out;
}

/**
 * Render the current conversation as a contribution narrative — not a hero.
 * Highlights the slice of lifetime savings this chat earned + concrete proof
 * (events, days alive, compact rescues).
 */
function renderConversation(c: ConversationStats, conversationUsd: string, contribPct: number): string[] {
  const out: string[] = [];
  const daysStr = c.daysAlive >= 1 ? `${c.daysAlive.toFixed(1)} days` : `${Math.max(1, Math.round(c.daysAlive * 24))} hr`;
  const pctStr = contribPct >= 1 ? `${contribPct.toFixed(0)}% of all-time` : `<1% of all-time`;
  out.push(`  This conversation contributed ${conversationUsd}  ·  ${pctStr}`);
  out.push(`  ${c.events.toLocaleString("en-US")} events  ·  ${daysStr} alive`);
  if (c.snapshotsConsumed > 0 && c.snapshotBytes > 0) {
    const rescuedTokens = Math.round(c.snapshotBytes / 4);
    out.push(
      `  ${c.snapshotsConsumed} compact weathered  ·  ${fmtNum(rescuedTokens)} tokens rescued from a ${(c.snapshotBytes / 1024).toFixed(0)} KB snapshot`,
    );
  }
  out.push("");
  if (c.byCategory.length === 0) return out;
  const max = c.byCategory[0].count || 1;
  for (const cat of c.byCategory) {
    out.push(`    ${cat.label.padEnd(26)} ${String(cat.count).padStart(5)}   ${dataBar(cat.count, max, 28)}`);
  }
  return out;
}

/**
 * B3b Slice 3.2/3.3 — render the "Where it came from" sub-block from a
 * `MultiAdapterLifetimeStats` (analytics.ts:1231-1240). Two layers:
 *
 *  1. Real adapters (`isReal=true`) become a table row each:
 *       Tool          Captures   Indexed     Total kept out
 *       Claude Code     17.4K    276.7 MB        291.1 MB
 *       JetBrains            —     8.6 MB          8.6 MB
 *
 *  2. Filtered adapters (`isReal=false` but with at least one .db on disk)
 *     become a single "Skipped (N): name1, name2, ..." disclosure line so
 *     the user sees that fixtures/probes were intentionally hidden.
 *
 * Returns [] when `multiAdapter` is undefined OR when there are no real
 * adapters AND nothing skipped — keeping the renderer additive (Slice 3.5).
 */
function renderMultiAdapter(multiAdapter: MultiAdapterLifetimeStats | undefined): string[] {
  if (!multiAdapter) return [];
  const real: typeof multiAdapter.perAdapter = [];
  const skipped: typeof multiAdapter.perAdapter = [];
  for (const a of multiAdapter.perAdapter) (a.isReal ? real : skipped).push(a);
  if (real.length === 0 && skipped.length === 0) return [];

  const out: string[] = [];
  if (real.length > 0) {
    out.push("");
    out.push("Where it came from (tools you actually used — fixtures + probes filtered):");
    out.push("");
    // Column widths chosen so the demo render stays visually aligned even
    // for adapters with very long marketing names. Right-aligned numerics.
    const NAME_W = 16;
    const CAP_W = 10;
    const IDX_W = 10;
    const TOT_W = 16;
    out.push(`  ${"Tool".padEnd(NAME_W)}${"Captures".padStart(CAP_W)}${"Indexed".padStart(IDX_W)}${"Total kept out".padStart(TOT_W)}`);
    // Sort by total kept out desc — biggest contributor first.
    const sorted = [...real].sort((a, b) => b.dataBytes + b.rescueBytes - (a.dataBytes + a.rescueBytes));
    for (const a of sorted) {
      const total = a.dataBytes + a.rescueBytes;
      // Em-dash for zero captures so the column reads "—" not "0".
      const captures = a.eventCount > 0 ? fmtNum(a.eventCount) : "—";
      const indexed = kb(a.dataBytes);
      const totalStr = kb(total);
      out.push(`  ${adapterLabel(a.name).padEnd(NAME_W)}${captures.padStart(CAP_W)}${indexed.padStart(IDX_W)}${totalStr.padStart(TOT_W)}`);
    }
  }

  if (skipped.length > 0) {
    if (real.length > 0) out.push("");
    const names = skipped.map((a) => adapterLabel(a.name)).join(", ");
    out.push(`  Skipped (${skipped.length}): ${names}`);
    out.push("  These adapters have DBs on disk but only test fixtures, dev skeletons,");
    out.push("  or detection probes — no real chat activity.");
  }

  return out;
}

/**
 * Render a FullReport as a visual savings dashboard designed for screenshotting.
 *
 * Design principles:
 * - Before/After comparison bar is the HERO — one glance = "wow"
 * - "tokens saved" is the number people share
 * - Per-tool breakdown shows what each tool SAVED, sorted by impact
 * - Project memory: category bars showing persistent data across sessions
 * - No: Pct column, category tables, tips, jargon
 */
export function formatReport(
  report: FullReport,
  version?: string,
  latestVersion?: string | null,
  opts?: {
    lifetime?: LifetimeStats;
    mcpUsage?: McpToolUsageRow[];
    conversation?: ConversationStats;
    /**
     * Phase 8 of D2 PRD — pass realBytes pre-aggregated from
     * `getRealBytesStats(...)` and the renderer will use those numbers
     * for the $ math instead of the conservative `events × 256` estimate.
     *
     * - `realBytes.lifetime` overrides `lifetimeTokensWithout`.
     * - `realBytes.conversation` overrides `conversationTokens`.
     * - Either may be omitted independently — missing values fall back
     *   to the legacy estimate so this feature can never produce
     *   a smaller number than before (Mert: stats only go up).
     * - When the new value is SMALLER than the legacy estimate (fresh
     *   sessions before any sandbox events emit), we keep the larger
     *   number to honour the same monotonic-growth invariant.
     */
    realBytes?: {
      lifetime?: RealBytesStats;
      conversation?: RealBytesStats;
    };
    /**
     * B3b — multi-adapter aggregation surfaced by
     * `getMultiAdapterLifetimeStats(...)` (analytics.ts:1248). When present,
     * the renderer adds a "Where it came from" sub-block under the receipt,
     * promotes the headline to "across N AI tools" when >= 2 real adapters
     * are detected, and renames the all-work block to "All your work
     * everywhere". Backward compat: omitting this opt preserves the legacy
     * single-adapter renderer output unchanged.
     */
    multiAdapter?: MultiAdapterLifetimeStats;
    /**
     * Point-in-time snapshot of the persistent content store. Optional —
     * callers that don't have store access can omit it and the renderer
     * skips the observability section gracefully.
     */
    indexState?: IndexState;
    /**
     * 5-section narrative renderer overrides. Defaults to ambient
     * `process.cwd()` + `Date.now()` + `detectLocaleAndTz()` for production
     * use; tests inject deterministic values so output is byte-stable.
     */
    cwd?: string;
    now?: number;
    locale?: string;
    tz?: string;
  },
): string {
  const lines: string[] = [];
  const duration = formatDuration(report.session.uptime_min);
  const lifetime = opts?.lifetime;
  const mcpUsage = opts?.mcpUsage;
  const conversation = opts?.conversation;
  const realBytes = opts?.realBytes;
  const multiAdapter = opts?.multiAdapter;
  // Real-adapter count drives the "across N AI tools" headline copy
  // (Slice 3.4) — we only call something a "tool you used" once it
  // passes the isReal filter inside getMultiAdapterLifetimeStats.
  const realAdapterCount = multiAdapter?.perAdapter.filter((a) => a.isReal).length ?? 0;

  // ── B3b Slice 3.4: opening tagline — runs in EVERY render path so the
  // multi-adapter headline appears regardless of which formatReport branch
  // executes (active session / fresh / per-conversation). Falls back to
  // "in Claude Code" when only one adapter qualifies as real, matching the
  // Mert-approved demo wording. Suppressed entirely without multiAdapter
  // so legacy single-adapter renders stay byte-identical (Slice 3.5).
  if (multiAdapter && realAdapterCount > 0) {
    const totalConvs = multiAdapter.totalSessions || lifetime?.totalSessions || 0;
    const sinceMs = lifetime?.firstEventMs ?? 0;
    const days = sinceMs > 0 ? Math.max(1, Math.round((Date.now() - sinceMs) / 86_400_000)) : 0;
    const daySegment = days > 0 ? `Across ${days} day${days === 1 ? "" : "s"} ` : "";
    const convStr = totalConvs > 0 ? `you ran ${fmtNum(totalConvs)} conversation${totalConvs === 1 ? "" : "s"} ` : "you ran ";
    let where: string;
    if (realAdapterCount >= 2) {
      where = `across ${realAdapterCount} AI tools`;
    } else {
      // Single real adapter — use its marketing label (defaults to Claude Code
      // if for some reason the only real adapter has no entry in adapterLabels).
      const onlyReal = multiAdapter.perAdapter.find((a) => a.isReal);
      where = `in ${onlyReal ? adapterLabel(onlyReal.name) : "Claude Code"}`;
    }
    lines.push(`${daySegment}${convStr}${where}.`);
    lines.push("");
  }

  // ── 5-section narrative ("kitap gibi") layout — Mert-approved
  //    screenshot format produced when the MCP handler has wired
  //    conversation + lifetime + multi-adapter through. Replaces the
  //    legacy hero/contribution/auto-memory stack with the:
  //      Opener
  //      1. Where you are now            (datetime, /compact, timeline)
  //      2. What this chat captured      (per-category bars)
  //      3. The receipt — getting wider
  //      4. For example: what would that cost?
  //      5. What open-context-mode learned about how you work
  //      Footer
  //    The opener block above (lines 1989-2005) is suppressed because
  //    renderNarrative5Section emits its own.
  if (conversation && conversation.events > 0) {
    // Strip the previous-block opener — narrative renderer emits its own.
    if (lines.length > 0) lines.length = 0;
    const detected = detectLocaleAndTz();
    const cwd = opts?.cwd ?? process.cwd();
    const now = opts?.now ?? Date.now();
    const locale = opts?.locale ?? detected.locale;
    const tz = opts?.tz ?? detected.tz;
    lines.push(
      ...renderNarrative5Section({
        conversation,
        lifetime,
        multiAdapter,
        realBytes,
        cwd,
        locale,
        tz,
        now,
        version,
        latestVersion,
      }),
    );
    return lines.join("\n");
  }

  // ── Compute real savings ──
  const totalKeptOut = report.savings.kept_out + (report.cache ? report.cache.bytes_saved : 0);
  const totalReturned = report.savings.total_bytes_returned;
  const totalCalls = report.savings.total_calls;
  const grandTotal = totalKeptOut + totalReturned;
  const savingsPct = grandTotal > 0 ? (totalKeptOut / grandTotal) * 100 : 0;
  const tokensSaved = Math.round(totalKeptOut / 4);
  const ratioMultiplier = totalReturned > 0 ? Math.max(1, Math.round(grandTotal / Math.max(totalReturned, 1))) : 0;

  // ── Fresh session: no savings yet ──
  if (totalKeptOut === 0) {
    lines.push(`open-context-mode  ${duration}  ${totalCalls} calls`);
    lines.push("");

    if (totalCalls === 0) {
      lines.push("No tool calls yet. Use open_ctx_batch_execute or open_ctx_execute to start saving tokens.");
    } else {
      lines.push(`${kb(totalReturned)} entered context  |  0 tokens saved`);
    }

    // Project memory + auto-memory + bottom line
    lines.push(...renderProjectMemory(report.projectMemory, { lifetime, multiAdapter, sessionTokensSaved: 0 }));
    lines.push(...renderMultiAdapter(multiAdapter));
    lines.push(...renderAutoMemory(lifetime));
    lines.push(...renderBottomLine(0, lifetime));

    // Footer
    lines.push("");
    const versionStr = version ? `v${version}` : "open-context-mode";
    lines.push(versionStr);
    if (version && latestVersion && latestVersion !== "unknown" && semverNewer(latestVersion, version)) {
      lines.push(`Update available: v${version} -> v${latestVersion}  |  git pull && npm run build`);
    }
    return lines.join("\n");
  }

  // ── Active session: visual savings dashboard ──

  // Line 1: Hero metric — the screenshottable number
  // Bug #6: include Opus pricing on the hero line for credibility.
  lines.push(
    `${fmtNum(tokensSaved)} tokens saved  ·  ${savingsPct.toFixed(1)}% reduction  ·  ${duration}  ·  ~${tokensToUsd(tokensSaved)} saved (Opus)`,
  );
  lines.push("");

  // Lines 2-3: Before/After comparison bars — the visual proof
  lines.push(`Without open-context-mode  |${dataBar(grandTotal, grandTotal)}| ${kb(grandTotal)}`);
  lines.push(`With open-context-mode     |${dataBar(totalReturned, grandTotal)}| ${kb(totalReturned)}`);
  lines.push("");

  // Value statement — the line people share
  // Bug #7: replace meaningless "3.0x" ratio with "3× longer sessions".
  if (ratioMultiplier >= 2) {
    lines.push(`${kb(totalKeptOut)} kept out of your conversation — ${ratioMultiplier}× longer sessions before compact.`);
  } else {
    lines.push(`${kb(totalKeptOut)} kept out of your conversation. Never entered context.`);
  }
  lines.push("");

  // Compact stats row
  const statParts = [`${totalCalls} calls`];
  if (report.cache && report.cache.hits > 0) {
    statParts.push(`${report.cache.hits} cache hits (+${kb(report.cache.bytes_saved)})`);
  }
  lines.push(statParts.join("  ·  "));

  // ── Per-tool breakdown (only if 2+ tools, sorted by saved) ──
  const activatedTools = report.savings.by_tool.filter((t) => t.calls > 0);
  if (activatedTools.length >= 2) {
    lines.push("");

    // Estimate per-tool saved using global savings ratio
    const toolRows = activatedTools
      .map((t) => {
        const returnedBytes = t.context_kb * 1024;
        const estimatedTotal = savingsPct < 100 ? returnedBytes / (1 - savingsPct / 100) : returnedBytes;
        const estimatedSaved = Math.max(0, estimatedTotal - returnedBytes);
        return { ...t, returnedBytes, estimatedSaved };
      })
      .sort((a, b) => b.estimatedSaved - a.estimatedSaved);

    // Compact table: tool name, calls, saved
    for (const t of toolRows) {
      const name = t.tool.length > 24 ? t.tool.slice(0, 21) + "..." : t.tool;
      lines.push(`  ${name.padEnd(24)}  ${String(t.calls).padStart(4)} calls  ${kb(t.estimatedSaved).padStart(8)} saved`);
    }
  }

  // ── Parallel I/O — value-forward framing for concurrent batch tools.
  // Suppressed when no tool ran with max_concurrency > 1 (don't claim
  // parallelism we didn't deliver). Internal mcp__*__ namespace stripped
  // for user-facing readability.
  if (mcpUsage && mcpUsage.length > 0) {
    const concurrent = mcpUsage.filter((u) => u.median_concurrency != null && (u.max_concurrency ?? 1) > 1);
    if (concurrent.length > 0) {
      lines.push("");
      lines.push("Parallel I/O  ✓ one call did the work of many — faster runs, lower bill, same answer.");
      for (const u of concurrent) {
        const name = u.tool_name.replace(/^mcp__.*?__/, "");
        lines.push(`  ${name.padEnd(24)} ${u.calls} batches · ${u.median_concurrency} typical, ${u.max_concurrency} peak`);
      }
    }
  }

  // ── Project memory — persistent across sessions (Bug #3 + #5) ──
  lines.push(...renderProjectMemory(report.projectMemory, { lifetime, multiAdapter, sessionTokensSaved: tokensSaved }));

  // ── B3b Slice 3.2/3.3 — "Where it came from" per-adapter sub-block.
  // Sits under the lifetime memory block so the receipt-to-source flow is
  // visually contiguous (lifetime totals → which tools produced them).
  lines.push(...renderMultiAdapter(multiAdapter));

  // ── Auto-memory — Claude Code's preference learnings (Bug #4) ──
  lines.push(...renderAutoMemory(lifetime));

  // ── Bottom line — business value framing (Bug #8) ──
  lines.push(...renderBottomLine(tokensSaved, lifetime));

  // ── Footer ──
  lines.push("");
  const versionStr = version ? `v${version}` : "open-context-mode";
  lines.push(versionStr);
  if (version && latestVersion && latestVersion !== "unknown" && latestVersion !== version) {
    lines.push(`Update available: v${version} -> v${latestVersion}  |  git pull && npm run build`);
  }

  return lines.join("\n");
}
