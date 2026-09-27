/**
 * Sheets write verification and batchUpdate change summaries.
 *
 * - verifyCells(): after a write, re-read the written range(s) and report every
 *   cell whose effective value is an error (#REF!, #DIV/0!, #N/A, …) with
 *   Google's message — a silent write of a broken formula becomes visible.
 * - describeRequests(): a human-readable plan for spreadsheets.batchUpdate
 *   requests (what each one touches and how), used for dry runs and for the
 *   post-apply summary (Google returns empty replies for most request types).
 * - writeValues: the one pseudo-request sheets_batch_update_spreadsheet accepts, translated into
 *   updateCells so a value write and a structural change ride in ONE ordered, atomic batch.
 * - Deletion previews, the post-structural-change error check and grouped warnings for that tool;
 *   the bounded grid reads they share with sheets_delete_sheet's check (gridReadTabs); and the
 *   pre-change snapshot that tool, sheets_delete_sheet and sheets_clear_range all take. Grids and
 *   resolved formulas come from sheets-analysis.ts (type-only import here: that module imports
 *   this one at runtime, so its loader and resolver are passed in).
 */
import type { GoogleClient } from "../google/client.js";
import { API, GoogleApiError, ResponseTooLargeError, formatBytes } from "../google/client.js";
import { audit, enc, type AnyRec } from "./_shared.js";
import { cellA1, colToLetters, gridRangeToA1, gridRangeCells, parseA1, quoteSheet, wholeTabRange } from "./sheets-a1.js";
import type { A1Range } from "./sheets-a1.js";
import type { ResolvedFormula, SheetGrid } from "./sheets-analysis.js";

export interface SheetMeta {
  titles: Map<number, string>;
  ids: Map<string, number>;
  grids: Map<number, { rowCount?: number; columnCount?: number }>;
  /** Each range's sheetId is always set: getSheetMeta reads a missing one as sheet 0, as Google means it. */
  namedRanges: { name: string; range: AnyRec & { sheetId: number } }[];
}

export async function getSheetMeta(g: GoogleClient, spreadsheetId: string): Promise<SheetMeta> {
  const r = await g.get<AnyRec>(`${API.sheets}/spreadsheets/${enc(spreadsheetId)}`, {
    fields: "sheets(properties(sheetId,title,gridProperties(rowCount,columnCount))),namedRanges(name,range)",
  });
  const meta: SheetMeta = { titles: new Map(), ids: new Map(), grids: new Map(), namedRanges: [] };
  for (const s of (r.sheets ?? []) as AnyRec[]) {
    const p = s.properties ?? {};
    meta.titles.set(Number(p.sheetId), String(p.title));
    meta.ids.set(String(p.title), Number(p.sheetId));
    meta.grids.set(Number(p.sheetId), p.gridProperties ?? {});
  }
  // Google's JSON leaves out a field at its zero value, so a named range on the first tab (sheetId 0) comes back
  // without sheetId — and a GridRange without one means sheet 0. Read it that way here, once, for every consumer.
  for (const n of (r.namedRanges ?? []) as AnyRec[]) meta.namedRanges.push({ name: String(n.name), range: { ...(n.range ?? {}), sheetId: Number(n.range?.sheetId ?? 0) } });
  return meta;
}

/** Cell fields of a verify re-read: the effective value, which says both whether a cell holds a value and whether it is an error. */
export const VERIFY_CELL_FIELDS = "effectiveValue";

export interface CellError {
  cell: string;
  type?: string;
  message?: string;
}
export interface Verification {
  cells: number;
  errors: CellError[];
  ok: boolean;
}

/**
 * Re-read ranges (A1) and list error cells. `cells` counts cells that carry any value.
 *
 * Each cell is asked for its effective value only: whether a cell carries a value and whether that
 * value is an error both come from it. The formatted value is the same content again (a text cell's
 * text twice), so it is not asked for. `maxBytes` refuses a larger response while it streams
 * (ResponseTooLargeError), as the grid reads do; the one-range write tools pass none.
 */
export async function verifyCells(g: GoogleClient, spreadsheetId: string, ranges: string[], opts: { maxBytes?: number } = {}): Promise<Verification> {
  const clean = ranges.filter((r) => typeof r === "string" && r.trim());
  if (!clean.length) return { cells: 0, errors: [], ok: true };
  const bounded = opts.maxBytes !== undefined;
  const r = await g.get<AnyRec>(
    `${API.sheets}/spreadsheets/${enc(spreadsheetId)}`,
    {
      ranges: clean,
      includeGridData: true,
      fields: `sheets(properties(title),data(startRow,startColumn,rowData(values(${VERIFY_CELL_FIELDS}))))`,
      // A bounded read counts content, not indentation (as in loadGrids).
      prettyPrint: bounded ? false : undefined,
    },
    bounded ? { maxBytes: opts.maxBytes } : undefined,
  );
  const errors: CellError[] = [];
  let cells = 0;
  for (const sheet of (r.sheets ?? []) as AnyRec[]) {
    const title = String(sheet.properties?.title ?? "");
    for (const block of (sheet.data ?? []) as AnyRec[]) {
      const r0 = Number(block.startRow ?? 0), c0 = Number(block.startColumn ?? 0);
      (block.rowData ?? []).forEach((row: AnyRec, ri: number) => {
        (row.values ?? []).forEach((cell: AnyRec, ci: number) => {
          if (!cell || cell.effectiveValue === undefined) return;
          cells++;
          const ev = cell.effectiveValue?.errorValue;
          if (ev) errors.push({ cell: `${quoteSheet(title)}!${cellA1(r0 + ri + 1, c0 + ci + 1)}`, type: ev.type, message: ev.message });
        });
      });
    }
  }
  return { cells, errors, ok: errors.length === 0 };
}

export interface RequestSummary {
  index: number;
  type: string;
  sheet?: string;
  range?: string;
  cells?: number;
  /** Rows/columns affected by dimension requests. */
  count?: number;
  effect: string;
  warning?: string;
  /** Set on dry runs for destructive/overwriting requests: current contents of the affected range. */
  preview?: unknown;
  /** Google's reply for this request (only when non-empty). */
  reply?: unknown;
}

const DIM = (d: unknown) => (String(d ?? "ROWS").toUpperCase() === "COLUMNS" ? "columns" : "rows");

function dimSpan(range: AnyRec | undefined, meta: SheetMeta): { label: string; n: number } {
  const start = Number(range?.startIndex ?? 0), end = Number(range?.endIndex ?? start + 1);
  const n = Math.max(0, end - start);
  const isCols = DIM(range?.dimension) === "columns";
  const a = isCols ? colToLetters(start + 1) : String(start + 1);
  const b = isCols ? colToLetters(end) : String(end);
  void meta;
  return { label: n === 1 ? a : `${a}-${b}`, n };
}

