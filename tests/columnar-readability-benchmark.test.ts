/**
 * Deterministic unit tests for the columnar readability benchmark's own
 * logic — the parts that must not depend on a model, a network, or a key.
 *
 * What is covered here:
 *   - the model denylist (the hard GLM/MiniMax-only constraint),
 *   - answer parsing and the three deterministic scorers,
 *   - the gate arithmetic,
 *   - the reference columnar implementation,
 *   - question derivation (the ground truth is computed from the payload).
 *
 * The live comparison itself is not exercised here: it needs a provider key
 * and is run explicitly with `vpx tests/columnar-readability-benchmark.ts
 * --live`.
 */

import { describe, expect, it } from "vite-plus/test";

import {
  DENIED_MODEL_SUBSTRINGS,
  buildPayload,
  buildQuestions,
  buildPrompt,
  evaluateGate,
  parseAnswers,
  referenceColumnar,
  resolveModel,
  scoreAnswer,
  scoreBoolean,
  scoreNumber,
  scoreString,
  validatePayload,
} from "./columnar-readability-benchmark.js";

describe("model policy — GLM and MiniMax only", () => {
  it("accepts the allowed models and their provider-qualified forms", () => {
    expect(resolveModel("glm-4.6").provider).toBe("zai");
    expect(resolveModel("glm-4-air").baseUrl).toBe("https://api.z.ai/api/paas/v4");
    expect(resolveModel("minimax-m3").provider).toBe("minimax");
    expect(resolveModel("minimax/MiniMax-M2.7").id).toBe("MiniMax-M2.7");
    expect(resolveModel("minimax/MiniMax-M2.7").provider).toBe("minimax");
  });

  it("refuses every excluded provider, even when it is passed explicitly", () => {
    const refused = ["claude-opus-4-8", "anthropic/claude-opus-4-8", "kimi-k2", "moonshot-v1-8k", "mistral-large-latest"];
    for (const model of refused) {
      expect(() => resolveModel(model)).toThrow(/refusing to run/i);
    }
  });

  it("covers the excluded families in the denylist itself", () => {
    for (const needle of ["claude", "anthropic", "kimi", "moonshot", "mistral"]) {
      expect(DENIED_MODEL_SUBSTRINGS).toContain(needle);
    }
  });

  it("refuses a denied base URL even when the model itself looks fine", () => {
    expect(() => resolveModel("glm-4.6", "https://api.anthropic.com/v1")).toThrow(/refusing to run/i);
    expect(() => resolveModel("glm-4.6", "https://api.moonshot.ai/v1")).toThrow(/refusing to run/i);
  });

  it("does not refuse an allowed model that merely resembles a denied one", () => {
    expect(resolveModel("glm-4.6").wireId).toBe("glm-4.6");
  });

  it("rejects an empty spec and an unknown provider", () => {
    expect(() => resolveModel("  ")).toThrow(/no model given/i);
    expect(() => resolveModel("somevendor/whatever")).toThrow(/unknown provider/i);
  });
});

describe("answer parsing", () => {
  it("reads one answer per line", () => {
    const answers = parseAnswers("Q01: 200\nQ02: open\nQ03: yes");
    expect(answers.get("Q01")).toBe("200");
    expect(answers.get("Q02")).toBe("open");
    expect(answers.get("Q03")).toBe("yes");
  });

  it("reads several answers that share a line", () => {
    const answers = parseAnswers("Q01: 200 Q02: open Q03: yes");
    expect(answers.get("Q01")).toBe("200");
    expect(answers.get("Q02")).toBe("open");
    expect(answers.get("Q03")).toBe("yes");
  });

  it("leaves an unanswered question absent rather than inventing a value", () => {
    const answers = parseAnswers("Q01: 200\nQ03: yes");
    expect(answers.has("Q02")).toBe(false);
  });

  it("tolerates markdown decoration around the marker", () => {
    const answers = parseAnswers("**Q01:** 200\n- Q02: open");
    expect(answers.get("Q01")).toBe("200");
    expect(answers.get("Q02")).toBe("open");
  });
});

