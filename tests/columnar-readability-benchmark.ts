/**
 * Columnar readability benchmark — does the typed columnar form read as
 * accurately as the original JSON?
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * SPEC-json-token-savings.md, point 3: "A GLM or MiniMax model reads the
 * compacted form and answers a question about it as accurately as it answers
 * the same question about the original." That sentence is the gate on the
 * whole inbound-compaction feature, and this file is the experiment behind it.
 *
 * WHAT IT DOES
 * ------------
 * 1. Builds a deterministic GitHub-issue-like payload (byte-identical every run).
 * 2. Renders it twice: the original JSON, and the typed columnar form
 *    {"_c":[[name,type],...],"_r":[[cell,...],...]}.
 * 3. Asks the SAME questions about each rendering with the SAME prompt
 *    template, and parses the model's answers.
 * 4. Scores every answer in code — no model anywhere in the scoring path.
 * 5. Reports accuracy and byte/token cost for both arms side by side, and
 *    exits non-zero when the compacted arm is materially less accurate.
 *
 * MODEL RESTRICTION (hard)
 * -------------------------
 * GLM and MiniMax only. Claude, Kimi/Moonshot and Mistral are refused by a
 * hardcoded denylist of provider/model substrings, even when the caller
 * passes them explicitly: routing goes through those providers, so a number
 * measured on them does not describe the models this plugin actually serves.
 * A denied model is an error — there is no fallback model, ever.
 *
 * NETWORK IS OPT-IN
 * -----------------
 * No network call happens unless --live (or
 * OPEN_CONTEXT_MODE_COLUMNAR_BENCH_LIVE=1) is given, and this file is not
 * collected by the default test suite (vitest collects tests/**\/*.test.ts).
 * Without --live the harness prints the plan it would run and exits 3.
 *
 * CREDENTIALS
 * -----------
 * From the environment:
 *   OPEN_CONTEXT_MODE_COLUMNAR_BENCH_API_KEY     provider API key
 *   OPEN_CONTEXT_MODE_COLUMNAR_BENCH_BASE_URL    OpenAI-compatible base URL
 *   OPEN_CONTEXT_MODE_COLUMNAR_BENCH_MODEL       model id (provider/model or bare)
 *   OPEN_CONTEXT_MODE_COLUMNAR_BENCH_MAX_DROP_PP gate threshold, in percentage points
 *   OPEN_CONTEXT_MODE_COLUMNAR_BENCH_LIVE        "1" enables the live run
 * Or from a JSON file passed with --config:
 *   {"apiKey":"...","baseUrl":"...","model":"...","maxDropPp":10}
 * Flags beat environment beats config file. There is deliberately no
 * --api-key flag: a key on the command line lands in shell history and in
 * every process listing on the machine.
 *
 * EXIT CODES
 * ----------
 *   0  gate PASSED — the compacted arm read as accurately as the original
 *   1  gate FAILED — the compacted arm was materially less accurate
 *   2  could not evaluate — bad arguments, denied model, missing credentials,
 *      or a provider/network error (nothing was scored)
 *   3  plan only — --live was not given, so nothing was called or scored
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Model policy ──────────────────────────────────────────

/**
 * Provider/model substrings that must never reach a provider call.
 *
 * The constraint is GLM and MiniMax only. These substrings cover the three
 * excluded families (Claude/Anthropic, Kimi/Moonshot, Mistral) and their
 * common model spellings. They are matched case-insensitively against the
 * whole model spec — provider and id together — AND against the base URL, so
 * neither `--model anthropic/claude-opus-4-8` nor
 * `--base-url https://api.anthropic.com` slips through a gate that is
 * supposed to describe this plugin's real traffic.
 */
export const DENIED_MODEL_SUBSTRINGS: readonly string[] = [
  "claude",
  "anthropic",
  "kimi",
  "moonshot",
  "mistral",
  "mixtral",
  "codestral",
  "magistral",
  "ministral",
  "devstral",
  "pixtral",
];

/** Default OpenAI-compatible base URL per provider segment. */
const PROVIDER_BASE_URLS: Record<string, string> = {
  zai: "https://api.z.ai/api/paas/v4",
  "z-ai": "https://api.z.ai/api/paas/v4",
  zhipu: "https://open.bigmodel.cn/api/paas/v4",
  minimax: "https://api.minimax.io/v1",
};

/** Provider inferred from a bare model id when the spec carries no prefix. */
const PROVIDER_BY_FAMILY: { prefix: string; provider: string }[] = [
  { prefix: "glm-", provider: "zai" },
  { prefix: "minimax-", provider: "minimax" },
];

export interface ResolvedModel {
  /** Provider segment, "" when the spec carried no prefix. */
  provider: string;
  /** Bare model id, prefix stripped. */
  id: string;
  /** The id sent on the wire. */
  wireId: string;
  /** OpenAI-compatible base URL. */
  baseUrl: string;
}