/** Describe one batchUpdate request. Pure; `meta` resolves sheet ids and grid sizes. */
export function describeRequest(req: AnyRec, index: number, meta: SheetMeta): RequestSummary {
  const type = Object.keys(req)[0] ?? "unknown";
  const body: AnyRec = req[type] ?? {};
  const sheetOf = (id: unknown) => (id === undefined || id === null ? undefined : (meta.titles.get(Number(id)) ?? `sheet#${id}`));
  const gr: AnyRec | undefined = body.range && typeof body.range === "object" && "sheetId" in body.range && !("dimension" in body.range) ? body.range : undefined;
  const out: RequestSummary = { index, type, effect: type };
  if (gr) {
    out.sheet = sheetOf(gr.sheetId);
    out.range = gridRangeToA1(gr, meta.titles);
    out.cells = gridRangeCells(gr, meta.grids.get(Number(gr.sheetId)));
  }
  const fields = typeof body.fields === "string" ? body.fields : undefined;
  switch (type) {
    case "insertDimension": {
      const { label, n } = dimSpan(body.range, meta);
      out.sheet = sheetOf(body.range?.sheetId);
      out.count = n;
      out.effect = `insert ${n} ${DIM(body.range?.dimension)} at ${label} (existing ${DIM(body.range?.dimension)} from there shift; references adjust automatically)`;
      out.warning = "shifts everything below/right of the insertion point";
      break;
    }
    case "deleteDimension": {
      const { label, n } = dimSpan(body.range, meta);
      out.sheet = sheetOf(body.range?.sheetId);
      out.count = n;
      out.effect = `delete ${n} ${DIM(body.range?.dimension)} (${label}) — their contents are lost, formulas pointing at them become #REF!`;
      out.warning = "destructive";
      break;
    }
    case "appendDimension":
      out.sheet = sheetOf(body.sheetId);
      out.count = Number(body.length ?? 1);
      out.effect = `append ${body.length ?? 1} ${DIM(body.dimension)} at the end of the sheet`;
      break;
    case "moveDimension": {
      const { label, n } = dimSpan(body.source, meta);
      out.sheet = sheetOf(body.source?.sheetId);
      out.count = n;
      out.effect = `move ${n} ${DIM(body.source?.dimension)} (${label}) to before index ${Number(body.destinationIndex ?? 0) + 1}`;
      out.warning = "shifts references";
      break;
    }
    case "insertRange":
      out.effect = `insert empty cells at ${out.range}, shifting existing cells ${DIM(body.shiftDimension) === "rows" ? "down" : "right"}`;
      out.warning = "shifts references";
      break;
    case "deleteRange":
      out.effect = `delete cells ${out.range}, shifting the rest ${DIM(body.shiftDimension) === "rows" ? "up" : "left"} — contents lost`;
      out.warning = "destructive";
      break;
    case "repeatCell": {
      // The field mask decides what is replaced, not the cell: under '*' (or a mask naming userEnteredValue)
      // a cell that carries only a format still clears every value in the range.
      const coversValue = /userEnteredValue/.test(fields ?? "") || (fields ?? "").split(",").some((f) => f.trim() === "*");
      const setsValue = !!body.cell?.userEnteredValue;
      const setsOther = Object.keys(body.cell ?? {}).some((k) => k !== "userEnteredValue");
      if (!coversValue) out.effect = `apply format to ${out.cells} cells (${out.range}; fields: ${fields ?? "*"})`;
      else if (setsValue) out.effect = `write the same value into ${out.cells} cells (${out.range}) — existing values overwritten`;
      else if (setsOther) out.effect = `apply format to ${out.cells} cells (${out.range}; fields: ${fields}) — fields '${fields}' also clears their values`;
      else out.effect = `clear the values of ${out.cells} cells (${out.range}; fields: ${fields})`;
      if (coversValue) out.warning = "overwrites values";
      break;
    }
    case "updateCells": {
      const rows = (body.rows ?? []) as AnyRec[];
      const n = rows.reduce((acc, r) => acc + ((r.values ?? []) as unknown[]).length, 0);
      const nCols = rows.reduce((m, r) => Math.max(m, ((r.values ?? []) as unknown[]).length), 0);
      if (body.start) {
        // The written block spans rows.length × widest row from `start` — the whole block must be verified, not just the anchor cell.
        const r0 = Number(body.start.rowIndex ?? 0), c0 = Number(body.start.columnIndex ?? 0);
        out.sheet = sheetOf(body.start.sheetId);
        out.range = gridRangeToA1({ sheetId: body.start.sheetId, startRowIndex: r0, endRowIndex: r0 + Math.max(1, rows.length), startColumnIndex: c0, endColumnIndex: c0 + Math.max(1, nCols) }, meta.titles);
      }
      out.cells = n || out.cells;
      out.effect = `update ${out.cells ?? "?"} cells at ${out.range ?? "?"} (fields: ${fields ?? "*"})${/userEnteredValue/.test(fields ?? "*") ? " — values overwritten" : ""}`;
      if (/userEnteredValue|\*/.test(fields ?? "*")) out.warning = "overwrites values";
      break;
    }
    case "updateBorders":
      out.effect = `set borders on ${out.cells} cells (${out.range})`;
      break;
    case "mergeCells":
      out.effect = `merge ${out.range} (${body.mergeType ?? "MERGE_ALL"}) — only the top-left value is kept`;
      out.warning = "values other than the top-left cell are dropped";
      break;
    case "unmergeCells":
      out.effect = `unmerge ${out.range}`;
      break;
    case "addConditionalFormatRule":
      out.effect = `add conditional format rule on ${(body.rule?.ranges ?? []).map((r: AnyRec) => gridRangeToA1(r, meta.titles)).join(", ") || "?"}`;
      break;
    case "updateConditionalFormatRule":
      out.effect = `update conditional format rule #${body.index} on sheet ${sheetOf(body.sheetId)}`;
      break;
    case "deleteConditionalFormatRule":
      out.effect = `delete conditional format rule #${body.index} on sheet ${sheetOf(body.sheetId)}`;
      break;
    case "setDataValidation":
      out.effect = body.rule ? `set data validation on ${out.cells} cells (${out.range})` : `clear data validation on ${out.range}`;
      break;
    case "sortRange":
      out.effect = `sort ${out.range} by ${(body.sortSpecs ?? []).map((s: AnyRec) => `${s.dimensionIndex !== undefined ? colToLetters(Number(s.dimensionIndex) + 1) : "?"} ${s.sortOrder ?? "ASCENDING"}`).join(", ")}`;
      out.warning = "reorders rows in place";
      break;
    case "autoResizeDimensions": {
      const { label } = dimSpan(body.dimensions, meta);
      out.sheet = sheetOf(body.dimensions?.sheetId);
      out.effect = `auto-resize ${DIM(body.dimensions?.dimension)} ${label}`;
      break;
    }
    case "updateDimensionProperties": {
      const { label } = dimSpan(body.range, meta);
      out.sheet = sheetOf(body.range?.sheetId);
      out.effect = `set ${fields ?? "properties"} on ${DIM(body.range?.dimension)} ${label}${body.properties?.pixelSize ? ` (pixelSize ${body.properties.pixelSize})` : ""}${body.properties?.hiddenByUser !== undefined ? ` (hidden: ${body.properties.hiddenByUser})` : ""}`;
      break;
    }
    case "addSheet":
      out.effect = `add sheet "${body.properties?.title ?? "(untitled)"}"`;
      break;
    case "deleteSheet":
      out.sheet = sheetOf(body.sheetId);
      out.effect = `delete sheet "${out.sheet}" and everything in it`;
      out.warning = "destructive";
      break;
    case "duplicateSheet":
      out.sheet = sheetOf(body.sourceSheetId);
      out.effect = `duplicate sheet "${out.sheet}"${body.newSheetName ? ` as "${body.newSheetName}"` : ""}`;
      break;
    case "updateSheetProperties":
      out.sheet = sheetOf(body.properties?.sheetId);
      out.effect = `update sheet "${out.sheet}" (${fields ?? "*"})`;
      break;
    case "addNamedRange":
      out.effect = `add named range ${body.namedRange?.name} = ${gridRangeToA1(body.namedRange?.range, meta.titles)}`;
      break;
    case "deleteNamedRange":
      out.effect = `delete named range ${body.namedRangeId}`;
      break;
    case "addProtectedRange":
      out.effect = `protect ${gridRangeToA1(body.protectedRange?.range, meta.titles) || "range"}`;
      break;
    case "deleteProtectedRange":
      out.effect = `unprotect range ${body.protectedRangeId}`;
      break;
    case "findReplace":
      out.sheet = sheetOf(body.sheetId);
      out.effect = `replace "${body.find}" with "${body.replacement}" in ${body.allSheets ? "all sheets" : body.range ? gridRangeToA1(body.range, meta.titles) : (out.sheet ?? "sheet")}`;
      out.warning = "overwrites matching cells";
      break;
    case "cutPaste":
      out.effect = `cut ${gridRangeToA1(body.source, meta.titles)} and paste at ${gridRangeToA1({ sheetId: body.destination?.sheetId, startRowIndex: body.destination?.rowIndex, endRowIndex: (body.destination?.rowIndex ?? 0) + 1, startColumnIndex: body.destination?.columnIndex, endColumnIndex: (body.destination?.columnIndex ?? 0) + 1 }, meta.titles)}`;
      out.warning = "source cleared, destination overwritten";
      break;
    case "copyPaste": {
      const pasteType = String(body.pasteType ?? "PASTE_NORMAL");
      const transposed = String(body.pasteOrientation ?? "NORMAL").toUpperCase() === "TRANSPOSE";
      const area = pasteArea(body.source, body.destination, meta, transposed);
      const how = transposed ? ", transposed" : "";
      out.sheet = sheetOf(body.destination?.sheetId ?? 0);
      out.range = gridRangeToA1(area ?? body.destination, meta.titles);
      if (area) out.cells = gridRangeCells(area);
      const keeps = FORMAT_ONLY_PASTE[pasteType];
      if (keeps) {
        // Google: PASTE_FORMAT = format + data validation, PASTE_DATA_VALIDATION / PASTE_CONDITIONAL_FORMATTING = only those.
        // None of them touches a value, so "destination overwritten" would be a false alarm.
        out.effect = `copy the ${keeps} of ${gridRangeToA1(body.source, meta.titles)} to ${out.range}${how} (${pasteType}) — replaces the destination's ${keeps}; values unchanged`;
      } else {
        // PASTE_NORMAL, PASTE_VALUES, PASTE_FORMULA and PASTE_NO_BORDERS (= PASTE_NORMAL without borders) all paste values.
        out.effect = `copy ${gridRangeToA1(body.source, meta.titles)} to ${out.range}${how} (${pasteType})`;
        out.warning = "destination overwritten";
      }
      break;
    }
    case "pasteData": {
      // Pasted text lands from `coordinate` down and right: as many rows as lines, as many columns as the widest line.
      const at: AnyRec = body.coordinate ?? {};
      const pasteType = String(body.type ?? "PASTE_NORMAL");
      const shape = body.html ? undefined : delimitedShape(body.data, body.delimiter);
      const r0 = Number(at.rowIndex ?? 0), c0 = Number(at.columnIndex ?? 0);
      out.sheet = sheetOf(at.sheetId ?? 0);
      out.range = gridRangeToA1({ sheetId: Number(at.sheetId ?? 0), startRowIndex: r0, endRowIndex: r0 + (shape?.rows ?? 1), startColumnIndex: c0, endColumnIndex: c0 + (shape?.cols ?? 1) }, meta.titles);
      if (shape) out.cells = shape.rows * shape.cols;
      // HTML: the table's size is not worked out here, so the anchor cell stands in for the block.
      const what = shape ? `${shape.rows} x ${shape.cols} cells at ${out.range}` : `an HTML table at ${out.range} (and the cells it spans)`;
      const keeps = FORMAT_ONLY_PASTE[pasteType];
      if (keeps) out.effect = `paste the ${keeps} of ${what} (${pasteType}) — values unchanged`;
      else {
        out.effect = `paste ${what} (${pasteType}) — existing values overwritten`;
        out.warning = "overwrites values";
      }
      break;
    }
    case "writeValues": {
      const t = resolveWriteValues(body, index, meta);
      out.sheet = meta.titles.get(t.sheetId);
      out.range = gridRangeToA1(t.range, meta.titles);
      out.cells = t.cells;
      out.effect = `write ${t.cells} value(s) into ${out.range} (formatting kept) — existing values overwritten`;
      out.warning = "overwrites values";
      break;
    }
    case "addChart":
      out.effect = `add chart${body.chart?.spec?.title ? ` "${body.chart.spec.title}"` : ""}`;
      break;
    case "updateChartSpec":
      out.effect = `update chart ${body.chartId}`;
      break;
    case "deleteEmbeddedObject":
      out.effect = `delete embedded object ${body.objectId}`;
      out.warning = "destructive";
      break;
    case "setBasicFilter":
      out.effect = `set filter on ${gridRangeToA1(body.filter?.range, meta.titles)}`;
      break;
    case "clearBasicFilter":
      out.sheet = sheetOf(body.sheetId);
      out.effect = `clear filter on sheet "${out.sheet}"`;
      break;
    case "addBanding":
      out.effect = `add banding on ${gridRangeToA1(body.bandedRange?.range, meta.titles)}`;
      break;
    case "textToColumns":
      out.range = gridRangeToA1(body.source, meta.titles);
      out.effect = `split text to columns from ${out.range}`;
      out.warning = "overwrites cells to the right";
      break;
    case "autoFill":
      out.effect = `auto-fill ${out.range ?? gridRangeToA1(body.sourceAndDestination?.source, meta.titles)}`;
      out.warning = "overwrites the fill destination";
      break;
    case "deleteDuplicates":
      out.effect = `delete duplicate rows in ${out.range}`;
      out.warning = "destructive";
      break;
    case "trimWhitespace":
      out.effect = `trim whitespace in ${out.range}`;
      break;
    case "randomizeRange":
      out.effect = `shuffle rows in ${out.range}`;
      out.warning = "reorders rows in place";
      break;
    default:
      out.effect = `${type}${out.range ? ` on ${out.range}` : ""}`;
  }
  return out;
}

export const describeRequests = (requests: AnyRec[], meta: SheetMeta): RequestSummary[] => requests.map((r, i) => describeRequest(r, i, meta));

const PREVIEW_CAP = 200;

/**
 * The grid cells a preview read of `range` covers: rows × columns of its block, an open end (a whole row,
 * column or tab) cut at the tab's grid — what values:batchGet can return for it, whatever the request
 * writes into it (a writeValues null, or an updateCells `range` wider than its `rows`, still comes back).
 * Infinity for a range on a tab the spreadsheet does not have yet, or an open end on an unknown grid.
 */
function previewCells(range: string, meta: SheetMeta): number {
  const b = blockOf(range, meta);
  return b ? rereadCost(b, meta.grids.get(b.sheetId)).cells : Infinity;
}

/**
 * For a dry run: attach the current contents of ranges that would be overwritten. Deletions
 * (DELETIONS) are left to previewDeletions, which also lists the formulas they break. A range is
 * read only when the block it names is at most PREVIEW_CAP grid cells (previewCells) — charged the
 * whole block, not the request's `cells`, which counts only what is written — and while the ranges
 * read stay within GRID_READ_MAX_CELLS together, like the grid reads. The one read is refused
 * past GRID_READ_MAX_BYTES while it streams (a cell can hold 50,000 characters); then each preview
 * says it is unavailable, and the plan is still the answer.
 */
