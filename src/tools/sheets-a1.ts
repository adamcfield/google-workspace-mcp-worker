/**
 * A1-notation, GridRange and formula-reference helpers shared by the Sheets
 * tools (write verification, dry-run summaries, audit, precedent tracing,
 * address-keyed reads).
 * Pure functions — unit-tested in tests/sheets-a1.test.ts.
 */
import type { AnyRec } from "./_shared.js";

/** 1-based column number → letters (1 → A, 27 → AA). */
export function colToLetters(n: number): string {
  let s = "";
  let x = n;
  while (x > 0) {
    const r = (x - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s;
}

/** Letters → 1-based column number (A → 1, AA → 27). */
export function lettersToCol(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

export const cellA1 = (row: number, col: number): string => `${colToLetters(col)}${row}`;

/** Quote a sheet title for A1 notation when needed (spaces, non-ASCII, punctuation; apostrophes doubled). */
export function quoteSheet(title: string): string {
  return /^[A-Za-z0-9_]+$/.test(title) ? title : `'${title.replace(/'/g, "''")}'`;
}

/**
 * A whole tab as a `ranges` value: always quoted. Unquoted, a title that reads like a cell (Q1, Jan2024,
 * FY24) is that cell on the first visible sheet, and one shared with a named range is the named range.
 */
export const wholeTabRange = (title: string): string => `'${title.replace(/'/g, "''")}'`;

export interface A1Range {
  sheet?: string;
  /** 1-based, inclusive. Undefined end = single cell; undefined row/col = whole column/row. */
  startCol?: number;
  startRow?: number;
  endCol?: number;
  endRow?: number;
}

const CELL_RE = /^\$?([A-Za-z]{1,3})?\$?(\d+)?$/;

/** Parse "'My sheet'!A1:C10", "Sheet1!A:A", "B5", "3:3" or a bare sheet name. */
export function parseA1(range: string): A1Range {
  let s = range.trim();
  let sheet: string | undefined;
  const q = /^'((?:[^']|'')*)'!(.*)$/.exec(s);
  if (q) {
    sheet = q[1].replace(/''/g, "'");
    s = q[2];
  } else {
    const bang = s.lastIndexOf("!");
    if (bang > 0) {
      sheet = s.slice(0, bang);
      s = s.slice(bang + 1);
    }
  }
  if (!s) return { sheet };
  const [a, b] = s.split(":");
  const ma = CELL_RE.exec(a);
  const mb = b !== undefined ? CELL_RE.exec(b) : null;
  if (!ma || (b !== undefined && !mb) || (!ma[1] && !ma[2])) {
    // Not a cell reference — treat the whole thing as a sheet name.
    return { sheet: range.trim().replace(/^'|'$/g, "").replace(/''/g, "'") };
  }
  const out: A1Range = { sheet };
  if (ma[1]) out.startCol = lettersToCol(ma[1]);
  if (ma[2]) out.startRow = Number(ma[2]);
  if (mb) {
    if (mb[1]) out.endCol = lettersToCol(mb[1]);
    if (mb[2]) out.endRow = Number(mb[2]);
  } else {
    out.endCol = out.startCol;
    out.endRow = out.startRow;
  }
  return out;
}

/** Where a values grid sits: 1-based top-left plus the size of each bounded dimension. */
export interface GridOrigin {
  row: number;
  col: number;
  /** Undefined when the range is open-ended in that dimension (`A:D` has no row count). */
  rows?: number;
  cols?: number;
}

/**
 * The top-left and size of the A1 range Google echoed back with a values read (`ValueRange.range`,
 * already resolved: a named range or a bare tab name comes back as `'Tab'!A1:Z1000`). An
 * open-ended dimension starts at its first row/column — `A:D` at A1, `2:5` at A2.
 *
 * Throws when the range has no coordinates at all: a bare word could be a tab OR a named range,
 * and assuming A1 would silently misplace every cell — the very error cell addresses exist to prevent.
 */
export function gridOrigin(range: string): GridOrigin {
  const r = parseA1(range);
  if (r.startCol === undefined && r.startRow === undefined) throw new Error(`Cannot tell where "${range}" starts — no cell coordinates; read it with shape=grid.`);
  const span = (a: number | undefined, b: number | undefined) => (a === undefined || b === undefined ? { start: a ?? b ?? 1 } : { start: Math.min(a, b), size: Math.abs(b - a) + 1 });
  const rows = span(r.startRow, r.endRow);
  const cols = span(r.startCol, r.endCol);
  return { row: rows.start, col: cols.start, rows: rows.size, cols: cols.size };
}

/**
 * One addressed cell of a values read; `formula` only when the formula grid was read and the
 * cell has one. `value` is absent only on a formula cell that displays as blank.
 */
