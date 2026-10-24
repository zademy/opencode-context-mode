/**
 * compressionRatio() — NUMERIC contract of the ADR-0004 strict-compression
 * formula (docs/adr/0004-stats-strict-compression-formula.md).
 *
 * Pure function extracted from renderNarrative5Section so the Section 1
 * Without/With bar semantics are pin-testable without rendering. These
 * assertions mirror the ADR's own worked example (95.4% / 22× on the
 * reporter's machine) and both amendments: the empty-state branch (the old
 * degenerate-100% bug on fresh sessions) and the #950 zero-denominator
 * artefacts (no fabricated 1-byte baseline, no 498528× multiple).
 */

import { describe, expect, test } from "vite-plus/test";
import { compressionRatio, pricePerToken } from "../../src/session/analytics-metrics.js";

describe("compressionRatio — ADR-0004 strict compression", () => {
  test("normal case: ADR reporter's machine → 95.4% kept out, 22× multiplier", () => {
    const r = compressionRatio({ avoidedBytes: 2898 * 1024, returnedBytes: 140 * 1024 });
    expect(r).not.toBeNull();
    // Without = 2,898 KB avoided + 140 KB returned = 3,038 KB (ADR table row).
    expect(r!.withoutBytes).toBe(3_110_912);
    expect(r!.withBytes).toBe(143_360);
    expect(r!.withoutTokens).toBe(777_728);
    expect(r!.withTokens).toBe(35_840);
    // ADR headline: 95.4% kept out, 22× runway.
    expect(r!.pct).toBeCloseTo(95.39170506912443, 10);
    expect(r!.mult).toBe(22);
  });

  test("empty state: zero avoided + zero returned → null (old degenerate-100% bug)", () => {
    // v1.0.134's formula collapsed a fresh session (nothing diverted, nothing
    // re-served) to a ~100% bar. ADR-0004 replaces that with the empty state.
    expect(compressionRatio({ avoidedBytes: 0, returnedBytes: 0 })).toBeNull();
  });

  test("zero denominator (#950): only avoided bytes → honest 100%, no fabricated baseline", () => {
    const r = compressionRatio({ avoidedBytes: 1_994_112, returnedBytes: 0 });
    expect(r).not.toBeNull();
    expect(r!.withoutBytes).toBe(1_994_112);
    expect(r!.withoutTokens).toBe(498_528);
    // With open-context-mode: the measured 0 — NOT max(1, 0) = 1 B (#950 amendment).
    expect(r!.withBytes).toBe(0);
    expect(r!.withTokens).toBe(0);
    expect(r!.pct).toBe(100);
    // No duration multiple from a placeholder denominator — the old
    // Math.max(1, …) floor printed 498528× here; no measurement produced it.
    expect(r!.mult).toBe(0);
  });

  test("sub-token byte counts floor to 1 token on each side, 0% when identical", () => {
    const r = compressionRatio({ avoidedBytes: 0, returnedBytes: 2 });
    expect(r).not.toBeNull();
    expect(r!.withoutBytes).toBe(2);
    expect(r!.withoutTokens).toBe(1); // Math.max(1, floor(2/4))
    expect(r!.withTokens).toBe(1);
    expect(r!.pct).toBe(0);
    expect(r!.mult).toBe(1);
  });

  test("mixed small case: 25% kept out, multiplier floors at 1", () => {
    const r = compressionRatio({ avoidedBytes: 100, returnedBytes: 300 });
    expect(r).not.toBeNull();
    expect(r!.withoutTokens).toBe(100);
    expect(r!.withTokens).toBe(75);
    expect(r!.pct).toBeCloseTo(25, 10);
    expect(r!.mult).toBe(1); // round(100/75) = 1
  });
});

describe("pricePerToken — per-model routing through pricing.ts", () => {
  test("modelId resolves through the curated catalog (gpt-4o input $2.5/1M)", () => {
    const saved = process.env.PI_OPEN_CONTEXT_MODE_PRICE_OUTPUT_PER_TOKEN;
    delete process.env.PI_OPEN_CONTEXT_MODE_PRICE_OUTPUT_PER_TOKEN;
    try {
      expect(pricePerToken("gpt-4o")).toBeCloseTo(2.5 / 1_000_000, 15);
    } finally {
      if (saved !== undefined) process.env.PI_OPEN_CONTEXT_MODE_PRICE_OUTPUT_PER_TOKEN = saved;
    }
  });

  test("unknown modelId and no-arg calls keep the flat Opus fallback ($5/1M)", () => {
    const saved = process.env.PI_OPEN_CONTEXT_MODE_PRICE_OUTPUT_PER_TOKEN;
    delete process.env.PI_OPEN_CONTEXT_MODE_PRICE_OUTPUT_PER_TOKEN;
    try {
      expect(pricePerToken()).toBeCloseTo(5 / 1_000_000, 15);
      expect(pricePerToken("no-such-model-id")).toBeCloseTo(5 / 1_000_000, 15);
    } finally {
      if (saved !== undefined) process.env.PI_OPEN_CONTEXT_MODE_PRICE_OUTPUT_PER_TOKEN = saved;
    }
  });
});