/**
 * Resolve a model spec, refusing anything on the denylist.
 *
 * A spec is `id` or `provider/id`, matching the repo's `provider/model`
 * convention (see src/session/pricing.ts, which strips one leading segment).
 *
 * Throws when the spec or the base URL names an excluded provider. It never
 * substitutes a different model: a denied request is an error, because
 * silently answering the question with a different model would make the
 * benchmark meaningless.
 */
export function resolveModel(spec: string, baseUrlOverride?: string): ResolvedModel {
  const raw = spec.trim();
  if (raw === "") throw new Error("no model given");

  const slash = raw.indexOf("/");
  const provider = slash > 0 ? raw.slice(0, slash).toLowerCase() : "";
  const id = slash > 0 ? raw.slice(slash + 1) : raw;

  let resolvedProvider = provider;
  if (resolvedProvider === "") {
    const lower = id.toLowerCase();
    const family = PROVIDER_BY_FAMILY.find((f) => lower.startsWith(f.prefix));
    if (family) resolvedProvider = family.provider;
  }

  const baseUrl = baseUrlOverride ?? (resolvedProvider ? PROVIDER_BASE_URLS[resolvedProvider] : undefined) ?? "";

  const haystack = `${raw}/${baseUrl}`.toLowerCase();
  for (const denied of DENIED_MODEL_SUBSTRINGS) {
    if (haystack.includes(denied)) {
      throw new Error(
        `refusing to run: "${raw}" names the excluded provider "${denied}". ` +
          "This benchmark measures GLM and MiniMax only (see ADR-0007 decision 3); " +
          "no fallback model is substituted.",
      );
    }
  }

  if (baseUrl === "") {
    throw new Error(
      `unknown provider "${resolvedProvider}" for model "${raw}". ` +
        "Use provider/model, or pass --base-url with an OpenAI-compatible endpoint.",
    );
  }

  return { provider: resolvedProvider, id, wireId: id, baseUrl };
}

// ── Payload ───────────────────────────────────────────────

/** One GitHub-issue-like row. Every field is a primitive or an array. */
export interface IssueRow {
  number: number;
  title: string;
  state: "open" | "closed";
  user: string;
  labels: string[];
  comments: number;
  createdAt: string;
  closedAt: string | null;
  milestone: number | null;
}

const TITLE_VERBS = ["Fix", "Investigate", "Regression in", "Support", "Optimize", "Document", "Remove", "Migrate"];
const TITLE_NOUNS = [
  "useEffect",
  "useMemo",
  "hydration",
  "Suspense",
  "the reconciler",
  "the scheduler",
  "context propagation",
  "key reconciliation",
];
const TITLE_CONDITIONS = [
  "under StrictMode",
  "on rapid re-render",
  "when the tab is backgrounded",
  "with nested providers",
  "during concurrent rendering",
  "after a fast refresh",
  "in production builds",
  "on the first paint",
];
const USER_POOL = [
  "ada",
  "grace",
  "linus",
  "barbara",
  "ken",
  "dennis",
  "margaret",
  "radia",
  "alan",
  "edsger",
  "donald",
  "hedy",
  "claude-shannon",
  "tim",
  "john",
  "vint",
  "bjarne",
  "james",
  "yukihiro",
  "matthias",
  "rich",
  "guido",
  "rasmus",
  "brendan",
  "joe",
  "philip",
  "mike",
  "sophie",
  "anita",
  "carol",
  "erik",
];
const LABEL_POOL = ["bug", "docs", "enhancement", "performance", "wontfix", "good first issue", "help wanted", "question"];

/** Deterministic PRNG (mulberry32) — the payload must not vary between runs. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Build the benchmark payload.
 *
 * The shape is a GitHub issue list: a numeric id, a title, a state, an author
 * login, labels, a comment count, two timestamps and a nullable milestone.
 * Two columns are deliberately mixed-typed (`closedAt` is string-or-null,
 * `milestone` is number-or-null) so the typed column header has something to
 * disambiguate — that is the property the benchmark is actually testing.
 */
