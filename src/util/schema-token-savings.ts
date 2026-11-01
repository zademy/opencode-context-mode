/**
 * Tool-schema token savings (SPEC Point 2).
 *
 * Every open_ctx_* tool carries prose twice over:
 *
 *   - the tool-level `description` — what the tool is FOR and when to reach
 *     for it. ADR-0002 owns the shape of this text.
 *   - the `description` fields nested inside `inputSchema` — what each
 *     PARAMETER means.
 *
 * The two are written for different readers and are not interchangeable: the
 * schema description is how the model learns that `language` selects a
 * runtime, that `intent` picks the search mode, that `commands` differs from
 * `code`. Dropping the schema layer wholesale would cost the model exactly
 * that knowledge, so it is not an option.
 *
 * What IS safe to drop is the subset that repeats what the tool's own prose
 * already says. This module implements that subset with ONE mechanical rule,
 * so the decision is reproducible and reviewable instead of a hand-picked list
 * of strings.
 *
 * ── THE RULE — "the prose covers it" ───────────────────────────────
 *
 * A schema-level `description` is REDUNDANT (and is removed) when the tool's
 * own prose description already covers it, meaning BOTH:
 *
 *   1. COVERAGE — every content word of the description (words of two or more
 *      characters, minus a fixed English stop-word list) already occurs in the
 *      prose. A word occurs when the prose contains it verbatim, or when the
 *      prose contains a word that differs from it only by an ending of at most
 *      two characters ("fetch" is covered by "fetches", "index" by "indexed").
 *
 *   2. NO NEW CONTRACT — the description introduces no RFC-2119 or
 *      prohibition keyword ("MUST", "MUST NOT", "NEVER", "REQUIRED",
 *      "deprecated", ...) that the prose does not already state. A constraint
 *      the prose never mentions is never redundant, however common the words
 *      it is built from.
 *
 * Coverage is the generalization of "the description is a byte-duplicate of a
 * phrase already in the prose": a byte-duplicate always satisfies coverage,
 * so the byte-duplicate case is a strict subset of what this rule removes.
 *
 * Condition 1 makes the rule safe by construction — every word the
 * description contributes is already in the context the model reads — and
 * condition 2 keeps the one class of description that coverage alone cannot
 * judge (a constraint) out of reach.
 *
 * `$schema` is the JSON-Schema dialect URI. It carries no model-facing
 * information — the consumer already knows the dialect — and it is repeated on
 * every tool, so both serving paths drop it.
 */

/**
 * English function words plus the filler nouns that carry no tool-specific
 * meaning. A fixed list on purpose: the rule has to be reproducible, so the
 * only judgement allowed is "is this ordinary English", never "is this
 * description about this tool".
 */
const STOP_WORDS = new Set([
  "a",
  "about",
  "above",
  "after",
  "again",
  "all",
  "also",
  "along",
  "an",
  "and",
  "any",
  "are",
  "around",
  "as",
  "at",
  "back",
  "be",
  "because",
  "been",
  "before",
  "being",
  "below",
  "between",
  "both",
  "but",
  "by",
  "can",
  "could",
  "did",
  "do",
  "does",
  "doing",
  "down",
  "during",
  "each",
  "either",
  "else",
  "enough",
  "every",
  "few",
  "for",
  "from",
  "further",
  "had",
  "has",
  "have",
  "having",
  "he",
  "her",
  "here",
  "hers",
  "him",
  "his",
  "how",
  "however",
  "i",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "itself",
  "just",
  "may",
  "might",
  "mine",
  "more",
  "most",
  "much",
  "must",
  "my",
  "neither",
  "no",
  "nor",
  "not",
  "now",
  "of",
  "off",
  "on",
  "once",
  "one",
  "only",
  "or",
  "other",
  "others",
  "ought",
  "our",
  "ours",
  "out",
  "over",
  "own",
  "per",
  "same",
  "shall",
  "she",
  "should",
  "so",
  "some",
  "such",
  "than",
  "that",
  "the",
  "their",
  "theirs",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "those",
  "through",
  "to",
  "too",
  "under",
  "until",
  "up",
  "upon",
  "us",
  "very",
  "via",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "while",
  "who",
  "whom",
  "why",
  "will",
  "with",
  "within",
  "without",
  "would",
  "you",
  "your",
  "yours",
]);