describe("scoring — deterministic, no model in the path", () => {
  it("scores a numeric answer by its first number", () => {
    expect(scoreNumber("200", "200")).toBe(true);
    expect(scoreNumber("There are 200 records", "200")).toBe(true);
    expect(scoreNumber("1,234", "1234")).toBe(true);
    expect(scoreNumber("200 records", "201")).toBe(false);
    expect(scoreNumber("no number here", "200")).toBe(false);
  });

  it("does not let a stray later number satisfy the question", () => {
    expect(scoreNumber("200 of 201 records", "201")).toBe(false);
  });

  it("scores a string answer on normalized equality or a trailing match", () => {
    expect(scoreString("Fix useEffect under StrictMode", "Fix useEffect under StrictMode")).toBe(true);
    expect(scoreString('"Fix useEffect under StrictMode"', "Fix useEffect under StrictMode")).toBe(true);
    expect(scoreString("the title is Fix useEffect under StrictMode", "Fix useEffect under StrictMode")).toBe(true);
    expect(scoreString("Fix useMemo under StrictMode", "Fix useEffect under StrictMode")).toBe(false);
    expect(scoreString("Fix useEffect under StrictMode plus more", "Fix useEffect under StrictMode")).toBe(false);
  });

  it("scores a boolean answer by the first yes/no word", () => {
    expect(scoreBoolean("yes", "yes")).toBe(true);
    expect(scoreBoolean("Yes, 3 of them", "yes")).toBe(true);
    expect(scoreBoolean("no", "no")).toBe(true);
    expect(scoreBoolean("No rows match", "no")).toBe(true);
    expect(scoreBoolean("yes", "no")).toBe(false);
    expect(scoreBoolean("unclear", "yes")).toBe(false);
  });

  it("scores a missing answer as wrong", () => {
    const question = { id: "Q01", kind: "number" as const, prompt: "How many?", expected: "200" };
    expect(scoreAnswer(question, undefined)).toBe(false);
  });
});

describe("the gate", () => {
  it("passes when both arms are equally accurate", () => {
    const verdict = evaluateGate([true, true, false], [true, true, false], 10);
    expect(verdict.dropPp).toBe(0);
    expect(verdict.passed).toBe(true);
  });

  it("passes when the compacted arm is better", () => {
    const verdict = evaluateGate([true, false], [true, true], 10);
    expect(verdict.dropPp).toBe(-50);
    expect(verdict.passed).toBe(true);
  });

  it("fails when the compacted arm drops more than the threshold", () => {
    const verdict = evaluateGate([true, true, true, true], [true, true, false, false], 10);
    expect(verdict.dropPp).toBe(50);
    expect(verdict.passed).toBe(false);
  });

  it("tolerates a drop exactly at the threshold but not beyond it", () => {
    expect(evaluateGate([true, true], [true, false], 50).passed).toBe(true);
    expect(evaluateGate([true, true], [true, false], 49).passed).toBe(false);
  });

  it("fails on any drop under the strict zero threshold", () => {
    expect(evaluateGate([true, true], [true, false], 0).passed).toBe(false);
  });
});

