/**
 * Google Sheets tools (highest priority — full fidelity).
 * API: https://sheets.googleapis.com/v4 (+ Drive for listing/moving).
 */
import { z } from "zod";
import { API, ResponseTooLargeError, formatBytes, type GoogleClient } from "../google/client.js";
import { tool, enc, listResult, JsonObject, PageSize, PageToken, audit, type AnyRec, provenance, MAX_OUTPUT_CHARS } from "./_shared.js";
import { driveTextQuery, escapeDriveQuery, moveToFolder } from "./_drive.js";
import { cellA1, cellsByAddress, compactFormat, entryChars, quoteSheet, wholeTabRange, type CharBudget } from "./sheets-a1.js";
import { attachPreviews, changeTotals, describeRequests, getSheetMeta, nonEmptyReply, verifyCells, type Verification } from "./sheets-verify.js";
import {
  CHECK_CELL_FIELDS,
  GRID_READ_MAX_BYTES,
  GRID_READ_MAX_CELLS,
  MOVER_CHECKS_MAX,
  OVER_BUDGET,
  eachResolvedFormula,
  expandRequests,
  gridReadTabs,
  groupWarnings,
  guardedBySnapshot,
  laterMovers,
  listFew,
  lossySheetIds,
  markShiftedPreviews,
  openEnded,
  planSnapshot,
  postCheckSummary,
  previewDeletions,
  repliesByRequest,
  requestSheetIds,
  rereadCost,
  sizedByGrid,
  snapshotReport,
  structuralSheets,
  summaryChanges,
  tabList,
  tabOfRange,
  tabsReading,
  takeSnapshot,
  titlesAfter,
  UNLOCATED,
  UNTRACKED,
  why,
  withSkipped,
  writtenBlock,
  type GridLoader,
  type GridRead,
  type RequestSummary,
  type SheetMeta,
  type SnapshotEntry,
  type TabBlock,
} from "./sheets-verify.js";
import { gridErrors, loadGrids, resolveFormulas } from "./sheets-analysis.js";
import { capFillVerification, MAX_FILL_VALUE_CHARS, planFill, qualifyRange } from "./sheets-fill.js";

const SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const escapeQ = escapeDriveQuery;
const CellValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const Rows = z.array(z.array(CellValue)).describe("2-D array of rows → cells. Strings starting with '=' are formulas when value_input_option=USER_ENTERED");
const ValueInputOption = z.enum(["USER_ENTERED", "RAW"]).default("USER_ENTERED").describe("USER_ENTERED parses like typing in the UI (formulas, dates, numbers); RAW stores strings verbatim");
const ValueRenderOption = z.enum(["FORMATTED_VALUE", "UNFORMATTED_VALUE", "FORMULA"]).default("FORMATTED_VALUE");
const DateTimeRenderOption = z.enum(["SERIAL_NUMBER", "FORMATTED_STRING"]).default("FORMATTED_STRING");
/** A short alias for a tab, so a long (often Hebrew) tab name is not repeated in every range. One meaning on every write: `qualifyRange`/`planFill`. */
const SheetIdForRange = z.number().int().optional().describe("Tab id for an unqualified range (sheets_get_spreadsheet)");

const METADATA_FIELDS =
  "spreadsheetId,spreadsheetUrl,properties(title,locale,timeZone,autoRecalc),sheets(properties(sheetId,title,index,sheetType,hidden,gridProperties(rowCount,columnCount,frozenRowCount,frozenColumnCount)),merges,protectedRanges(protectedRangeId,range,description)),namedRanges(namedRangeId,name,range),dataSources(dataSourceId)";

const CELL_FIELDS = ["value", "formula", "note", "link", "validation", "number_format", "text", "fill", "align", "borders", "format"] as const;
type CellField = (typeof CELL_FIELDS)[number];
const FORMAT_FIELDS: CellField[] = ["number_format", "text", "fill", "align", "borders"];
const DEFAULT_CELL_FIELDS: CellField[] = ["value", "formula", "note", "link"];

/** Expand the `fields` selection ("format" = every format field) into a Set. */
function wantedFields(fields: readonly CellField[]): Set<CellField> {
  const want = new Set<CellField>(fields);
  if (want.has("format")) for (const f of FORMAT_FIELDS) want.add(f);
  return want;
}

/** API field mask for spreadsheets.get matching the selection (keeps the response as small as the output). */
function cellFieldMask(want: Set<CellField>): string {
  const parts: string[] = [];
  if (want.has("value")) parts.push("formattedValue", "effectiveValue");
  if (want.has("formula")) parts.push("userEnteredValue");
  if (want.has("note")) parts.push("note");
  if (want.has("link")) parts.push("hyperlink");
  if (want.has("validation")) parts.push("dataValidation");
  const fmt: string[] = [];
  if (want.has("number_format")) fmt.push("numberFormat");
  if (want.has("fill")) fmt.push("backgroundColor");
  if (want.has("text")) fmt.push("textFormat");
  if (want.has("align")) fmt.push("horizontalAlignment", "verticalAlignment", "wrapStrategy", "textDirection");
  if (want.has("borders")) fmt.push("borders");
  if (fmt.length) parts.push(`userEnteredFormat(${fmt.join(",")})`);
  return parts.join(",");
}

/** Compact a CellData into {v, f?, n?, note?, link?, error?, fmt?, validation?} — only the selected fields. */
export function compactCell(c: AnyRec | undefined, want: Set<CellField>): AnyRec | null {
  if (!c) return null;
  const out: AnyRec = {};
  const uev = c.userEnteredValue;
  if (want.has("value")) {
    if (c.formattedValue !== undefined) out.v = c.formattedValue;
    else if (uev && !uev.formulaValue) out.v = uev.stringValue ?? uev.numberValue ?? uev.boolValue ?? uev.errorValue?.message;
    if (c.effectiveValue?.numberValue !== undefined && typeof out.v === "string") out.n = c.effectiveValue.numberValue;
    if (c.effectiveValue?.errorValue) out.error = c.effectiveValue.errorValue.message ?? c.effectiveValue.errorValue.type;
  }
  if (want.has("formula") && uev?.formulaValue) out.f = uev.formulaValue;
  if (want.has("note") && c.note) out.note = c.note;
  if (want.has("link") && c.hyperlink) out.link = c.hyperlink;
  const fmt = compactFormat(c.userEnteredFormat, want);
  if (fmt) out.fmt = fmt;
  if (want.has("validation") && c.dataValidation) out.validation = c.dataValidation;
  return Object.keys(out).length ? out : null;
}

/** Attach post-write verification (error cells) to a write result. */
function withVerification<T extends AnyRec>(result: T, verification: Verification | undefined): T & { verification?: Verification; warning?: string } {
  if (!verification) return result;
  const out: T & { verification?: Verification; warning?: string } = { ...result, verification };
  if (!verification.ok) out.warning = `${verification.errors.length} written cell(s) evaluate to an error: ${verification.errors.slice(0, 5).map((e) => `${e.cell} ${e.type ?? ""}${e.message ? ` (${e.message})` : ""}`).join("; ")}${verification.errors.length > 5 ? "; …" : ""}`;
  return out;
}