export function buildPayload(rows: number, seed: number): IssueRow[] {
  const random = mulberry32(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const out: IssueRow[] = [];

  for (let i = 0; i < rows; i++) {
    // Base-8 digits keep every title unique for the first 512 rows.
    const title = `${TITLE_VERBS[i % 8]} ${TITLE_NOUNS[Math.floor(i / 8) % 8]} ${TITLE_CONDITIONS[Math.floor(i / 64) % 8]}`;
    const state: "open" | "closed" = random() < 0.68 ? "open" : "closed";
    const labelCount = Math.floor(random() * 3.4);
    const labels: string[] = [];
    for (let l = 0; l < labelCount; l++) {
      const label = pick(LABEL_POOL);
      if (!labels.includes(label)) labels.push(label);
    }
    const created = Date.UTC(2026, 1, 1) - i * 3_600_000 * 5;
    out.push({
      number: 41200 - i * 7 + (i % 5),
      title,
      state,
      user: pick(USER_POOL),
      labels,
      comments: Math.floor(random() * 61),
      createdAt: new Date(created).toISOString(),
      closedAt: state === "closed" ? new Date(created + 86_400_000 * (1 + Math.floor(random() * 9))).toISOString() : null,
      milestone: random() < 0.72 ? Math.floor(random() * 12) + 1 : null,
    });
  }

  return out;
}

// ── Reference columnar implementation ─────────────────────

/** Type codes, in the order the production module concatenates them. */
const REFERENCE_TYPE_ORDER = ["n", "s", "b", "z", "o", "a"] as const;

function referenceTypeOf(value: unknown): string {
  if (value === null) return "z";
  if (Array.isArray(value)) return "a";
  switch (typeof value) {
    case "boolean":
      return "b";
    case "number":
      return "n";
    case "string":
      return "s";
    case "object":
      return "o";
    default:
      return "z";
  }
}

/**
 * REFERENCE IMPLEMENTATION of the typed columnar wire format.
 *
 * The benchmark prefers the production module
 * (src/platforms/opencode/json-columnar.ts) and only falls back to this
 * function when that module cannot be imported at run time — it is a
 * stand-in, never a second source of truth, and must not be copied into
 * src/. The wire format is the one ADR-0007 describes:
 *
 *   {"_c":[[name,typeCode],...],"_r":[[cell,...],...]}
 *
 * The header carries the column names with their type codes, so a number
 * never becomes a string on the way through. This fallback assumes a uniform
 * row shape (every row carries every column) and throws otherwise.
 */
export function referenceColumnar(rows: Record<string, unknown>[]): string {
  const names: string[] = [];
  const index = new Map<string, number>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!index.has(key)) {
        index.set(key, names.length);
        names.push(key);
      }
    }
  }

  const width = names.length;
  if (width === 0) throw new Error("reference columnar: no columns");

  const cells: unknown[][] = [];
  const types = new Map<number, Set<string>>();
  for (const row of rows) {
    const keys = Object.keys(row);
    if (keys.length !== width) {
      throw new Error("reference columnar: the local fallback requires a uniform row shape");
    }
    const line: unknown[] = [];
    for (let c = 0; c < width; c++) {
      const name = names[c]!;
      if (!(name in row)) throw new Error("reference columnar: the local fallback requires a uniform row shape");
      const value = row[name];
      line.push(value);
      let seen = types.get(c);
      if (!seen) {
        seen = new Set<string>();
        types.set(c, seen);
      }
      seen.add(referenceTypeOf(value));
    }
    cells.push(line);
  }

  const columns = names.map((name, c) => {
    const seen = types.get(c)!;
    const code = REFERENCE_TYPE_ORDER.filter((t) => seen.has(t)).join("");
    return [name, code] as [string, string];
  });

  return JSON.stringify({ _c: columns, _r: cells });
}

// ── Compactor resolution ──────────────────────────────────

export interface Compactor {
  /** Where the compaction came from, for the report. */
  label: string;
  /** Compact the rows into the typed columnar wire format. */
  pack: (rows: Record<string, unknown>[]) => string;
  /** Optional inverse, used to prove the compaction is lossless. */
  expand?: (text: string) => Record<string, unknown>[] | null;
}

/**
 * Prefer the production columnar module; fall back to the local reference
 * implementation when it cannot be imported.
 *
 * The specifier is a variable on purpose: a literal import of a module that
 * does not exist is a build-time error, whereas a runtime import of a
 * missing module is a catchable failure. That difference is what lets the
 * benchmark survive the production module being renamed or temporarily absent.
 */
export async function resolveCompactor(): Promise<Compactor> {
  const specifier = "../src/platforms/opencode/json-columnar.js";
  try {
    const mod = (await import(/* @vite-ignore */ specifier)) as {
      packColumnar?: (rows: Record<string, unknown>[]) => unknown;
      expandColumnar?: (text: string) => Record<string, unknown>[] | null;
    };
    if (typeof mod.packColumnar === "function") {
      return {
        label: "production (src/platforms/opencode/json-columnar.ts)",
        pack: (rows) => JSON.stringify(mod.packColumnar!(rows)),
        expand: typeof mod.expandColumnar === "function" ? (text) => mod.expandColumnar!(text) : undefined,
      };
    }
  } catch {
    // fall through to the reference implementation
  }
  return {
    label: "local reference implementation (production module unavailable)",
    pack: (rows) => referenceColumnar(rows),
  };
}

// ── Questions ─────────────────────────────────────────────

export type AnswerKind = "number" | "string" | "boolean";

export interface Question {
  /** Stable id, also the label the model must echo. */
  id: string;
  kind: AnswerKind;
  prompt: string;
  /** Canonical expected answer, as a string. */
  expected: string;
}

function countBy(rows: IssueRow[], predicate: (row: IssueRow) => boolean): number {
  let total = 0;
  for (const row of rows) if (predicate(row)) total++;
  return total;
}

/**
 * Check that a payload read from a file has the shape the questions need.
 *
 * The questions are derived from the rows, so a payload that does not
 * carry the fields would produce vacuous answers. Refusing it here beats
 * asking the model a question whose expected answer is meaningless.
 */