export interface AddressedCell {
  value?: unknown;
  formula?: string;
}

export interface AddressedGrid {
  /** Size of the echoed range (the extent of the returned data for an open-ended dimension). */
  rowCount: number;
  columnCount: number;
  /** Non-empty cells in the range — all of them, also when `cells` was cut. Reported next to `cells` because strip() drops an empty `{}`. */
  cellCount: number;
  /** Set only when the budget ran out before every non-empty cell was added. */
  truncated?: true;
  /** How many of `cellCount` are in `cells` — set only when `truncated`. */
  returnedCells?: number;
  cells: Record<string, AddressedCell>;
}

/**
 * Characters left for addressed cells in one reply. Mutable so several ranges of one batch
 * read draw on the same reply: each call of cellsByAddress takes what its cells cost.
 */
export interface CharBudget {
  left: number;
}

/**
 * Exactly what one addressed entry adds to the serialized cells object: `"D7":{…},`
 * (addresses are ASCII, so quoting one adds two characters). Summed over n entries, that is the
 * JSON length of the object minus one.
 */
export function entryChars(address: string, cell: unknown): number {
  return address.length + 4 + JSON.stringify(cell).length;
}

const isEmpty = (v: unknown) => v === undefined || v === null || v === "";

/**
 * Key a values.get / values.batchGet grid by unqualified A1 address ("D7"), keeping only
 * non-empty cells. Positional rows are easy to misread: Google drops trailing empty cells (and
 * trailing empty rows), and a range that starts at C5 puts column C at index 0. Addresses are
 * computed from `range` — the range Google echoed — so neither can shift a column.
 *
 * `formulas` is the same grid read with valueRenderOption=FORMULA; a cell whose entry there
 * starts with "=" gets `formula`, and such a cell is kept even when it displays as blank (then
 * it has no `value` key at all). `majorDimension: "COLUMNS"` means `values[i]` is column i, not row i.
 *
 * `budget` bounds what is BUILT, not only what is sent: a whole-tab read can hold hundreds of
 * thousands of cells, and one object per cell (then strip()'s copy of each, then the JSON) is
 * enough to run an isolate out of memory, while ok() would keep only the first MAX_OUTPUT_CHARS
 * of it anyway. Cells are added in read order until the next one does not fit; from there on
 * they are only counted, and the result says `truncated` with `returnedCells`. The cells are
 * always a prefix — a later, shorter cell is never squeezed in after a gap.
 */
export function cellsByAddress(range: string, values: unknown[][] = [], opts: { majorDimension?: string; formulas?: unknown[][]; budget?: CharBudget } = {}): AddressedGrid {
  const origin = gridOrigin(range);
  const byColumn = opts.majorDimension === "COLUMNS";
  const formulas = opts.formulas ?? [];
  const budget = opts.budget ?? { left: Infinity };
  const cells: Record<string, AddressedCell> = {};
  let cellCount = 0;
  let returned = 0;
  let full = false;
  let innerExtent = 0;
  const outer = Math.max(values.length, formulas.length);
  for (let i = 0; i < outer; i++) {
    const vs = values[i] ?? [];
    const fs = formulas[i] ?? [];
    const inner = Math.max(vs.length, fs.length);
    for (let j = 0; j < inner; j++) {
      const value = vs[j];
      const f = fs[j];
      const formula = typeof f === "string" && f.startsWith("=") ? f : undefined;
      const blank = isEmpty(value);
      if (blank && !formula) continue;
      cellCount++;
      if (full) continue;
      const address = cellA1(origin.row + (byColumn ? j : i), origin.col + (byColumn ? i : j));
      const cell: AddressedCell = formula ? (blank ? { formula } : { value, formula }) : { value };
      const size = entryChars(address, cell);
      if (size > budget.left) {
        full = true;
        continue;
      }
      budget.left -= size;
      cells[address] = cell;
      returned++;
    }
    innerExtent = Math.max(innerExtent, inner);
  }
  const [rowExtent, colExtent] = byColumn ? [innerExtent, outer] : [outer, innerExtent];
  const cut = returned < cellCount ? { truncated: true as const, returnedCells: returned } : {};
  return { rowCount: origin.rows ?? rowExtent, columnCount: origin.cols ?? colExtent, cellCount, ...cut, cells };
}