describe("reference columnar implementation", () => {
  it("keeps numbers and strings distinguishable", () => {
    // A column's type code is the union of the types that column holds across
    // every row, so a column that is a number in one row and a string in another
    // reads as "ns" — and the cell values themselves stay typed.
    const packed = JSON.parse(
      referenceColumnar([
        { a: 1, b: "x" },
        { a: "1", b: "y" },
      ]),
    ) as {
      _c: [string, string][];
      _r: unknown[][];
    };
    expect(packed._c).toEqual([
      ["a", "ns"],
      ["b", "s"],
    ]);
    expect(packed._r).toEqual([
      [1, "x"],
      ["1", "y"],
    ]);
  });

  it("reports a null column as null-typed", () => {
    const packed = JSON.parse(referenceColumnar([{ a: null }])) as { _c: [string, string][] };
    expect(packed._c).toEqual([["a", "z"]]);
  });

  it("is lossless for a uniform row shape", () => {
    const rows = [
      { a: 1, b: "x" },
      { a: 2, b: "y" },
    ];
    const packed = JSON.parse(referenceColumnar(rows)) as { _r: unknown[][] };
    expect(packed._r).toEqual([
      [1, "x"],
      [2, "y"],
    ]);
  });

  it("refuses a payload whose rows do not share one shape", () => {
    expect(() => referenceColumnar([{ a: 1 }, { a: 2, b: 3 }])).toThrow(/uniform row shape/i);
  });
});

describe("payload validation", () => {
  it("accepts a well-formed payload", () => {
    const rows = validatePayload([{ ...buildPayload(1, 5)[0]! }]);
    expect(rows).toHaveLength(1);
  });

  it("refuses a payload missing a field the questions need", () => {
    const row = { ...buildPayload(1, 5)[0]! } as Record<string, unknown>;
    delete row.labels;
    expect(() => validatePayload([row])).toThrow(/missing "labels"/);
  });

  it("refuses a payload whose field has the wrong type", () => {
    const row = { ...buildPayload(1, 5)[0]!, comments: "many" } as unknown;
    expect(() => validatePayload([row])).toThrow(/bad "comments"/);
  });

  it("refuses a payload whose rows are not objects", () => {
    expect(() => validatePayload(["nope"])).toThrow(/not an object/);
  });
});

describe("question derivation", () => {
  it("derives every answer from the payload it was given", () => {
    const rows = buildPayload(40, 1337);
    const questions = buildQuestions(rows);
    expect(questions.length).toBeGreaterThan(0);

    const byId = new Map(questions.map((q) => [q.id, q]));
    expect(byId.get("Q01")?.expected).toBe(String(rows.length));

    const open = rows.filter((r) => r.state === "open").length;
    expect(byId.get("Q02")?.expected).toBe(String(open));

    const bug = rows.filter((r) => r.labels.includes("bug")).length;
    expect(byId.get("Q03")?.expected).toBe(String(bug));
  });

  it("asks every question about the same payload, in a stable order", () => {
    const rows = buildPayload(25, 7);
    const first = buildQuestions(rows).map((q) => q.id);
    const second = buildQuestions(rows).map((q) => q.id);
    expect(first).toEqual(second);
    expect(first[0]).toBe("Q01");
  });

  it("is deterministic for a fixed seed", () => {
    expect(buildPayload(10, 42)).toEqual(buildPayload(10, 42));
    expect(buildPayload(10, 42)).not.toEqual(buildPayload(10, 43));
  });
});

describe("prompt construction", () => {
  it("uses one template for both renderings and only swaps the data block", () => {
    const questions = buildQuestions(buildPayload(10, 3));
    const original = buildPrompt("ORIGINAL-DATA", questions);
    const compacted = buildPrompt("COMPACTED-DATA", questions);

    expect(original.replace("ORIGINAL-DATA", "X")).toBe(compacted.replace("COMPACTED-DATA", "X"));
    expect(original).toContain("ORIGINAL-DATA");
    expect(compacted).toContain("COMPACTED-DATA");
  });

  it("explains both encodings so neither arm has to guess the format", () => {
    const prompt = buildPrompt("[]", buildQuestions(buildPayload(5, 1)));
    expect(prompt).toContain('"_c"');
    expect(prompt).toContain('"_r"');
  });

  it("lists every question id it asks about", () => {
    const questions = buildQuestions(buildPayload(10, 3));
    const prompt = buildPrompt("[]", questions);
    for (const question of questions) {
      expect(prompt).toContain(`${question.id}. ${question.prompt}`);
    }
  });
});