export async function attachPreviews(g: GoogleClient, spreadsheetId: string, summaries: RequestSummary[], meta: SheetMeta): Promise<void> {
  const wanted: RequestSummary[] = [];
  let left = GRID_READ_MAX_CELLS;
  for (const s of summaries) {
    if (!s.warning || DELETIONS.has(s.type) || s.cells === undefined || !s.range) continue;
    const n = previewCells(s.range, meta);
    if (n > PREVIEW_CAP) {
      if (Number.isFinite(n)) s.preview = { note: `${n} cells in ${s.range} — preview capped at ${PREVIEW_CAP} cells; read the range first if needed` };
      continue;
    }
    // A range without '!' names a whole tab, and an unquoted title can read as a cell (Q1): never read by it.
    if (!s.range.includes("!")) continue;
    if (n > left) {
      s.preview = { note: `preview skipped: this dry run's previews already cover the ${GRID_READ_MAX_CELLS}-cell read budget; read the range first if needed` };
      continue;
    }
    left -= n;
    wanted.push(s);
  }
  if (!wanted.length) return;
  let r: AnyRec;
  try {
    r = await g.get<AnyRec>(
      `${API.sheets}/spreadsheets/${enc(spreadsheetId)}/values:batchGet`,
      { ranges: wanted.map((s) => s.range!), valueRenderOption: "FORMULA", prettyPrint: false },
      { maxBytes: GRID_READ_MAX_BYTES },
    );
  } catch (err) {
    if (!(err instanceof ResponseTooLargeError)) throw err;
    for (const s of wanted) s.preview = { note: `preview unavailable: the current values came back over the ${formatBytes(GRID_READ_MAX_BYTES)} read budget` };
    return;
  }
  const vr: AnyRec[] = r.valueRanges ?? [];
  wanted.forEach((s, i) => {
    s.preview = { range: vr[i]?.range ?? s.range, currentValues: vr[i]?.values ?? [] };
  });
}

/** Extract Google's reply for request i, or undefined when it is an empty object. */
export const nonEmptyReply = (replies: unknown[] | undefined, i: number): unknown => {
  const r = replies?.[i];
  return r && typeof r === "object" && Object.keys(r as object).length ? r : undefined;
};

/**
 * Aggregate what a batchUpdate changed: {rowsInserted, rowsDeleted, columnsInserted, columnsDeleted,
 * cellsWritten, cellsFormatted, cellsMerged, sheetsAdded, sheetsDeleted, rulesAdded, chartsAdded,
 * cellsReplaced (findReplace, from Google's reply), other: [types]} — only non-zero keys are emitted.
 */
export function changeTotals(summaries: RequestSummary[], replies?: unknown[]): AnyRec {
  const t: Record<string, number> = {};
  const other: string[] = [];
  const add = (k: string, n = 1) => {
    if (n > 0) t[k] = (t[k] ?? 0) + n;
  };
  for (const s of summaries) {
    const cols = /columns/.test(s.effect);
    switch (s.type) {
      case "insertDimension":
      case "appendDimension":
        add(cols ? "columnsInserted" : "rowsInserted", s.count ?? 0);
        break;
      case "deleteDimension":
        add(cols ? "columnsDeleted" : "rowsDeleted", s.count ?? 0);
        break;
      case "moveDimension":
        add(cols ? "columnsMoved" : "rowsMoved", s.count ?? 0);
        break;
      case "repeatCell":
      case "updateCells":
        add(s.warning === "overwrites values" ? "cellsWritten" : "cellsFormatted", s.cells ?? 0);
        break;
      case "writeValues":
        add("cellsWritten", s.cells ?? 0);
        break;
      case "copyPaste":
      case "pasteData":
        // A format/validation-only paste carries no warning (describeRequest): it formats, it does not write.
        if (s.cells === undefined) other.push(s.type);
        else add(s.warning ? "cellsWritten" : "cellsFormatted", s.cells);
        break;
      case "updateBorders":
        add("cellsFormatted", s.cells ?? 0);
        break;
      case "mergeCells":
        add("cellsMerged", s.cells ?? 0);
        break;
      case "unmergeCells":
        add("cellsUnmerged", s.cells ?? 0);
        break;
      case "setDataValidation":
        add("cellsValidated", s.cells ?? 0);
        break;
      case "insertRange":
      case "deleteRange":
      case "sortRange":
      case "randomizeRange":
      case "trimWhitespace":
      case "deleteDuplicates":
      case "autoFill":
      case "textToColumns":
        add(`${s.type}Cells`, s.cells ?? 0);
        break;
      case "addSheet":
        add("sheetsAdded");
        break;
      case "deleteSheet":
        add("sheetsDeleted");
        break;
      case "duplicateSheet":
        add("sheetsDuplicated");
        break;
      case "addConditionalFormatRule":
        add("rulesAdded");
        break;
      case "deleteConditionalFormatRule":
        add("rulesDeleted");
        break;
      case "addChart":
        add("chartsAdded");
        break;
      case "addNamedRange":
        add("namedRangesAdded");
        break;
      case "addProtectedRange":
        add("protectedRangesAdded");
        break;
      case "findReplace": {
        const rep = (replies?.[s.index] as AnyRec | undefined)?.findReplace;
        add("cellsReplaced", Number(rep?.valuesChanged ?? 0) + Number(rep?.formulasChanged ?? 0));
        if (!rep) other.push(s.type);
        break;
      }
      default:
        other.push(s.type);
    }
  }
  const out: AnyRec = { ...t };
  if (other.length) out.other = other;
  return out;
}

// ---- copyPaste --------------------------------------------------------------------

/** pasteType → what a format-only paste replaces. Every other pasteType (incl. PASTE_NO_BORDERS) pastes values. */
const FORMAT_ONLY_PASTE: Record<string, string> = {
  PASTE_FORMAT: "formatting and data validation",
  PASTE_DATA_VALIDATION: "data validation",
  PASTE_CONDITIONAL_FORMATTING: "conditional formatting",
};

/**
 * The block a copyPaste actually lands on: Google repeats the source to fill a destination that is
 * a whole multiple of it, and otherwise pastes the whole source from the destination's top-left
 * (also when the destination is smaller). Undefined when either side is missing or empty.
 * `transposed` (pasteOrientation TRANSPOSE): the source's rows become columns, so its block is
 * turned sideways before it is fitted — 1 row x 5 columns pastes into 5 rows x 1 column.
 */
function pasteArea(source: AnyRec | undefined, destination: AnyRec | undefined, meta: SheetMeta, transposed = false): AnyRec | undefined {
  if (!source || !destination) return undefined;
  const sg = meta.grids.get(Number(source.sheetId ?? 0)), dg = meta.grids.get(Number(destination.sheetId ?? 0));
  const span = (s: unknown, e: unknown, size?: number) => Number(e ?? size ?? 0) - Number(s ?? 0);
  const rows = span(source.startRowIndex, source.endRowIndex, sg?.rowCount), cols = span(source.startColumnIndex, source.endColumnIndex, sg?.columnCount);
  const [sr, sc] = transposed ? [cols, rows] : [rows, cols];
  const dr = span(destination.startRowIndex, destination.endRowIndex, dg?.rowCount), dc = span(destination.startColumnIndex, destination.endColumnIndex, dg?.columnCount);
  if (sr <= 0 || sc <= 0) return undefined;
  const fit = (d: number, s: number) => (d >= s && d % s === 0 ? d : s);
  const r0 = Number(destination.startRowIndex ?? 0), c0 = Number(destination.startColumnIndex ?? 0);
  return { sheetId: Number(destination.sheetId ?? 0), startRowIndex: r0, endRowIndex: r0 + fit(dr, sr), startColumnIndex: c0, endColumnIndex: c0 + fit(dc, sc) };
}

/** pasteData text → rows (lines; one trailing line break ignored) × widest line split on the delimiter (1 column without one). */
function delimitedShape(data: unknown, delimiter: unknown): { rows: number; cols: number } {
  const lines = String(data ?? "").split(/\r\n|\n|\r/);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  const d = typeof delimiter === "string" && delimiter ? delimiter : undefined;
  const cols = d ? lines.reduce((m, line) => Math.max(m, line.split(d).length), 1) : 1;
  return { rows: lines.length, cols };
}

// ---- writeValues: a value write inside the ordered, atomic batch ---------------------

type Scalar = string | number | boolean | null;

export interface WriteValuesTarget {
  sheetId: number;
  /** The 0-based, end-exclusive block the values cover. */
  range: { sheetId: number; startRowIndex: number; endRowIndex: number; startColumnIndex: number; endColumnIndex: number };
  values: Scalar[][];
  /** Cells that carry a value (null = left untouched). */
  cells: number;
  /** The updateCells requests it becomes (writeValuesRequests): one per run of rows without a null, one per run of values in a row with one. */
  updates: number;
}

/**
 * The most cells that carry a value (not null) the writeValues of ONE batch may hold together, and the most
 * updateCells requests they may become together (one per run of rows without a null, one per run of values
 * in a row with one, so at least one per writeValues). The body sent to Google is built in memory — a
 * CellData pair per value and an updateCells object per run, all alive while the body is serialized, next
 * to the batch's own per-request bookkeeping — so a batch over either cap is refused before anything is read
 * or written, pointing at sheets_write_range and sheets_batch_write_ranges, which send the values as given.
 * Measured under Node with the tool's own code (verify=false, a fake client that serializes the body): uncapped, 1,000 × 500 values with alternating
 * nulls (250,000 one-cell runs) and 120,000 × 5 dense values ran out of a 128 MB heap, and 200,000 × 1
 * peaked at about 107 MB. At the caps, 100,000 one-value rows peak about 32 MB above the caller's own values,
 * 10,000 one-cell runs about 10 MB and 10,000 one-cell writeValues about 25 MB (their per-request bookkeeping
 * included).
 */
export const WRITE_VALUES_MAX_CELLS = 100_000;
export const WRITE_VALUES_MAX_UPDATES = 10_000;

const wvLabel = (index: number) => `writeValues (request #${index})`;
const isScalar = (v: unknown): v is Scalar => v === null || typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v));

/** "Data (0), Summary (1)": the tabs with their sheetIds, for errors that name a tab that is not there. */
export const tabList = (meta: SheetMeta): string => [...meta.titles].map(([id, title]) => `${title} (${id})`).join(", ");

/**
 * Validate a {writeValues: {range, values}} body against the spreadsheet as it is now. `range` is
 * an A1 block whose size must equal the array's (rows × widest row), so a value can never land one
 * column off without an error. It names its tab, or `sheetId` does (then the range may leave the tab
 * out; if it names one, it must be that tab). Throws with the block that would fit.
 */