/** GridRange (0-based, end-exclusive) → A1 string using a sheetId→title map. */
export function gridRangeToA1(gr: AnyRec | undefined, titles: Map<number, string>): string {
  if (!gr) return "";
  const title = titles.get(Number(gr.sheetId)) ?? `sheet#${gr.sheetId ?? "?"}`;
  const sc = gr.startColumnIndex, ec = gr.endColumnIndex, sr = gr.startRowIndex, er = gr.endRowIndex;
  const colPart = (i: number | undefined) => (i === undefined ? "" : colToLetters(i + 1));
  const rowPart = (i: number | undefined) => (i === undefined ? "" : String(i + 1));
  if (sc === undefined && sr === undefined && ec === undefined && er === undefined) return quoteSheet(title);
  const start = `${colPart(sc)}${rowPart(sr)}`;
  const end = `${ec === undefined ? colPart(sc) : colToLetters(ec)}${er === undefined ? rowPart(sr) : String(er)}`;
  // Whole rows/columns are always written as a range (5:5, C:C); a single bounded cell collapses.
  const single = start === end && sc !== undefined && sr !== undefined;
  return `${quoteSheet(title)}!${start}${single ? "" : `:${end}`}`;
}

/** Number of cells in a GridRange given the sheet's grid size (whole-row/column ranges use it). */
export function gridRangeCells(gr: AnyRec | undefined, grid?: { rowCount?: number; columnCount?: number }): number {
  if (!gr) return 0;
  const rows = (gr.endRowIndex ?? grid?.rowCount ?? 0) - (gr.startRowIndex ?? 0);
  const cols = (gr.endColumnIndex ?? grid?.columnCount ?? 0) - (gr.startColumnIndex ?? 0);
  return Math.max(0, rows) * Math.max(0, cols);
}

// ---- formula references -----------------------------------------------------

export interface FormulaRef {
  /** Text exactly as it appears in the formula. */
  text: string;
  sheet?: string;
  range: A1Range;
  /** Named range (no A1 shape). */
  name?: string;
}

// Range bodies: A1 · A1:B2 · A1:B (cell → whole column) · A:A · A:B5 · 3:5. A bare
// letters-only token needs a colon so words are never mistaken for columns.
const RANGE_BODY = String.raw`\$?[A-Za-z]{1,3}\$?\d+(?::\$?[A-Za-z]{1,3}(?:\$?\d+)?)?|\$?[A-Za-z]{1,3}:\$?[A-Za-z]{1,3}(?:\$?\d+)?|\$?\d+:\$?\d+`;
// Sheet names are bounded by Google's 100-character tab title limit (200 UTF-16 units quoted, where ''
// counts once): unbounded, the name was retried from every character of a long run of name characters
// or apostrophes to its end — quadratic in the run, 1.3 s for one 50,000-character formula. Every real
// tab name still matches as before.
const REF_RE = new RegExp(
  String.raw`(?:'((?:[^']|''){1,200})'|([A-Za-z0-9_.À-ɏ֐-׿؀-ۿ]{1,100}))!(${RANGE_BODY})|(?<![A-Za-z0-9_.])(${RANGE_BODY})(?![A-Za-z0-9_(])`,
  "g",
);

/** Strip string literals so their contents are not parsed as references. */
const stripStrings = (f: string) => f.replace(/"(?:[^"]|"")*"/g, (m) => " ".repeat(m.length));

/**
 * Extract cell/range references from a formula (sheet-qualified or not),
 * plus named ranges when `names` is provided. Function names like LOG10( are excluded.
 * Pass a Set when calling per cell: it is used as is, not copied, so the cost stays linear in the formula.
 */