export function validatePayload(rows: unknown[]): IssueRow[] {
  const required: [string, (value: unknown) => boolean][] = [
    ["number", (v) => typeof v === "number"],
    ["title", (v) => typeof v === "string"],
    ["state", (v) => typeof v === "string"],
    ["user", (v) => typeof v === "string"],
    ["labels", (v) => Array.isArray(v) && v.every((l) => typeof l === "string")],
    ["comments", (v) => typeof v === "number"],
    ["createdAt", (v) => typeof v === "string"],
    ["closedAt", (v) => typeof v === "string" || v === null],
    ["milestone", (v) => typeof v === "number" || v === null],
  ];

  const typed = rows.map((row, index) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error(`payload row ${index + 1} is not an object`);
    }
    const record = row as Record<string, unknown>;
    for (const [field, check] of required) {
      const shape = required.map(([field]) => `"${field}"`).join(", ");
      if (!(field in record)) {
        throw new Error(`payload row ${index + 1} is missing "${field}" (required fields: ${shape})`);
      }
      if (!check(record[field])) throw new Error(`payload row ${index + 1} has a bad "${field}" (required fields: ${shape})`);
    }
    return record as unknown as IssueRow;
  });

  return typed;
}

/**
 * Derive the question set from the payload.
 *
 * Every expected answer is computed from the same rows the model is asked
 * about, so the ground truth cannot drift from the data. A question whose
 * premise is absent from the payload (no "bug" label, say) is dropped rather
 * than asked with a vacuous answer.
 */
export function buildQuestions(rows: IssueRow[]): Question[] {
  const questions: Question[] = [];
  const add = (kind: AnswerKind, prompt: string, expected: string): void => {
    questions.push({ id: `Q${String(questions.length + 1).padStart(2, "0")}`, kind, prompt, expected });
  };

  add("number", "How many issue records are in this dataset?", String(rows.length));

  add("number", 'How many records have state exactly "open"?', String(countBy(rows, (r) => r.state === "open")));

  const hasBugLabel = rows.some((r) => r.labels.includes("bug"));
  if (hasBugLabel) {
    add("number", 'How many records carry the label "bug"?', String(countBy(rows, (r) => r.labels.includes("bug"))));
  }

  add("number", "How many records have a closedAt value that is not null?", String(countBy(rows, (r) => r.closedAt !== null)));

  add("number", "How many records have more than 10 comments?", String(countBy(rows, (r) => r.comments > 10)));

  let maxNumber = Number.NEGATIVE_INFINITY;
  for (const row of rows) if (row.number > maxNumber) maxNumber = row.number;
  add("number", "What is the highest issue number in the dataset?", String(maxNumber));

  add("number", "How many distinct user values appear across all records?", String(new Set(rows.map((r) => r.user)).size));

  const allLabels = new Set<string>();
  for (const row of rows) for (const label of row.labels) allLabels.add(label);
  add("number", "How many distinct label values appear across all records?", String(allLabels.size));

  const maxNumberRow = rows.find((r) => r.number === maxNumber);
  if (maxNumberRow) {
    add("string", "What is the title of the record with the highest issue number?", maxNumberRow.title);
  }

  let topComments = rows[0];
  for (const row of rows) if (row.comments > (topComments?.comments ?? -1)) topComments = row;
  if (topComments) {
    add("string", "What is the user value of the record with the most comments?", topComments.user);
  }

  const sortedNumbers = rows.map((r) => r.number).sort((a, b) => a - b);
  const medianNumber = sortedNumbers[Math.floor(sortedNumbers.length / 2)];
  const medianRow = rows.find((r) => r.number === medianNumber);
  if (medianRow) {
    add("string", `What is the user value of the record whose issue number is ${medianNumber}?`, medianRow.user);
  }

  if (allLabels.has("wontfix")) {
    add("boolean", 'Does any record carry the label "wontfix"? Answer yes or no.', "yes");
  }

  return questions;
}

// ── Prompt ────────────────────────────────────────────────

const PROMPT_LEAD = [
  "You are given a dataset of issue records and a list of questions about it.",
  "",
  "The dataset is JSON. It is given in one of two encodings:",
  "  - a plain JSON array of objects, one object per record; or",
  '  - a typed columnar form: {"_c":[[name,type],...],"_r":[[cell,...],...]}',
  '    where "_c" lists the column names in order with their type codes',
  '    ("n" number, "s" string, "b" boolean, "z" null, "o" object, "a" array;',
  '    several codes mean the column holds more than one type), and "_r" lists one',
  "    array of cell values per record, in that same column order.",
  "Read whichever encoding you were given.",
].join("\n");

const PROMPT_TAIL = [
  "Answer every question. Write one line per question, in order, formatted as",
  '"<question id>: <answer>". The answer must be the bare value only — a number,',
  "a string, or yes/no — with no units, no explanation and no surrounding sentences.",
].join("\n");

/**
 * Build the prompt for one rendering.
 *
 * The template is byte-identical for both arms: the same lead, the same
 * questions, the same tail. Only the rendering block changes, so the two
 * arms differ in the data and nothing else. The lead explains both possible
 * encodings to both arms, so neither arm is asked to guess a private format.
 */