export function resolveWriteValues(body: unknown, index: number, meta: SheetMeta): WriteValuesTarget {
  const b = (body && typeof body === "object" ? body : {}) as AnyRec;
  const label = wvLabel(index);
  const extra = Object.keys(b).filter((k) => k !== "sheetId" && k !== "range" && k !== "values");
  if (extra.length) throw new Error(`${label}: takes only sheetId, range and values (got ${extra.join(", ")})`);
  if (typeof b.range !== "string" || !b.range.trim()) throw new Error(`${label}: range must be an A1 block with its tab, e.g. "'Sheet1'!A1:C2" (or A1:C2 with sheetId)`);
  const values = b.values;
  if (!Array.isArray(values) || !values.length || !values.every((row) => Array.isArray(row))) throw new Error(`${label}: values must be a non-empty 2-D array of rows`);
  for (const row of values as unknown[][]) for (const v of row) if (!isScalar(v)) throw new Error(`${label}: cells must be strings, finite numbers, booleans or null — got ${JSON.stringify(v)}`);
  const rows = values as Scalar[][];
  const a1 = parseA1(b.range);
  let sheet: string, sheetId: number;
  if (b.sheetId !== undefined) {
    if (typeof b.sheetId !== "number" || !Number.isInteger(b.sheetId)) throw new Error(`${label}: sheetId must be a tab's integer sheetId (sheets_get_spreadsheet) — got ${JSON.stringify(b.sheetId)}`);
    const title = meta.titles.get(b.sheetId);
    if (title === undefined) throw new Error(`${label}: no tab with sheetId ${b.sheetId}. Tabs: ${tabList(meta)}`);
    if (a1.sheet !== undefined && a1.sheet !== title) throw new Error(`${label}: range "${b.range}" names tab '${a1.sheet}' but sheetId ${b.sheetId} is '${title}' — drop the tab from the range or make them agree`);
    [sheet, sheetId] = [title, b.sheetId];
  } else {
    if (!a1.sheet) throw new Error(`${label}: range "${b.range}" names no tab — write it as "'Tab'!A1:C2" or pass sheetId`);
    const id = meta.ids.get(a1.sheet);
    if (id === undefined) throw new Error(`${label}: no tab named '${a1.sheet}'. Tabs: ${[...meta.ids.keys()].join(", ")}`);
    [sheet, sheetId] = [a1.sheet, id];
  }
  if (a1.startRow === undefined || a1.startCol === undefined || a1.endRow === undefined || a1.endCol === undefined) {
    throw new Error(`${label}: range "${b.range}" must be a bounded block like A1:C2, not a whole row, column or tab`);
  }
  const r0 = Math.min(a1.startRow, a1.endRow), r1 = Math.max(a1.startRow, a1.endRow);
  const c0 = Math.min(a1.startCol, a1.endCol), c1 = Math.max(a1.startCol, a1.endCol);
  // A loop, not Math.max(...rows): a block can have more rows than a call may take arguments.
  let width = 0;
  for (const row of rows) width = Math.max(width, row.length);
  const height = rows.length;
  if (width === 0) throw new Error(`${label}: every row of values is empty`);
  if (r1 - r0 + 1 !== height || c1 - c0 + 1 !== width) {
    const fits = `${quoteSheet(sheet)}!${cellA1(r0, c0)}${height === 1 && width === 1 ? "" : `:${cellA1(r0 + height - 1, c0 + width - 1)}`}`;
    throw new Error(`${label}: range ${b.range} is ${r1 - r0 + 1} row(s) x ${c1 - c0 + 1} column(s) but values is ${height} x ${width} — the block for this array is ${fits}`);
  }
  // Counted the way writeValuesRequests splits the block, without building anything.
  let cells = 0, updates = 0, inWhole = false;
  for (const row of rows) {
    let nulls = false, runs = 0, prev: Scalar = null;
    for (const v of row) {
      if (v === null) nulls = true;
      else {
        cells++;
        if (prev === null) runs++;
      }
      prev = v;
    }
    if (!nulls) {
      if (!inWhole) updates++;
      inWhole = true;
    } else {
      updates += runs;
      inWhole = false;
    }
  }
  if (!cells) throw new Error(`${label}: every cell is null — nothing to write`);
  return { sheetId, range: { sheetId, startRowIndex: r0 - 1, endRowIndex: r1, startColumnIndex: c0 - 1, endColumnIndex: c1 }, values: rows, cells, updates };
}

/** One value → CellData under fields=userEnteredValue: '=…' formula, other strings text, '' clears the value (formatting is kept either way). */
function cellData(v: Exclude<Scalar, null>): AnyRec {
  if (typeof v === "number") return { userEnteredValue: { numberValue: v } };
  if (typeof v === "boolean") return { userEnteredValue: { boolValue: v } };
  if (v === "") return {};
  return { userEnteredValue: v.startsWith("=") ? { formulaValue: v } : { stringValue: v } };
}

/**
 * writeValues → updateCells. `start` (not `range`) so cells past a short row stay untouched. A
 * null cannot be expressed inside one updateCells (its field mask clears every cell it covers),
 * so each row holding a null becomes one updateCells per run of non-null cells; consecutive rows
 * without a null stay together in one updateCells. Order is kept throughout.
 */
export function writeValuesRequests(t: WriteValuesTarget): AnyRec[] {
  const at = (ri: number, ci: number) => ({ sheetId: t.sheetId, rowIndex: t.range.startRowIndex + ri, columnIndex: t.range.startColumnIndex + ci });
  const update = (ri: number, ci: number, rows: Exclude<Scalar, null>[][]) => ({ updateCells: { start: at(ri, ci), rows: rows.map((row) => ({ values: row.map(cellData) })), fields: "userEnteredValue" } });
  const out: AnyRec[] = [];
  let whole: Exclude<Scalar, null>[][] = [];
  let wholeFrom = 0;
  const flush = () => {
    if (whole.length) out.push(update(wholeFrom, 0, whole));
    whole = [];
  };
  t.values.forEach((row, ri) => {
    if (!row.includes(null)) {
      if (!whole.length) wholeFrom = ri;
      whole.push(row as Exclude<Scalar, null>[]);
      return;
    }
    flush();
    let from = -1;
    for (let ci = 0; ci <= row.length; ci++) {
      const v = ci < row.length ? row[ci] : null;
      if (v !== null && from < 0) from = ci;
      if (v === null && from >= 0) {
        out.push(update(ri, from, [row.slice(from, ci) as Exclude<Scalar, null>[]]));
        from = -1;
      }
    }
  });
  flush();
  return out;
}

const isWriteValues = (req: AnyRec) => !!req && typeof req === "object" && Object.prototype.hasOwnProperty.call(req, "writeValues");

/**
 * The requests to send to Google: every writeValues translated in place (so the order the caller
 * gave is the order Google applies), plus `origin[k]` = the caller's index of Google request k.
 * Returns the caller's array untouched when it holds no writeValues.
 */
export function expandRequests(requests: AnyRec[], meta: SheetMeta): { requests: AnyRec[]; origin: number[] } {
  if (!requests.some(isWriteValues)) return { requests, origin: requests.map((_, i) => i) };
  // Every writeValues validated and counted first, so a batch over the caps is refused before anything is built.
  const targets = new Map<number, WriteValuesTarget>();
  let cells = 0, updates = 0;
  requests.forEach((req, i) => {
    if (!isWriteValues(req)) return;
    if (Object.keys(req).length !== 1) throw new Error(`${wvLabel(i)}: a request object holds exactly one request — put writeValues in its own object`);
    const t = resolveWriteValues(req.writeValues, i, meta);
    targets.set(i, t);
    cells += t.cells;
    updates += t.updates;
  });
  const instead = "write large blocks with sheets_write_range or sheets_batch_write_ranges (they send the values as given), and keep writeValues for the values that must be ordered with structural requests in this batch";
  if (cells > WRITE_VALUES_MAX_CELLS) throw new Error(`writeValues: this batch writes ${cells} values, over the ${WRITE_VALUES_MAX_CELLS} one batch may translate — ${instead}. Nothing was written`);
  if (updates > WRITE_VALUES_MAX_UPDATES) {
    throw new Error(`writeValues: this batch's writeValues become ${updates} separate updateCells (one per writeValues, more where nulls split a row), over the ${WRITE_VALUES_MAX_UPDATES} one batch may send — ${instead}. Nothing was written`);
  }
  const out: AnyRec[] = [];
  const origin: number[] = [];
  requests.forEach((req, i) => {
    const t = targets.get(i);
    if (!t) {
      out.push(req);
      origin.push(i);
      return;
    }
    for (const r of writeValuesRequests(t)) {
      out.push(r);
      origin.push(i);
    }
  });
  return { requests: out, origin };
}

/** Google's replies re-indexed to the caller's requests (first non-empty reply per caller request). */
export function repliesByRequest(replies: unknown[] | undefined, origin: number[], n: number): unknown[] {
  const list = replies ?? [];
  if (origin.length === n && origin.every((o, k) => o === k)) return list;
  const out: unknown[] = Array.from({ length: n }, () => ({}));
  list.forEach((r, k) => {
    const i = origin[k];
    if (i !== undefined && nonEmptyReply(out, i) === undefined && nonEmptyReply(list, k) !== undefined) out[i] = r;
  });
  return out;
}

// ---- which tabs a request touches ----------------------------------------------------

/** Requests that move, remove or reorder cells: formulas pointing into them can break, and coordinates after them shift. */
export const STRUCTURAL = new Set(["insertDimension", "deleteDimension", "moveDimension", "insertRange", "deleteRange", "cutPaste", "sortRange", "randomizeRange", "deleteDuplicates", "deleteSheet"]);
/** Requests whose dry run previews the lost contents and the formulas that break (previewDeletions). */
export const DELETIONS = new Set(["deleteDimension", "deleteRange", "deleteSheet"]);

const typeOf = (req: AnyRec | undefined) => Object.keys(req ?? {})[0] ?? "";

/** Existing sheetIds a request changes (a GridRange without sheetId means sheet 0, as in the API). */
export function requestSheetIds(req: AnyRec, index: number, meta: SheetMeta): number[] {
  const type = typeOf(req);
  const b: AnyRec = req?.[type] ?? {};
  if (type === "writeValues") return [resolveWriteValues(b, index, meta).sheetId];
  if (type === "findReplace" && b.allSheets) return [...meta.titles.keys()];
  const ids = new Set<number>();
  // A copyPaste only reads its source; cutPaste clears it, so there the source counts.
  for (const o of [b.range, type === "copyPaste" ? undefined : b.source, b.destination, b.start, b.coordinate, b.dimensions, b.sourceAndDestination?.source]) {
    if (o && typeof o === "object") ids.add(Number((o as AnyRec).sheetId ?? 0));
  }
  if (b.sheetId !== undefined || type === "deleteSheet") ids.add(Number(b.sheetId ?? 0));
  return [...ids].filter((id) => meta.titles.has(id));
}

/**
 * For a batch, a function giving the nearest STRUCTURAL request before request `i` on one of its tabs, if any
 * (the dry-run preview caveat). The structural requests are indexed once, by tab and in order, so each lookup
 * is a binary search per tab of `i` rather than a walk back through the batch.
 */
function structuralBefore(requests: AnyRec[], meta: SheetMeta): (i: number) => number | undefined {
  const byTab = new Map<number, number[]>();
  requests.forEach((req, j) => {
    if (STRUCTURAL.has(typeOf(req))) for (const id of requestSheetIds(req, j, meta)) (byTab.get(id) ?? byTab.set(id, []).get(id)!).push(j);
  });
  return (i) => {
    let nearest: number | undefined;
    for (const id of requestSheetIds(requests[i], i, meta)) {
      const on = byTab.get(id) ?? [];
      const k = firstAfter(on, i - 1) - 1; // the last entry before i
      if (k >= 0 && (nearest === undefined || on[k] > nearest)) nearest = on[k];
    }
    return nearest;
  };
}

// ---- does a later request move a written block? ----------------------------------------

/** A block of cells on one tab, 1-based and inclusive; MAX_INDEX = open-ended. */
export interface TabBlock {
  sheetId: number;
  r0: number;
  r1: number;
  c0: number;
  c1: number;
}

/** A GridRange (0-based, end-exclusive, missing bounds unbounded) as a 1-based inclusive Box. */
function gridBox(gr: AnyRec | undefined): Box {
  const at = (v: unknown, dflt: number) => (v === undefined || v === null ? dflt : Number(v));
  return { r0: at(gr?.startRowIndex, 0) + 1, r1: at(gr?.endRowIndex, MAX_INDEX), c0: at(gr?.startColumnIndex, 0) + 1, c1: at(gr?.endColumnIndex, MAX_INDEX) };
}

/** The block an A1 range with its tab covers (a whole-row or whole-column range is open-ended); undefined for a tab the spreadsheet does not have. */
export function blockOf(range: string, meta: SheetMeta): TabBlock | undefined {
  const a1 = parseA1(range);
  const sheetId = a1.sheet === undefined ? undefined : meta.ids.get(a1.sheet);
  return sheetId === undefined ? undefined : { sheetId, ...refBox(a1) };
}

