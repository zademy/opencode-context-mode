/**
 * Analytics metrics layer — PURE savings formulas (ADR-0004).
 *
 * No I/O, no rendering: byte→token→USD math and the strict-compression
 * ratio that powers the Section 1 Without/With bar. Token→USD routes
 * per-model lookups through ./pricing.ts (the curated catalog); the flat
 * Opus fallback below is the documented default when no model resolves.
 */

import { lookupPrice } from "./pricing.js";

// ─────────────────────────────────────────────────────────
// Pricing (Bug #6) — Anthropic Opus input rate
// ─────────────────────────────────────────────────────────

// ── Pricing (Bug #6) — per-token USD rate ─────────────────
// Reads PI_OPEN_CONTEXT_MODE_PRICE_OUTPUT_PER_TOKEN when set by a Pi host;
// falls back to the Opus 4.7/4.8 input rate ($5/1M) for all other adapters.
// Verified against platform.claude.com/docs/en/about-claude/pricing 2026-06.
//
// IMPORTANT: this is a FUNCTION, not a const. Pi sets the env var
// AFTER the MCP server has been imported (the bridge spawns the server
// child, then the child reads its own env on every render). A
// module-load-time const would freeze to the fallback because
// process.env.PI_OPEN_CONTEXT_MODE_PRICE_OUTPUT_PER_TOKEN is unset at
// import time. Resolving on every call keeps the dynamic-pricing
// contract honest — the env var works without an MCP restart.
// (Reverted module-load const semantics, PR #741 follow-up.)

/** Model id whose catalog row backs the flat fallback (Opus 4.7/4.8, $5/1M input). */
const FALLBACK_MODEL_ID = "claude-opus-4-7";

/**
 * Per-token USD rate — resolves on every call.
 * Dynamic when PI_OPEN_CONTEXT_MODE_PRICE_OUTPUT_PER_TOKEN is set, Opus 4.7/4.8 input
 * ($5 per 1M tokens) otherwise.
 *
 * Per-model rates are owned by ./pricing.ts (the curated catalog): pass a
 * `modelId` and the catalog's input rate is used when it has one. Without a
 * modelId — or when the catalog lacks the row — the documented flat Opus
 * fallback applies, because pricing.ts resolves unknown ids to null rather
 * than inventing a default.
 */
export function pricePerToken(modelId?: string): number {
  const env = process.env.PI_OPEN_CONTEXT_MODE_PRICE_OUTPUT_PER_TOKEN;
  if (env !== undefined && env !== "") {
    const parsed = Number(env);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  const price = lookupPrice(modelId ?? FALLBACK_MODEL_ID);
  if (price && typeof price.input_per_mtok === "number") return price.input_per_mtok / 1_000_000;
  return OPUS_INPUT_PRICE_PER_TOKEN; // flat Opus 4.7/4.8 input fallback ($5/1M)
}

/**
 * Back-compat alias for the original Opus-rate const (PR #401 architect
 * P1.1 — single source of truth). Kept as a literal so any third-party
 * consumer importing the named constant still resolves to the same
 * fallback rate. New code should call pricePerToken() to pick up the
 * dynamic Pi env override.
 *
 * @deprecated Use pricePerToken() to honor PI_OPEN_CONTEXT_MODE_PRICE_OUTPUT_PER_TOKEN.
 */
export const OPUS_INPUT_PRICE_PER_TOKEN = 5 / 1_000_000;

/** Convert a token count to a USD string at the current per-token rate. */
export function tokensToUsd(tokens: number): string {
  const safe = Number.isFinite(tokens) && tokens > 0 ? tokens : 0;
  return `$${(safe * pricePerToken()).toFixed(2)}`;
}

// ─────────────────────────────────────────────────────────
// Strict-compression ratio (ADR-0004) — Bug G / #950
// ─────────────────────────────────────────────────────────

/**
 * Result of the strict-compression comparison between "Without open-context-mode"
 * and "With open-context-mode" (ADR-0004). Token figures use the ÷4 bytes-per-token
 * convention used everywhere in the renderer.
 */
export interface CompressionRatio {
  /** Bytes the model WOULD have re-seen without redirects = avoided + returned. */
  withoutBytes: number;
  /** Bytes the model ACTUALLY re-saw = returnedBytes. No fabricated 1-byte floor (#950). */
  withBytes: number;
  /** Tokens for `withoutBytes` — `max(1, floor(withoutBytes / 4))` (bar scale). */
  withoutTokens: number;
  /** Tokens for `withBytes` — floored the same way; 0 when nothing was re-served (#950). */
  withTokens: number;
  /** Percent kept out of context, 0–100. 100 (honest) when nothing was re-served. */
  pct: number;
  /** Duration multiple `round(withoutTokens / withTokens)`. 0 when nothing was re-served (#950 amendment). */
  mult: number;
}

/**
 * The strict-compression formula for the per-conversation Section 1
 * Without/With bar (ADR-0004, docs/adr/0004-stats-strict-compression-formula.md):
 *
 *   Without = bytesAvoided + bytesReturned
 *   With    = bytesReturned
 *   pct     = (1 − With / Without) × 100
 *
 * `eventDataBytes` is EXCLUDED from both sides — hook-captured payload bytes
 * are analytics infrastructure, never context-window bytes.
 *
 * Empty state: when neither avoided nor returned bytes have been measured
 * (`avoidedBytes + returnedBytes === 0`) there is no honest ratio to draw —
 * the old formula collapsed to a degenerate ~100% bar on fresh sessions with
 * zero redirects. Returns `null` and the renderer emits a hint line instead.
 *
 * Zero-denominator amendment (#950, 2026-10-04): with `returnedBytes === 0`
 * and `avoidedBytes > 0` the bar still renders — 100% kept out is true — but
 * `withBytes`/`withTokens`/`mult` report 0 rather than figures derived from a
 * fabricated `max(1, …)` 1-byte baseline. A duration multiple divided by a
 * placeholder is an artefact of the guard, not a measurement.
 */
export function compressionRatio(args: { avoidedBytes: number; returnedBytes: number }): CompressionRatio | null {
  const avoided = args?.avoidedBytes ?? 0;
  const returned = args?.returnedBytes ?? 0;
  const withoutBytes = avoided + returned;
  if (withoutBytes === 0) return null; // empty state — no measurable redirect activity yet
  const hasReturned = returned > 0;
  const withBytes = returned;
  const withoutTokens = Math.max(1, Math.floor(withoutBytes / 4));
  const withTokens = hasReturned ? Math.max(1, Math.floor(withBytes / 4)) : 0;
  const pct = (1 - (hasReturned ? withTokens / withoutTokens : 0)) * 100;
  const mult = hasReturned ? Math.max(1, Math.round(withoutTokens / withTokens)) : 0;
  return { withoutBytes, withBytes, withoutTokens, withTokens, pct, mult };
}