/**
 * shape=cells replies build only the cells one reply can carry (see cellsByAddress): the budget
 * is the reply limit minus the fields around the cells. `head` (provenance, range, sheet) is
 * charged as measured; ENVELOPE covers the counts, the cut flags and the cut note, and a batch
 * reserves RANGE plus the echoed range for every entry of `valueRanges` up front, before any
 * range's cells are built. RANGE covers one entry's keys, its counts at their largest and the
 * separators around its cells (about 125 characters).
 */
const CELLS_ENVELOPE_CHARS = 1_000;
const CELLS_RANGE_CHARS = 150;
const cellsBudget = (head: unknown): CharBudget => ({ left: MAX_OUTPUT_CHARS - JSON.stringify(head).length - CELLS_ENVELOPE_CHARS });
const CELLS_CUT_NOTE = "Reply size limit: cells holds only the first returnedCells of cellCount non-empty cells, in read order. Read a narrower range to get the rest.";
const CELLS_BATCH_CUT_NOTE = "Reply size limit: a range with truncated=true holds only the first returnedCells of its cellCount non-empty cells, in read order. Read fewer or narrower ranges to get the rest.";

/** A shape=cells reply: `head` first, then the counts, the cut note when cut, then the cells (so the note precedes them). */
function addressedReply(head: AnyRec, grid: { cellCount: number; truncated?: true; returnedCells?: number; cells: AnyRec }): AnyRec {
  const { cells, ...counts } = grid;
  return { ...head, ...counts, ...(grid.truncated ? { note: CELLS_CUT_NOTE } : {}), cells };
}

const Verify = z.boolean().default(true).describe("Re-read the written cells and report any that evaluate to an error (#REF!, #DIV/0!, #N/A, …) with Google's message. One extra read.");

/** Once a change IS applied, a failed re-read is reported, never thrown: a thrown error would read as "nothing happened" and invite a retry that repeats it. */
const rereadFailed = (what: string, err: unknown, applied: string) => `${what} re-read failed (${why(err)}); ${applied}`;
/** Opt-in (default false) on every tool that takes one: a tool never adds tabs to someone's file unasked. */
const Snapshot = z.boolean().default(false);

/** The grid reads of the safety features: callers keep them to GRID_READ_MAX_CELLS, this to GRID_READ_MAX_BYTES and the cell fields asked for. */
const boundedLoader =
  (g: GoogleClient, id: string): GridLoader =>
  (ranges, cells) =>
    loadGrids(g, id, ranges, { cells, maxBytes: GRID_READ_MAX_BYTES });

/**
 * sheets_delete_sheet's check before the delete: the other tabs holding a formula that reads `title`, from one
 * formulas-and-errors read of every other tab that fits. Its own function so that read's grids are released
 * before the re-read after the delete; `over` lists the tabs when the response came back over the byte budget.
 */
async function readersOf(load: GridLoader, meta: SheetMeta, sheetId: number, title: string): Promise<{ read: GridRead; reading: string[] } | { error: string } | { over: string[] }> {
  const read = gridReadTabs(meta, [], new Set([sheetId]));
  try {
    const grids = read.titles.length ? await load(read.titles.map(wholeTabRange), CHECK_CELL_FIELDS) : [];
    return { read, reading: tabsReading(title, eachResolvedFormula(grids, meta, resolveFormulas)) };
  } catch (err) {
    if (err instanceof ResponseTooLargeError) return { over: [...meta.titles].filter(([id]) => id !== sheetId).map(([, t]) => t) };
    return { error: why(err) };
  }
}

/**
 * One formulas-and-errors read of the tabs `read` covers (every tab, unnamed, when `named` is false) → postCheck
 * in the batch tool's shape, the tabs it left out under `skipped`. A response over the byte budget is refused
 * while it streams and every tab it covered joins `skipped`: never parsed, and never ok: true for tabs nobody saw.
 */
async function errorCheck(load: GridLoader, read: GridRead, meta: SheetMeta, named = true): Promise<AnyRec> {
  if (!read.titles.length) return withSkipped(undefined, read.skipped);
  try {
    const grids = await load(named ? read.titles.map(wholeTabRange) : undefined, CHECK_CELL_FIELDS);
    return withSkipped(postCheckSummary(grids.map((x) => x.title), grids.flatMap((x) => gridErrors(x))), read.skipped);
  } catch (err) {
    if (!(err instanceof ResponseTooLargeError)) throw err;
    const left = new Set([...read.titles, ...read.skipped]);
    return withSkipped(undefined, [...meta.titles.values()].filter((t) => left.has(t)), OVER_BUDGET);
  }
}