/** Whether a block leaves out an end bound (a whole row, column or tab): its size comes from the tab's grid. */
export const openEnded = (b: TabBlock): boolean => b.r1 === MAX_INDEX || b.c1 === MAX_INDEX;

/**
 * What a verify re-read of the written block `b` costs: every grid cell it covers — the whole block,
 * not only the values written into it — with each open end (a whole row, column or tab, or a range
 * that leaves out an end bound) cut at the tab's grid, the most Google can return for it. `a1` is the
 * closed block to read (without its tab), so the read covers exactly the cells charged. Infinity, and
 * no `a1`, when an open end meets a grid size the metadata does not give; 0 cells when the block starts
 * past the grid. The batch tool passes the grid as it is AFTER the batch (an earlier request in it can
 * append, insert or delete rows and columns); a dry run's preview, the grid as it is now.
 */
export function rereadCost(b: TabBlock, grid: { rowCount?: number; columnCount?: number } | undefined): { cells: number; a1?: string } {
  const r1 = b.r1 === MAX_INDEX ? Number(grid?.rowCount) : b.r1;
  const c1 = b.c1 === MAX_INDEX ? Number(grid?.columnCount) : b.c1;
  if (!Number.isFinite(r1) || !Number.isFinite(c1)) return { cells: Infinity };
  const cells = Math.max(0, r1 - b.r0 + 1) * Math.max(0, c1 - b.c0 + 1);
  return { cells, a1: r1 === b.r0 && c1 === b.c0 ? cellA1(b.r0, b.c0) : `${cellA1(b.r0, b.c0)}:${cellA1(r1, c1)}` };
}

/**
 * Whether writtenBlock sizes `req`'s block from a tab's grid although the block it returns is closed: a
 * value paste whose source (or, for copyPaste, destination) leaves out an end bound — a whole column pasted
 * is as long as the tab. Such a block, like an open-ended one (openEnded), is sized on the grid as it is
 * after the batch.
 */
export function sizedByGrid(req: AnyRec): boolean {
  const type = typeOf(req);
  if (type !== "copyPaste" && type !== "cutPaste") return false;
  const q: AnyRec = req[type] ?? {};
  const open = (gr: unknown) => !!gr && typeof gr === "object" && [(gr as AnyRec).endRowIndex, (gr as AnyRec).endColumnIndex].some((v) => v === undefined || v === null);
  return open(q.source) || (type === "copyPaste" && open(q.destination));
}

/** writtenBlock's answer for a value write whose cells are not known before it runs: it is named, never guessed. */
export const UNLOCATED = "unlocated";

/**
 * The block a request writes VALUES into, for `verify`'s re-read after the batch: a TabBlock whose open ends
 * (a range that leaves a bound out: a whole row, column or tab) rereadCost cuts at the grid; UNLOCATED for a
 * value write whose cells are not known before it runs (findReplace, textToColumns, a pasteData of HTML, an
 * autoFill past its source's open end);
 * undefined for a request that writes no value (formatting, a format-only paste, structure). A GridRange or
 * GridCoordinate without sheetId is on sheet 0, as in the API. `s` is describeRequest's summary of `req`.
 * - writeValues; updateCells and repeatCell under a value mask ("overwrites values"); pasteData of text;
 * - copyPaste of values (PASTE_NORMAL, PASTE_VALUES, PASTE_FORMULA, PASTE_NO_BORDERS): the block Google pastes into;
 * - cutPaste of values: its source's block at the destination;
 * - autoFill: its `range`, or the rows (columns) `fillLength` adds before or after its source.
 */
export function writtenBlock(req: AnyRec, s: RequestSummary, meta: SheetMeta): TabBlock | typeof UNLOCATED | undefined {
  const type = typeOf(req);
  const q: AnyRec = req?.[type] ?? {};
  const on = (gr: unknown): TabBlock | undefined => (gr && typeof gr === "object" ? { sheetId: Number((gr as AnyRec).sheetId ?? 0), ...gridBox(gr as AnyRec) } : undefined);
  /** `rows` x `cols` cells from a GridCoordinate down and right. */
  const from = (c: unknown, rows: number, cols: number): TabBlock | undefined => {
    if (!c || typeof c !== "object") return undefined;
    const at: AnyRec = c;
    const r = Number(at.rowIndex ?? 0), col = Number(at.columnIndex ?? 0);
    return on({ sheetId: at.sheetId, startRowIndex: r, endRowIndex: r + rows, startColumnIndex: col, endColumnIndex: col + cols });
  };
  const pastesValues = (t: unknown) => !FORMAT_ONLY_PASTE[String(t ?? "PASTE_NORMAL")];
  const valueMask = s.warning === "overwrites values";
  switch (type) {
    case "writeValues":
      return on(resolveWriteValues(q, s.index, meta).range);
    case "repeatCell":
      return valueMask ? on(q.range) : undefined;
    case "updateCells": {
      if (!valueMask) return undefined;
      if (!q.start) return on(q.range);
      const rows = (Array.isArray(q.rows) ? q.rows : []) as AnyRec[];
      let cols = 0;
      for (const row of rows) cols = Math.max(cols, Array.isArray(row?.values) ? row.values.length : 0);
      return from(q.start, Math.max(1, rows.length), Math.max(1, cols));
    }
    case "pasteData": {
      if (!valueMask) return undefined;
      if (q.html) return UNLOCATED;
      const { rows, cols } = delimitedShape(q.data, q.delimiter);
      return from(q.coordinate ?? {}, rows, cols);
    }
    case "copyPaste":
      if (!pastesValues(q.pasteType)) return undefined;
      return on(pasteArea(q.source, q.destination, meta, String(q.pasteOrientation ?? "NORMAL").toUpperCase() === "TRANSPOSE") ?? q.destination);
    case "cutPaste": {
      if (!pastesValues(q.pasteType) || !q.destination || typeof q.destination !== "object") return undefined;
      const d: AnyRec = q.destination;
      const r = Number(d.rowIndex ?? 0), c = Number(d.columnIndex ?? 0);
      const anchor = { sheetId: d.sheetId, startRowIndex: r, endRowIndex: r + 1, startColumnIndex: c, endColumnIndex: c + 1 };
      return on(pasteArea(q.source, anchor, meta) ?? anchor);
    }
    case "autoFill": {
      if (q.range) return on(q.range);
      const sd: AnyRec | undefined = q.sourceAndDestination;
      const n = Number(sd?.fillLength ?? 0);
      const src = on(sd?.source);
      if (!src || !Number.isInteger(n) || n === 0) return undefined;
      const [lo, hi] = DIM(sd?.dimension) === "columns" ? (["c0", "c1"] as const) : (["r0", "r1"] as const);
      // Filling past an open end: where it lands is not known from the request.
      if (n > 0 && src[hi] === MAX_INDEX) return UNLOCATED;
      return { ...src, [lo]: n > 0 ? src[hi] + 1 : Math.max(1, src[lo] + n), [hi]: n > 0 ? src[hi] + n : src[lo] - 1 };
    }
    case "findReplace":
    case "textToColumns":
      return UNLOCATED;
    default:
      return undefined;
  }
}

/**
 * Whether `req`, applied after `b` was written, moves or deletes any of its cells — so re-reading
 * `b`'s coordinates afterwards would read other cells. Only these do:
 * - insertDimension / deleteDimension from an index at or before the block's last row (column);
 * - moveDimension whose source-to-destination span overlaps the block's rows (columns);
 * - insertRange / deleteRange that shift down/up across the block's columns from a row at or above
 *   its last row (or left/right across its rows from a column at or before its last column);
 * - cutPaste whose source (cleared), or sortRange / randomizeRange / deleteDuplicates whose range, intersects it;
 * - deleteSheet of its tab, or updateSheetProperties shrinking the grid below its last row (column).
 * Everything else — including a structural request lower down, further right or on another tab — leaves it in place.
 */
export function movesBlock(req: AnyRec, b: TabBlock): boolean {
  const type = typeOf(req);
  const q: AnyRec = req?.[type] ?? {};
  if (moverTab(type, q) !== b.sheetId) return false;
  const first = (v: unknown) => (v === undefined || v === null ? 0 : Number(v)) + 1; // 0-based start → 1-based
  const last = (v: unknown) => (v === undefined || v === null ? MAX_INDEX : Number(v)); // 0-based exclusive end → 1-based inclusive
  switch (type) {
    case "insertDimension":
    case "deleteDimension": {
      const r: AnyRec = q.range ?? {};
      return first(r.startIndex) <= (DIM(r.dimension) === "columns" ? b.c1 : b.r1);
    }
    case "moveDimension": {
      // Only the indexes between the source and the destination change places.
      const r: AnyRec = q.source ?? {};
      const d = Number(q.destinationIndex ?? 0);
      const lo = Math.min(first(r.startIndex), d + 1), hi = Math.max(last(r.endIndex), d);
      return DIM(r.dimension) === "columns" ? lo <= b.c1 && b.c0 <= hi : lo <= b.r1 && b.r0 <= hi;
    }
    case "insertRange":
    case "deleteRange": {
      const x = gridBox(q.range);
      return DIM(q.shiftDimension) === "rows" ? x.c0 <= b.c1 && b.c0 <= x.c1 && x.r0 <= b.r1 : x.r0 <= b.r1 && b.r0 <= x.r1 && x.c0 <= b.c1;
    }
    case "cutPaste":
      return intersects(gridBox(q.source), b);
    case "sortRange":
    case "randomizeRange":
    case "deleteDuplicates":
      return intersects(gridBox(q.range), b);
    case "deleteSheet":
      return true;
    case "updateSheetProperties": {
      const p: AnyRec = q.properties ?? {};
      const gp: AnyRec = p.gridProperties ?? {};
      const masked = (k: string) => String(q.fields ?? "").split(",").some((f) => ["*", "gridProperties", `gridProperties.${k}`].includes(f.trim()));
      const shrinks = (k: string, end: number) => masked(k) && gp[k] !== undefined && gp[k] !== null && Number(gp[k]) < end;
      return shrinks("rowCount", b.r1) || shrinks("columnCount", b.c1);
    }
    default:
      return false;
  }
}

/**
 * The tab on which a request can move cells — the sheetId of the part movesBlock tests (a GridRange without
 * one means sheet 0) — or undefined for a request that moves none (formatting, value writes, appends, …).
 */
function moverTab(type: string, q: AnyRec): number | undefined {
  let on: unknown;
  switch (type) {
    case "insertDimension":
    case "deleteDimension":
    case "insertRange":
    case "deleteRange":
    case "sortRange":
    case "randomizeRange":
    case "deleteDuplicates":
      on = q.range;
      break;
    case "moveDimension":
    case "cutPaste":
      on = q.source;
      break;
    case "deleteSheet":
      on = q;
      break;
    case "updateSheetProperties":
      on = q.properties;
      break;
    default:
      return undefined;
  }
  return Number((on as AnyRec | undefined)?.sheetId ?? 0);
}

/**
 * movesBlock() tests one written block against one request; a batch makes at most this many tests in all
 * (about 50 ms of CPU under Node). Without a cap a batch of tens of thousands of requests costs written blocks ×
 * later requests on their tab — seconds, after Google has applied the batch.
 */
export const MOVER_CHECKS_MAX = 1_000_000;
/** laterMovers' answer once MOVER_CHECKS_MAX is spent: not known, so the block is not re-read (never guessed). */
export const UNTRACKED = "untracked";

/**
 * For a batch, a function giving the first request after `i` that moves or deletes a cell of `block` (written
 * by request `i`) — until then its coordinates hold — undefined when none does, or UNTRACKED past the budget.
 * The requests that can move cells are indexed once, by tab and in order, so a block is tested only against
 * the later ones on its own tab, and all tests together stop at `maxChecks`: linear in the batch.
 */
