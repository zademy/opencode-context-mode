/**
 * json-columnar — compact an oversized JSON array into a typed columnar form.
 *
 * The elide pass (`history-elide.ts`) slices an oversized native tool result
 * head/tail and points at the original bytes. That is the right move for
 * unstructured output, but for a JSON array it is the wrong one: the slice
 * cuts the middle out of the data and then spends the byte budget on
 * duplicated key names.
 *
 * This module produces the alternative for the one shape where a structural
 * rewrite actually pays: an ARRAY OF OBJECTS. The payload becomes a typed
 * columnar form — one column header, one array of rows — and the key names
 * are paid for once instead of once per row.
 *
 * The wire format:
 *
 *   {"_c":[["id","n"],["name","s"]],"_r":[[1,"a"],[2,"b"]]}
 *
 *   _c  column header — one `[name, type]` pair per column, in first-seen
 *       order. `name` is the original key, `type` is the column's type code.
 *   _r  rows — one array of cells per row, in header-column order.
 *   _s  OPTIONAL — the distinct ROW SHAPES, present only when the rows do not
 *       all have the same keys in the same order. A shape is the list of
 *       column indices one row carries, in that row's own key order.
 *
 * Type codes:
 *
 *   n number · s string · b boolean · z null · o object · a array
 *
 * A column whose rows disagree about the type carries every code it holds,
 * in a fixed order (`ns` = number or string). A column is never given a type
 * it does not have.
 *
 * The cells are RAW JSON values, and that is the whole point of the type
 * header. A TSV-style dump collapses the number 1 and the string "1" into one
 * cell and the model cannot tell them apart afterwards; here a number stays
 * `1` and a string stays `"1"` in the wire form itself, and the header says
 * which of the two the column carries. A number can never be read back as a
 * string.
 *
 * When the rows do not agree about their SHAPE, the row carries its shape
 * index and the cells follow the shape's order:
 *
 *   {"_c":[["a","n"],["b","x"]],"_s":[[0,1],[0]],"_r":[[0,1,2],[1,3]]}
 *
 * Three properties this module guarantees:
 *
 *  1. **Byte-exact reversible.** The bytes that ship are re-parsed and
 *     rebuilt and compared against the original — value AND key order — before
 *     the rewrite is offered. A payload that does not survive that check is
 *     REFUSED, not rewritten. There is no "probably fine" path.
 *  2. **It never invents data.** Every cell is a value from the payload.
 *  3. **It never claims a saving it did not make.** The replacement is
 *     measured in bytes and is refused when it is not smaller than what it
 *     replaces.
 *
 * The original bytes are the agent's way back. The caller indexes them FIRST
 * and only rewrites when the index write succeeded, exactly like the
 * two-phase contract in `history-elide.ts`.
 */

// ── Wire format ──────────────────────────────────────────

/** The wire type of a single value. */
export type ColumnarValueType = "n" | "s" | "b" | "z" | "o" | "a";

/**
 * A column's type code: one code for a column whose rows agree, every code
 * it holds for a column whose rows do not (`ns` = number or string).
 */
export type ColumnarType = string;

/** One column: `[name, type]`. */
export type ColumnarColumn = [name: string, type: ColumnarType];

/** The packed columnar structure. */
export type ColumnarPacked = {
  _c: ColumnarColumn[];
  _r: unknown[][];
  /** Distinct row shapes — column indices, in the row's own key order. */
  _s?: number[][];
};

const TYPE_NUMBER = "n";
const TYPE_STRING = "s";
const TYPE_BOOLEAN = "b";
const TYPE_NULL = "z";
const TYPE_OBJECT = "o";
const TYPE_ARRAY = "a";

/** The order type codes are listed in when a column carries more than one. */
const TYPE_ORDER: ColumnarValueType[] = [TYPE_NUMBER, TYPE_STRING, TYPE_BOOLEAN, TYPE_NULL, TYPE_OBJECT, TYPE_ARRAY];

// ── Config ───────────────────────────────────────────────

export type ColumnarConfig = {
  /**
   * Tool results at or above this many bytes are candidates. Below it the
   * rewrite costs more than it saves: the model has to re-learn the columnar
   * form for a payload that was never going to hurt. Default 8 KB.
   */
  minBytes: number;
  /**
   * Master switch. `OPEN_CONTEXT_MODE_COLUMNAR=1` turns the pass on,
   * `=0` turns it off.
   *
   * DEFAULT IS OFF. The columnar form changes what the model reads, so it
   * ships disabled until a model has read it as accurately as the original.
   * The gate is `tests/columnar-readability-benchmark.ts`: it asks a model
   * the same questions of both renderings and fails when the compacted one
   * scores worse. Run it against a GLM or MiniMax endpoint and, if it
   * passes, enable the pass.
   *
   * Turning it on is an explicit operator decision, not a default: an
   * unvalidated format the model has to re-learn can cost more than the
   * bytes it saves.
   */
  enabled: boolean;
};

