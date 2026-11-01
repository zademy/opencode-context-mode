# SPEC — json-token-savings

**Status:** Approved 2026-10-31
**Module:** `json-token-savings` (SPEC-map build order — new row)
**Related:** ADR-0002 (tool description structure), ADR-0004 (strict compression formula), SPEC-hook-resilience

## Problem

open-context-mode already routes tool output away from the context window. Two
gaps remain in what the plugin itself costs, and one in what it lets through.

**Gap 1 — the elide pass slices where it could describe.** `history-elide.ts`
caps an oversized native tool result to `capBytes` (2 KB) by taking a 60/40
head/tail slice. The slice is blind: it cuts the middle of a JSON payload, so
the model sees the first rows and the last rows and nothing in between. It is
also *larger* than a structured summary of the same payload would be.

**Gap 2 — tool descriptions repeat doctrine the routing block already carries.**
Measured against the plugin's own tool definitions: the tool array is 5,598
tokens and is sent on **every** request; the routing block is 1,035 tokens and
is injected **once per session** in v2 (`routingOncePerSession: true`).
609 of the 2,478 description tokens restate content the routing block already
teaches. That duplication sits in the per-request critical path.

**Gap 3 — JSON arriving from API requests is not compacted at all.** When an
external MCP tool or a native command returns a JSON payload, the bytes reach
the model verbatim. The plugin has a verified mutation point for this
(`packages/core/src/tool.ts` in the host reads `afterEvent.result.content`
*after* the `tool.execute.after` trigger fires) and does not use it.

A fourth, narrower gap: the plugin's own `tool.execute.after` handler reads
the tool result and never writes it back. The capability exists and is unused.

### What the measurements ruled out

Measured with tiktoken `o200k` (gpt-4o) against realistic API payloads:

| transform | token saving | verdict |
|---|---|---|
| strip whitespace (`lite`) | **0.0%** on minified API JSON | rejected — APIs already return minified JSON. Only pays if the source was pretty-printed. |
| columnar TSV | 27.9% – 56.4% | rejected — collapses number `1` and string `"1"` into one cell. Lossy. |
| value-dictionary dedup | ~0% on minified API JSON | rejected — nothing left to deduplicate once whitespace is gone. |
| **columnar JSON (typed columns)** | **19.5% – 49.8%** | candidate — round-trip verified deep-equal, including nested payloads |
| **shape + sample summary** | **44% – 84% of the elide budget** | candidate — structured, not sliced |

## Goals

1. **Structured over sliced.** A JSON tool result that gets elided carries a
   shape and samples, not an arbitrary head/tail cut.
2. **Zero data loss.** Every rewrite points at bytes that are already in the
   content store. A pointer is never written for bytes that are not there.
3. **Nothing the model reads gets worse.** The plugin's own overhead shrinks;
   the payload the model sees is either equal or more informative. No new
   format the model has to learn.
4. **Deterministic.** No model in the loop. Same input, same output, every run.
5. **Measured in avoided bytes**, per CONTEXT.md — a byte ratio is the only
   honest claim here, and it does not depend on which tokenizer the operator's
   provider uses.

## Non-Goals

- Changing what the plugin sends to the provider on the wire (prompt caching,
  cache_control placement) — the host owns that.
- Compacting JSON *inside* the model prompt (the model emits its own JSON).
- Any transform that changes the semantic content the model reads: no TSV, no
  null-dropping, no value truncation without a pointer.
- New user-facing tools for this. The savings come from existing mechanisms
  behaving better, not from a new tool the agent has to remember to call.

## Resolved Decisions (user: "aplica lo que recomiendes", "no ocupes Claude, Kimi ni Mistral")