/**
 * Keywords that turn a description into a CONTRACT rather than a hint. A
 * description carrying one of these states a rule the reader must obey; if the
 * prose does not state the same rule, the description is the only place the
 * reader learns it and must be kept.
 */
const CONTRACT_PHRASES = [
  "must not",
  "shall not",
  "should not",
  "do not",
  "don't",
  "must",
  "shall",
  "should",
  "never",
  "required",
  "mandatory",
  "important",
  "warning",
  "caution",
  "destructive",
  "danger",
  "deprecated",
  "critical",
];

/** Lowercase alphanumeric word tokens — punctuation carries no meaning here. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter(Boolean);
}

/** True when `phrase` appears as a contiguous run of tokens inside `tokens`. */
function containsPhrase(tokens: string[], phrase: string[]): boolean {
  if (phrase.length === 0 || tokens.length < phrase.length) return false;
  outer: for (let i = 0; i + phrase.length <= tokens.length; i++) {
    for (let j = 0; j < phrase.length; j++) {
      if (tokens[i + j] !== phrase[j]) continue outer;
    }
    return true;
  }
  return false;
}

/**
 * True when `word` already occurs in the prose. An exact hit counts; so does
 * a hit whose only difference is an ending of at most two characters
 * ("fetch"/"fetches", "index"/"indexed", "url"/"urls"). Longer differences
 * ("run"/"runtime") are NOT matches — they can mean different things.
 */
function isWordCovered(word: string, proseWords: Set<string>): boolean {
  if (proseWords.has(word)) return true;
  for (const other of proseWords) {
    const shorter = word.length <= other.length ? word : other;
    const longer = word.length <= other.length ? other : word;
    if (longer.length - shorter.length <= 2 && longer.startsWith(shorter)) return true;
  }
  return false;
}

/**
 * The rule, as a predicate: is this schema-level description already covered
 * by the tool's own prose description?
 */
export function isDescriptionCoveredByProse(description: string, prose: string): boolean {
  const proseTokens = tokenize(prose);
  const proseWords = new Set(proseTokens);
  const descriptionTokens = tokenize(description);
  const contentWords = descriptionTokens.filter((word) => word.length >= 2 && !STOP_WORDS.has(word));
  // Nothing to say (an empty or punctuation-only description) is not a
  // redundancy claim — leave it alone rather than silently deleting it.
  if (contentWords.length === 0) return false;
  // (2) A contract the prose never states is never redundant.
  for (const phrase of CONTRACT_PHRASES) {
    const phraseTokens = tokenize(phrase);
    if (!containsPhrase(descriptionTokens, phraseTokens)) continue;
    if (!containsPhrase(proseTokens, phraseTokens)) return false;
  }
  // (1) Every content word must already be in the prose.
  return contentWords.every((word) => isWordCovered(word, proseWords));
}

/**
 * Strip the JSON-Schema dialect URI and every schema-level `description` the
 * tool's prose already covers. Returns a new value; the input is untouched.
 *
 * Applied on both serving paths — the MCP `tools/list` response and the v2
 * native tool registry — so both hand the model the same bytes.
 */
export function slimToolSchema<T>(schema: T, prose: string): T {
  return slimNode(schema, prose) as T;
}

function slimNode(node: unknown, prose: string): unknown {
  if (Array.isArray(node)) return node.map((item) => slimNode(item, prose));
  if (node === null || typeof node !== "object") return node;
  const source = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    // The dialect URI tells the model nothing and repeats on every tool.
    if (key === "$schema") continue;
    if (key === "description" && typeof value === "string") {
      if (isDescriptionCoveredByProse(value, prose)) continue;
      out[key] = value;
      continue;
    }
    out[key] = slimNode(value, prose);
  }
  return out;
}