export const DEFAULT_COLUMNAR_CONFIG: ColumnarConfig = {
  minBytes: 8192,
  enabled: false,
};

function positiveEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function columnarConfig(): ColumnarConfig {
  return {
    minBytes: positiveEnv("OPEN_CONTEXT_MODE_COLUMNAR_MIN_BYTES", DEFAULT_COLUMNAR_CONFIG.minBytes),
    enabled: process.env.OPEN_CONTEXT_MODE_COLUMNAR === "1",
  };
}

// ── Labels ───────────────────────────────────────────────

/** Content-store labels must survive round-tripping through FTS5 lookups. */
function sanitizeLabelSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 80) || "x";
}

/**
 * Stable content-store label for a compacted tool result. It is also the
 * handle the agent gets back, so it must be derivable from the tool call.
 */
export function columnarLabel(tool: string, id: string): string {
  return `cm-columnar/${sanitizeLabelSegment(tool)}/${sanitizeLabelSegment(id)}`;
}

// ── Encoding ─────────────────────────────────────────────

/**
 * The wire type of a value. Empty string means "not a JSON value" (undefined,
 * a function, a symbol) — the payload cannot contain those, and if it somehow
 * does the caller refuses the whole rewrite.
 */
function valueType(value: unknown): string {
  if (value === null) return TYPE_NULL;
  switch (typeof value) {
    case "number":
      return TYPE_NUMBER;
    case "string":
      return TYPE_STRING;
    case "boolean":
      return TYPE_BOOLEAN;
    case "object":
      return Array.isArray(value) ? TYPE_ARRAY : TYPE_OBJECT;
    default:
      return "";
  }
}

function typeCode(types: Set<string>): ColumnarType {
  return TYPE_ORDER.filter((t) => types.has(t)).join("");
}

/**
 * Pack an array of plain objects into the columnar form.
 *
 * Returns null when the rows cannot be packed — no columns at all, or a value
 * that is not a JSON value.
 */
export function packColumnar(rows: Record<string, unknown>[]): ColumnarPacked | null {
  if (rows.length === 0) return null;

  // Column names: the union of every row's keys, in first-seen order.
  const names: string[] = [];
  const index = new Map<string, number>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (index.has(key)) continue;
      index.set(key, names.length);
      names.push(key);
    }
  }
  const width = names.length;
  if (width === 0) return null;

  // Each row's shape: the column indices it carries, in its own key order.
  const rowShapes: number[][] = [];
  for (const row of rows) {
    rowShapes.push(Object.keys(row).map((key) => index.get(key)!));
  }

  // Distinct shapes, in first-seen order.
  const shapes: number[][] = [];
  const shapeIndex = new Map<string, number>();
  const rowShape: number[] = [];
  for (const shape of rowShapes) {
    const key = shape.join(",");
    let at = shapeIndex.get(key);
    if (at === undefined) {
      at = shapes.length;
      shapes.push(shape);
      shapeIndex.set(key, at);
    }
    rowShape.push(at);
  }

  // Per-column type sets. A column that some rows do not carry still has a
  // type: the one its rows agree on.
  const types: Set<string>[] = [];
  for (let c = 0; c < width; c++) types.push(new Set<string>());
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    for (const c of rowShapes[r]) {
      const kind = valueType(row[names[c]]);
      if (!kind) return null;
      types[c].add(kind);
    }
  }

  // Cells: raw values. A number stays a number and a string stays a string.
  const uniform = shapes.length === 1;
  const packedRows: unknown[][] = [];
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    const shape = rowShapes[r];
    const cells: unknown[] = [];
    for (const c of shape) cells.push(row[names[c]]);
    // With one shape every row carries every column, so the cells line up
    // with the header. With several shapes the row leads with its shape
    // index, and the cells follow the shape's order.
    packedRows.push(uniform ? cells : [rowShape[r], ...cells]);
  }

  const packed: ColumnarPacked = {
    _c: names.map((name, i) => [name, typeCode(types[i])] as ColumnarColumn),
    _r: packedRows,
  };
  if (!uniform) packed._s = shapes;
  return packed;
}