| Open question | Decision | Rationale |
|---|---|---|
| Order of work | **1 → 2 → 3.** Structured elide first, description dedup second, inbound columnar last. | 1 and 2 give more savings and touch nothing the model reads. 3 changes what the model reads, so it goes last and only behind a model benchmark. |
| Inbound compaction format | **Columnar JSON with a typed column header** (`{"_c":[[name,type],…],"_r":[[…],[…]]}`), not TSV. | Typed columns keep number/string distinguishable, so the round-trip is deep-equal. TSV was rejected on measurement. |
| Inbound compaction trigger | **Only above a byte threshold, and only when the payload is an array of objects.** Below the threshold, or for any other shape, the payload is left alone. | A rewrite the model has to re-learn for 200 tokens of savings is a net loss. The threshold keeps the common case untouched. |
| Inbound compaction reversibility | **Original bytes go to the content store; the compacted form carries the pointer.** | Makes "no losses" literal rather than approximate, and reuses the two-phase find-then-index contract that `history-elide` already proves. |
| Description dedup mechanism | **Move shared doctrine out of tool descriptions into the routing block; keep each description's unique contract.** | 609 tokens/request leave the per-request critical path. The routing block is once-per-session in v2 and outranks descriptions. |
| Description dedup and ADR-0002 | **The canonical `WHEN / WHEN NOT / RETURNS / EXAMPLE` structure stays exactly as it is.** Only prose *content* moves. | ADR-0002 is a locked rubric with a contract test on every commit. Its structure is not in scope to change. |
| Validation models | **GLM or MiniMax only. Claude, Kimi, and Mistral are excluded.** | Operator constraint. |
| Measuring savings | **Avoided bytes, per CONTEXT.md.** Token counts are a design aid, not the reported metric. | A byte ratio does not change when the operator switches provider or model. The repo already reports `avoidedBytes`. |
| Merging `execute` / `batch_execute` / `execute_file` | **Out of scope.** | ~1,200 tokens/request, but it is a public API change and it degrades tool discoverability. Not a savings win worth the blast radius. |

## Success Criteria — Verification

### Point 1 — structured elide
- [x] A JSON array-of-objects tool result above `minBytes` is replaced by a
      shape + samples summary, not a head/tail slice.
- [x] The summary states the column names and their types, the row count,
      at least two sample rows, and the distinct-shape count.
- [x] The summary is smaller than the head/tail slice it replaces.
- [x] The original bytes are still indexed before the rewrite, and the marker
      still names the content-store label.
- [x] A non-JSON tool result (log output, build output) still takes the
      head/tail path unchanged.
- [x] A JSON payload that is not an array of objects still takes the head/tail
      path unchanged.
- [x] A payload that fails to parse is never rewritten.
- [x] A digest that does not fit the byte budget is refused rather than cut,
      so a truncated digest never becomes a slice again.
- [x] Indexer failure leaves the transcript byte-identical (existing
      two-phase invariant preserved).
- [x] `avoidedBytes` still reports the true delta.

### Point 2 — schema and description cost

The original framing of this point was "move doctrine out of tool descriptions
into the routing block", estimated at 609 tokens/request. A precise
sentence-level measurement against the rendered routing block refuted that
estimate: the real figure is **68 tokens (3.0%)**. ADR-0002 already required
doctrine to live in the routing block, and the shipped descriptions comply.
The remaining lever is the schema, not the prose.

**Landed.** `src/util/schema-token-savings.ts` — one mechanical rule,
applied on both serving paths: the MCP `tools/list` response
(`src/server.ts`) and the v2 native tool registry
(`zodShapeToJsonSchema`, `src/platforms/opencode/plugin.ts`).
Tests: `tests/core/schema-token-savings.test.ts` (23).

**The rule — "the prose covers it".** A schema-level `description` is
removed iff the tool's OWN prose description already covers it:

1. **Coverage** — every content word of the description (≥2 characters,
   minus a fixed English stop-word list) already occurs in the prose. A
   word occurs when the prose has it verbatim, or when the prose has a
   word differing from it only by an ending of ≤2 characters ("fetch" ⊂
   "fetches").
2. **No new contract** — the description introduces no RFC-2119 /
   prohibition keyword ("MUST", "MUST NOT", "NEVER", "REQUIRED",
   "deprecated", …) that the prose does not already state. A
   constraint the prose never mentions is never redundant, however
   common the words it is built from.

Coverage is the generalization of the byte-duplicate case — a
byte-duplicate of a prose phrase always satisfies coverage, so the
byte-duplicate rule is a strict subset of this one. Condition 1 makes
the rule safe by construction (every word the description contributes is
already in the context the model reads); condition 2 keeps the one
class coverage cannot judge — a constraint — out of reach. One
function, one pass, no per-tool list.

`$schema` (the JSON-Schema dialect URI) is dropped on both paths: it
carries no model-facing information and repeats on every tool.

- [x] A schema `description` that duplicates its own tool's prose is
      removed.
- [x] A schema `description` that explains a parameter the tool prose
      does NOT explain is kept — the model needs it to call the tool
      correctly.
- [x] `$schema` is stripped from the schemas the MCP path serves,
      matching what the v2 native path already does.
- [x] Each tool description keeps its ADR-0002 canonical structure.
- [x] The tool-description contract test in `tests/core/server.test.ts`
      still passes unchanged.
- [x] Tool descriptions stay within the ADR-0002 length cap.
- [x] The routing block is still injected once per session in v2.