export function extractRefs(formula: string, names: Iterable<string> = []): FormulaRef[] {
  if (!formula.startsWith("=")) return [];
  const src = stripStrings(formula);
  const out: FormulaRef[] = [];
  for (const m of src.matchAll(REF_RE)) {
    const sheet = m[1] !== undefined ? m[1].replace(/''/g, "'") : m[2];
    const body = m[3] ?? m[4];
    if (!body) continue;
    const range = parseA1(body);
    if (range.startCol === undefined && range.startRow === undefined) continue;
    out.push({ text: m[0], sheet, range });
  }
  const nameSet = names instanceof Set ? (names as ReadonlySet<string>) : new Set(names);
  if (nameSet.size) {
    for (const m of src.matchAll(/(?<![A-Za-z0-9_.!'])([A-Za-z_][A-Za-z0-9_.]*)(?![A-Za-z0-9_(!])/g)) {
      if (nameSet.has(m[1])) out.push({ text: m[1], range: {}, name: m[1] });
    }
  }
  return out;
}

/** Rewrite a formula's A1 references relative to (row, col) into R1C1 so structurally identical formulas compare equal. */
export function toR1C1(formula: string, row: number, col: number): string {
  if (!formula.startsWith("=")) return formula;
  const conv = (ref: string) => {
    const m = /^(\$?)([A-Za-z]{1,3})?(\$?)(\d+)?$/.exec(ref);
    if (!m) return ref;
    let out = "";
    if (m[4]) out += m[3] ? `R${m[4]}` : `R[${Number(m[4]) - row}]`;
    if (m[2]) out += m[1] ? `C${lettersToCol(m[2])}` : `C[${lettersToCol(m[2]) - col}]`;
    return out;
  };
  return formula.replace(REF_RE, (whole, q, bare, qualified, plain) => {
    const body: string = qualified ?? plain;
    const prefix = qualified !== undefined ? whole.slice(0, whole.length - body.length) : "";
    void q;
    void bare;
    return prefix + body.split(":").map(conv).join(":");
  });
}

/** Does range `r` (same sheet assumed) contain the cell (row, col)? Whole-row/column ranges handled. */
export function rangeContains(r: A1Range, row: number, col: number): boolean {
  const sc = r.startCol ?? 1, ec = r.endCol ?? r.startCol ?? Number.MAX_SAFE_INTEGER;
  const sr = r.startRow ?? 1, er = r.endRow ?? r.startRow ?? Number.MAX_SAFE_INTEGER;
  return col >= Math.min(sc, ec) && col <= Math.max(sc, ec) && row >= Math.min(sr, er) && row <= Math.max(sr, er);
}

/** Size of an A1 range in cells (unbounded dimensions count as `unbounded`). */
export function a1Cells(r: A1Range, unbounded = 1_000_000): number {
  const cols = r.startCol === undefined ? unbounded : Math.abs((r.endCol ?? r.startCol) - r.startCol) + 1;
  const rows = r.startRow === undefined ? unbounded : Math.abs((r.endRow ?? r.startRow) - r.startRow) + 1;
  return cols * rows;
}

/** Google color {red,green,blue,alpha} (0-1 floats) → "#rrggbb" (or "#rrggbbaa" when alpha < 1). */
export function colorHex(c: AnyRec | undefined): string | undefined {
  if (!c || typeof c !== "object") return undefined;
  const ch = (v: unknown) => Math.round(Math.min(1, Math.max(0, Number(v ?? 0))) * 255).toString(16).padStart(2, "0");
  const hex = `#${ch(c.red)}${ch(c.green)}${ch(c.blue)}`;
  return typeof c.alpha === "number" && c.alpha < 1 ? `${hex}${ch(c.alpha)}` : hex;
}

/** Compact a CellFormat: hex colors, no colorStyle duplicates, identical borders collapsed to `all`. */
export function compactFormat(f: AnyRec | undefined, want: Set<string>): AnyRec | undefined {
  if (!f) return undefined;
  const out: AnyRec = {};
  if (want.has("number_format") && f.numberFormat) out.numberFormat = f.numberFormat.pattern ? `${f.numberFormat.type}:${f.numberFormat.pattern}` : f.numberFormat.type;
  if (want.has("fill") && f.backgroundColor) out.bg = colorHex(f.backgroundColor);
  if (want.has("text") && f.textFormat) {
    const t = f.textFormat;
    const tf: AnyRec = {};
    if (t.bold) tf.bold = true;
    if (t.italic) tf.italic = true;
    if (t.strikethrough) tf.strike = true;
    if (t.underline) tf.underline = true;
    if (t.fontSize) tf.size = t.fontSize;
    if (t.fontFamily) tf.font = t.fontFamily;
    const color = colorHex(t.foregroundColor);
    if (color && color !== "#000000") tf.color = color;
    if (t.link?.uri) tf.link = t.link.uri;
    if (Object.keys(tf).length) out.text = tf;
  }
  if (want.has("align")) {
    if (f.horizontalAlignment) out.hAlign = f.horizontalAlignment;
    if (f.verticalAlignment) out.vAlign = f.verticalAlignment;
    if (f.wrapStrategy) out.wrap = f.wrapStrategy;
    if (f.textDirection) out.dir = f.textDirection;
  }
  if (want.has("borders") && f.borders) {
    const side = (b: AnyRec | undefined) => (b && b.style && b.style !== "NONE" ? `${b.style}${b.width && b.width !== 1 ? `x${b.width}` : ""}${colorHex(b.color) && colorHex(b.color) !== "#000000" ? ` ${colorHex(b.color)}` : ""}` : undefined);
    const sides: AnyRec = { top: side(f.borders.top), bottom: side(f.borders.bottom), left: side(f.borders.left), right: side(f.borders.right) };
    const vals = Object.values(sides);
    if (vals.every((v) => v !== undefined) && new Set(vals).size === 1) out.borders = { all: vals[0] };
    else if (vals.some((v) => v !== undefined)) out.borders = Object.fromEntries(Object.entries(sides).filter(([, v]) => v !== undefined));
  }
  return Object.keys(out).length ? out : undefined;
}