/**
 * Rebuild the rows from a packed structure. The inverse of `packColumnar`:
 * same values, same key order.
 */
export function unpackColumnar(packed: ColumnarPacked): Record<string, unknown>[] {
  const columns = Array.isArray(packed?._c) ? packed._c : [];
  const rows = Array.isArray(packed?._r) ? packed._r : [];
  const shapes = Array.isArray(packed?._s) ? packed._s : null;
  const out: Record<string, unknown>[] = [];
  for (const raw of rows) {
    const cells = Array.isArray(raw) ? raw : [];
    let shape: number[];
    let values: unknown[];
    if (shapes) {
      const at = Number(cells[0]);
      shape = Array.isArray(shapes[at]) ? shapes[at] : [];
      values = cells.slice(1);
    } else {
      shape = columns.map((_, i) => i);
      values = cells;
    }
    const obj: Record<string, unknown> = {};
    for (let k = 0; k < shape.length; k++) {
      const column = columns[shape[k]];
      if (!column) continue;
      obj[column[0]] = values[k];
    }
    out.push(obj);
  }
  return out;
}

/**
 * Parse a compact columnar payload and rebuild the original rows.
 *
 * Returns null when the text is not a packed structure — a malformed payload
 * is never a rewrite, it is a refusal.
 */
export function expandColumnar(text: string): Record<string, unknown>[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const packed = parsed as ColumnarPacked;
  if (!Array.isArray(packed._c) || !Array.isArray(packed._r)) return null;
  return unpackColumnar(packed);
}