export function buildPrompt(rendering: string, questions: Question[]): string {
  return [PROMPT_LEAD, "", "DATA:", rendering, "", "QUESTIONS:", ...questions.map((q) => `${q.id}. ${q.prompt}`), "", PROMPT_TAIL].join(
    "\n",
  );
}

// ── Answer parsing and scoring ────────────────────────────

/**
 * Parse "Q01: <value>" lines out of a model reply.
 *
 * Values are taken up to the next question marker or the end of the line, so
 * a reply that puts several answers on one line still parses. A question the
 * model did not answer is simply absent from the map and scores as wrong.
 */
export function parseAnswers(text: string): Map<string, string> {
  const answers = new Map<string, string>();
  const marker = /Q(\d{2})\s*[:\-]\s*/g;
  const found: { id: string; valueStart: number; markerStart: number }[] = [];
  let match = marker.exec(text);
  while (match !== null) {
    found.push({ id: `Q${match[1]}`, valueStart: match.index + match[0].length, markerStart: match.index });
    match = marker.exec(text);
  }
  for (let i = 0; i < found.length; i++) {
    const current = found[i]!;
    const limit = i + 1 < found.length ? found[i + 1]!.markerStart : text.length;
    const segment = text.slice(current.valueStart, limit).split("\n")[0] ?? "";
    // Models often bold the marker ("**Q01:** 42"). Strip the decoration so the
    // parsed value is the value, not the markup around it.
    answers.set(current.id, segment.replace(/^[*_`\s]+/, "").replace(/[*_`\s]+$/, ""));
  }
  return answers;
}