**Measured (bytes — the repo's metric).** The tool array the MCP path
serves: **23,528 → 22,926 bytes, 602 bytes avoided per request** (2.6%
of the array). Schema bytes alone: 10,319 → 9,717. Prose bytes:
10,579 → 10,579 — unchanged, the transform never touches the
tool-level `description`.

| What | Bytes/request |
|---|---|
| `$schema` dialect URI + its key, 10 tools | 520 |
| Schema descriptions the prose covers (2 of 46) | 48 |
| **Total avoided** | **602** |

Secondary figure, tiktoken `o200k_base` (design aid only): 5,600 →
5,431 tokens, 169 saved (prose 2,478 → 2,478, schema 2,421 → 2,259).

**The premise did not hold.** The 46 schema-level descriptions are NOT
redundant with the tool prose: none of them is a byte-duplicate of a
prose phrase, and only 2 of 46 are word-covered by their own tool's
prose. The other 44 each introduce a word the prose never uses —
"milliseconds", "BM25", "truncated", the enum values, the deprecation
notes. The blanket figure in the log below (drop every description =
1,626 tokens) is therefore unreachable without taking away what a
parameter MEANS: the schema cost is dominated by information the prose
does not carry.

### Point 3 — inbound columnar (gated)

**Landed.** `src/platforms/opencode/json-columnar.ts` + the v2
`execute.after` write-back in `src/platforms/opencode/plugin.ts`.
Tests: `tests/adapters/opencode-json-columnar.test.ts`.

**Wire format.** `{"_c":[[name,type],…],"_r":[[cell,…],…]}` — one column
header, one array of rows. `_c` carries the per-column type code
(`n` number, `s` string, `b` boolean, `z` null, `o` object, `a` array;
a column whose rows disagree carries every code it holds, e.g. `ns`).
The cells are raw JSON values, so a number stays `1` and a string stays
`"1"` in the wire form itself — the TSV failure mode is structurally
impossible. When the rows do not all carry the same keys in the same
order, an optional `_s` holds the distinct row shapes and each row
leads with its shape index.

**Mutation point.** `event.result.content[0].text` in the v2
`tool.execute.after` hook — the host reads it AFTER the trigger fires,
so mutating it changes what the model receives.

- [x] Columnar compaction is byte-exact reversible: round-trip is deep-equal
      for nested payloads, verified by test. The bytes that ship are
      re-parsed and rebuilt and compared against the original — value AND
      key order — before the rewrite is offered; a payload that fails the
      check is refused, not rewritten.
- [x] It only fires above the byte threshold and only for arrays of objects.
      `OPEN_CONTEXT_MODE_COLUMNAR_MIN_BYTES` (default 8192) and
      `OPEN_CONTEXT_MODE_COLUMNAR=0` to turn it off. Anything that is not
      an array of plain objects, and any payload whose replacement would
      not be smaller, is left byte-identical.
- [x] The original bytes are in the content store and the pointer resolves.
      Two-phase, like the history-elide pass: the plan is computed first,
      the ORIGINAL bytes are indexed second, and the rewrite happens only
      if the index write succeeded. A failed index leaves the tool result
      byte-identical. The marker names the content-store label in the
      same wording style as the history-elide marker.
- [ ] A GLM or MiniMax model reads the compacted form and answers a question
      about it as accurately as it answers the same question about the
      original. **Claude, Kimi, and Mistral are not used for this check.**
      Still open — this check has not been run.
- [ ] If the model answers the compacted form less accurately, the feature
      ships disabled by default. Still open; the switch
      (`OPEN_CONTEXT_MODE_COLUMNAR=0`) is in place for it.

**Measured.** On a 200-row flat payload the rewrite keeps 47.9% of the
bytes out of the transcript; on a 200-row nested API payload (GitHub
issues, objects and arrays inside the rows) 22.1%. Both are in line
with the 19.5%–49.8% band the typed columnar form was measured at.

#### How to run the model check

`tests/columnar-readability-benchmark.ts` is the harness for the two
open items above. It renders one payload twice — the original JSON and
the typed columnar form — asks the same questions about both with the
same prompt template, and scores every answer in code.

```sh
# plan only: prints both renderings' sizes, the questions and their
# expected answers. No model is called and no credential is read.
npx vpx tests/columnar-readability-benchmark.ts

# the live comparison. Needs a key for a GLM or MiniMax endpoint.
OPEN_CONTEXT_MODE_COLUMNAR_BENCH_API_KEY=... \
  npx vpx tests/columnar-readability-benchmark.ts --live
```

Credentials come from `OPEN_CONTEXT_MODE_COLUMNAR_BENCH_API_KEY`, or
from a JSON file named by `--config` (`{"apiKey","baseUrl","model",
"maxDropPp"}`). Flags beat environment beats config file. The model
defaults to `glm-4.6` and may be given as `glm-4.6` or
`minimax/MiniMax-M2.7` — a provider that is not GLM or MiniMax is
refused, not quietly rerouted.

**The model restriction is enforced, not documented.** A hardcoded
denylist of provider/model substrings — `claude`, `anthropic`, `kimi`,
`moonshot`, `mistral`, `mixtral`, `codestral`, `magistral`, `ministral`,
`devstral`, `pixtral` — is matched against the whole model spec AND the
base URL. A denied model aborts the run with a loud error; no fallback
model is substituted.

**The gate.** Accuracy is correct answers over questions, per arm.
The run fails when the compacted arm's accuracy drops by more than
`--max-drop-pp` percentage points (default 10; `0` holds the strict
reading that the compacted form must not be worse at all). Exit codes:
`0` gate passed, `1` gate failed, `2` could not evaluate (bad arguments,
denied model, missing credentials, provider error), `3` plan only.

The harness is not part of the default test suite and makes no network
call at import time. `tests/columnar-readability-benchmark.test.ts`
covers its own logic — the denylist, the scorers, the gate arithmetic
and the reference columnar implementation — with no model and no key.

### Cross-cutting
- [ ] `npm run lint` → 0 errors.
- [ ] `npm run format:check` → pass.
- [ ] Full test suite passes.

## Boundaries

**Always:**
- One deterministic transform per surface, no model in the loop.
- The content store holds the original before any rewrite lands.
- Report avoided bytes, not tokens.
- Leave anything the transform cannot prove safe exactly as it was.

**Never:**
- Rewrite a payload the model is reading right now (`keepRecent` stands).
- Write a pointer to bytes that are not in the content store.
- Ship a format that loses type information (TSV, null-dropping).
- Use Claude, Kimi, or Mistral for validation.

## Implementation Notes

The mutation point for point 3 is `event.result.content` in the v2
`tool.execute.after` hook: the host reads it *after* the trigger fires
(`packages/core/src/tool.ts`, `afterEvent.result.content` is passed to
`normalizeContent` post-trigger), so mutating it changes what the model
receives. The current handler at `src/platforms/opencode/plugin.ts` reads the
result and never writes it back — that is the unused capability.

Point 1 lands in `src/platforms/opencode/history-elide.ts`, inside the existing
two-phase contract: the summary is computed from the same `text` the caller
already indexes, so the pointer invariant is unchanged.

Point 2 lands in `src/server.ts` (descriptions) and `hooks/routing-block.mjs`
(doctrine), and must keep the ADR-0002 contract test green.

## Session Log

- **2026-10-31:** Investigation complete. Measurements taken with tiktoken
  `o200k`; whitespace-stripping and TSV rejected on evidence. Model constraint
  from operator (GLM/MiniMax only) recorded. Point 1 implementation starting.
- **2026-10-31:** Point 1 implemented.
  New module `src/platforms/opencode/json-summary.ts` (digest builder) wired
  into `applyElision` in `src/platforms/opencode/history-elide.ts`. The
  head/tail slice now runs only when the digest is refused — either because
  the payload is not a JSON array of objects, or because the digest does not
  fit the byte budget.
  Tests: 17 new in `tests/adapters/opencode-json-summary.test.ts`, 6 new in
  `tests/adapters/opencode-history-elide.test.ts`. Suite: 3115 passed /
  26 skipped / 1 failed — the failure is `package-deps-policy` (the
  `better-sqlite3` pin is `^13.0.3` in HEAD and the test expects `^12.6.2`),
  pre-existing and reproduced on a clean tree via `git stash`.
  `npm run lint` → 0 errors (483 pre-existing warnings). `npm run
  format:check` → pass.
  Measured with the shipped implementation at `capBytes: 2048`, in bytes:
  gh-issues(100) 2064 → 1167; flat-rows(500) 2064 → 465; flat-rows(50)
  2064 → 447. Total avoided 165,486 → 169,599 bytes (96.4% → 98.8%).
  Next: point 2 (description dedup).
- **2026-10-31:** Point 2 re-scoped after measurement. The 609-token estimate
  for prose dedup was a false positive from a coarse overlap heuristic; the
  precise figure is 68 tokens (3.0%), because ADR-0002 already did that
  work. The lever is the schema instead: `description` fields inside
  `inputSchema` are 6,546 bytes = 24% of schema bytes, and dropping them
  entirely would save 1,626 tokens/request (67.2% of the schema). They are
  NOT removable as a blanket — a schema description is how the model learns
  what a parameter means, which the tool-level prose does not cover. Only the
  subset that duplicates its own tool's prose is safe to remove.
- **2026-10-31:** Point 2 implemented.
  New module `src/util/schema-token-savings.ts` holds the mechanical
  rule — a schema-level `description` is removed iff the tool's own
  prose already covers it (every content word present, and no contract
  keyword the prose does not state). Wired into the MCP `tools/list`
  handler in `src/server.ts` and into `zodShapeToJsonSchema` on the v2
  native path, so both serve the same bytes. `$schema` is dropped on
  both paths. Prose is untouched.
  Tests: 23 new in `tests/core/schema-token-savings.test.ts`.
  Measured in bytes (the repo's metric): tool array 23,528 → 22,926,
  602 bytes avoided per request (520 from `$schema`, 48 from the two
  prose-covered descriptions). Prose bytes unchanged at 10,579.
  Secondary, tiktoken `o200k_base`: 5,600 → 5,431 tokens (169 saved);
  prose 2,478 → 2,478, schema 2,421 → 2,259.
  Correction to the entry above: the 46 schema-level `description`
  fields are 6,452 bytes, which is 62.5% of the 10,319 schema bytes —
  not 24%. 24% is roughly their share of the whole 23,528-byte tool
  array (27.4%). The safe, mechanical subset is 2 of 46 descriptions:
  the other 44 each carry a word their tool's prose never uses, so the
  blanket "drop them all" figure is not reachable without removing
  what a parameter means.
- **2026-10-31:** Point 3 implemented, and its default set to OFF.
  New module `src/platforms/opencode/json-columnar.ts` (typed columnar
  packing) wired into the v2 `execute.after` hook via `compactInboundColumnar`,
  with the write-back guarded by `failSafe("tool.execute.after.columnar")`.
  Two-phase like the elide pass: plan (pure) → index the ORIGINAL bytes via
  `indexForElision` → rewrite only if the index returned true. Wire format
  `{"_c":[[name,typeCodes],…],"_r":[[value,…],…]}` with an optional `_s`
  row-shape table when rows disagree; cells are raw JSON values, so a number
  never becomes a string. Round-trip is verified deep-equal for flat AND
  nested payloads, plus a 200-case property test and 3,600 fuzz payloads.
  Measured in bytes: gh-issues(100) 84,133 → 65,214 (22.5%);
  gh-issues(200) 168,823 → 130,406 (22.8%); flat-rows(200) 31,538 → 15,793
  (49.9%); flat-rows(500) 79,806 → 39,761 (50.2%). flat-rows(50) at 7,739
  bytes is REFUSED — the ~230-byte marker plus header costs more than the
  key names removed, so the effective floor is "many rows", not just
  `minBytes`.
  **DEFAULT IS OFF** (`OPEN_CONTEXT_MODE_COLUMNAR=1` to enable). The columnar
  form changes what the model reads, and no real model has yet been
  measured reading it. The gate is `tests/columnar-readability-benchmark.ts`,
  which asks a model the same questions of both renderings and fails when
  the compacted one scores worse. It has been validated end-to-end against
  a local mock provider (both arms correct → exit 0; compacted wrong →
  exit 1) but NOT against a live GLM or MiniMax endpoint — no credentials
  are present in this environment. The two model-readability checklist
  items therefore remain open, and the pass ships disabled until they
  close.
- **2026-10-31:** Benchmark harness implemented.
  `tests/columnar-readability-benchmark.ts` (1,143 lines) plus 34 unit tests
  in `tests/columnar-readability-benchmark.test.ts`. 12 questions derived
  programmatically from a seeded 200-row payload, so ground truth cannot
  drift from the data. Scoring is pure code (numeric first-token equality,
  normalized string equality, first yes/no word) — no model in the scoring
  path. The prompt template is byte-identical between arms; only the data
  block differs.
  **Provider denylist (operator constraint):** `claude`, `anthropic`, `kimi`,
  `moonshot`, `mistral`, `mixtral`, `codestral`, `magistral`, `ministral`,
  `devstral`, `pixtral` — matched case-insensitively against BOTH the model
  spec and the base URL, so neither `--model anthropic/…` nor
  `--base-url https://api.mistral.ai/v1` slips through. Rejection is loud
  (exit 2) with no fallback model substituted. Verified by running the
  harness against each denied name and a denied base URL: all exit 2.
  Default model `glm-4.6` (zai); `minimax/*` resolves to
  `https://api.minimax.io/v1`. Without credentials the harness exits 2 with
  a clear message and makes NO network call (verified against a local HTTP
  sink that counted zero hits). Exit codes: 0 gate passed, 1 gate failed,
  2 could not evaluate, 3 plan only.