/**
 * Strict equality — value AND key order, with `Object.is` semantics for
 * primitives so that -0 and 0 are not the same number.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i]) return false;
    if (!deepEqual((a as Record<string, unknown>)[ka[i]], (b as Record<string, unknown>)[kb[i]])) return false;
  }
  return true;
}

// ── Plan ─────────────────────────────────────────────────

export type ColumnarPlan = {
  /** The compact JSON text — `JSON.parse` gives the packed structure. */
  compacted: string;
  /** What goes into the transcript: the marker, then the compact JSON. */
  replacement: string;
  /** The content-store label that holds the ORIGINAL bytes. */
  label: string;
  originalBytes: number;
  replacementBytes: number;
  /** Bytes the rewrite keeps out of every replay of this result. */
  avoidedBytes: number;
  rows: number;
  columns: number;
};

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${n}B`;
}

/**
 * The pointer the model gets back. Same shape as the marker `history-elide.ts`
 * writes: what happened, where the original lives, how to ask for it.
 */
function columnarMarker(label: string, originalBytes: number, keptBytes: number, rows: number, columns: number): string {
  return (
    `[open-context-mode] ${formatBytes(originalBytes)} of this tool result was compacted into columnar form and indexed as source "${label}". ` +
    `Retrieve the original bytes with open_ctx_search(queries: ["<what you need>"], source: "${label}"). ` +
    `${formatBytes(keptBytes)} kept (${rows} rows, ${columns} columns).`
  );
}

/**
 * Compute the compaction for a JSON payload. Pure: nothing is written and
 * nothing is indexed.
 *
 * Returns null — the payload stays byte-identical — when:
 *   - the payload is smaller than `minBytes`;
 *   - the payload is not valid JSON;
 *   - the payload is not an array of objects;
 *   - the round-trip check does not reproduce the original exactly;
 *   - the replacement would not be smaller than what it replaces.
 */
export function planColumnar(text: string, opts: { label: string; minBytes: number }): ColumnarPlan | null {
  const originalBytes = Buffer.byteLength(text, "utf8");
  if (originalBytes < opts.minBytes) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Malformed JSON is never rewritten — there is nothing to compact.
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  if (parsed.length === 0) return null;

  const rows: Record<string, unknown>[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    rows.push(entry as Record<string, unknown>);
  }

  const packed = packColumnar(rows);
  if (!packed) return null;

  let compacted: string;
  try {
    compacted = JSON.stringify(packed);
  } catch {
    return null;
  }

  // Proof of reversibility, on the bytes that actually ship: re-parse the
  // compact JSON, rebuild, and compare against the original — value AND key
  // order. If the rebuild is not identical, the payload is refused.
  let rebuilt: Record<string, unknown>[];
  try {
    rebuilt = unpackColumnar(JSON.parse(compacted) as ColumnarPacked);
  } catch {
    return null;
  }
  if (!deepEqual(rebuilt, rows)) return null;

  const compactedBytes = Buffer.byteLength(compacted, "utf8");
  const replacement = `${columnarMarker(opts.label, originalBytes, compactedBytes, packed._r.length, packed._c.length)}\n${compacted}`;
  const replacementBytes = Buffer.byteLength(replacement, "utf8");
  // A rewrite that does not pay for itself is a rewrite the model has to
  // re-learn for nothing.
  if (replacementBytes >= originalBytes) return null;

  return {
    compacted,
    replacement,
    label: opts.label,
    originalBytes,
    replacementBytes,
    avoidedBytes: originalBytes - replacementBytes,
    rows: packed._r.length,
    columns: packed._c.length,
  };
}

/**
 * Two-phase compaction, mirroring `elideToolResults`: plan first, index the
 * ORIGINAL bytes second, and only then is the rewrite handed back.
 *
 * `index` must resolve to true only once the bytes are durably in the content
 * store. A false return, a rejected promise, or a throw all leave the
 * transcript byte-identical — a pointer to bytes that are not there is worse
 * than no reduction at all.
 */
export async function compactWithIndex(
  text: string,
  opts: { label: string; minBytes: number },
  index: (text: string, label: string) => boolean | Promise<boolean>,
): Promise<ColumnarPlan | null> {
  const plan = planColumnar(text, opts);
  if (!plan) return null;
  let stored: boolean;
  try {
    stored = (await index(text, plan.label)) === true;
  } catch {
    stored = false;
  }
  if (!stored) return null;
  return plan;
}

// ── Tool result shape ────────────────────────────────────

export type ColumnarRewrite = {
  /** The original payload text — this is what has to be indexed. */
  original: string;
  /** The replacement text. */
  replacement: string;
  /** Write the replacement into `result.content[0].text`. */
  content: boolean;
  /** Write the replacement into `result.output`. */
  output: boolean;
  avoidedBytes: number;
  label: string;
  rows: number;
  columns: number;
};

type ResultShape = {
  output?: unknown;
  content?: unknown;
};

/**
 * Find the JSON payload in a v2 tool result and plan its compaction.
 *
 * Only a single text part counts: a result that also carries a file or an
 * image must survive untouched, and collapsing several text parts into one
 * would change what the host hands the model.
 */
export function planToolResultColumnar(result: unknown, opts: { label: string; minBytes: number }): ColumnarRewrite | null {
  if (!result || typeof result !== "object") return null;
  const shape = result as ResultShape;

  let contentText: string | null = null;
  if (Array.isArray(shape.content) && shape.content.length === 1) {
    const part = shape.content[0] as { type?: unknown; text?: unknown } | null;
    if (part && part.type === "text" && typeof part.text === "string") contentText = part.text;
  }
  const outputText = typeof shape.output === "string" ? shape.output : null;

  const sameText = contentText !== null && outputText !== null && outputText === contentText;
  const contentPlan = contentText === null ? null : planColumnar(contentText, opts);
  const outputPlan = outputText === null || sameText ? null : planColumnar(outputText, opts);

  if (contentPlan) {
    return {
      original: contentText!,
      replacement: contentPlan.replacement,
      // When the host's `output` carries the same bytes it has to be rewritten
      // too, or the model would still see the original payload.
      content: true,
      output: sameText,
      avoidedBytes: contentPlan.avoidedBytes,
      label: contentPlan.label,
      rows: contentPlan.rows,
      columns: contentPlan.columns,
    };
  }
  if (outputPlan) {
    return {
      original: outputText!,
      replacement: outputPlan.replacement,
      content: false,
      output: true,
      avoidedBytes: outputPlan.avoidedBytes,
      label: outputPlan.label,
      rows: outputPlan.rows,
      columns: outputPlan.columns,
    };
  }
  return null;
}

/**
 * Two-phase compaction at the tool-result level: plan first, index the
 * ORIGINAL bytes second, and only then is the rewrite handed back.
 *
 * `index` must resolve to true only once the bytes are durably in the content
 * store. A false return, a rejected promise, or a throw all leave the result
 * byte-identical — a pointer to bytes that are not there is worse than no
 * reduction at all.
 */
export async function compactToolResultWithIndex(
  result: unknown,
  opts: { label: string; minBytes: number },
  index: (text: string, label: string) => boolean | Promise<boolean>,
): Promise<ColumnarRewrite | null> {
  const rewrite = planToolResultColumnar(result, opts);
  if (!rewrite) return null;
  let stored: boolean;
  try {
    stored = (await index(rewrite.original, rewrite.label)) === true;
  } catch {
    stored = false;
  }
  if (!stored) return null;
  return rewrite;
}