export function laterMovers(requests: AnyRec[], maxChecks = MOVER_CHECKS_MAX): (i: number, block: TabBlock) => number | typeof UNTRACKED | undefined {
  const byTab = new Map<number, number[]>();
  requests.forEach((req, j) => {
    const type = typeOf(req);
    const tab = moverTab(type, req?.[type] ?? {});
    if (tab !== undefined) (byTab.get(tab) ?? byTab.set(tab, []).get(tab)!).push(j);
  });
  let left = maxChecks;
  return (i, block) => {
    const on = byTab.get(block.sheetId) ?? [];
    for (let k = firstAfter(on, i); k < on.length; k++) {
      if (left-- <= 0) return UNTRACKED;
      if (movesBlock(requests[on[k]], block)) return on[k];
    }
    return undefined;
  };
}

/** Position of the first entry greater than `i` in an ascending list (its length when there is none). */
function firstAfter(sorted: number[], i: number): number {
  let lo = 0, hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= i) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * sheetId → title once the batch is applied: renames (updateSheetProperties with `title` under its
 * field mask), tabs deleteSheet removes, and tabs addSheet / duplicateSheet add (their titles from
 * Google's replies, indexed by the caller's requests). Re-reads after the batch name tabs by these.
 */
export function titlesAfter(requests: AnyRec[], meta: SheetMeta, replies?: unknown[]): Map<number, string> {
  const out = new Map(meta.titles);
  requests.forEach((req, i) => {
    const type = typeOf(req);
    const q: AnyRec = req?.[type] ?? {};
    if (type === "updateSheetProperties") {
      const p: AnyRec = q.properties ?? {};
      const masked = String(q.fields ?? "").split(",").some((f) => ["*", "title"].includes(f.trim()));
      if (masked && typeof p.title === "string" && p.title) out.set(Number(p.sheetId ?? 0), p.title);
    } else if (type === "deleteSheet") out.delete(Number(q.sheetId ?? 0));
    else if (type === "addSheet" || type === "duplicateSheet") {
      const p = ((replies?.[i] ?? {}) as AnyRec)[type]?.properties;
      if (p?.title !== undefined) out.set(Number(p.sheetId ?? 0), String(p.title));
    }
  });
  return out;
}

/** Tabs touched by STRUCTURAL requests, and the ones deleteSheet removes. */
export function structuralSheets(requests: AnyRec[], meta: SheetMeta): { touched: Set<number>; deleted: Set<number> } {
  const touched = new Set<number>(), deleted = new Set<number>();
  requests.forEach((req, i) => {
    const type = typeOf(req);
    if (!STRUCTURAL.has(type)) return;
    for (const id of requestSheetIds(req, i, meta)) (type === "deleteSheet" ? deleted : touched).add(id);
  });
  return { touched, deleted };
}

// ---- grouped warnings and the summary reply --------------------------------------------

export interface WarningGroup {
  warning: string;
  requests: number[];
  types: string[];
}

/** One entry per distinct warning text, with the request indexes and types that raised it. */
export function groupWarnings(summaries: RequestSummary[]): WarningGroup[] {
  const groups = new Map<string, WarningGroup>();
  for (const s of summaries) {
    if (!s.warning) continue;
    let grp = groups.get(s.warning);
    if (!grp) groups.set(s.warning, (grp = { warning: s.warning, requests: [], types: [] }));
    grp.requests.push(s.index);
    if (!grp.types.includes(s.type)) grp.types.push(s.type);
  }
  return [...groups.values()];
}

export const SUMMARY_CHANGES_CAP = 20;

/**
 * reply="summary": only the changes worth reading — a warning (listed once under `warnings`, not
 * repeated here) or a non-empty Google reply — as {index, type, range|sheet, effect, reply}.
 */
export function summaryChanges(summaries: RequestSummary[]): { changes: AnyRec[]; omitted: number } {
  const worth = summaries.filter((s) => s.warning || s.reply !== undefined);
  const changes = worth.slice(0, SUMMARY_CHANGES_CAP).map((s) => {
    const e: AnyRec = { index: s.index, type: s.type };
    if (s.range) e.range = s.range;
    else if (s.sheet) e.sheet = s.sheet;
    e.effect = s.effect;
    if (s.reply !== undefined) e.reply = s.reply;
    return e;
  });
  return { changes, omitted: worth.length - changes.length };
}

// ---- deletion previews (dry run) ------------------------------------------------------

const MAX_INDEX = Number.MAX_SAFE_INTEGER;
const DELETED_ROWS_SHOWN = 50;
const DELETED_COLS_SHOWN = 26;
const DEPENDENTS_SHOWN = 25;
const FORMULA_CHARS = 160;
/**
 * Deletions in one dry run that get a preview. Each preview scans the cells and formulas read, so this
 * keeps a dry run's work linear in the grid it read however many deletions the batch holds.
 */
export const DELETION_PREVIEWS_MAX = 20;
/**
 * What eachResolvedFormula hands the resolver at once: formula cells until their formulas total
 * RESOLVE_CHUNK_CHARS characters (a formula longer than that goes alone), and never more than
 * RESOLVE_CHUNK cells. Characters, not cells, bound what one batch costs: every reference in a formula
 * resolves to an object that takes over 100 times its text in heap ("A1+" is three characters), so
 * 1,000 cells of 8,000-character formulas (889 references each) resolved together ran out of a 128 MB heap.
 * At this budget a batch of formulas within Google's 50,000-character cell limit resolves at most a few tens
 * of thousands of references however dense they are (33,333 for "=A1+A1+…").
 */
export const RESOLVE_CHUNK_CHARS = 100_000;
const RESOLVE_CHUNK = 1_000;

/** 1-based inclusive bounds; MAX_INDEX = unbounded. */
interface Box {
  r0: number;
  r1: number;
  c0: number;
  c1: number;
}
interface Span extends Box {
  sheet: string;
}

const clip = (f: string | undefined) => (f && f.length > FORMULA_CHARS ? `${f.slice(0, FORMULA_CHARS - 1)}…` : f);
const shown = (v: unknown) => (typeof v === "string" ? clip(v) : v);
const inBox = (b: Box, row: number, col: number) => row >= b.r0 && row <= b.r1 && col >= b.c0 && col <= b.c1;
const intersects = (a: Box, b: Box) => a.r0 <= b.r1 && b.r0 <= a.r1 && a.c0 <= b.c1 && b.c0 <= a.c1;
const within = (a: Box, b: Box) => a.r0 >= b.r0 && a.r1 <= b.r1 && a.c0 >= b.c0 && a.c1 <= b.c1;
/** Every cell of a tab: what deleteSheet removes. */
const wholeTab = (sheet: string): Span => ({ sheet, r0: 1, r1: MAX_INDEX, c0: 1, c1: MAX_INDEX });

/** A formula reference as a Box. A missing end is open-ended (A5:C, a named range with no end row). */
function refBox(r: A1Range): Box {
  const lo = (s?: number, e?: number) => (s === undefined ? 1 : e === undefined ? s : Math.min(s, e));
  const hi = (s?: number, e?: number) => (e === undefined ? MAX_INDEX : s === undefined ? e : Math.max(s, e));
  return { r0: lo(r.startRow, r.endRow), r1: hi(r.startRow, r.endRow), c0: lo(r.startCol, r.endCol), c1: hi(r.startCol, r.endCol) };
}

/** What a deletion removes, as a Span on its tab (undefined for a tab this spreadsheet does not have). */
function deletionSpan(req: AnyRec, meta: SheetMeta): Span | undefined {
  const type = typeOf(req);
  const b: AnyRec = req?.[type] ?? {};
  const idx = (v: unknown, dflt: number) => (v === undefined || v === null ? dflt : Number(v));
  if (type === "deleteSheet") {
    const sheet = meta.titles.get(idx(b.sheetId, 0));
    return sheet === undefined ? undefined : wholeTab(sheet);
  }
  const r: AnyRec = b.range ?? {};
  const sheet = meta.titles.get(idx(r.sheetId, 0));
  if (sheet === undefined) return undefined;
  if (type === "deleteDimension") {
    const s = idx(r.startIndex, 0) + 1, e = idx(r.endIndex, MAX_INDEX);
    return DIM(r.dimension) === "columns" ? { sheet, r0: 1, r1: MAX_INDEX, c0: s, c1: e } : { sheet, r0: s, r1: e, c0: 1, c1: MAX_INDEX };
  }
  if (type === "deleteRange") return { sheet, ...gridBox(r) };
  return undefined;
}

/**
 * The populated part of the span, formulas as '=…': a DELETED_ROWS_SHOWN × DELETED_COLS_SHOWN window
 * anchored at the first populated row and column inside the span (not at the span's top-left, which
 * may be blank for fifty rows), with the rows/columns of data beyond it counted, not listed.
 * Two passes over the tab's cells, neither of which copies them.
 */
function lostContents(span: Span, grid: SheetGrid | undefined): AnyRec {
  // Loops, not Math.min(...cells): a deleted span can hold more cells than a call may take arguments.
  let n = 0, r0 = MAX_INDEX, c0 = MAX_INDEX, lastRow = 0, lastCol = 0;
  for (const c of grid?.cells.values() ?? []) {
    if (!inBox(span, c.row, c.col)) continue;
    n++;
    r0 = Math.min(r0, c.row);
    c0 = Math.min(c0, c.col);
    lastRow = Math.max(lastRow, c.row);
    lastCol = Math.max(lastCol, c.col);
  }
  if (!grid || !n) return { cellsWithData: 0 };
  const r1 = Math.min(lastRow, r0 + DELETED_ROWS_SHOWN - 1), c1 = Math.min(lastCol, c0 + DELETED_COLS_SHOWN - 1);
  const rows: unknown[][] = Array.from({ length: r1 - r0 + 1 }, () => []);
  // The window lies inside the span (its corners are populated cells of the span), so its bounds are the only test.
  // Cut like a dependent's formula: a cell holds up to 50,000 characters, and the window shows 1,300 cells.
  for (const c of grid.cells.values()) if (c.row >= r0 && c.row <= r1 && c.col >= c0 && c.col <= c1) rows[c.row - r0][c.col - c0] = shown(c.formula ?? c.value ?? null);
  const out: AnyRec = {
    range: `${quoteSheet(span.sheet)}!${cellA1(r0, c0)}${r1 === r0 && c1 === c0 ? "" : `:${cellA1(r1, c1)}`}`,
    cellsWithData: n,
    currentValues: rows.map((row) => Array.from(row, (v) => (v === undefined ? null : v))),
  };
  if (lastRow > r1) out.rowsOmitted = lastRow - r1;
  if (lastCol > c1) out.columnsOmitted = lastCol - c1;
  return out;
}

/** sheets-analysis' resolveFormulas, passed in by the caller: that module imports this one, so a runtime import here would be circular. */
export type FormulaResolver = (grids: SheetGrid[], meta: SheetMeta) => ResolvedFormula[];

/**
 * Every formula in `grids` with its references resolved, a batch of formula cells at a time: at most
 * RESOLVE_CHUNK cells and RESOLVE_CHUNK_CHARS characters of formula text (one longer formula alone). A scan
 * that keeps only what it reports holds one batch of resolved references, not the whole spreadsheet's.
 */