/** Lowercase, drop markdown emphasis and quotes, collapse whitespace. */
export function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[`*_]/g, "")
    .replace(/["'“”‘’]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[.\s]+$/, "")
    .trim();
}

/**
 * Score a numeric answer.
 *
 * The FIRST number in the answer is the answer: a model that says "there are
 * 42 records" is answering 42, and a model that says "42" is answering 42.
 * Comparing the first number rather than any number keeps a stray number
 * elsewhere in the reply from accidentally satisfying the question.
 */
export function scoreNumber(answer: string, expected: string): boolean {
  const expectedValue = Number(expected);
  if (!Number.isFinite(expectedValue)) return false;
  const tokens = normalizeText(answer).match(/-?\d[\d,]*(?:\.\d+)?/g);
  if (!tokens || tokens.length === 0) return false;
  const first = Number(tokens[0]!.replace(/,/g, ""));
  return Number.isFinite(first) && first === expectedValue;
}

/**
 * Score a string answer.
 *
 * Equal after normalization, or the answer ends with the expected value as
 * its last word run ("the title is bug: x"). Containment anywhere would let
 * a reply that merely mentions the right title somewhere among other text
 * pass; requiring it at the end keeps the answer to the question.
 */
export function scoreString(answer: string, expected: string): boolean {
  const normalizedAnswer = normalizeText(answer);
  const normalizedExpected = normalizeText(expected);
  if (normalizedExpected === "") return false;
  if (normalizedAnswer === normalizedExpected) return true;
  return normalizedAnswer.endsWith(` ${normalizedExpected}`);
}

/**
 * Score a yes/no answer.
 *
 * The first yes/no/true/false word in the answer decides, so "yes, 3 of them"
 * scores yes and "no rows match" scores no.
 */
export function scoreBoolean(answer: string, expected: string): boolean {
  const expectedValue = normalizeText(expected) === "yes";
  const match = /\b(yes|no|true|false)\b/.exec(normalizeText(answer));
  if (!match) return false;
  const token = match[1]!;
  if (token === "yes" || token === "true") return expectedValue;
  return !expectedValue;
}

/** Score one answer against its question. */
export function scoreAnswer(question: Question, answer: string | undefined): boolean {
  if (answer === undefined) return false;
  if (question.kind === "number") return scoreNumber(answer, question.expected);
  if (question.kind === "boolean") return scoreBoolean(answer, question.expected);
  return scoreString(answer, question.expected);
}

// ── Comparison and the gate ───────────────────────────────

export interface ArmResult {
  /** Raw reply per question, in question order. */
  replies: (string | undefined)[];
  /** Correctness per question, in question order. */
  correct: boolean[];
  /** Provider-reported prompt tokens per request, in question order. */
  promptTokens: number[];
}

export interface GateVerdict {
  originalAccuracy: number;
  compactedAccuracy: number;
  /** Accuracy drop in percentage points. Negative means the compacted arm won. */
  dropPp: number;
  thresholdPp: number;
  passed: boolean;
}

/**
 * Decide whether the compacted form read as accurately as the original.
 *
 * "Materially worse" is defined as an accuracy drop of MORE THAN
 * `thresholdPp` percentage points. With 12 questions one question is 8.33
 * points, so the default threshold of 10 tolerates a single flipped answer
 * and fails on two. Pass 0 to hold the strict spec reading — the compacted
 * form must not be worse at all.
 */
export function evaluateGate(original: boolean[], compacted: boolean[], thresholdPp: number): GateVerdict {
  const total = original.length;
  const accuracy = (scores: boolean[]): number => (total === 0 ? 0 : scores.filter(Boolean).length / total);
  const originalAccuracy = accuracy(original);
  const compactedAccuracy = accuracy(compacted);
  const dropPp = (originalAccuracy - compactedAccuracy) * 100;
  return {
    originalAccuracy,
    compactedAccuracy,
    dropPp,
    thresholdPp,
    passed: dropPp <= thresholdPp + 1e-9,
  };
}

// ── Provider call ─────────────────────────────────────────

interface ChatResponse {
  content: string;
  promptTokens: number | null;
}

async function callProvider(baseUrl: string, apiKey: string, wireModel: string, prompt: string, timeoutMs: number): Promise<ChatResponse> {
  const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: wireModel,
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_tokens: 2048,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`provider ${response.status} ${response.statusText}: ${text.slice(0, 300)}`);
  }

  let parsed: {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number };
  };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`provider returned non-JSON: ${text.slice(0, 200)}`);
  }

  const content = parsed.choices?.[0]?.message?.content ?? "";
  const promptTokens = typeof parsed.usage?.prompt_tokens === "number" ? parsed.usage.prompt_tokens : null;
  return { content, promptTokens };
}

// ── CLI ───────────────────────────────────────────────────

interface Options {
  live: boolean;
  /** Undefined until a flag sets it, so the default never masks a flag. */
  model?: string;
  baseUrl?: string;
  configPath?: string;
  /** Undefined until a flag sets it, so the default never masks a flag. */
  maxDropPp?: number;
  rows: number;
  seed: number;
  payloadPath?: string;
  showPrompt: boolean;
  timeoutMs: number;
}

const DEFAULTS = {
  model: "glm-4.6",
  maxDropPp: 10,
  rows: 200,
  seed: 1337,
  timeoutMs: 120_000,
};

interface ConfigFile {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  maxDropPp?: number;
}

function readNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`expected a number, got "${raw}"`);
  return value;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    live: false,
    rows: DEFAULTS.rows,
    seed: DEFAULTS.seed,
    showPrompt: false,
    timeoutMs: DEFAULTS.timeoutMs,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = (): string => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      return value;
    };
    switch (arg) {
      case "--live":
        options.live = true;
        break;
      case "--model":
        options.model = next();
        break;
      case "--base-url":
        options.baseUrl = next();
        break;
      case "--config":
        options.configPath = next();
        break;
      case "--max-drop-pp":
        options.maxDropPp = readNumber(next(), DEFAULTS.maxDropPp);
        break;
      case "--rows":
        options.rows = readNumber(next(), DEFAULTS.rows);
        break;
      case "--seed":
        options.seed = readNumber(next(), DEFAULTS.seed);
        break;
      case "--payload":
        options.payloadPath = next();
        break;
      case "--show-prompt":
        options.showPrompt = true;
        break;
      case "--timeout-ms":
        options.timeoutMs = readNumber(next(), DEFAULTS.timeoutMs);
        break;
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
        break;
      default:
        throw new Error(`unknown argument "${arg}"`);
    }
  }

  return options;
}

function printUsage(): void {
  console.log(
    [
      "Columnar readability benchmark — is the compacted columnar form read as",
      "accurately as the original JSON?",
      "",
      "Usage:",
      "  vpx tests/columnar-readability-benchmark.ts [options]",
      "",
      "Options:",
      "  --live              run the live comparison (default: print the plan only)",
      "  --model <spec>      model id, bare or provider/model (default: glm-4.6)",
      "  --base-url <url>    OpenAI-compatible base URL override",
      "  --config <path>     JSON config file {apiKey, baseUrl, model, maxDropPp}",
      "  --max-drop-pp <n>   accuracy drop (pp) that fails the gate (default: 10)",
      "  --rows <n>          payload rows (default: 200)",
      "  --seed <n>          payload seed (default: 1337)",
      "  --payload <file>    read the payload from a JSON file instead of generating it",
      "  --show-prompt       print both prompts",
      "  --timeout-ms <n>    per-request timeout (default: 120000)",
      "  -h, --help          this message",
      "",
      "Environment:",
      "  OPEN_CONTEXT_MODE_COLUMNAR_BENCH_API_KEY     provider API key",
      "  OPEN_CONTEXT_MODE_COLUMNAR_BENCH_BASE_URL    OpenAI-compatible base URL",
      "  OPEN_CONTEXT_MODE_COLUMNAR_BENCH_MODEL       model id",
      "  OPEN_CONTEXT_MODE_COLUMNAR_BENCH_MAX_DROP_PP gate threshold, percentage points",
      '  OPEN_CONTEXT_MODE_COLUMNAR_BENCH_LIVE        "1" enables the live run',
      "",
      "Models: GLM and MiniMax only. Claude, Kimi/Moonshot and Mistral are refused.",
      "",
      "Exit codes: 0 gate passed, 1 gate failed, 2 could not evaluate, 3 plan only.",
    ].join("\n"),
  );
}

function loadConfigFile(path: string): ConfigFile {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`cannot read config file "${path}": ${(error as Error).message}`);
  }
  try {
    return JSON.parse(raw) as ConfigFile;
  } catch (error) {
    throw new Error(`config file "${path}" is not valid JSON: ${(error as Error).message}`);
  }
}

function envValue(name: string): string | undefined {
  const value = process.env[name];
  return value !== undefined && value.trim() !== "" ? value.trim() : undefined;
}

// ── Reporting ─────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${bytes}B`;
}