export const sheetsTools = [
  tool({
    name: "sheets_list_spreadsheets",
    description: "List Google Sheets spreadsheets in Drive (optionally filtered by name/full-text query or folder). Returns id, name, modifiedTime, owners, webViewLink.",
    scope: "https://www.googleapis.com/auth/drive",
    input: {
      query: z.string().optional().describe("Free text (matches name or contents) OR a raw Drive query like name contains 'Budget'"),
      folder_id: z.string().optional().describe("Only spreadsheets inside this folder"),
      page_size: PageSize(25, 200),
      page_token: PageToken,
      order_by: z.string().default("modifiedTime desc").describe("Drive orderBy, e.g. 'modifiedTime desc', 'name'"),
    },
    handler: async (a, { g }) => {
      const parts = ["mimeType = 'application/vnd.google-apps.spreadsheet'", "trashed = false"];
      if (a.folder_id) parts.push(`'${escapeQ(a.folder_id)}' in parents`);
      if (a.query) parts.push(driveTextQuery(a.query));
      const r = await g.get<AnyRec>(`${API.drive}/files`, {
        q: parts.join(" and "),
        pageSize: a.page_size,
        pageToken: a.page_token,
        orderBy: a.order_by,
        fields: "nextPageToken,files(id,name,modifiedTime,owners(emailAddress),webViewLink,shared,parents)",
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });
      return listResult(r.files, r.nextPageToken);
    },
  }),

  tool({
    name: "sheets_get_spreadsheet",
    description: "Spreadsheet metadata: title, locale/timezone, every tab (sheetId, title, index, grid rowCount/columnCount, frozen rows/cols, hidden), named ranges, protected ranges, and (include_merges=true) merged ranges.",
    scope: SCOPE,
    input: {
      spreadsheet_id: z.string().describe("Spreadsheet id (from the URL /d/<id>/)"),
      include_merges: z.boolean().default(false).describe("Also list merged cell ranges per tab (can be long on formatted sheets)"),
    },
    handler: async (a, { g }) => g.get(`${API.sheets}/spreadsheets/${enc(a.spreadsheet_id)}`, { fields: a.include_merges ? METADATA_FIELDS : METADATA_FIELDS.replace(",merges", "") }),
  }),

  tool({
    name: "sheets_read_range",
    description:
      "Read cell values from a range in A1 notation (e.g. 'Sheet1!A1:D20', 'Sheet1' for the whole tab, or a named range). Set include_formulas=true to also get a parallel 2-D array `formulas` where formula cells show their '=…' text and every other cell repeats the entry from `values`. FORMATTED_VALUE returns display strings; use UNFORMATTED_VALUE for typed numbers/dates. shape=cells keys non-empty cells by A1 address; use it before writing into a specific cell or when trailing blanks matter.",
    scope: SCOPE,
    input: {
      spreadsheet_id: z.string(),
      range: z.string().describe("A1 notation or named range"),
      include_formulas: z.boolean().default(false).describe("Also return formulas (cells without a formula show their value)"),
      value_render_option: ValueRenderOption.describe("FORMATTED_VALUE (as displayed), UNFORMATTED_VALUE (raw numbers/dates), FORMULA"),
      date_time_render_option: DateTimeRenderOption,
      major_dimension: z.enum(["ROWS", "COLUMNS"]).default("ROWS"),
      shape: z.enum(["grid", "cells"]).default("grid"),
    },
    handler: async (a, { g }) => {
      const base = `${API.sheets}/spreadsheets/${enc(a.spreadsheet_id)}/values`;
      const common = { majorDimension: a.major_dimension, dateTimeRenderOption: a.date_time_render_option };
      if (!a.include_formulas) {
        const r = await g.get<AnyRec>(`${base}/${enc(a.range)}`, { ...common, valueRenderOption: a.value_render_option });
        if (a.shape === "cells") {
          const head = { ...provenance(`sheets:spreadsheet:${a.spreadsheet_id}`, ["cells.*.value"]), range: r.range ?? a.range };
          return addressedReply(head, cellsByAddress(head.range, r.values, { majorDimension: r.majorDimension ?? a.major_dimension, budget: cellsBudget(head) }));
        }
        return { ...provenance(`sheets:spreadsheet:${a.spreadsheet_id}`, ["values"]), range: r.range, majorDimension: r.majorDimension, rows: r.values?.length ?? 0, values: r.values ?? [] };
      }
      const [vals, formulas] = await Promise.all([
        g.get<AnyRec>(`${base}/${enc(a.range)}`, { ...common, valueRenderOption: a.value_render_option }),
        g.get<AnyRec>(`${base}/${enc(a.range)}`, { ...common, valueRenderOption: "FORMULA" }),
      ]);
      if (a.shape === "cells") {
        const head = { ...provenance(`sheets:spreadsheet:${a.spreadsheet_id}`, ["cells.*.value", "cells.*.formula"]), range: vals.range ?? a.range };
        return addressedReply(head, cellsByAddress(head.range, vals.values, { majorDimension: vals.majorDimension ?? a.major_dimension, formulas: formulas.values, budget: cellsBudget(head) }));
      }
      const values: unknown[][] = vals.values ?? [];
      const formulaRows: unknown[][] = formulas.values ?? [];
      // Google's FORMULA rendering returns raw typed values for non-formula cells (numbers where
      // `values` has strings); mirror `values` there so the two arrays only differ on formulas.
      const merged = formulaRows.map((row, i) => row.map((cell, j) => (typeof cell === "string" && cell.startsWith("=") ? cell : (values[i]?.[j] ?? cell))));
      return { ...provenance(`sheets:spreadsheet:${a.spreadsheet_id}`, ["values", "formulas"]), range: vals.range, majorDimension: vals.majorDimension, rows: values.length, values, formulas: merged };
    },
  }),

  tool({
    name: "sheets_batch_read_ranges",
    description: "Read several ranges in one call (values.batchGet). shape=cells keys each range's non-empty cells by A1 address; use it before writing into a specific cell or when trailing blanks matter.",
    scope: SCOPE,
    input: {
      spreadsheet_id: z.string(),
      ranges: z.array(z.string()).min(1).max(100),
      value_render_option: ValueRenderOption,
      date_time_render_option: DateTimeRenderOption,
      shape: z.enum(["grid", "cells"]).default("grid"),
    },
    handler: async (a, { g }) => {
      const r = await g.get<AnyRec>(`${API.sheets}/spreadsheets/${enc(a.spreadsheet_id)}/values:batchGet`, {
        ranges: a.ranges,
        valueRenderOption: a.value_render_option,
        dateTimeRenderOption: a.date_time_render_option,
      });
      if (a.shape === "cells") {
        // One entry per range, in the order asked, each addressed from the range Google echoed for
        // it. The ranges share one reply's budget: once it is spent, later ranges are only counted.
        // Every range's entry is reserved BEFORE any cells are built — a range after the cut still
        // sends its range and counts, so charging it only when reached let a big first range spend
        // what the entries after it needed.
        const head = provenance(`sheets:spreadsheet:${a.spreadsheet_id}`, ["valueRanges[].cells.*.value"]);
        const budget = cellsBudget(head);
        const echoed: AnyRec[] = (r.valueRanges ?? []).map((v: AnyRec, i: number) => ({ ...v, range: v.range ?? a.ranges[i] }));
        for (const v of echoed) budget.left -= JSON.stringify(v.range ?? "").length + CELLS_RANGE_CHARS;
        const valueRanges = echoed.map((v) => ({ range: v.range as string, ...cellsByAddress(v.range, v.values, { majorDimension: v.majorDimension, budget }) }));
        const cut = valueRanges.some((v: { truncated?: true }) => v.truncated);
        return { ...head, ...(cut ? { note: CELLS_BATCH_CUT_NOTE } : {}), valueRanges };
      }
      return { ...provenance(`sheets:spreadsheet:${a.spreadsheet_id}`, ["valueRanges[].values"]), valueRanges: (r.valueRanges ?? []).map((v: AnyRec) => ({ range: v.range, values: v.values ?? [] })) };
    },
  }),

  tool({
    name: "sheets_read_cells",
    description:
      "Full-fidelity cell read for a range: values, formulas, notes, hyperlinks, data validation and formatting — pick exactly which with `fields` so the output stays small. Cells come back as {v, f, n (numeric value when v is a formatted string), note, link, error, fmt, validation}. fmt uses hex colors and collapses identical borders to {all}. Heavier than sheets_read_range; use it when formatting/notes matter. shape=cells keys non-empty cells by A1 address.",
    scope: SCOPE,
    input: {
      spreadsheet_id: z.string(),
      range: z.string().describe("A1 notation (keep it small — every cell is expanded)"),
      fields: z
        .array(z.enum(CELL_FIELDS))
        .min(1)
        .default([...DEFAULT_CELL_FIELDS])
        .describe("Which cell facets to return. value | formula | note | link | validation | number_format | text (bold/italic/size/font/color) | fill (background) | align (h/v/wrap/direction) | borders | format (= all format facets). Default: value, formula, note, link."),
      shape: z.enum(["grid", "cells"]).default("grid"),
    },
    handler: async (a, { g }) => {
      const want = wantedFields(a.fields);
      const r = await g.get<AnyRec>(`${API.sheets}/spreadsheets/${enc(a.spreadsheet_id)}`, {
        ranges: a.range,
        includeGridData: true,
        fields: `sheets(properties(sheetId,title),data(startRow,startColumn,rowData(values(${cellFieldMask(want)}))))`,
      });
      const sheet = r.sheets?.[0];
      const data = sheet?.data?.[0];
      if (a.shape === "cells") {
        // GridData carries its own 0-based origin (Google omits a 0), so the requested range needs no parsing.
        const row0 = (data?.startRow ?? 0) + 1;
        const col0 = (data?.startColumn ?? 0) + 1;
        const head = { ...provenance(`sheets:spreadsheet:${a.spreadsheet_id}`, ["cells.*.v", "cells.*.f", "cells.*.note", "cells.*.link"]), sheet: sheet?.properties };
        // Same bound as cellsByAddress: add cells in read order while they fit one reply, then only count.
        const budget = cellsBudget(head);
        const cells: Record<string, AnyRec> = {};
        let cellCount = 0;
        let returned = 0;
        let full = false;
        (data?.rowData ?? []).forEach((row: AnyRec, i: number) =>
          (row.values ?? []).forEach((c: AnyRec, j: number) => {
            const cell = compactCell(c, want);
            if (!cell) return;
            cellCount++;
            if (full) return;
            const address = cellA1(row0 + i, col0 + j);
            const size = entryChars(address, cell);
            if (size > budget.left) {
              full = true;
              return;
            }
            budget.left -= size;
            cells[address] = cell;
            returned++;
          }),
        );
        return addressedReply(head, { cellCount, ...(full ? { truncated: true as const, returnedCells: returned } : {}), cells });
      }
      return {
        ...provenance(`sheets:spreadsheet:${a.spreadsheet_id}`, ["rows[][].v", "rows[][].f", "rows[][].note", "rows[][].link"]),
        sheet: sheet?.properties,
        startRow: (data?.startRow ?? 0) + 1,
        startColumn: (data?.startColumn ?? 0) + 1,
        rows: (data?.rowData ?? []).map((row: AnyRec) => (row.values ?? []).map((c: AnyRec) => compactCell(c, want))),
      };
    },
  }),

  tool({
    name: "sheets_write_range",
    description: "Overwrite a range with values (values.update). The 2-D array's top-left lands on the range's top-left; cells beyond the array are untouched. Use null to skip a cell, '' to clear it. Same formula in many cells: sheets_fill_range.",
    scope: SCOPE,
    write: true,
    idempotent: true,
    input: {
      spreadsheet_id: z.string(),
      range: z.string().describe("A1 notation, e.g. 'Sheet1!B2'"),
      sheet_id: SheetIdForRange,
      values: Rows,
      value_input_option: ValueInputOption,
      include_values_in_response: z.boolean().default(false),
      verify: Verify,
    },
    handler: async (a, { g }) => {
      // Without sheet_id the range goes to Google exactly as given, and no metadata is read.
      const range = a.sheet_id === undefined ? a.range : qualifyRange(a.range, a.sheet_id, await getSheetMeta(g, a.spreadsheet_id));
      const r = await g.put<AnyRec>(
        `${API.sheets}/spreadsheets/${enc(a.spreadsheet_id)}/values/${enc(range)}`,
        { range, majorDimension: "ROWS", values: a.values },
        { valueInputOption: a.value_input_option, includeValuesInResponse: a.include_values_in_response, responseValueRenderOption: "FORMATTED_VALUE" },
      );
      audit("sheets_write_range", { spreadsheet: a.spreadsheet_id, range, cells: r.updatedCells });
      const verification = a.verify && r.updatedRange ? await verifyCells(g, a.spreadsheet_id, [r.updatedRange]) : undefined;
      return withVerification(r, verification);
    },
  }),

  tool({
    name: "sheets_batch_write_ranges",
    description: "Write several ranges in one call (values.batchUpdate). Same formula in many cells: sheets_fill_range.",
    scope: SCOPE,
    write: true,
    idempotent: true,
    input: {
      spreadsheet_id: z.string(),
      data: z.array(z.object({ range: z.string(), sheet_id: SheetIdForRange, values: Rows })).min(1),
      value_input_option: ValueInputOption,
      verify: Verify,
    },
    handler: async (a, { g }) => {
      // Metadata is read once, and only when an entry carries sheet_id; every entry is qualified before anything is written.
      const meta = a.data.some((d) => d.sheet_id !== undefined) ? await getSheetMeta(g, a.spreadsheet_id) : undefined;
      const data = a.data.map((d, i) => {
        if (d.sheet_id === undefined || !meta) return { range: d.range, majorDimension: "ROWS", values: d.values };
        try {
          return { range: qualifyRange(d.range, d.sheet_id, meta), majorDimension: "ROWS", values: d.values };
        } catch (err) {
          throw new Error(`data[${i}]: ${(err as Error).message}`);
        }
      });
      const r = await g.post<AnyRec>(`${API.sheets}/spreadsheets/${enc(a.spreadsheet_id)}/values:batchUpdate`, { valueInputOption: a.value_input_option, data });
      audit("sheets_batch_write_ranges", { spreadsheet: a.spreadsheet_id, ranges: a.data.length, cells: r.totalUpdatedCells });
      const responses: AnyRec[] = r.responses ?? [];
      const written = responses.map((x) => x.updatedRange).filter((x): x is string => typeof x === "string");
      const verification = a.verify && written.length ? await verifyCells(g, a.spreadsheet_id, written) : undefined;
      return withVerification({ totalUpdatedCells: r.totalUpdatedCells, totalUpdatedRows: r.totalUpdatedRows, responses: responses.map((x) => ({ range: x.updatedRange, cells: x.updatedCells })) }, verification);
    },
  }),

  tool({
    name: "sheets_fill_range",
    description:
      "Fill one formula or value across a range, relative references adjusting as with the fill handle. It is written once into the top-left cell of `range`, then copyPaste PASTE_NORMAL copies it and that cell's format over the rest. Max 50,000 cells.",
    scope: SCOPE,
    write: true,
    idempotent: true,
    input: {
      spreadsheet_id: z.string(),
      range: z.string().describe("Whole target incl. first cell: 'Tab'!C2:N2, or C2:C40 with sheet_id"),
      value: z.string().min(1).max(MAX_FILL_VALUE_CHARS).describe("Top-left cell as typed: '=…' formula, number, TRUE/FALSE or text"),
      sheet_id: SheetIdForRange,
      verify: Verify,
    },
    handler: async (a, { g }) => {
      const plan = planFill(a.range, a.sheet_id, a.value, await getSheetMeta(g, a.spreadsheet_id));
      await g.post(`${API.sheets}/spreadsheets/${enc(a.spreadsheet_id)}:batchUpdate`, { requests: plan.requests });
      audit("sheets_fill_range", { spreadsheet: a.spreadsheet_id, range: plan.range, cells: plan.cells });
      const verification = a.verify ? await verifyCells(g, a.spreadsheet_id, plan.verifyRanges) : undefined;
      const result: AnyRec = { spreadsheetId: a.spreadsheet_id, range: plan.range, cells: plan.cells, topLeft: { cell: plan.topLeft, value: a.value } };
      // Over FILL_VERIFY_CELLS only a head and a tail band are re-read; say which, so `ok` is not read as "every cell checked".
      if (verification && plan.sampled) result.verifiedRanges = plan.verifyRanges;
      // The warning counts every error cell; the list is capped, since one bad formula fills them all.
      const out = withVerification(result, verification);
      if (out.verification) out.verification = capFillVerification(out.verification);
      return out;
    },
  }),

  tool({
    name: "sheets_append_rows",
    description: "Append rows after the last row of the table that starts at `range` (values.append). Pass the tab name (e.g. 'Sheet1' or 'Sheet1!A:D') — Sheets finds the end of the data.",
    scope: SCOPE,
    write: true,
    destructive: false,
    input: {
      spreadsheet_id: z.string(),
      range: z.string().describe("Table range / tab name to append to"),
      values: Rows,
      value_input_option: ValueInputOption,
      insert_data_option: z.enum(["INSERT_ROWS", "OVERWRITE"]).default("INSERT_ROWS"),
      verify: Verify,
    },
    handler: async (a, { g }) => {
      const r = await g.post<AnyRec>(
        `${API.sheets}/spreadsheets/${enc(a.spreadsheet_id)}/values/${enc(a.range)}:append`,
        { range: a.range, majorDimension: "ROWS", values: a.values },
        { valueInputOption: a.value_input_option, insertDataOption: a.insert_data_option, includeValuesInResponse: false },
      );
      audit("sheets_append_rows", { spreadsheet: a.spreadsheet_id, range: a.range, rows: a.values.length });
      const updatedRange = r.updates?.updatedRange;
      const verification = a.verify && typeof updatedRange === "string" ? await verifyCells(g, a.spreadsheet_id, [updatedRange]) : undefined;
      return withVerification({ tableRange: r.tableRange, updates: r.updates }, verification);
    },
  }),

  tool({
    name: "sheets_clear_range",
    description: "Clear values in a range (formatting is kept).",
    scope: SCOPE,
    write: true,
    idempotent: true,
    destructive: true,
    input: { spreadsheet_id: z.string(), range: z.string(), snapshot: Snapshot.describe("First copy its tab to a hidden backup tab (range must name the tab)") },
    handler: async (a, { g }) => {
      const id = a.spreadsheet_id;
      // The same snapshot as sheets_batch_update_spreadsheet takes: a hidden copy of the tab, in its own call, before the clear.
      let snapshot: SnapshotEntry[] | undefined;
      if (a.snapshot === true) {
        const meta = await getSheetMeta(g, id);
        snapshot = await takeSnapshot(g, id, [tabOfRange(a.range, meta)], meta, "sheets_clear_range");
      }
      const r = await guardedBySnapshot(g, id, snapshot, () => g.post<AnyRec>(`${API.sheets}/spreadsheets/${enc(id)}/values/${enc(a.range)}:clear`, {}));
      audit("sheets_clear_range", { spreadsheet: id, range: a.range });
      return snapshot ? { ...r, snapshot: snapshotReport(snapshot) } : r;
    },
  }),

  tool({
    name: "sheets_batch_update_spreadsheet",
    description:
      "Run spreadsheets.batchUpdate requests — the full Sheets API: repeatCell/updateCells (formats, number formats, colors), updateBorders, insertDimension/deleteDimension, mergeCells, addConditionalFormatRule, setDataValidation, sortRange, autoResizeDimensions, addChart, addNamedRange, updateSheetProperties (freeze/rename/hide), etc. Grid ranges are 0-based, end-exclusive; sheetId from sheets_get_spreadsheet. Requests apply in order and atomically: put value writes ({writeValues}) and structural changes (deleteDimension, insertDimension, …) in ONE call. dry_run=true writes nothing and previews each request, incl. the current contents of cells it overwrites or deletes and the formulas a deletion breaks. A real run re-reads written cells and, after structural changes, re-checks the tabs for error cells.",
    scope: SCOPE,
    write: true,
    idempotent: true,
    input: {
      spreadsheet_id: z.string(),
      requests: z
        .array(JsonObject)
        .min(1)
        .describe(
          "Request objects, e.g. [{repeatCell:{range:{sheetId:0,startRowIndex:0,endRowIndex:1},cell:{userEnteredFormat:{textFormat:{bold:true}}},fields:'userEnteredFormat.textFormat.bold'}}]. Also {writeValues:{range:\"'Tab'!A1:B2\",values:[[…]]}} (or sheetId + range A1:B2): range = the array's exact block; '=…' is a formula, other strings text, null skips a cell, '' clears it",
        ),
      dry_run: z.boolean().default(false).describe("Preview every request and write nothing"),
      reply: z.enum(["summary", "full"]).default("summary").describe("summary: totals, grouped warnings, notable changes only; full: every request's effect"),
      verify: Verify.describe("Re-read cells whose values were written and report error cells"),
      post_check: z.boolean().default(true).describe("After structural changes, re-read the tabs and report error cells (#REF!, …)"),
      snapshot: Snapshot.describe("First copy each tab a destructive request touches to a hidden backup tab (delete backups when no longer needed)"),
      include_spreadsheet_in_response: z.boolean().default(false),
      response_ranges: z.array(z.string()).optional().describe("Limit the returned spreadsheet to these ranges when include_spreadsheet_in_response"),
    },
    handler: async (a, { g }) => {
      const id = a.spreadsheet_id;
      const url = `${API.sheets}/spreadsheets/${enc(id)}:batchUpdate`;
      const meta = await getSheetMeta(g, id);
      // Validates every writeValues (tab, shape, cell types) before anything is read or written.
      const expanded = expandRequests(a.requests, meta);
      const plan = describeRequests(a.requests, meta);
      const warnings = groupWarnings(plan);
      const lossy = lossySheetIds(plan, a.requests, meta);
      if (a.dry_run) {
        await attachPreviews(g, id, plan, meta);
        // Bounded like the post-check, and never fatal: without the grids the plan is still the answer.
        await previewDeletions(plan, a.requests, meta, boundedLoader(g, id), resolveFormulas);
        markShiftedPreviews(plan, a.requests, meta);
        // Previews carry the spreadsheet's own contents: the provenance notice goes first, as on every Sheets read.
        const shown = plan.some((p) => {
          const pv = (p.preview ?? {}) as AnyRec;
          return (Array.isArray(pv.currentValues) && pv.currentValues.length > 0) || Array.isArray(pv.dependents);
        });
        const out: AnyRec = {
          ...(shown ? provenance(`sheets:spreadsheet:${id}`, ["requests[].preview.currentValues", "requests[].preview.dependents[].formula"]) : {}),
          dryRun: true,
          wrote: false,
          requests: plan,
          totals: changeTotals(plan),
          warnings,
          note: "Nothing was changed. Re-run with dry_run=false to apply.",
        };
        if (lossy.length && a.snapshot === true) out.snapshot = planSnapshot(lossy, meta).map(({ sheet, backupTitle }) => ({ sheet, backupTitle }));
        else if (lossy.length) out.hint = `snapshot=true would first copy ${lossy.map((x) => meta.titles.get(x)).join(", ")} to hidden backup tab(s)`;
        return out;
      }

      // Snapshot: a SEPARATE batchUpdate issued first, so the backups exist before anything is lost.
      const snapshot: SnapshotEntry[] | undefined = a.snapshot === true && lossy.length ? await takeSnapshot(g, id, lossy, meta, "sheets_batch_update_spreadsheet") : undefined;
      const r = await guardedBySnapshot(g, id, snapshot, () =>
        g.post<AnyRec>(url, {
          requests: expanded.requests,
          includeSpreadsheetInResponse: a.include_spreadsheet_in_response,
          responseRanges: a.response_ranges,
          responseIncludeGridData: false,
        }),
      );
      audit("sheets_batch_update_spreadsheet", { spreadsheet: id, requests: a.requests.map((q) => Object.keys(q)[0]) });
      const replies = repliesByRequest(r.replies, expanded.origin, a.requests.length);
      for (const p of plan) {
        p.reply = nonEmptyReply(replies, p.index);
        delete p.preview;
      }
      const totals = changeTotals(plan, replies);

      // From here on the batch IS applied: a failed re-read is reported, never thrown.
      const failure = (what: string, err: unknown) => rereadFailed(what, err, "the batch itself was applied");
      const notes: string[] = [];
      // Re-reads name tabs as they are titled after the batch (a rename in it would fail a read by the old title).
      const after = titlesAfter(a.requests, meta, replies);
      // The tab list and grid sizes as they are AFTER the batch: one small metadata read, made only when the
      // verify re-read (a write sized by a tab's grid) or the post-check needs it, and shared between them.
      let metaAfterRead: Promise<SheetMeta> | undefined;
      const metaAfter = () => (metaAfterRead ??= getSheetMeta(g, id));
      // Re-read every block a value write lands on (writtenBlock) at its coordinates, unless a later request in
      // the batch moves or deletes its cells: then those coordinates hold other cells (or none), and the block is
      // left to the post-check. The re-read is one grid read, bounded like the others: GRID_READ_MAX_CELLS grid
      // cells, each block charged at every cell the read covers (rereadCost: the whole block, not only the values
      // written, each open end — a whole row, column or tab — cut at the grid AFTER the batch, which an earlier
      // request in it may have grown or shrunk, and read as that closed block), GRID_READ_MAX_BYTES of response,
      // and only each cell's effective value. Every write it does not re-read is named in the note: moved, over a
      // budget, on a tab this batch adds, covering no cell of the grid after the batch, with an open end on a grid
      // that could not be read, or one whose cells are not known before it runs (UNLOCATED). Telling whether a
      // later request moves a block keeps to a budget of its own (laterMovers). All of it only when verifying.
      const moved: { index: number; range: string; sheetId: number; by: number }[] = [];
      const untracked: { index: number; range: string; sheetId: number }[] = [];
      const unlocated: { label: string; sheetIds: number[] }[] = [];
      const onAdded: string[] = [];
      const reread: string[] = [];
      const rereadRanges: string[] = [];
      const unread: string[] = [];
      const noCells: string[] = [];
      const unsized: { index: number; label: string; sheetId: number }[] = [];
      let sizeError: unknown;
      if (a.verify !== false) {
        const moverOf = laterMovers(a.requests);
        const inPlace: { block: TabBlock; label: string; index: number; type: string }[] = [];
        /** A block left where it was written goes to inPlace, a moved one is named with its mover. */
        const place = (block: TabBlock, label: string, p: RequestSummary) => {
          const by = moverOf(p.index, block);
          if (by === UNTRACKED) untracked.push({ index: p.index, range: label, sheetId: block.sheetId });
          else if (by !== undefined) moved.push({ index: p.index, range: label, sheetId: block.sheetId, by });
          // Gone after the batch without a later mover: only a deleteSheet BEFORE the write, which Google rejects.
          else if (after.has(block.sheetId)) inPlace.push({ block, label, index: p.index, type: p.type });
        };
        const pastes: { p: RequestSummary; label: string; sheetId: number }[] = [];
        for (const p of plan) {
          const req = a.requests[p.index];
          const block = writtenBlock(req, p, meta);
          if (block === undefined) continue;
          if (block === UNLOCATED) {
            unlocated.push({ label: `#${p.index} ${p.type}`, sheetIds: requestSheetIds(req, p.index, meta) });
            continue;
          }
          // Named as the block it covers on the tab as it was before the batch, under that tab's title.
          const before = rereadCost(block, meta.grids.get(block.sheetId));
          const title = meta.titles.get(block.sheetId) ?? after.get(block.sheetId) ?? `sheet#${block.sheetId}`;
          const label = before.a1 !== undefined ? `${quoteSheet(title)}!${before.a1}` : (p.range ?? `#${p.index} ${p.type}`);
          if (!meta.titles.has(block.sheetId)) onAdded.push(label);
          // A paste of a whole column (row, tab) is as long as the grid: its block is worked out on the grid after the batch.
          else if (sizedByGrid(req)) pastes.push({ p, label, sheetId: block.sheetId });
          // An open end stays open here, so a later request anywhere in it counts as moving it.
          else place(block, label, p);
        }
        // Blocks are sized on the grid as it is after the batch: sized before it, rows an earlier appendDimension
        // or insertDimension adds would go unread, and a read past rows an earlier deleteDimension removes would fail.
        let sized: SheetMeta | undefined;
        if (pastes.length || inPlace.some((w) => openEnded(w.block))) {
          try {
            sized = { ...meta, grids: (await metaAfter()).grids };
          } catch (err) {
            sizeError = err;
          }
        }
        for (const { p, label, sheetId } of pastes) {
          const block = sized && writtenBlock(a.requests[p.index], p, sized);
          if (block && block !== UNLOCATED) place(block, label, p);
          else unsized.push({ index: p.index, label: `#${p.index} ${p.type}`, sheetId });
        }
        // Pastes were placed last: back into request order, for the budget and the notes.
        for (const list of [inPlace, moved, untracked]) list.sort((x, y) => x.index - y.index);
        let budget = GRID_READ_MAX_CELLS;
        for (const { block, label, index, type } of inPlace) {
          const grid = sized?.grids.get(block.sheetId);
          if (openEnded(block) && !grid) {
            unsized.push({ index, label: `#${index} ${type}`, sheetId: block.sheetId });
            continue;
          }
          const title = quoteSheet(meta.titles.get(block.sheetId)!);
          const cost = rereadCost(block, grid);
          const range = cost.a1 !== undefined ? `${title}!${cost.a1}` : label;
          if (cost.cells > budget || cost.a1 === undefined) unread.push(range);
          else if (cost.cells === 0) noCells.push(`#${index} ${type} from ${title}!${cellA1(block.r0, block.c0)}`);
          else {
            budget -= cost.cells;
            reread.push(`${quoteSheet(after.get(block.sheetId)!)}!${cost.a1}`);
            rereadRanges.push(range);
          }
        }
        unsized.sort((x, y) => x.index - y.index);
      }
      let verification: Verification | undefined;
      if (reread.length) {
        try {
          verification = await verifyCells(g, id, reread, { maxBytes: GRID_READ_MAX_BYTES });
        } catch (err) {
          if (err instanceof ResponseTooLargeError) notes.push(`${rereadRanges.length} written range(s) not re-read: the re-read came back over the ${formatBytes(GRID_READ_MAX_BYTES)} read budget (${listFew(rereadRanges)})`);
          else notes.push(failure("verification", err));
        }
      }
      if (unread.length) notes.push(`${unread.length} written range(s) not re-read: over the ${GRID_READ_MAX_CELLS}-cell re-read budget (${listFew(unread)})`);
      if (noCells.length) notes.push(`${noCells.length} value write(s) not re-read: they cover no cell of their tab's grid after the batch (${listFew(noCells)})`);

      const { touched, deleted } = structuralSheets(a.requests, meta);
      let postCheck: AnyRec | undefined;
      if (a.post_check !== false && (touched.size || deleted.size)) {
        try {
          // The tabs and grid sizes as they are AFTER the batch: renamed, added and grown tabs all count
          // against the budget, and the new backups are left out (reading them would double the read).
          const now = await metaAfter();
          const read = gridReadTabs(now, touched, new Set(snapshot?.map((e) => e.backupSheetId)));
          // Unnamed when it covers every tab: a read naming hundreds of tabs could outgrow the URL.
          postCheck = await errorCheck(boundedLoader(g, id), read, now, !(read.all && !snapshot));
        } catch (err) {
          postCheck = { error: failure("post-check", err) };
        }
      }
      // Claim the post-check only for tabs it really re-read (not skipped as too large, not failed, not deleted).
      const checked = Array.isArray(postCheck?.sheets) ? (postCheck.sheets as string[]) : [];
      const coveredBy = (blocks: { sheetId: number }[]) => {
        const tabs = [...new Set(blocks.map((m) => after.get(m.sheetId)).filter((t): t is string => t !== undefined))];
        return tabs.length > 0 && tabs.every((t) => checked.includes(t)) ? "; postCheck re-read their tab(s)" : "";
      };
      if (moved.length) {
        const list = moved.slice(0, 5).map((m) => `${m.range} (by #${m.by} ${Object.keys(a.requests[m.by])[0]})`);
        if (moved.length > 5) list.push(`+${moved.length - 5} more`);
        notes.push(`${moved.length} written range(s) not re-read because a later request in this batch moves or deletes their cells: ${list.join(", ")}${coveredBy(moved)}`);
      }
      if (untracked.length) {
        notes.push(`${untracked.length} written range(s) not re-read: telling whether a later request in this batch moves them stopped at ${MOVER_CHECKS_MAX} checks (${listFew(untracked.map((m) => m.range))})${coveredBy(untracked)}`);
      }
      if (unsized.length) {
        const reason = sizeError === undefined ? "is not known" : `could not be read (${why(sizeError)})`;
        notes.push(`${unsized.length} value write(s) not re-read: their tab's grid after the batch ${reason} (${listFew(unsized.map((u) => u.label))})${coveredBy(unsized)}`);
      }
      if (unlocated.length) {
        const tabs = unlocated.flatMap((u) => u.sheetIds.map((sheetId) => ({ sheetId })));
        notes.push(`${unlocated.length} value write(s) not re-read: the cells they change are not known before they run (${listFew(unlocated.map((u) => u.label))})${coveredBy(tabs)}`);
      }
      if (onAdded.length) notes.push(`${onAdded.length} written range(s) not re-read: on a tab this batch adds (${listFew(onAdded)})`);

      const updatedSpreadsheet = a.include_spreadsheet_in_response ? r.updatedSpreadsheet : undefined;
      // postCheck.errors quotes formulas from the spreadsheet: the provenance notice goes first.
      const quoted = Array.isArray(postCheck?.errors) && postCheck.errors.length > 0 ? provenance(`sheets:spreadsheet:${id}`, ["postCheck.errors[].formula"]) : {};
      const result: AnyRec =
        a.reply === "full"
          ? { ...quoted, applied: plan.length, totals, changes: plan, warnings: plan.filter((p) => p.warning).map((p) => `#${p.index} ${p.type}: ${p.warning}`), updatedSpreadsheet }
          : (() => {
              const { changes, omitted } = summaryChanges(plan);
              return { ...quoted, applied: plan.length, totals, warnings, changes, changesOmitted: omitted || undefined, updatedSpreadsheet };
            })();
      if (postCheck) result.postCheck = postCheck;
      if (snapshot) result.snapshot = snapshotReport(snapshot);
      if (notes.length) result.note = notes.join("; ");
      return withVerification(result, verification);
    },
  }),

  tool({
    name: "sheets_add_sheet",
    description: "Add a new tab (sheet) to a spreadsheet.",
    scope: SCOPE,
    write: true,
    destructive: false,
    input: {
      spreadsheet_id: z.string(),
      title: z.string(),
      rows: z.number().int().min(1).max(10_000_000).default(1000),
      columns: z.number().int().min(1).max(18278).default(26),
      index: z.number().int().min(0).optional().describe("Tab position (0 = first)"),
      tab_color: z.object({ red: z.number(), green: z.number(), blue: z.number() }).optional().describe("0-1 floats"),
    },
    handler: async (a, { g }) => {
      const r = await g.post<AnyRec>(`${API.sheets}/spreadsheets/${enc(a.spreadsheet_id)}:batchUpdate`, {
        requests: [{ addSheet: { properties: { title: a.title, index: a.index, tabColor: a.tab_color, gridProperties: { rowCount: a.rows, columnCount: a.columns } } } }],
      });
      audit("sheets_add_sheet", { spreadsheet: a.spreadsheet_id, title: a.title });
      return r.replies?.[0]?.addSheet?.properties ?? r;
    },
  }),

  tool({
    name: "sheets_delete_sheet",
    description: "Delete a tab by sheetId (irreversible — the tab and its data are gone).",
    scope: SCOPE,
    write: true,
    destructive: true,
    idempotent: true,
    input: {
      spreadsheet_id: z.string(),
      sheet_id: z.number().int(),
      snapshot: Snapshot.describe("First copy the tab to a hidden backup tab"),
      post_check: z.boolean().default(true).describe("Report error cells (#REF!, …) on the tabs whose formulas read it"),
    },
    handler: async (a, { g }) => {
      const id = a.spreadsheet_id;
      const remove = () => g.post(`${API.sheets}/spreadsheets/${enc(id)}:batchUpdate`, { requests: [{ deleteSheet: { sheetId: a.sheet_id } }] });
      if (a.snapshot !== true && a.post_check === false) {
        // Neither safety feature asked for: the one call this tool always made.
        await remove();
        audit("sheets_delete_sheet", { spreadsheet: id, sheetId: a.sheet_id });
        return { deleted: true, sheetId: a.sheet_id };
      }
      const meta = await getSheetMeta(g, id);
      const title = meta.titles.get(a.sheet_id);
      if (title === undefined) throw new Error(`no tab with sheetId ${a.sheet_id}. Tabs: ${tabList(meta)}`);
      // Post-check, before the delete: which other tabs hold a formula that reads this one — the only tabs
      // the delete can break, and afterwards their formulas no longer name it. Same bounded read and the same
      // reference resolution as the batch tool's deletion preview; a failed read never blocks the delete.
      const load = boundedLoader(g, id);
      const scan = a.post_check !== false ? await readersOf(load, meta, a.sheet_id, title) : undefined;
      const snapshot = a.snapshot === true ? await takeSnapshot(g, id, [a.sheet_id], meta, "sheets_delete_sheet") : undefined;
      await guardedBySnapshot(g, id, snapshot, remove);
      audit("sheets_delete_sheet", { spreadsheet: id, sheetId: a.sheet_id });

      let postCheck: AnyRec | undefined;
      if (scan && "error" in scan) postCheck = { error: `post-check unavailable: reading the other tabs before the delete failed (${scan.error}); the tab was deleted` };
      else if (scan && "over" in scan) postCheck = withSkipped(undefined, scan.over, OVER_BUDGET);
      else if (scan && !scan.read.titles.length) postCheck = withSkipped(undefined, scan.read.skipped);
      else if (scan && !scan.reading.length) postCheck = withSkipped({ ...postCheckSummary([], []), note: `no formula on the ${scan.read.titles.length} other tab(s) checked reads ${title}` }, scan.read.skipped);
      else if (scan) {
        try {
          // The tabs that read it were read whole within the budget a moment ago, and deleting a tab resizes no other.
          postCheck = await errorCheck(load, { all: false, titles: scan.reading, skipped: scan.read.skipped }, meta);
        } catch (err) {
          postCheck = { error: rereadFailed("post-check", err, "the tab was deleted") };
        }
      }
      // postCheck.errors quotes formulas from the spreadsheet: the provenance notice goes first.
      const quoted = Array.isArray(postCheck?.errors) && postCheck.errors.length > 0 ? provenance(`sheets:spreadsheet:${id}`, ["postCheck.errors[].formula"]) : {};
      const out: AnyRec = { ...quoted, deleted: true, sheetId: a.sheet_id, sheet: title };
      if (postCheck) out.postCheck = postCheck;
      if (snapshot) out.snapshot = snapshotReport(snapshot);
      return out;
    },
  }),

  tool({
    name: "sheets_create_spreadsheet",
    description: "Create a new spreadsheet (optionally with named tabs, initial data in the first tab, and inside a Drive folder). Returns id + URL.",
    scope: SCOPE,
    write: true,
    destructive: false,
    input: {
      title: z.string(),
      sheet_titles: z.array(z.string()).optional().describe("Tab names (default one tab 'Sheet1')"),
      initial_values: Rows.optional().describe("Rows written to A1 of the first tab"),
      folder_id: z.string().optional().describe("Drive folder to create it in (needs the drive scope)"),
      locale: z.string().optional().describe("Spreadsheet locale, e.g. en_US, iw_IL (Google still uses the legacy code for Hebrew — he_IL is rejected; this tool maps he/he_IL to iw/iw_IL automatically)"),
      time_zone: z.string().optional().describe("e.g. Asia/Jerusalem"),
    },
    handler: async (a, { g }) => {
      const locale = a.locale?.replace(/^he(?=$|_)/i, "iw");
      const body: AnyRec = { properties: { title: a.title, locale, timeZone: a.time_zone } };
      if (a.sheet_titles?.length) body.sheets = a.sheet_titles.map((t, i) => ({ properties: { title: t, index: i } }));
      const r = await g.post<AnyRec>(`${API.sheets}/spreadsheets`, body, { fields: "spreadsheetId,spreadsheetUrl,properties(title),sheets(properties(sheetId,title))" });
      const id = r.spreadsheetId as string;
      if (a.initial_values?.length) {
        const first = r.sheets?.[0]?.properties?.title ?? "Sheet1";
        await g.put(`${API.sheets}/spreadsheets/${enc(id)}/values/${enc(`'${String(first).replace(/'/g, "''")}'!A1`)}`, { values: a.initial_values }, { valueInputOption: "USER_ENTERED" });
      }
      if (a.folder_id) {
        await moveToFolder(g, id, a.folder_id);
      }
      audit("sheets_create_spreadsheet", { spreadsheet: id, title: a.title });
      return { spreadsheetId: id, url: r.spreadsheetUrl, title: r.properties?.title, sheets: r.sheets?.map((s: AnyRec) => s.properties) };
    },
  }),

  tool({
    name: "sheets_replace_text",
    description: "Find & replace text across a tab or the whole spreadsheet (supports regex, match case, entire cell, inside formulas).",
    scope: SCOPE,
    write: true,
    idempotent: true,
    input: {
      spreadsheet_id: z.string(),
      find: z.string(),
      replacement: z.string(),
      sheet_id: z.number().int().optional().describe("Limit to this tab (omit for all sheets)"),
      match_case: z.boolean().default(false),
      match_entire_cell: z.boolean().default(false),
      search_by_regex: z.boolean().default(false),
      include_formulas: z.boolean().default(false),
    },
    handler: async (a, { g }) => {
      const req: AnyRec = { find: a.find, replacement: a.replacement, matchCase: a.match_case, matchEntireCell: a.match_entire_cell, searchByRegex: a.search_by_regex, includeFormulas: a.include_formulas };
      if (a.sheet_id !== undefined) req.sheetId = a.sheet_id;
      else req.allSheets = true;
      const r = await g.post<AnyRec>(`${API.sheets}/spreadsheets/${enc(a.spreadsheet_id)}:batchUpdate`, { requests: [{ findReplace: req }] });
      audit("sheets_replace_text", { spreadsheet: a.spreadsheet_id, sheetId: a.sheet_id });
      return r.replies?.[0]?.findReplace ?? r;
    },
  }),

  tool({
    name: "sheets_copy_sheet",
    description: "Copy a tab into another spreadsheet (sheets.copyTo).",
    scope: SCOPE,
    write: true,
    input: { spreadsheet_id: z.string(), sheet_id: z.number().int(), destination_spreadsheet_id: z.string() },
    handler: async (a, { g }) => {
      const r = await g.post<AnyRec>(`${API.sheets}/spreadsheets/${enc(a.spreadsheet_id)}/sheets/${a.sheet_id}:copyTo`, { destinationSpreadsheetId: a.destination_spreadsheet_id });
      audit("sheets_copy_sheet", { from: a.spreadsheet_id, sheetId: a.sheet_id, to: a.destination_spreadsheet_id });
      return r;
    },
  }),
];
