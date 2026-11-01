# ADR-0007 — Lossless JSON compaction for the context window

- **Status**: Accepted
- **Date**: 2026-10-31
- **Motivating question**: can the plugin shrink the JSON that reaches the
  model without losing anything, and without making the model read worse?
- **Reviewers**: owner Mert
- **Related**: ADR-0002 (tool description style), ADR-0004 (strict compression
  formula), ADR-0006 (OpenCode-native, MCP-only), SPEC-json-token-savings

## Context

open-context-mode's thesis is that data stays out of the context window and
only the answer enters it. That holds for the plugin's own tools: the output
ladder in `src/tool-pipeline.ts` auto-indexes anything past 100 KB.

Two surfaces do not have that protection:

1. **The elide pass.** `history-elide.ts` caps a native tool result past
   `minBytes` (4 KB) to `capBytes` (2 KB) by taking a 60/40 head/tail slice.
   For a JSON array that slice is the worst possible cut: the model sees the
   first rows and the last rows and nothing between, so it cannot tell "there
   are five hundred of these" from "there are two". The budget is also spent
   on repeated key names.

2. **The tool array the plugin sends.** 10 `open_ctx_*` tools cost 5,598
   tokens per request — 2,478 of prose and 2,421 of JSON Schema — plus a
   1,035-token routing block that v2 injects once per session.

The operator's requirement was explicit: **no data loss, and the model must
not start failing.** Savings that come from a format the model has to
re-learn do not count, even when the byte ratio looks good.

## Measurement first

Every claim below was measured with tiktoken `o200k` (gpt-4o) against
realistic API payloads, and re-measured in bytes where the shipped code
changed. The repo reports **avoided bytes**, not tokens (CONTEXT.md), because
a byte ratio does not change when the operator switches provider — and this
project's operators use GLM and MiniMax, whose tokenizers are not o200k.

Two candidates were rejected on evidence:

| transform | saving | verdict |
|---|---|---|
| strip whitespace | **0.0%** on minified API JSON | rejected — APIs already return minified JSON. Only pays if the source was pretty-printed, which it is not. |
| TSV columns | 27.9% – 56.4% | rejected — a cell is an untyped string, so number `1` and string `"1"` become indistinguishable. Lossy. |

A third estimate was **refuted by re-measurement**: an initial claim that 609
tokens of tool-description prose were duplicated by the routing block turned
out to be 68 tokens (3.0%). The first figure came from a coarse heuristic
matching generic vocabulary — "code", "file", "search" — not doctrine.
ADR-0002 had already required doctrine to live in the routing block, and the
shipped descriptions complied.

## Decision

### 1 — A JSON array is summarised, not sliced

`applyElision` computes a shape-and-samples digest before falling back to the
head/tail slice. The digest states the column names with their types, the row
count, the number of distinct row shapes, and two real sample rows.

The slice stays as the fallback for everything else: a payload that is not
JSON, a payload that is not an array of objects, a payload that fails to
parse, and a digest that does not fit the byte budget. **A digest that does
not fit is refused, not cut** — a cut digest is a slice with extra steps, and
a slice that loses the shape line is the blind cut this replaces.

Measured at `capBytes: 2048`, in bytes: gh-issues(100) 2,064 → 1,167;
flat-rows(500) 2,064 → 465; flat-rows(50) 2,064 → 447. Total avoided bytes
rose from 96.4% to 98.8%.

### 2 — A column's type is reported as the set of types it holds

When rows disagree on a type, the descriptor names every type the column
actually holds (`null|number`), rather than collapsing them into one word or
pinning the first row's type. `mixed` is reserved for a column with too many
types to enumerate. The model needs both facts: a column that is `null` in
some rows and a number in others is a different fact from a column that is
always a number.

### 3 — Inbound compaction is typed columnar JSON, gated on a model benchmark

When a tool result carries a JSON array of objects above a byte threshold,
the model receives a typed columnar form — `{"_c":[[name,type],…],"_r":[[…],[…]]}`
— and a pointer to the original bytes in the content store. The per-column
type is what makes the round-trip **byte-exact**: a number never becomes a
string.

The write-back point is `event.result.content` in the v2 `execute.after`
hook. The host reads it *after* the trigger fires, so mutating it changes
what the model receives. The handler previously only read the result and
never wrote it back; that unused capability is what this uses.

This point ships **disabled unless a model benchmark says the compacted form
reads as accurately as the original**. The benchmark uses GLM or MiniMax
only — never Claude, Kimi, or Mistral, because routing goes through those
providers.

### 4 — Schema descriptions are stripped only where redundant

A schema-level `description` is how the model learns what a PARAMETER means,
which the tool-level prose does not cover. Removing all of them would save
1,626 tokens per request (67.2% of the schema) and would be wrong.

The rule is mechanical and auditable: strip a schema description only when
its normalized text already appears in that same tool's prose description.
Everything else stays. `$schema` is stripped from the MCP path, matching
what the v2 native path already does.

### 5 — Tool prose is not touched

ADR-0002 governs the tool descriptions: a locked section structure, a
forbidden-token list, a length cap, and a contract test that runs on every
commit. The prose is already lean — the real lever is the schema. Only
schema-level content moves.

## Consequences

- The transcript carries a description of a JSON payload instead of a slice
  of it, so the model can reason about the payload's shape without a second
  tool call.
- The original bytes stay retrievable through the content store. The pointer
  invariant is unchanged: a pointer is only ever written for bytes that are
  already there.
- Nothing the model reads gets worse. Point 1 and point 2 shrink what the
  model reads while making it more informative; point 3 changes the format,
  so it **ships disabled** and is enabled by an explicit
  `OPEN_CONTEXT_MODE_COLUMNAR=1` only after the benchmark shows a real
  model reads the compacted form as accurately as the original. The
  benchmark uses GLM or MiniMax only — never Claude, Kimi, or Mistral,
  because routing goes through those providers.
- The plugin's own per-request footprint drops, which is the one cost every
  session pays whether or not it calls a tool.

## Alternatives rejected

- **Strip whitespace.** 0.0% on minified API JSON.
- **TSV columns.** Lossy: number and string collapse.
- **Merging `execute` / `batch_execute` / `execute_file` into one tool with a
  `mode` parameter.** ~1,200 tokens per request, but it is a public API
  change and it degrades tool discoverability. Not worth the blast radius.
- **A blanket strip of schema descriptions.** 1,626 tokens per request on
  paper, but it would remove what a parameter *means*: of the 46 shipped
  schema descriptions, none is a byte-duplicate of its tool's prose and
  only 2 of 46 are even word-covered by it. The safe mechanical subset
  avoids 602 bytes per request.
- **Summarising every JSON payload, at any size.** A rewrite the model has
  to re-learn for 200 bytes of savings is a net loss. Thresholds stay.

## References

- `docs/specs/SPEC-json-token-savings.md` — the spec, its verification
  checklist, and the implementation record.
- `src/platforms/opencode/json-summary.ts` — the point 1 digest.
- `src/platforms/opencode/json-columnar.ts` — the point 3 columnar form.
- `src/platforms/opencode/history-elide.ts` — the two-phase elide contract.