function formatPercent(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

function truncate(value: string, max: number): string {
  const single = value.replace(/\s+/g, " ").trim();
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

function printPlan(
  model: ResolvedModel,
  compactor: Compactor,
  questions: Question[],
  originalBytes: number,
  compactedBytes: number,
  minifiedBytes: number,
  thresholdPp: number,
): void {
  console.log("");
  console.log("Columnar readability benchmark — PLAN (no model was called)");
  console.log("=".repeat(78));
  console.log(`model          : ${model.wireId} (${model.provider || "no provider segment"})`);
  console.log(`base url       : ${model.baseUrl}`);
  console.log(`compactor      : ${compactor.label}`);
  console.log(`questions      : ${questions.length}`);
  console.log(`gate           : fail when the accuracy drop exceeds ${thresholdPp} pp`);
  console.log("");
  console.log("byte cost");
  console.log(`  original (pretty)   ${String(originalBytes).padStart(8)}  ${formatBytes(originalBytes)}`);
  console.log(`  original (minified) ${String(minifiedBytes).padStart(8)}  ${formatBytes(minifiedBytes)}`);
  console.log(`  compacted columnar  ${String(compactedBytes).padStart(8)}  ${formatBytes(compactedBytes)}`);
  console.log("");
  console.log("questions");
  for (const question of questions) {
    console.log(`  ${question.id} [${question.kind}] ${question.prompt}`);
    console.log(`       expected: ${truncate(question.expected, 70)}`);
  }
  console.log("");
  console.log("Pass --live to run the comparison (set OPEN_CONTEXT_MODE_COLUMNAR_BENCH_API_KEY first).");
  console.log("");
}

// ── Main ──────────────────────────────────────────────────

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));

  const config = options.configPath ? loadConfigFile(options.configPath) : {};

  const apiKey = envValue("OPEN_CONTEXT_MODE_COLUMNAR_BENCH_API_KEY") ?? config.apiKey;
  const baseUrl = options.baseUrl ?? envValue("OPEN_CONTEXT_MODE_COLUMNAR_BENCH_BASE_URL") ?? config.baseUrl;
  const modelSpec = options.model ?? envValue("OPEN_CONTEXT_MODE_COLUMNAR_BENCH_MODEL") ?? config.model ?? DEFAULTS.model;
  const thresholdPp =
    options.maxDropPp ?? readNumber(envValue("OPEN_CONTEXT_MODE_COLUMNAR_BENCH_MAX_DROP_PP"), config.maxDropPp ?? DEFAULTS.maxDropPp);
  const live = options.live || envValue("OPEN_CONTEXT_MODE_COLUMNAR_BENCH_LIVE") === "1";

  // Refuse an excluded model before anything else happens — no credentials are
  // read and no request is built for a provider this benchmark may not name.
  const model = resolveModel(modelSpec, baseUrl);

  let rows: IssueRow[];
  if (options.payloadPath) {
    let raw: string;
    try {
      raw = readFileSync(options.payloadPath, "utf8");
    } catch (error) {
      throw new Error(`cannot read payload file "${options.payloadPath}": ${(error as Error).message}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`payload file "${options.payloadPath}" is not valid JSON: ${(error as Error).message}`);
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error(`payload file "${options.payloadPath}" must be a non-empty JSON array`);
    }
    rows = validatePayload(parsed);
  } else {
    rows = buildPayload(options.rows, options.seed);
  }

  const questions = buildQuestions(rows);
  if (questions.length === 0) throw new Error("the payload supports none of the benchmark questions");

  const compactor = await resolveCompactor();
  const originalRendering = JSON.stringify(rows, null, 2);
  const compactedRendering = compactor.pack(rows as unknown as Record<string, unknown>[]);

  const originalBytes = Buffer.byteLength(originalRendering, "utf8");
  const minifiedBytes = Buffer.byteLength(JSON.stringify(rows), "utf8");
  const compactedBytes = Buffer.byteLength(compactedRendering, "utf8");

  // Prove the compaction is lossless before measuring anything about it: a
  // lossy compaction would make an accuracy drop meaningless.
  let reversible = false;
  if (compactor.expand) {
    const rebuilt = compactor.expand(compactedRendering);
    reversible = rebuilt !== null && JSON.stringify(rebuilt) === JSON.stringify(rows);
  }

  if (!live) {
    printPlan(model, compactor, questions, originalBytes, compactedBytes, minifiedBytes, thresholdPp);
    if (options.showPrompt) {
      console.log("original prompt:");
      console.log(buildPrompt(originalRendering, questions));
      console.log("");
      console.log("compacted prompt:");
      console.log(buildPrompt(compactedRendering, questions));
      console.log("");
    }
    return 3;
  }

  if (!apiKey) {
    console.error("");
    console.error("No API key found — the live comparison was NOT run and nothing was scored.");
    console.error('Set OPEN_CONTEXT_MODE_COLUMNAR_BENCH_API_KEY, or pass --config <file> with an "apiKey" field.');
    console.error("");
    return 2;
  }

  const arms: { name: string; rendering: string; prompt: string }[] = [
    { name: "original", rendering: originalRendering, prompt: buildPrompt(originalRendering, questions) },
    { name: "compacted", rendering: compactedRendering, prompt: buildPrompt(compactedRendering, questions) },
  ];

  const results = new Map<string, ArmResult>();

  for (const arm of arms) {
    const replies: (string | undefined)[] = [];
    const correct: boolean[] = [];
    const promptTokens: number[] = [];
    for (const question of questions) {
      const response = await callProvider(model.baseUrl, apiKey, model.wireId, arm.prompt, options.timeoutMs);
      const parsed = parseAnswers(response.content);
      const reply = parsed.get(question.id);
      replies.push(reply);
      correct.push(scoreAnswer(question, reply));
      promptTokens.push(response.promptTokens ?? 0);
    }
    results.set(arm.name, { replies, correct, promptTokens });
  }

  const original = results.get("original")!;
  const compacted = results.get("compacted")!;
  const verdict = evaluateGate(original.correct, compacted.correct, thresholdPp);

  console.log("");
  console.log("Columnar readability benchmark");
  console.log("=".repeat(78));
  console.log(`model          : ${model.wireId} (${model.provider || "no provider segment"})`);
  console.log(`base url       : ${model.baseUrl}`);
  console.log(`compactor      : ${compactor.label}`);
  console.log(`round-trip     : ${reversible ? "lossless (rebuild matches the original)" : "NOT verified"}`);
  console.log(`questions      : ${questions.length}`);
  console.log(`gate           : fail when the accuracy drop exceeds ${thresholdPp} pp`);
  console.log("");
  console.log("byte cost");
  console.log(`  original (pretty)   ${String(originalBytes).padStart(8)}  ${formatBytes(originalBytes)}`);
  console.log(`  original (minified) ${String(minifiedBytes).padStart(8)}  ${formatBytes(minifiedBytes)}`);
  console.log(`  compacted columnar  ${String(compactedBytes).padStart(8)}  ${formatBytes(compactedBytes)}`);
  const columnarSaving = minifiedBytes === 0 ? 0 : (1 - compactedBytes / minifiedBytes) * 100;
  const totalSaving = originalBytes === 0 ? 0 : (1 - compactedBytes / originalBytes) * 100;
  console.log(`  saving vs minified original : ${columnarSaving.toFixed(1)}%`);
  console.log(`  saving vs pretty original   : ${totalSaving.toFixed(1)}%`);
  console.log("");
  console.log("token cost (provider-reported prompt tokens per request)");
  const originalTokens = original.promptTokens.reduce((sum, n) => sum + n, 0);
  const compactedTokens = compacted.promptTokens.reduce((sum, n) => sum + n, 0);
  console.log(`  original  : ${originalTokens} total, ${Math.round(originalTokens / Math.max(questions.length, 1))} per request`);
  console.log(`  compacted : ${compactedTokens} total, ${Math.round(compactedTokens / Math.max(questions.length, 1))} per request`);
  console.log("");
  console.log("per-question results");
  console.log(`  ${"id".padEnd(5)}${"expected".padEnd(26)}${"original".padEnd(28)}${"ok".padEnd(5)}compacted`);
  questions.forEach((question, index) => {
    const originalReply = truncate(original.replies[index] ?? "(no answer)", 26);
    const compactedReply = truncate(compacted.replies[index] ?? "(no answer)", 26);
    console.log(
      `  ${question.id.padEnd(5)}${truncate(question.expected, 24).padEnd(26)}${originalReply.padEnd(28)}${(original.correct[index] ? "yes" : "NO").padEnd(5)}${compactedReply}`,
    );
  });
  console.log("");
  console.log("accuracy");
  console.log(`  original  : ${original.correct.filter(Boolean).length}/${questions.length} (${formatPercent(verdict.originalAccuracy)})`);
  console.log(
    `  compacted : ${compacted.correct.filter(Boolean).length}/${questions.length} (${formatPercent(verdict.compactedAccuracy)})`,
  );
  console.log(`  drop      : ${verdict.dropPp.toFixed(1)} pp (threshold ${thresholdPp} pp)`);
  console.log("");
  console.log(
    verdict.passed
      ? "GATE: PASS — the compacted form reads as accurately as the original"
      : "GATE: FAIL — the compacted form reads materially worse than the original",
  );
  console.log("");

  return verdict.passed ? 0 : 1;
}

/**
 * True when this file is the process entry point.
 *
 * The module is imported by its unit test, so the benchmark must not start
 * itself on import. Under vitest the entry point is the worker script, never
 * this file, so the comparison is safe there.
 */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return resolve(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error("");
      console.error(`Columnar readability benchmark could not run: ${(error as Error).message}`);
      console.error("");
      process.exitCode = 2;
    });
}