export function* eachResolvedFormula(grids: SheetGrid[], meta: SheetMeta, resolve: FormulaResolver): Generator<ResolvedFormula> {
  for (const grid of grids) {
    const cells = grid.formulas;
    for (let i = 0; i < cells.length; ) {
      let j = i + 1, chars = cells[i].formula?.length ?? 0;
      while (j < cells.length && j - i < RESOLVE_CHUNK && chars + (cells[j].formula?.length ?? 0) <= RESOLVE_CHUNK_CHARS) chars += cells[j++].formula?.length ?? 0;
      yield* resolve([{ ...grid, formulas: cells.slice(i, j) }], meta);
      i = j;
    }
  }
}

export interface Dependent {
  cell: string;
  formula?: string;
  becomes: "#REF!" | "loses the deleted cells";
}
/** One span's dependents: counted in full, the first DEPENDENTS_SHOWN of each kind kept, and the tabs they sit on. */
export interface DependentTally {
  total: number;
  refErrors: number;
  breaking: Dependent[];
  losing: Dependent[];
  sheets: Set<string>;
}

/**
 * For each span: the formulas OUTSIDE it that read cells inside it, with references resolved the way
 * sheets_trace_dependents resolves them. A reference entirely inside the span becomes #REF!; one that only
 * overlaps it keeps working but no longer reads the deleted cells. One pass over `formulas` for every span
 * together, each formula looked at once: linear in the formulas read.
 */
export function tallyDependents(spans: Span[], formulas: Iterable<ResolvedFormula>): DependentTally[] {
  const out: DependentTally[] = spans.map(() => ({ total: 0, refErrors: 0, breaking: [], losing: [], sheets: new Set<string>() }));
  if (!spans.length) return out;
  for (const f of formulas) {
    const refs = f.refs.map((x) => ({ sheet: x.res.sheet, box: refBox(x.res.range) }));
    for (let k = 0; k < spans.length; k++) {
      const span = spans[k];
      if (f.sheet === span.sheet && inBox(span, f.row, f.col)) continue; // deleted along with the span
      let reads = false, breaks = false;
      for (const x of refs) {
        if (x.sheet !== span.sheet || !intersects(x.box, span)) continue;
        reads = true;
        if (within(x.box, span)) breaks = true;
      }
      if (!reads) continue;
      const t = out[k];
      t.total++;
      t.sheets.add(f.sheet);
      if (breaks) t.refErrors++;
      const list = breaks ? t.breaking : t.losing;
      if (list.length < DEPENDENTS_SHOWN) list.push({ cell: f.cell, formula: clip(f.formula), becomes: breaks ? "#REF!" : "loses the deleted cells" });
    }
  }
  return out;
}

/** The preview fields of one tally: counts, then up to DEPENDENTS_SHOWN dependents with the #REF! ones first. */
function dependentsPreview(t: DependentTally): AnyRec {
  const shown = [...t.breaking, ...t.losing].slice(0, DEPENDENTS_SHOWN);
  const out: AnyRec = { dependentFormulas: t.total, refErrors: t.refErrors };
  if (shown.length) out.dependents = shown;
  if (t.total > shown.length) out.dependentsOmitted = t.total - shown.length;
  return out;
}

/**
 * The tabs holding a formula that reads any cell of `title` (in the order `formulas` meets them): the
 * only tabs that deleting it can break. sheets_delete_sheet's post-check re-reads these after the delete.
 */
export function tabsReading(title: string, formulas: Iterable<ResolvedFormula>): string[] {
  return [...tallyDependents([wholeTab(title)], formulas)[0].sheets];
}

/** A bounded grid read: `ranges` (every tab when undefined), `cells` fields per cell, refused over GRID_READ_MAX_BYTES. */
export type GridLoader = (ranges: string[] | undefined, cells: string) => Promise<SheetGrid[]>;

/**
 * What each span loses, from ONE read of the spans themselves (clipped to their tab's grid, GRID_READ_MAX_CELLS
 * together at most) with only what a preview shows of a cell. A span that does not fit, or a read that fails
 * or comes back over the byte budget, gets a note instead — never a false "cellsWithData: 0".
 */
async function lostContentsOf(spans: Span[], meta: SheetMeta, load: GridLoader): Promise<AnyRec[]> {
  let budget = GRID_READ_MAX_CELLS;
  const ranges: string[] = [];
  const plan = spans.map((span): "read" | "outside" | string => {
    const grid = meta.grids.get(meta.ids.get(span.sheet) ?? -1);
    if (!grid?.rowCount || !grid.columnCount) return "contents not shown: the tab's grid size is unknown — read the rows with sheets_read_range";
    const r1 = Math.min(span.r1, grid.rowCount), c1 = Math.min(span.c1, grid.columnCount);
    if (span.r0 > r1 || span.c0 > c1) return "outside";
    const n = (r1 - span.r0 + 1) * (c1 - span.c0 + 1);
    if (n > budget) return `contents not shown: ${n} grid cells, over the ${GRID_READ_MAX_CELLS}-cell read budget — read the rows with sheets_read_range`;
    budget -= n;
    ranges.push(`${wholeTabRange(span.sheet)}!${cellA1(span.r0, span.c0)}:${cellA1(r1, c1)}`);
    return "read";
  });
  let grids: SheetGrid[] = [];
  let failed: string | undefined;
  if (ranges.length) {
    try {
      grids = await load(ranges, SHOWN_CELL_FIELDS);
    } catch (err) {
      failed = `contents not shown: the read failed (${why(err)})`;
    }
  }
  const byTitle = new Map(grids.map((g) => [g.title, g]));
  return spans.map((span, k) => (plan[k] === "outside" ? { cellsWithData: 0 } : plan[k] !== "read" ? { note: plan[k] } : failed ? { note: failed } : lostContents(span, byTitle.get(span.sheet))));
}

/**
 * Dry run: on each deleteDimension / deleteRange / deleteSheet (the first DELETION_PREVIEWS_MAX), preview
 * what is lost (the populated cells, capped) and which formulas elsewhere read it — the #REF! list first.
 * Two bounded reads, neither of which downloads what it does not use: the deleted cells with what a preview
 * shows of them, then the formulas of every tab that fits GRID_READ_MAX_CELLS (the deleted tabs first).
 * A deletion on a tab left out of that read gets a note instead of a preview; when other tabs were left out
 * the preview names them, since formulas there were not checked. A failed formulas read marks every preview
 * unavailable, and the dry run still returns its plan. `resolve` is sheets-analysis' resolveFormulas.
 */
export async function previewDeletions(summaries: RequestSummary[], requests: AnyRec[], meta: SheetMeta, load: GridLoader, resolve: FormulaResolver): Promise<void> {
  const deletions = summaries.filter((s) => DELETIONS.has(s.type));
  if (!deletions.length) return;
  const read = gridReadTabs(meta, deletions.flatMap((s) => requestSheetIds(requests[s.index], s.index, meta)));
  const previewed: { s: RequestSummary; span: Span }[] = [];
  for (const s of deletions) {
    const span = deletionSpan(requests[s.index], meta);
    if (!span) continue;
    if (read.skipped.includes(span.sheet)) {
      const n = tabCells(meta, meta.ids.get(span.sheet));
      s.preview = { note: `preview unavailable: ${span.sheet} has ${n} grid cells and does not fit the ${GRID_READ_MAX_CELLS}-cell read budget — read the rows with sheets_read_range and check sheets_trace_dependents first` };
    } else if (previewed.length >= DELETION_PREVIEWS_MAX) {
      s.preview = { note: `not previewed: a dry run previews the first ${DELETION_PREVIEWS_MAX} deletions of a batch — dry-run the rest separately` };
    } else previewed.push({ s, span });
  }
  if (!previewed.length) return;
  const spans = previewed.map((x) => x.span);
  const lost = await lostContentsOf(spans, meta, load);
  let tallies: DependentTally[];
  try {
    const grids = read.titles.length ? await load(read.all ? undefined : read.titles.map(wholeTabRange), CHECK_CELL_FIELDS) : [];
    tallies = tallyDependents(spans, eachResolvedFormula(grids, meta, resolve));
  } catch (err) {
    for (const { s } of previewed) s.preview = { note: `preview unavailable: the grid read failed (${why(err)})` };
    return;
  }
  const unchecked = read.skipped.length ? `large spreadsheet: formulas on ${listFew(read.skipped)} were not checked (over the ${GRID_READ_MAX_CELLS}-cell read budget) — any there that read these cells are not listed (sheets_trace_dependents)` : undefined;
  previewed.forEach(({ s }, k) => {
    const note = [lost[k].note, unchecked].filter(Boolean).join("; ");
    s.preview = { ...lost[k], ...dependentsPreview(tallies[k]), ...(note ? { note } : {}) };
  });
}

/**
 * Dry run: a preview taken after an earlier request reshaped the same tab shows today's cells, not the
 * ones that will be hit — say so. Only on previews that show cells: a note alone ("not previewed", "preview
 * unavailable") has no cells to qualify.
 */
export function markShiftedPreviews(summaries: RequestSummary[], requests: AnyRec[], meta: SheetMeta): void {
  const before = structuralBefore(requests, meta);
  for (const s of summaries) {
    if (!s.preview || typeof s.preview !== "object") continue;
    if (!("currentValues" in s.preview) && !("cellsWithData" in s.preview)) continue;
    const j = before(s.index);
    if (j !== undefined) (s.preview as AnyRec).caveat = `request #${j} reshapes this tab first — this shows today's cells at these coordinates, not necessarily the ones this request will hit`;
  }
}

// ---- bounded grid reads: the preview, the post-check, sheets_delete_sheet's check and the batch's verify re-read ----

/**
 * The most grid cells (rows × columns from the tab metadata, an upper bound on the cells Google can
 * return; for the batch's verify re-read, rows × columns of each written block, see rereadCost) one
 * includeGridData read may cover. It bounds the per-cell work (parsing, the grid map, reference
 * resolution) but not the bytes: a cell holds up to 50,000 characters, so a read also asks only for
 * the cell fields it uses (CHECK_CELL_FIELDS, SHOWN_CELL_FIELDS, VERIFY_CELL_FIELDS) and is refused
 * past GRID_READ_MAX_BYTES while it streams.
 */
export const GRID_READ_MAX_CELLS = 100_000;
/**
 * The most bytes of response one of these reads accepts (GoogleClient maxBytes), counted as the body
 * streams: a larger one is refused, never buffered or parsed, and its tabs (or, for the verify
 * re-read, its written ranges) are reported as not checked.
 * Holding a read under both caps does not by itself bound the work done on it: formula references are
 * resolved in batches bounded by formula characters (RESOLVE_CHUNK_CHARS), because 8 MB of reference-dense
 * formulas resolved at once ran out of a 128 MB heap. Measured with the tools' own code under Node, against
 * a fake that answers from serialized JSON: sheets_delete_sheet over 1,000 formulas of 889 references each
 * (two 7.7 MB reads) peaks at about 55 MB of heap and completes with a 40 MB old space; over 100,000 formula
 * cells with 3,000 named ranges (two 6.1 MB reads) it peaks between about 55 and 90 MB and needs more than a
 * 64 MB old space, within a 128 MB heap.
 */
export const GRID_READ_MAX_BYTES = 8 * 1024 * 1024;
/** Cell fields of a check read (post-checks, the dependents scan): formulas and errors only — the text a tab holds never comes down. */
export const CHECK_CELL_FIELDS = "userEnteredValue/formulaValue,effectiveValue/errorValue";
/** Cell fields of the lost-contents read: what a deletion preview shows of a cell (its formula, else its displayed value). */
export const SHOWN_CELL_FIELDS = "userEnteredValue/formulaValue,formattedValue";
/** Why a tab under `skipped` was not checked: the cells budget, or a read that came back over the byte budget. */
const OVER_CELLS = `over the ${GRID_READ_MAX_CELLS}-cell read budget`;
export const OVER_BUDGET = `over the ${GRID_READ_MAX_CELLS}-cell or ${formatBytes(GRID_READ_MAX_BYTES)} read budget`;
/** An error's message for a note, capped. */
export const why = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 200);
export const POST_CHECK_ERRORS_SHOWN = 20;
/** Names (tabs, ranges) a note lists before it says "and N more". */
const LISTED_IN_NOTE = 10;

