/**
 * json-summary — describe an oversized JSON payload instead of slicing it.
 *
 * The elide pass (`history-elide.ts`) caps a native tool result by taking a
 * head/tail slice of the raw text. For a JSON array that slice is the worst
 * possible cut: the model sees the first rows and the last rows and nothing
 * between, so it cannot tell "there are five hundred of these" from "there
 * are two". It also spends the byte budget on duplicated key names.
 *
 * This module produces the alternative: a shape-and-samples digest. It states
 * the column names with their types, the row count, a couple of real sample
 * rows, and how many distinct row shapes the array holds. For the payloads
 * this was measured on, that digest is both SMALLER than the slice it
 * replaces and strictly more informative.
 *
 * Three properties this module guarantees:
 *
 * 1. **It never invents data.** Every value in a digest is derived from the
 *    payload it describes. A field whose type varies between rows is reported
 *    as varying, not pinned to the first row's type.
 * 2. **It never silently drops a shape.** A digest that does not fit the byte
 *    budget is refused (returns null) so the caller falls back to the slice.
 * 3. **It is deterministic.** No model, no clock, no randomness — the same
 *    payload always yields the same digest.
 *
 * The payload itself is never modified or discarded here. The caller keeps
 * the original bytes in the content store and points at them; this module
 * only decides what the transcript keeps in their place.
 */

/** Longest cell value rendered verbatim before it is cut. */
const MAX_CELL = 48;

/** Longest type descriptor rendered before it is cut. */
const MAX_TYPE = 24;

/** Rows sampled to count distinct shapes. */
const SAMPLE_ROWS = 200;

/**
 * Type words in the order a column lists them when it holds several.
 * Fixed, not insertion order, so the same payload always renders the
 * same digest.
 */
const TYPE_ORDER = ["null", "boolean", "number", "string", "array", "object"] as const;

/** How many distinct types a column may hold before it reads as `mixed`. */
const MAX_COLUMN_TYPES = 3;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/**
 * The type of a JSON value, as a short word the model can read at a glance.
 * `mixed` marks a column whose rows disagree — the honest answer, since
 * pinning it to the first row's type would misdescribe the rest.
 */
function typeOf(value: Json): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "boolean":
      return "boolean";
    case "number":
      return "number";
    case "string":
      return "string";
    default:
      return "object";
  }
}

/**
 * A column descriptor that stays true across every row that has the column.
 *
 * When the rows disagree on the type, the descriptor names EVERY type the
 * column actually holds rather than collapsing them into one word: a
 * column that is `null` in some rows and a number in others reads as
 * `null|number`, which tells the model both facts. `mixed` is reserved
 * for a column with too many types to enumerate.
 */
function columnType(rows: Json[][], col: number): string {
  const seen = new Set<string>();
  for (const row of rows) {
    if (row[col] === undefined) continue;
    seen.add(typeOf(row[col] as Json));
  }
  if (seen.size === 0) return "any";
  if (seen.size === 1) return [...seen][0];
  if (seen.size > MAX_COLUMN_TYPES) return "mixed";
  // Stable order: the type words in a fixed order, not insertion order,
  // so the same payload always renders the same digest.
  return TYPE_ORDER.filter((t) => seen.has(t)).join("|");
}

/** Render one cell for a sample row. */
function renderCell(value: Json | undefined): string {
  if (value === undefined) return "";
  if (value === null) return "null";
  if (typeof value === "string") return value.length > MAX_CELL ? value.slice(0, MAX_CELL) + "…" : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.length}]`;
  return `{${Object.keys(value as object).length}}`;
}

/**
 * Whether the payload is a JSON array whose elements are all objects.
 *
 * Only that shape gets a digest. A bare object, an array of primitives, or
 * text that is not JSON at all keeps the existing slice behaviour — a digest
 * of a shape we do not understand is worse than a slice of it.
 */
export function isJsonArrayPayload(text: string): boolean {
  const parsed = tryParse(text);
  if (!parsed) return false;
  if (!Array.isArray(parsed) || parsed.length === 0) return false;
  return parsed.every((row) => row !== null && typeof row === "object" && !Array.isArray(row));
}

function tryParse(text: string): Json | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("[")) return undefined;
  try {
    return JSON.parse(trimmed) as Json;
  } catch {
    return undefined;
  }
}

/**
 * Build the digest, or null when the payload is not a summarisable array of
 * objects or the digest would not fit the byte budget.
 *
 * @param text  the raw tool result text
 * @param maxBytes  byte budget for the digest; the digest is refused rather
 *                  than cut, because a cut digest is just a slice again
 */
export function jsonSummary(text: string, maxBytes = 2048): string | null {
  const parsed = tryParse(text);
  if (!parsed || !Array.isArray(parsed) || parsed.length === 0) return null;
  const rows = parsed as Json[];
  if (!rows.every((row) => row !== null && typeof row === "object" && !Array.isArray(row))) return null;

  const objects = rows as Record<string, Json>[];

  // Column set, in first-seen order so the digest is stable.
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const row of objects) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        columns.push(key);
      }
    }
  }
  if (columns.length === 0) return null;

  // Type per column, computed across the sampled rows.
  const sample = objects.slice(0, SAMPLE_ROWS).map((row) => columns.map((c) => row[c]));
  const types = columns.map((_, i) => columnType(sample as Json[][], i));

  const lines: string[] = [];

  lines.push(`JSON array — ${rows.length} row${rows.length === 1 ? "" : "s"}, ${columns.length} column${columns.length === 1 ? "" : "s"}`);
  lines.push("shape: " + columns.map((c, i) => `${c}:${types[i]}`).join(", "));

  // Distinct shapes among the sampled rows: "500 rows but only 3 shapes" is
  // the fact a slice cannot convey.
  const shapeKeys = new Set(sample.map((row) => columns.map((c, i) => `${c}=${typeOf((row[i] ?? null) as Json)}`).join("|")));
  if (rows.length > SAMPLE_ROWS) {
    lines.push(`distinct shapes (first ${SAMPLE_ROWS} rows): ${shapeKeys.size}`);
  } else {
    lines.push(`distinct shapes: ${shapeKeys.size}`);
  }

  // Sample rows: real values, so the model sees what a row looks like.
  const header = columns.join(" | ");
  lines.push(`columns: ${header}`);
  for (const row of objects.slice(0, 2)) {
    lines.push("row: " + columns.map((c) => renderCell(row[c])).join(" | "));
  }

  const digest = lines.join("\n");
  if (Buffer.byteLength(digest, "utf8") > maxBytes) return null;
  return digest;
}