/** A tab's grid size (rows × columns) from the metadata; 0 when unknown. */
const tabCells = (meta: SheetMeta, id: number | undefined): number => (id === undefined ? 0 : gridRangeCells({}, meta.grids.get(id)));

/** "A, B and 3 more": at most LISTED_IN_NOTE names, so a spreadsheet with hundreds of tabs does not flood a note. */
export const listFew = (names: string[]): string => (names.length <= LISTED_IN_NOTE ? names.join(", ") : `${names.slice(0, LISTED_IN_NOTE).join(", ")} and ${names.length - LISTED_IN_NOTE} more`);

/** Which tabs one grid read covers (both lists in tab order); `all` = no tab was left out. */
export interface GridRead {
  all: boolean;
  titles: string[];
  skipped: string[];
}

/**
 * Tabs for one grid read, GRID_READ_MAX_CELLS together at most: the `wanted` tabs first (the ones a
 * change touches), then every other tab not in `exclude` in tab order (formulas on other tabs are where
 * a deletion's #REF! usually lands), each one read while it fits what is left. The rest are `skipped`,
 * never read in part: a tab is read whole or not at all.
 */
export function gridReadTabs(meta: SheetMeta, wanted: Iterable<number>, exclude: Set<number> = new Set()): GridRead {
  const take = new Set<number>(), skip = new Set<number>();
  let budget = GRID_READ_MAX_CELLS;
  for (const id of [...wanted, ...meta.titles.keys()]) {
    if (take.has(id) || skip.has(id) || exclude.has(id) || !meta.titles.has(id)) continue;
    const n = tabCells(meta, id);
    if (n <= budget) {
      take.add(id);
      budget -= n;
    } else skip.add(id);
  }
  const inTabOrder = (ids: Set<number>) => [...meta.titles].filter(([id]) => ids.has(id)).map(([, title]) => title);
  return { all: skip.size === 0, titles: inTabOrder(take), skipped: inTabOrder(skip) };
}

/** postCheck = {sheets, errorCount, ok, errors: [{cell, error, formula, message}] (capped), errorsOmitted}. */
export function postCheckSummary(sheets: string[], errors: AnyRec[]): AnyRec {
  const out: AnyRec = {
    sheets,
    errorCount: errors.length,
    ok: errors.length === 0,
    errors: errors.slice(0, POST_CHECK_ERRORS_SHOWN).map((e) => ({ cell: e.cell, error: e.error, formula: clip(e.formula as string | undefined), message: e.message })),
  };
  if (errors.length > POST_CHECK_ERRORS_SHOWN) out.errorsOmitted = errors.length - POST_CHECK_ERRORS_SHOWN;
  // A state check, not a diff: without this an old #N/A reads as damage the change just did.
  if (errors.length) out.note = POST_CHECK_STATE_NOTE;
  return out;
}

export const POST_CHECK_STATE_NOTE = "lists every error these tabs show now, including any from before this change";

/**
 * The post-check of a grid read that left tabs out: `skipped` lists them, and the note says why. When
 * nothing at all was read there is no count to report — never `ok: true` for tabs nobody looked at.
 */
export function withSkipped(postCheck: AnyRec | undefined, skipped: string[], reason: string = OVER_CELLS): AnyRec {
  if (!skipped.length) return postCheck ?? postCheckSummary([], []);
  const note = `${skipped.length} tab(s) under skipped not checked: ${reason} — run sheets_audit_spreadsheet with ranges`;
  if (!postCheck) return { skipped, note };
  return { ...postCheck, skipped, note: [postCheck.note, note].filter(Boolean).join("; ") };
}

// ---- snapshot (hidden backup tabs before a destructive change) -------------------------

/** Google Sheets' limit on a tab title. */
export const MAX_SHEET_TITLE = 100;

export interface SnapshotEntry {
  sheet: string;
  sheetId: number;
  backupSheetId: number;
  backupTitle: string;
}

/** A warning that means data can be lost (not merely shifted or reordered). */
const losesData = (s: RequestSummary) => !!s.warning && !/^(shifts|reorders)/.test(s.warning);

/** Existing tabs touched by a request that can lose data: deletions, cutPaste, value writes and other overwrites. */
export function lossySheetIds(summaries: RequestSummary[], requests: AnyRec[], meta: SheetMeta): number[] {
  const ids = new Set<number>();
  for (const s of summaries) if (losesData(s)) for (const id of requestSheetIds(requests[s.index], s.index, meta)) ids.add(id);
  return [...ids];
}

const randomSheetId = (): number => (crypto.getRandomValues(new Uint32Array(1))[0] & 0x7fffffff) || 1;

/** "<title> (backup YYYY-MM-DD HH:MM UTC)", the title cut (by code point) so the whole stays within MAX_SHEET_TITLE, unique among the tabs. */
export function planSnapshot(sheetIds: number[], meta: SheetMeta, now: Date = new Date(), newId: () => number = randomSheetId): SnapshotEntry[] {
  const stamp = `${now.toISOString().slice(0, 16).replace("T", " ")} UTC`;
  const titles = new Set(meta.ids.keys());
  const ids = new Set(meta.titles.keys());
  return sheetIds.map((sheetId) => {
    const sheet = meta.titles.get(sheetId) ?? `sheet#${sheetId}`;
    let backupTitle = "";
    for (let n = 1; !backupTitle || titles.has(backupTitle); n++) {
      const suffix = ` (backup ${stamp}${n > 1 ? ` #${n}` : ""})`;
      let head = "";
      for (const ch of sheet) {
        if (head.length + ch.length + suffix.length > MAX_SHEET_TITLE) break;
        head += ch;
      }
      backupTitle = head + suffix;
    }
    titles.add(backupTitle);
    let backupSheetId = newId();
    while (ids.has(backupSheetId)) backupSheetId = newId();
    ids.add(backupSheetId);
    return { sheet, sheetId, backupSheetId, backupTitle };
  });
}

/**
 * What to append to the error of a change that failed after a snapshot was taken, so the caller
 * learns which hidden tabs now exist: `kept` after a timeout/5xx (outcome unknown, the backups stay
 * on purpose), `cleanup-failed` after a 4xx (nothing applied) whose removal of the backups failed.
 */
export function snapshotFailureNote(entries: SnapshotEntry[], why: "kept" | "cleanup-failed"): string {
  const tabs = entries.map((e) => `'${e.backupTitle}' (sheetId ${e.backupSheetId})`).join(", ");
  const list = `hidden backup tab${entries.length > 1 ? "s" : ""} ${tabs}`;
  const it = entries.length > 1 ? "them" : "it";
  return why === "kept"
    ? `snapshot kept (outcome unknown): ${list}; delete ${it} with sheets_delete_sheet when no longer needed`
    : `nothing was applied, but removing the snapshot failed: ${list}; delete ${it} with sheets_delete_sheet`;
}

/** One separate batchUpdate: duplicate each tab to the end of the tab list, then hide the copy. */
export function snapshotRequests(entries: SnapshotEntry[], meta: SheetMeta): AnyRec[] {
  return entries.flatMap((e, k) => [
    { duplicateSheet: { sourceSheetId: e.sheetId, newSheetId: e.backupSheetId, newSheetName: e.backupTitle, insertSheetIndex: meta.titles.size + k } },
    { updateSheetProperties: { properties: { sheetId: e.backupSheetId, hidden: true }, fields: "hidden" } },
  ]);
}

/**
 * Take the snapshot of `sheetIds` — sheets_batch_update_spreadsheet, sheets_delete_sheet and
 * sheets_clear_range share this: ONE batchUpdate of its own, issued before the change, so the
 * backups exist before anything is lost. Backup ids and titles come from Google's replies.
 */
export async function takeSnapshot(g: GoogleClient, spreadsheetId: string, sheetIds: number[], meta: SheetMeta, action: string): Promise<SnapshotEntry[]> {
  const entries = planSnapshot(sheetIds, meta);
  const r = await g.post<AnyRec>(`${API.sheets}/spreadsheets/${enc(spreadsheetId)}:batchUpdate`, { requests: snapshotRequests(entries, meta) });
  entries.forEach((e, k) => {
    const p = r.replies?.[2 * k]?.duplicateSheet?.properties;
    if (p?.sheetId !== undefined) e.backupSheetId = Number(p.sheetId);
    if (p?.title) e.backupTitle = String(p.title);
  });
  audit(action, { spreadsheet: spreadsheetId, snapshot: entries.map((e) => e.backupSheetId) });
  return entries;
}

/**
 * Run the change a snapshot guards (without one, just run it). Every guarded change is atomic: a 4xx
 * means Google applied none of it, so the backups guard nothing — remove them. After a timeout or 5xx
 * the outcome is unknown and the backups stay. Either way the caller must learn about any hidden tab
 * left behind, so the error names them (same status, same class, so the same classification).
 */
export async function guardedBySnapshot<T>(g: GoogleClient, spreadsheetId: string, snapshot: SnapshotEntry[] | undefined, change: () => Promise<T>): Promise<T> {
  try {
    return await change();
  } catch (err) {
    if (!snapshot?.length) throw err;
    const rejected = err instanceof GoogleApiError && err.status >= 400 && err.status < 500;
    const remove = { requests: snapshot.map((e) => ({ deleteSheet: { sheetId: e.backupSheetId } })) };
    if (rejected && (await g.post(`${API.sheets}/spreadsheets/${enc(spreadsheetId)}:batchUpdate`, remove).then(() => true, () => false))) throw err;
    const note = snapshotFailureNote(snapshot, rejected ? "cleanup-failed" : "kept");
    if (err instanceof GoogleApiError) {
      // classifyError prints the body only when it does not repeat the message; keep that decision as it was.
      throw new GoogleApiError(err.status, err.method, err.url, `${err.message} — ${note}`, err.reason, err.body?.includes(err.message) ? undefined : err.body);
    }
    if (err instanceof Error) {
      err.message = `${err.message} — ${note}`; // in place: the error keeps its class (e.g. GoogleAuthError) and so its classification
      throw err;
    }
    throw new Error(`${String(err)} — ${note}`);
  }
}

/** A snapshot as a reply reports it. */
export const snapshotReport = (entries: SnapshotEntry[]) => entries.map(({ sheet, backupSheetId, backupTitle }) => ({ sheet, backupSheetId, backupTitle }));

/**
 * The tab an A1 range lies on — a tab title, or a named range — for sheets_clear_range's snapshot.
 * A range that names no tab is rejected rather than guessed (Google would clear the first visible tab).
 */
export function tabOfRange(range: string, meta: SheetMeta): number {
  const a1 = parseA1(range);
  const id = a1.sheet === undefined ? undefined : meta.ids.get(a1.sheet);
  if (id !== undefined) return id;
  const named = meta.namedRanges.find((n) => n.name === range.trim());
  if (named) return named.range.sheetId;
  if (a1.sheet === undefined) throw new Error(`range "${range}" names no tab — with snapshot=true write it as "'Tab'!${range.trim()}"`);
  throw new Error(`no tab named '${a1.sheet}'. Tabs: ${[...meta.ids.keys()].join(", ")}`);
}
