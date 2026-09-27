/**
 * The batch tool's safety features on the other destructive Sheets tools — sheets_delete_sheet (an
 * opt-in snapshot, and a post-check of the tabs whose formulas read the deleted one) and
 * sheets_clear_range (an opt-in snapshot) — plus what every grid read of those features keeps to:
 * tab titles quoted (Q1 is a tab, not a cell), a cells cap across the tabs read with the tabs left out
 * named, only the cell fields it uses, a byte budget enforced while the response streams, and per-cell
 * work that stays linear (named ranges, long formulas), shown on generated large spreadsheets. Grid
 * reads are answered by tests/helpers/sheets-grid.ts under Google's range rules and field masks.
 * Tool output is parsed as JSON, never asserted on whitespace.
 */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { annotationsFor, ok, type AnyRec } from "../src/tools/_shared.js";
import { GoogleApiError, GoogleClient, ResponseTooLargeError } from "../src/google/client.js";
import { sheetsTools } from "../src/tools/sheets.js";
import {
  DELETION_PREVIEWS_MAX,
  GRID_READ_MAX_BYTES,
  GRID_READ_MAX_CELLS,
  MAX_SHEET_TITLE,
  MOVER_CHECKS_MAX,
  POST_CHECK_STATE_NOTE,
  WRITE_VALUES_MAX_UPDATES,
  tabOfRange,
  type SheetMeta,
} from "../src/tools/sheets-verify.js";
import { a1Cells, parseA1 } from "../src/tools/sheets-a1.js";
import { answerGridRead, jsonLength } from "./helpers/sheets-grid.js";

const byName = (name: string) => sheetsTools.find((t) => t.name === name)!;
const deleteSheet = byName("sheets_delete_sheet");
const clearRange = byName("sheets_clear_range");
const batchUpdate = byName("sheets_batch_update_spreadsheet");
const ctx = (g: any) => ({ g, readOnly: false, grantedScopes: [] });
/** The wire text a caller reads, parsed back — never asserted on whitespace. */
const wire = (data: unknown) => JSON.parse(ok(data).content[0].text);

/** Fake GoogleClient: records calls (with the request options, e.g. maxBytes) and answers from a routing function. */
function fakeClient(route: (method: string, url: string, body: any, params: any) => any) {
  const calls: { method: string; url: string; body?: any; params?: any; opts?: any }[] = [];
  const make = (method: string) => async (url: string, a?: any, b?: any, c?: any) => {
    const [body, params, opts] = method === "get" ? [undefined, a, b] : [a, b, c];
    calls.push({ method, url, body, params, opts });
    return route(method, url, body, params);
  };
  return { g: { get: make("get"), post: make("post"), put: make("put"), patch: make("patch"), delete: make("delete") } as any, calls };
}
const isGridRead = (params: any) => params?.includeGridData === true;
const posts = <T extends { method: string }>(calls: T[]) => calls.filter((c) => c.method === "post");
/** A grid read answers as Google does: the ranges it names under Google's A1 rules, each cell under its field mask. */
const named = answerGridRead;
/** Tab metadata: [sheetId, title, rows] with 26 columns each. */
const tabsMeta = (tabs: [number, string, number][], namedRanges: AnyRec[] = []) => ({
  sheets: tabs.map(([sheetId, title, rowCount]) => ({ properties: { sheetId, title, gridProperties: { rowCount, columnCount: 26 } } })),
  namedRanges,
});
/** A duplicateSheet batch answered the way Google answers it. */
const duplicated = (body: any) => ({ replies: body.requests.map((q: AnyRec) => (q.duplicateSheet ? { duplicateSheet: { properties: { sheetId: q.duplicateSheet.newSheetId, title: q.duplicateSheet.newSheetName } } } : {})) });

const num = (n: number) => ({ userEnteredValue: { numberValue: n }, effectiveValue: { numberValue: n }, formattedValue: String(n) });
const formula = (f: string, v: number) => ({ userEnteredValue: { formulaValue: f }, effectiveValue: { numberValue: v }, formattedValue: String(v) });
const refError = (f: string) => ({ userEnteredValue: { formulaValue: f }, effectiveValue: { errorValue: { type: "REF", message: "Reference does not exist." } }, formattedValue: "#REF!" });

// Data (0) is read by Summary (1) through a reference and by Report (2) through a named range; Notes (3) reads only itself.
const META = tabsMeta([[0, "Data", 100], [1, "Summary", 100], [2, "Report", 100], [3, "Notes", 100]], [{ name: "Amounts", range: { sheetId: 0, startRowIndex: 1, endRowIndex: 5, startColumnIndex: 1, endColumnIndex: 2 } }]);
const BEFORE = {
  sheets: [
    { properties: { sheetId: 0, title: "Data" }, data: [{ rowData: [{ values: [num(10), num(20)] }] }] },
    { properties: { sheetId: 1, title: "Summary" }, data: [{ rowData: [{ values: [formula("=Data!A1*2", 20), formula("=SUM(A1:A1)", 20)] }] }] },
    { properties: { sheetId: 2, title: "Report" }, data: [{ rowData: [{ values: [formula("=SUM(Amounts)", 20)] }] }] },
    { properties: { sheetId: 3, title: "Notes" }, data: [{ rowData: [{ values: [num(1), formula("=A1+1", 2)] }] }] },
  ],
};
/** After Data is gone: Google rewrites what read it to #REF!. */
const AFTER = {
  sheets: [
    { properties: { sheetId: 1, title: "Summary" }, data: [{ rowData: [{ values: [refError("=#REF!*2"), formula("=SUM(A1:A1)", 0)] }] }] },
    { properties: { sheetId: 2, title: "Report" }, data: [{ rowData: [{ values: [refError("=SUM(#REF!)")] }] }] },
    { properties: { sheetId: 3, title: "Notes" }, data: [{ rowData: [{ values: [num(1), formula("=A1+1", 2)] }] }] },
  ],
};

/** Routes a whole sheets_delete_sheet call: grid reads come from BEFORE until the delete lands, then from AFTER. */
function deleteRoute(opts: { failDelete?: GoogleApiError; failScan?: boolean; failAfter?: boolean } = {}) {
  let deleted = false;
  return (m: string, url: string, body: any, params: any) => {
    if (m === "post" && body.requests[0]?.duplicateSheet) return duplicated(body);
    if (m === "post" && body.requests[0]?.deleteSheet) {
      const backupCleanup = body.requests[0].deleteSheet.sheetId !== 0 && body.requests[0].deleteSheet.sheetId !== 3;
      if (opts.failDelete && !backupCleanup) throw opts.failDelete;
      deleted = true;
      return { replies: [{}] };
    }
    if (isGridRead(params)) {
      if (!deleted && opts.failScan) throw new Error("upstream hiccup");
      if (deleted && opts.failAfter) throw new Error("second hiccup");
      return named(params, deleted ? AFTER : BEFORE);
    }
    return META;
  };
}

describe("sheets_delete_sheet: flags, annotations and today's call are unchanged", () => {
  it("keeps write + destructive + idempotent and the pinned annotations", () => {
    const pinned = JSON.parse(readFileSync(new URL("./fixtures/annotations.json", import.meta.url), "utf8"));
    for (const t of [deleteSheet, clearRange]) {
      expect([t.write, t.destructive, t.idempotent], t.name).toEqual([true, true, true]);
      expect(annotationsFor(t), t.name).toEqual(pinned[t.name]);
    }
  });

  it("post_check=false and no snapshot: exactly the one POST it always made, and the same reply", async () => {
    const { g, calls } = fakeClient(deleteRoute());
    const r = wire(await deleteSheet.handler({ spreadsheet_id: "sid", sheet_id: 0, snapshot: false, post_check: false }, ctx(g)));
    expect(calls.map((c) => c.method)).toEqual(["post"]);
    expect(calls[0].body).toEqual({ requests: [{ deleteSheet: { sheetId: 0 } }] });
    expect(r).toEqual({ deleted: true, sheetId: 0 });
  });
});

describe("sheets_delete_sheet: post-check of the tabs that read the deleted one (default on)", () => {
  it("finds the readers before the delete (named ranges included), re-reads only them after it, and reports their error cells", async () => {
    const { g, calls } = fakeClient(deleteRoute());
    const r = wire(await deleteSheet.handler({ spreadsheet_id: "sid", sheet_id: 0, snapshot: false, post_check: true }, ctx(g)));
    // meta; the other tabs before the delete (never the deleted one); the delete; the readers after it.
    expect(calls.map((c) => c.method)).toEqual(["get", "get", "post", "get"]);
    expect(calls[1].params).toMatchObject({ includeGridData: true, ranges: ["'Summary'", "'Report'", "'Notes'"] });
    expect(calls[3].params).toMatchObject({ includeGridData: true, ranges: ["'Summary'", "'Report'"] });
    // The errors quote the spreadsheet's formulas: the provenance notice goes first, as on the batch tool.
    expect(Object.keys(r)[0]).toBe("provenance");
    expect(r.provenance.fields).toEqual(["postCheck.errors[].formula"]);
    expect(r).toMatchObject({ deleted: true, sheetId: 0, sheet: "Data" });
    // The same postCheck shape as sheets_batch_update_spreadsheet: errors = list, errorCount = count.
    expect(r.postCheck).toEqual({
      sheets: ["Summary", "Report"],
      errorCount: 2,
      ok: false,
      errors: [
        { cell: "Summary!A1", error: "REF", formula: "=#REF!*2", message: "Reference does not exist." },
        { cell: "Report!A1", error: "REF", formula: "=SUM(#REF!)", message: "Reference does not exist." },
      ],
      note: POST_CHECK_STATE_NOTE,
    });
  });

  it("a tab no formula reads: no second read, and the check says so", async () => {
    const { g, calls } = fakeClient(deleteRoute());
    const r = wire(await deleteSheet.handler({ spreadsheet_id: "sid", sheet_id: 3, snapshot: false, post_check: true }, ctx(g)));
    expect(calls.map((c) => c.method)).toEqual(["get", "get", "post"]);
    expect(r).toEqual({ deleted: true, sheetId: 3, sheet: "Notes", postCheck: { errorCount: 0, ok: true, note: "no formula on the 3 other tab(s) checked reads Notes" } });
  });

  it("an unknown sheetId fails before anything is deleted, naming the tabs", async () => {
    const { g, calls } = fakeClient(deleteRoute());
    await expect(deleteSheet.handler({ spreadsheet_id: "sid", sheet_id: 9, snapshot: false, post_check: true }, ctx(g))).rejects.toThrow("no tab with sheetId 9. Tabs: Data (0), Summary (1), Report (2), Notes (3)");
    expect(posts(calls)).toHaveLength(0);
  });

  it("a failed read never blocks the delete and never turns it into an error", async () => {
    const before = fakeClient(deleteRoute({ failScan: true }));
    const r1 = wire(await deleteSheet.handler({ spreadsheet_id: "sid", sheet_id: 0, snapshot: false, post_check: true }, ctx(before.g)));
    expect(posts(before.calls)).toHaveLength(1);
    expect(r1).toEqual({ deleted: true, sheetId: 0, sheet: "Data", postCheck: { error: "post-check unavailable: reading the other tabs before the delete failed (upstream hiccup); the tab was deleted" } });
    const after = fakeClient(deleteRoute({ failAfter: true }));
    const r2 = wire(await deleteSheet.handler({ spreadsheet_id: "sid", sheet_id: 0, snapshot: false, post_check: true }, ctx(after.g)));
    expect(r2.postCheck).toEqual({ error: "post-check re-read failed (second hiccup); the tab was deleted" });
  });

  it("the same size bounds: tabs over the read budget are skipped and named, never read", async () => {
    // Summary is 60% of the budget, Report 60% — both cannot be read; Notes is small.
    const rows = Math.ceil((GRID_READ_MAX_CELLS * 0.6) / 26);
    const big = tabsMeta([[0, "Data", 100], [1, "Summary", rows], [2, "Report", rows], [3, "Notes", 100]]);
    const rest = deleteRoute();
    const { g, calls } = fakeClient((m, url, body, params) => (m === "get" && !isGridRead(params) ? big : rest(m, url, body, params)));
    const r = wire(await deleteSheet.handler({ spreadsheet_id: "sid", sheet_id: 0, snapshot: false, post_check: true }, ctx(g)));
    expect(calls.filter((c) => isGridRead(c.params)).map((c) => c.params.ranges)).toEqual([["'Summary'", "'Notes'"], ["'Summary'"]]);
    expect(r.postCheck).toMatchObject({ sheets: ["Summary"], errorCount: 1, skipped: ["Report"] });
    expect(r.postCheck.note).toBe(`${POST_CHECK_STATE_NOTE}; 1 tab(s) under skipped not checked: over the ${GRID_READ_MAX_CELLS}-cell read budget — run sheets_audit_spreadsheet with ranges`);
  });
});

describe("a named range on the first tab: Google's JSON leaves out sheetId 0", () => {
  // A GridRange field left at zero is omitted from Google's JSON, and a GridRange without sheetId means sheet 0.
  // Report (2) reads Data (0) only through Amounts, whose range comes back without its sheetId.
  const META0 = tabsMeta([[0, "Data", 100], [1, "Summary", 100], [2, "Report", 100], [3, "Notes", 100]], [{ name: "Amounts", range: { startRowIndex: 1, endRowIndex: 5, startColumnIndex: 1, endColumnIndex: 2 } }]);
  const route0 = () => {
    const rest = deleteRoute();
    return (m: string, url: string, body: any, params: any) => (m === "get" && !isGridRead(params) ? META0 : rest(m, url, body, params));
  };
  const dryRun = (requests: AnyRec[]) => ({ spreadsheet_id: "sid", requests, dry_run: true, reply: "summary", verify: true, post_check: true, snapshot: false, include_spreadsheet_in_response: false });

  it("sheets_delete_sheet re-reads the tab that reads it only through the name, and reports its #REF!", async () => {
    // Before: the name resolved to no tab, Report was never re-read, and the check came back with Summary's error only.
    const { g, calls } = fakeClient(route0());
    const r = wire(await deleteSheet.handler({ spreadsheet_id: "sid", sheet_id: 0, snapshot: false, post_check: true }, ctx(g)));
    expect(calls.filter((c) => isGridRead(c.params)).map((c) => c.params.ranges)).toEqual([["'Summary'", "'Report'", "'Notes'"], ["'Summary'", "'Report'"]]);
    expect(r.postCheck).toMatchObject({ sheets: ["Summary", "Report"], errorCount: 2, ok: false });
    expect(r.postCheck.errors.map((e: AnyRec) => e.cell)).toEqual(["Summary!A1", "Report!A1"]);
  });

  it("a dry run of deleteSheet, or of deleting the named rows, lists the formula that reads them through the name", async () => {
    const whole = wire(await batchUpdate.handler(dryRun([{ deleteSheet: { sheetId: 0 } }]), ctx(fakeClient(route0()).g)));
    expect(whole.requests[0].preview.dependents).toContainEqual({ cell: "Report!A1", formula: "=SUM(Amounts)", becomes: "#REF!" });
    const rows = wire(await batchUpdate.handler(dryRun([{ deleteDimension: { range: { sheetId: 0, dimension: "ROWS", startIndex: 1, endIndex: 3 } } }]), ctx(fakeClient(route0()).g)));
    expect(rows.requests[0].preview.dependents).toContainEqual({ cell: "Report!A1", formula: "=SUM(Amounts)", becomes: "loses the deleted cells" });
  });

  it("the tab a named range lies on is read the same way everywhere: clear_range's snapshot backs up tab 0 too", async () => {
    const { g, calls } = fakeClient((m, url, body) => (m === "post" ? (body.requests?.[0]?.duplicateSheet ? duplicated(body) : { spreadsheetId: "sid", clearedRange: "Data!B2:B5" }) : META0));
    const r = wire(await clearRange.handler({ spreadsheet_id: "sid", range: "Amounts", snapshot: true }, ctx(g)));
    expect(posts(calls)[0].body.requests[0].duplicateSheet.sourceSheetId).toBe(0);
    expect(r.snapshot[0].sheet).toBe("Data");
  });
});

describe("sheets_delete_sheet: snapshot (opt-in)", () => {
  it("duplicates the tab as a hidden, uniquely titled backup in its own call BEFORE the delete, and reports it", async () => {
    const { g, calls } = fakeClient(deleteRoute());
    const r = wire(await deleteSheet.handler({ spreadsheet_id: "sid", sheet_id: 0, snapshot: true, post_check: false }, ctx(g)));
    const [snap, del] = posts(calls);
    const [dup, hide] = snap.body.requests;
    expect(dup.duplicateSheet).toMatchObject({ sourceSheetId: 0, insertSheetIndex: 4 });
    expect(dup.duplicateSheet.newSheetName).toMatch(/^Data \(backup \d{4}-\d\d-\d\d \d\d:\d\d UTC\)$/);
    expect([0, 1, 2, 3]).not.toContain(dup.duplicateSheet.newSheetId);
    expect(hide).toEqual({ updateSheetProperties: { properties: { sheetId: dup.duplicateSheet.newSheetId, hidden: true }, fields: "hidden" } });
    expect(del.body).toEqual({ requests: [{ deleteSheet: { sheetId: 0 } }] });
    // The batch tool's return shape.
    expect(r).toEqual({ deleted: true, sheetId: 0, sheet: "Data", snapshot: [{ sheet: "Data", backupSheetId: dup.duplicateSheet.newSheetId, backupTitle: dup.duplicateSheet.newSheetName }] });
  });

  it("a long Hebrew title keeps the backup title within Google's 100-character limit", async () => {
    const long = "גיליון נתונים ".repeat(10).trim();
    const { g, calls } = fakeClient((m, url, body, params) => (m === "post" ? (body.requests[0]?.duplicateSheet ? duplicated(body) : { replies: [{}] }) : tabsMeta([[5, long, 10], [6, "Other", 10]])));
    const r = wire(await deleteSheet.handler({ spreadsheet_id: "sid", sheet_id: 5, snapshot: true, post_check: false }, ctx(g)));
    expect(r.snapshot[0].backupTitle.length).toBeLessThanOrEqual(MAX_SHEET_TITLE);
    expect(r.snapshot[0].backupTitle).toMatch(/^גיליון נתונים .* \(backup \d{4}-\d\d-\d\d \d\d:\d\d UTC\)$/);
    expect(posts(calls).map((c) => Object.keys(c.body.requests[0])[0])).toEqual(["duplicateSheet", "deleteSheet"]);
  });

  it("Google rejecting the delete (4xx: nothing applied) removes the backup again and rethrows", async () => {
    const rejected = new GoogleApiError(400, "POST", "https://sheets.example.com", "You can't remove all the visible sheets in a document.");
    const { g, calls } = fakeClient(deleteRoute({ failDelete: rejected }));
    await expect(deleteSheet.handler({ spreadsheet_id: "sid", sheet_id: 0, snapshot: true, post_check: false }, ctx(g))).rejects.toThrow(/can't remove all the visible sheets/);
    const p = posts(calls);
    expect(p).toHaveLength(3);
    expect(p[2].body).toEqual({ requests: [{ deleteSheet: { sheetId: p[0].body.requests[0].duplicateSheet.newSheetId } }] });
  });

  it("a timeout on the delete keeps the backup and the error names it", async () => {
    const timeout = new GoogleApiError(0, "POST", "https://sheets.example.com", "Google did not answer within 30s", "timeout");
    const { g, calls } = fakeClient(deleteRoute({ failDelete: timeout }));
    const err: any = await deleteSheet.handler({ spreadsheet_id: "sid", sheet_id: 0, snapshot: true, post_check: false }, ctx(g)).catch((e) => e);
    const dup = posts(calls)[0].body.requests[0].duplicateSheet;
    expect(err).toBeInstanceOf(GoogleApiError);
    expect(err.message).toBe(`Google did not answer within 30s — snapshot kept (outcome unknown): hidden backup tab '${dup.newSheetName}' (sheetId ${dup.newSheetId}); delete it with sheets_delete_sheet when no longer needed`);
  });

  it("snapshot and post-check together: the check reads the original tabs, never the new backup", async () => {
    const { g, calls } = fakeClient(deleteRoute());
    const r = wire(await deleteSheet.handler({ spreadsheet_id: "sid", sheet_id: 0, snapshot: true, post_check: true }, ctx(g)));
    expect(calls.map((c) => c.method)).toEqual(["get", "get", "post", "post", "get"]);
    expect(calls.filter((c) => isGridRead(c.params)).map((c) => c.params.ranges)).toEqual([["'Summary'", "'Report'", "'Notes'"], ["'Summary'", "'Report'"]]);
    expect(r.snapshot).toHaveLength(1);
    expect(r.postCheck.errorCount).toBe(2);
  });
});

describe("whole-tab reads quote the title: Q1, Jan2024 and FY24 are tabs, not cells", () => {
  // Google reads an unquoted Q1 as cell Q1 of the first sheet and a name shared with a named range as that range;
  // 'Q1' is always the tab. Data (0) is read by Q1 (1) and Jan2024 (2); Big (3) is there only to overflow the cap.
  const tabs = (big: boolean) => tabsMeta([[0, "Data", 100], [1, "Q1", 100], [2, "Jan2024", 100], ...(big ? [[3, "Big", Math.ceil(GRID_READ_MAX_CELLS / 26)] as [number, string, number]] : [])]);
  const before = {
    sheets: [
      { properties: { sheetId: 0, title: "Data" }, data: [{ rowData: [{ values: [num(10)] }, { values: [num(20)] }] }] },
      { properties: { sheetId: 1, title: "Q1" }, data: [{ rowData: [{ values: [formula("=Data!A1*2", 20)] }] }] },
      { properties: { sheetId: 2, title: "Jan2024" }, data: [{ rowData: [{ values: [formula("=Data!A1*3", 30)] }] }] },
    ],
  };
  const broken = {
    sheets: [
      { properties: { sheetId: 0, title: "Data" }, data: [{ rowData: [{ values: [num(20)] }] }] },
      { properties: { sheetId: 1, title: "Q1" }, data: [{ rowData: [{ values: [refError("=#REF!*2")] }] }] },
      { properties: { sheetId: 2, title: "Jan2024" }, data: [{ rowData: [{ values: [refError("=#REF!*3")] }] }] },
    ],
  };
  const route = (big: boolean) => {
    let applied = false;
    return (m: string, url: string, body: any, params: any) => {
      if (m === "post" && body.requests[0]?.duplicateSheet) return duplicated(body);
      if (m === "post") return (applied = true), { replies: body.requests.map(() => ({})) };
      return isGridRead(params) ? named(params, applied ? broken : before) : tabs(big);
    };
  };
  const gridRanges = (calls: { params?: any }[]) => calls.filter((c) => isGridRead(c.params)).map((c) => c.params.ranges);

  it("sheets_delete_sheet finds the tabs that read it and re-checks them (unquoted, the check came back clean)", async () => {
    const { g, calls } = fakeClient(route(false));
    const r = wire(await deleteSheet.handler({ spreadsheet_id: "sid", sheet_id: 0, snapshot: false, post_check: true }, ctx(g)));
    expect(r.postCheck).toMatchObject({ sheets: ["Q1", "Jan2024"], errorCount: 2, ok: false });
    expect(r.postCheck.errors.map((e: AnyRec) => e.cell)).toEqual(["Q1!A1", "Jan2024!A1"]);
    expect(gridRanges(calls)).toEqual([["'Q1'", "'Jan2024'"], ["'Q1'", "'Jan2024'"]]);
  });

  it("the batch post-check names them quoted when it names tabs", async () => {
    const { g, calls } = fakeClient(route(false));
    const del = { deleteDimension: { range: { sheetId: 0, dimension: "ROWS", startIndex: 0, endIndex: 1 } } };
    const r = wire(await batchUpdate.handler({ spreadsheet_id: "sid", requests: [del], dry_run: false, reply: "summary", verify: true, post_check: true, snapshot: true, include_spreadsheet_in_response: false }, ctx(g)));
    expect(r.postCheck).toMatchObject({ sheets: ["Data", "Q1", "Jan2024"], errorCount: 2 });
    expect(gridRanges(calls)).toEqual([["'Data'", "'Q1'", "'Jan2024'"]]);
  });

  it("a dry run over the cap scans them by quoted title for the formulas a deletion breaks", async () => {
    const { g, calls } = fakeClient(route(true));
    const del = { deleteDimension: { range: { sheetId: 0, dimension: "ROWS", startIndex: 0, endIndex: 1 } } };
    const r = wire(await batchUpdate.handler({ spreadsheet_id: "sid", requests: [del], dry_run: true, reply: "summary", verify: true, post_check: true, snapshot: false, include_spreadsheet_in_response: false }, ctx(g)));
    expect(r.requests[0].preview).toMatchObject({ dependentFormulas: 2, refErrors: 2 });
    expect(r.requests[0].preview.dependents.map((d: AnyRec) => d.cell)).toEqual(["Q1!A1", "Jan2024!A1"]);
    expect(gridRanges(calls).at(-1)).toEqual(["'Data'", "'Q1'", "'Jan2024'"]);
  });
});

describe("sheets_clear_range: snapshot (opt-in)", () => {
  const route = (m: string, url: string, body: any) => (m === "post" ? (body.requests?.[0]?.duplicateSheet ? duplicated(body) : { spreadsheetId: "sid", clearedRange: "Data!A1:B2" }) : META);

  it("the default is the one clear call it always made, with Google's reply", async () => {
    const { g, calls } = fakeClient(route);
    const r = wire(await clearRange.handler({ spreadsheet_id: "sid", range: "Data!A1:B2", snapshot: false }, ctx(g)));
    expect(calls.map((c) => [c.method, c.url.endsWith(":clear")])).toEqual([["post", true]]);
    expect(r).toEqual({ spreadsheetId: "sid", clearedRange: "Data!A1:B2" });
  });

  it("snapshot=true backs up the range's tab (hidden, in its own call) before clearing, and reports it", async () => {
    const { g, calls } = fakeClient(route);
    const r = wire(await clearRange.handler({ spreadsheet_id: "sid", range: "'Summary'!A1:B2", snapshot: true }, ctx(g)));
    const [snap, clear] = posts(calls);
    expect(snap.body.requests[0].duplicateSheet).toMatchObject({ sourceSheetId: 1, newSheetName: expect.stringMatching(/^Summary \(backup /) });
    expect(snap.body.requests[1].updateSheetProperties.properties.hidden).toBe(true);
    expect(clear.url).toMatch(/\/values\/.*:clear$/);
    expect(r).toMatchObject({ clearedRange: "Data!A1:B2", snapshot: [{ sheet: "Summary", backupSheetId: snap.body.requests[0].duplicateSheet.newSheetId }] });
  });

  it("the tab comes from the range, a Hebrew title or a named range; a range that names no tab is rejected before anything is written", async () => {
    const meta: SheetMeta = {
      titles: new Map([[0, "Data"], [7, "תקציב 2026"]]),
      ids: new Map([["Data", 0], ["תקציב 2026", 7]]),
      grids: new Map(),
      namedRanges: [{ name: "Totals", range: { sheetId: 7 } }, { name: "Tax", range: { sheetId: 0 } }],
    };
    expect(tabOfRange("'תקציב 2026'!C3:D9", meta)).toBe(7);
    expect(tabOfRange("Data", meta)).toBe(0);
    expect(tabOfRange("Totals", meta)).toBe(7);
    // A three-letter name reads like a column (TAX); it is still the named range.
    expect(tabOfRange("Tax", meta)).toBe(0);
    expect(() => tabOfRange("A1:B2", meta)).toThrow(`range "A1:B2" names no tab — with snapshot=true write it as "'Tab'!A1:B2"`);
    expect(() => tabOfRange("Nope!A1", meta)).toThrow("no tab named 'Nope'. Tabs: Data, תקציב 2026");

    const { g, calls } = fakeClient(route);
    await expect(clearRange.handler({ spreadsheet_id: "sid", range: "A1:B2", snapshot: true }, ctx(g))).rejects.toThrow(/names no tab/);
    expect(posts(calls)).toHaveLength(0);
  });

  it("Google rejecting the clear (4xx) removes the backup again and rethrows", async () => {
    const { g, calls } = fakeClient((m, url, body) => {
      if (m === "post" && url.endsWith(":clear")) throw new GoogleApiError(400, "POST", url, "Unable to parse range: Data!A1:B");
      return route(m, url, body);
    });
    await expect(clearRange.handler({ spreadsheet_id: "sid", range: "Data!A1:B", snapshot: true }, ctx(g))).rejects.toThrow(/Unable to parse range/);
    const p = posts(calls);
    expect(p.map((c) => (c.url.endsWith(":clear") ? "clear" : Object.keys(c.body.requests[0])[0]))).toEqual(["duplicateSheet", "clear", "deleteSheet"]);
  });
});

describe("resource bounds on a generated large spreadsheet", () => {
  // 40 tabs of 1,000 rows × 26 columns: 1.04M grid cells, ten times the read budget, and 3,000 named ranges.
  // Every tab is dense: a number in A, then 25 formulas — B reads the next row, C reads T00 (the tab the
  // tests delete from), D multiplies by a named range, E–Z read their own row. Tab titles like T01 read
  // as cells (column T, row 1), so every whole-tab read must quote them.
  const TABS = 40, ROWS = 1_000, NAMES = 3_000;
  const title = (i: number) => `T${String(i).padStart(2, "0")}`;
  const rate = (k: number) => `Rate_${String(k % NAMES).padStart(4, "0")}`;
  // The named ranges point at T39, which no read reaches: resolving them must stay a lookup, not a scan of 3,000 names per formula.
  const namedRanges = Array.from({ length: NAMES }, (_, k) => ({ name: rate(k), range: { sheetId: TABS - 1, startRowIndex: k % ROWS, endRowIndex: (k % ROWS) + 1, startColumnIndex: 0, endColumnIndex: 1 } }));
  const meta = tabsMeta(Array.from({ length: TABS }, (_, i) => [i, title(i), ROWS] as [number, string, number]), namedRanges);
  // Rows shared by every tab (only column C differs), so the fixture stays small in memory.
  const shared = Array.from({ length: ROWS }, (_, r) =>
    Array.from({ length: 26 }, (_, c) => (c === 0 ? num(r * 26) : c === 1 ? formula(`=A${r + 2}*2`, r) : c === 3 ? formula(`=A${r + 1}*${rate(r)}`, r) : formula(`=A${r + 1}+${c}`, r))),
  );
  const dense = (i: number) => ({
    properties: { sheetId: i, title: title(i) },
    data: [{ rowData: shared.map((row, r) => ({ values: [row[0], row[1], formula(`=T00!A${r + 1}+${i}`, r), ...row.slice(3)] })) }],
  });
  // Built once, outside the timed calls: only the tool's own work is measured.
  const grids = { sheets: Array.from({ length: TABS }, (_, i) => dense(i)) };
  const route = (m: string, url: string, body: any, params: any) => {
    if (m === "post") return body.requests[0]?.duplicateSheet ? duplicated(body) : { replies: body.requests.map(() => ({})) };
    return isGridRead(params) ? named(params, grids) : meta;
  };
  /** Grid cells one read covers: every tab when it names none, a whole tab ROWS × 26, a block its own size. */
  const cellsOf = (ranges: string[] | undefined) => (ranges ?? []).reduce((n, r) => n + (r.includes("!") ? a1Cells(parseA1(r)) : ROWS * 26), ranges ? 0 : TABS * ROWS * 26);
  const gridReads = (calls: { params?: any }[]) => calls.filter((c) => isGridRead(c.params)).map((c) => c.params.ranges as string[] | undefined);
  /**
   * Generous for a loaded CI machine: alone each call takes 0.1-0.6 s, but a full parallel `npm test`
   * (which also runs the audit's 128 MB child-heap tests) once took 1.8 s against the earlier 1.5 s.
   * Still far below what the bounds prevent: without them a call read 1.04M cells, and reference
   * extraction took about 1.3 s per 50,000-character formula (26 s for the 20 below).
   */
  const TIME_BUDGET_MS = 5_000;
  const timed = async (fn: () => Promise<unknown>) => {
    const t0 = performance.now();
    const out = await fn();
    return { out: out as any, ms: performance.now() - t0 };
  };

  it("a dry run with 200 row deletions reads within the cap, names the tabs it left out and previews the first 20", async () => {
    const { g, calls } = fakeClient(route);
    const requests = Array.from({ length: 200 }, (_, k) => ({ deleteDimension: { range: { sheetId: 0, dimension: "ROWS", startIndex: 2 * k, endIndex: 2 * k + 1 } } }));
    const { out, ms } = await timed(() => batchUpdate.handler({ spreadsheet_id: "sid", requests, dry_run: true, reply: "summary", verify: true, post_check: true, snapshot: false, include_spreadsheet_in_response: false }, ctx(g)));
    expect(ms, `${Math.round(ms)} ms`).toBeLessThan(TIME_BUDGET_MS);
    // First the cells of the 20 previewed rows, then the formulas of the deleted tab and what fits after it:
    // 3 × 26,000 = 78,000 of the 100,000-cell budget. Each read keeps to the budget on its own.
    const reads = gridReads(calls);
    expect(reads).toEqual([Array.from({ length: DELETION_PREVIEWS_MAX }, (_, k) => `'T00'!A${2 * k + 1}:Z${2 * k + 1}`), ["'T00'", "'T01'", "'T02'"]]);
    for (const ranges of reads) expect(cellsOf(ranges)).toBeLessThanOrEqual(GRID_READ_MAX_CELLS);
    const r = wire(out);
    const previewed = r.requests.filter((p: AnyRec) => p.preview?.dependentFormulas !== undefined);
    expect(previewed).toHaveLength(DELETION_PREVIEWS_MAX);
    // Row 1 is read by T00!B0 (none), T01!C1 and T02!C1 (both #REF!), and nothing else that was read.
    expect(previewed[0].preview).toMatchObject({ range: "T00!A1:Z1", cellsWithData: 26, dependentFormulas: 2, refErrors: 2 });
    expect(previewed[0].preview.note).toBe("large spreadsheet: formulas on T03, T04, T05, T06, T07, T08, T09, T10, T11, T12 and 27 more were not checked (over the 100000-cell read budget) — any there that read these cells are not listed (sheets_trace_dependents)");
    // Row 3's formula B2 (=A3*2) in the same tab breaks too.
    expect(previewed[1].preview.dependents).toContainEqual({ cell: "T00!B2", formula: "=A3*2", becomes: "#REF!" });
    const rest = r.requests.slice(DELETION_PREVIEWS_MAX);
    expect(rest).toHaveLength(180);
    // A note alone carries no "reshapes this tab first" caveat: there are no cells for it to qualify.
    for (const p of rest) expect(p.preview).toEqual({ note: "not previewed: a dry run previews the first 20 deletions of a batch — dry-run the rest separately" });
    expect(previewed[1].preview.caveat).toMatch(/^request #0 reshapes this tab first/);
  });

  it("the post-check after a real run re-reads within the same cap and lists every tab it skipped", async () => {
    const { g, calls } = fakeClient(route);
    const del = { deleteDimension: { range: { sheetId: 5, dimension: "ROWS", startIndex: 0, endIndex: 1 } } };
    const { out, ms } = await timed(() => batchUpdate.handler({ spreadsheet_id: "sid", requests: [del], dry_run: false, reply: "summary", verify: true, post_check: true, snapshot: false, include_spreadsheet_in_response: false }, ctx(g)));
    expect(ms, `${Math.round(ms)} ms`).toBeLessThan(TIME_BUDGET_MS);
    // The touched tab first (T05), then tab order.
    expect(gridReads(calls)).toEqual([["'T00'", "'T01'", "'T05'"]]);
    expect(cellsOf(gridReads(calls)[0])).toBeLessThanOrEqual(GRID_READ_MAX_CELLS);
    const r = wire(out);
    expect(r.postCheck).toMatchObject({ sheets: ["T00", "T01", "T05"], errorCount: 0, ok: true });
    expect(r.postCheck.skipped).toHaveLength(TABS - 3);
    expect(r.postCheck.skipped[0]).toBe("T02");
    expect(r.postCheck.note).toBe(`37 tab(s) under skipped not checked: over the ${GRID_READ_MAX_CELLS}-cell read budget — run sheets_audit_spreadsheet with ranges`);
  });

  it("a formula as long as a cell can hold is scanned in linear time", async () => {
    // 20 formulas of 50,000 characters (Google's limit for one cell), each one long name. Reference extraction
    // used to retry the sheet-name pattern from every character inside it: about 1.3 s per formula.
    const long = `=${"a".repeat(49_999)}`;
    const tabs2 = tabsMeta([[0, "Data", 100], [1, "Long", 100]]);
    const grids2 = { sheets: [{ properties: { sheetId: 0, title: "Data" }, data: [{ rowData: [{ values: [num(1)] }] }] }, { properties: { sheetId: 1, title: "Long" }, data: [{ rowData: Array.from({ length: 20 }, () => ({ values: [formula(long, 0)] })) }] }] };
    const { g } = fakeClient((m, url, body, params) => (m === "post" ? { replies: [{}] } : isGridRead(params) ? named(params, grids2) : tabs2));
    const { out, ms } = await timed(() => deleteSheet.handler({ spreadsheet_id: "sid", sheet_id: 0, snapshot: false, post_check: true }, ctx(g)));
    expect(ms, `${Math.round(ms)} ms`).toBeLessThan(TIME_BUDGET_MS);
    expect(wire(out).postCheck).toEqual({ errorCount: 0, ok: true, note: "no formula on the 1 other tab(s) checked reads Data" });
  }, 60_000);

  it("sheets_delete_sheet's check stays within the cap too, before and after the delete", async () => {
    const { g, calls } = fakeClient(route);
    const { out, ms } = await timed(() => deleteSheet.handler({ spreadsheet_id: "sid", sheet_id: 0, snapshot: false, post_check: true }, ctx(g)));
    expect(ms, `${Math.round(ms)} ms`).toBeLessThan(TIME_BUDGET_MS);
    const reads = gridReads(calls);
    // Before: the three other tabs that fit; after: those of them whose formulas read T00 (all three).
    expect(reads).toEqual([["'T01'", "'T02'", "'T03'"], ["'T01'", "'T02'", "'T03'"]]);
    for (const ranges of reads) expect(cellsOf(ranges)).toBeLessThanOrEqual(GRID_READ_MAX_CELLS);
    const r = wire(out);
    expect(r.postCheck.skipped).toHaveLength(TABS - 4);
    expect(r.postCheck.sheets).toEqual(["T01", "T02", "T03"]);
  });
});

describe("the work per request stays linear in the size of the batch", () => {
  // A script-driven import: 30,000 one-cell writes by sheetId. Nothing bounds the number of requests, and the
  // checks after the write run once Google has applied the batch: an isolate killed there (30 s of CPU) turns
  // an applied write into an error, which invites a retry. They are updateCells, value writes the tool re-reads
  // like any other: writeValues become at most WRITE_VALUES_MAX_UPDATES updateCells per batch, and a batch of
  // one-cell writeValues at that cap is timed on its own below.
  const N = 30_000;
  const TIME_BUDGET_MS = 1_500;
  const writes = (n: number, row0 = 1) =>
    Array.from({ length: n }, (_, k) => ({ updateCells: { start: { sheetId: 0, rowIndex: row0 - 1 + k, columnIndex: 0 }, rows: [{ values: [{ userEnteredValue: { numberValue: k } }] }], fields: "userEnteredValue" } }));
  const writeValues = (n: number) => Array.from({ length: n }, (_, k) => ({ writeValues: { sheetId: 0, range: `A${k + 1}`, values: [[k]] } }));
  const route = (rows: number) => (m: string, _url: string, body: any, params: any) =>
    m === "post" ? { replies: body.requests.map(() => ({})) } : isGridRead(params) ? { sheets: [{ properties: { title: "Data" }, data: [] }] } : tabsMeta([[0, "Data", rows], [1, "Other", 100]]);
  const batch = (requests: AnyRec[], extra: AnyRec = {}) => ({ spreadsheet_id: "sid", requests, dry_run: false, reply: "summary", verify: true, post_check: true, snapshot: false, include_spreadsheet_in_response: false, ...extra });
  const timed = async (fn: () => Promise<unknown>) => {
    const t0 = performance.now();
    const out = await fn();
    return { out: out as any, ms: performance.now() - t0 };
  };

  it("30,000 one-cell writes: verified within the time budget, and nothing re-checked at all with verify off", async () => {
    // Before: every written block was tested against every later request — 7 s for 30,000 one-cell writes, 12.6 s for 40,000.
    const on = fakeClient(route(N));
    const a = await timed(() => batchUpdate.handler(batch(writes(N)), ctx(on.g)));
    expect(a.ms, `${Math.round(a.ms)} ms`).toBeLessThan(TIME_BUDGET_MS);
    expect(wire(a.out)).toMatchObject({ applied: N, verification: { cells: 0, ok: true } });
    expect(on.calls.filter((c) => isGridRead(c.params)).map((c) => c.params.ranges.length)).toEqual([N]);

    const off = fakeClient(route(N));
    const b = await timed(() => batchUpdate.handler(batch(writes(N), { verify: false, post_check: false }), ctx(off.g)));
    expect(b.ms, `${Math.round(b.ms)} ms`).toBeLessThan(TIME_BUDGET_MS);
    expect(off.calls.map((c) => c.method)).toEqual(["get", "post"]);
    expect(wire(b.out)).toMatchObject({ applied: N });
    expect(wire(b.out).note).toBeUndefined();
  }, 60_000);

  it(`${WRITE_VALUES_MAX_UPDATES} one-cell writeValues, the most one batch may hold: verified within the time budget`, async () => {
    const { g, calls } = fakeClient(route(N));
    const { out, ms } = await timed(() => batchUpdate.handler(batch(writeValues(WRITE_VALUES_MAX_UPDATES)), ctx(g)));
    expect(ms, `${Math.round(ms)} ms`).toBeLessThan(TIME_BUDGET_MS);
    expect(wire(out)).toMatchObject({ applied: WRITE_VALUES_MAX_UPDATES, verification: { cells: 0, ok: true } });
    expect(calls.filter((c) => c.method === "post").map((c) => c.body.requests.length)).toEqual([WRITE_VALUES_MAX_UPDATES]);
  }, 60_000);

  it("writes followed by as many row inserts below them: the checks stop at a fixed budget and the note says which writes were not re-read", async () => {
    // No insert moves a write (all land below row 20,000), so each write would be tested against all 20,000 of them.
    const inserts = Array.from({ length: 20_000 }, (_, k) => ({ insertDimension: { range: { sheetId: 0, dimension: "ROWS", startIndex: 20_000 + k, endIndex: 20_001 + k } } }));
    const { g, calls } = fakeClient(route(40_000));
    const { out, ms } = await timed(() => batchUpdate.handler(batch([...writes(20_000), ...inserts], { post_check: false }), ctx(g)));
    expect(ms, `${Math.round(ms)} ms`).toBeLessThan(TIME_BUDGET_MS);
    const reread = calls.filter((c) => isGridRead(c.params)).flatMap((c) => c.params.ranges as string[]);
    expect(reread.length).toBeGreaterThan(0);
    expect(reread.length).toBeLessThan(20_000);
    expect(reread[0]).toBe("Data!A1");
    expect(wire(out).note).toBe(
      `${20_000 - reread.length} written range(s) not re-read: telling whether a later request in this batch moves them stopped at ${MOVER_CHECKS_MAX} checks (Data!A${reread.length + 1}, Data!A${reread.length + 2}, Data!A${reread.length + 3}, Data!A${reread.length + 4}, Data!A${reread.length + 5}, Data!A${reread.length + 6}, Data!A${reread.length + 7}, Data!A${reread.length + 8}, Data!A${reread.length + 9}, Data!A${reread.length + 10} and ${20_000 - reread.length - 10} more)`,
    );
  }, 60_000);

  it("a dry run of 30,000 writes after a row insert plans them within the time budget", async () => {
    const insert = { insertDimension: { range: { sheetId: 0, dimension: "ROWS", startIndex: 0, endIndex: 1 } } };
    const { g } = fakeClient((m, url, body, params) => (url.includes("values:batchGet") ? { valueRanges: [] } : route(N)(m, url, body, params)));
    const { out, ms } = await timed(() => batchUpdate.handler(batch([insert, ...writes(N)], { dry_run: true }), ctx(g)));
    expect(ms, `${Math.round(ms)} ms`).toBeLessThan(TIME_BUDGET_MS);
    // The plan itself, not the wire text: a 30,001-request plan is over the reply cap and comes back truncated.
    expect(out.requests).toHaveLength(N + 1);
    expect(out.requests[N].preview.caveat).toMatch(/^request #0 reshapes this tab first/);
  }, 60_000);
});

describe("grid reads are bounded in bytes, not only in cells", () => {
  // Log is Google's default 1,000 × 26 grid: six columns of 5,000-character text (a webhook payload logged per
  // row) and a formula reading Data. With Data that is 28,600 grid cells, under a third of the cells cap — yet
  // a read of every cell field returns Log's text three times over (about 90M characters).
  const LONG = "log entry ".repeat(500);
  const text = (s: string) => ({ userEnteredValue: { stringValue: s }, effectiveValue: { stringValue: s }, formattedValue: s });
  const meta = tabsMeta([[0, "Data", 100], [1, "Log", 1_000]]);
  const grids = {
    sheets: [
      { properties: { sheetId: 0, title: "Data" }, data: [{ rowData: Array.from({ length: 100 }, (_, r) => ({ values: [num(r)] })) }] },
      { properties: { sheetId: 1, title: "Log" }, data: [{ rowData: Array.from({ length: 1_000 }, (_, r) => ({ values: [...Array.from({ length: 6 }, () => text(LONG)), formula(`=Data!A${(r % 100) + 1}*2`, r)] })) }] },
    ],
  };
  /** One copy of Log's text: what any single read may not come near. */
  const LOG_TEXT = 6 * 1_000 * LONG.length;
  const CHECK_FIELDS = "values(userEnteredValue/formulaValue,effectiveValue/errorValue)";
  const SHOWN_FIELDS = "values(userEnteredValue/formulaValue,formattedValue)";
  const client = () => {
    const sizes: number[] = [];
    const fake = fakeClient((m, url, body, params) => {
      if (m === "post") return { replies: body.requests.map(() => ({})) };
      if (!isGridRead(params)) return meta;
      const out = named(params, grids);
      sizes.push(jsonLength(out));
      return out;
    });
    return { ...fake, sizes };
  };
  const gridReads = (calls: { params?: any; opts?: any }[]) => calls.filter((c) => isGridRead(c.params));
  const delData = { deleteDimension: { range: { sheetId: 0, dimension: "ROWS", startIndex: 0, endIndex: 1 } } };
  const batch = (extra: AnyRec) => ({ spreadsheet_id: "sid", dry_run: false, reply: "summary", verify: true, post_check: true, snapshot: false, include_spreadsheet_in_response: false, ...extra });

  it("the batch post-check asks for formulas and errors only, so the text never comes down", async () => {
    const { g, calls, sizes } = client();
    const r = wire(await batchUpdate.handler(batch({ requests: [delData] }), ctx(g)));
    expect(r.postCheck).toMatchObject({ sheets: ["Data", "Log"], errorCount: 0, ok: true });
    expect(Math.max(...sizes)).toBeLessThan(LOG_TEXT / 100);
    for (const c of gridReads(calls)) {
      expect(c.params.fields).toContain(CHECK_FIELDS);
      expect(c.params).toMatchObject({ prettyPrint: false });
      expect(c.opts).toEqual({ maxBytes: GRID_READ_MAX_BYTES });
    }
  });

  it("sheets_delete_sheet's scan and re-read ask for formulas and errors only", async () => {
    const { g, calls, sizes } = client();
    const r = wire(await deleteSheet.handler({ spreadsheet_id: "sid", sheet_id: 0, snapshot: false, post_check: true }, ctx(g)));
    expect(r.postCheck).toMatchObject({ sheets: ["Log"], errorCount: 0, ok: true });
    expect(gridReads(calls)).toHaveLength(2);
    expect(Math.max(...sizes)).toBeLessThan(LOG_TEXT / 100);
    for (const c of gridReads(calls)) expect([c.params.fields.includes(CHECK_FIELDS), c.opts?.maxBytes]).toEqual([true, GRID_READ_MAX_BYTES]);
  });

  it("a dry run reads values only for the deleted cells, formulas only for the dependents scan, and clips long cells", async () => {
    const { g, calls, sizes } = client();
    const delLog = { deleteDimension: { range: { sheetId: 1, dimension: "ROWS", startIndex: 0, endIndex: 2 } } };
    const r = wire(await batchUpdate.handler(batch({ dry_run: true, requests: [delLog] }), ctx(g)));
    const [shown, scan] = gridReads(calls);
    expect(gridReads(calls)).toHaveLength(2);
    expect([shown.params.ranges, shown.params.fields.includes(SHOWN_FIELDS)]).toEqual([["'Log'!A1:Z2"], true]);
    expect([scan.params.ranges, scan.params.fields.includes(CHECK_FIELDS)]).toEqual([undefined, true]);
    for (const c of [shown, scan]) expect(c.opts).toEqual({ maxBytes: GRID_READ_MAX_BYTES });
    expect(Math.max(...sizes)).toBeLessThan(LOG_TEXT / 100);
    const p = r.requests[0].preview;
    expect(p).toMatchObject({ range: "Log!A1:G2", cellsWithData: 14, dependentFormulas: 0 });
    // A 5,000-character cell is shown cut, like a dependent's formula: the reply stays small whatever the cells hold.
    expect(p.currentValues[0][0]).toHaveLength(160);
    expect(p.currentValues[0][0].endsWith("…")).toBe(true);
    expect(p.currentValues[0][6]).toBe("=Data!A1*2");
  });

  // Review finding: the verify re-read after a batch was not bounded the way the CHANGELOG said. It passed no
  // byte cap, asked for effectiveValue AND formattedValue (a text cell's text twice), and charged its
  // 100,000-cell budget with the plan's `cells` — for writeValues the values that are not null — while it
  // re-read the whole block, whatever text the other cells already held.
  const OLD_VERIFY_FIELDS = "sheets(properties(title),data(startRow,startColumn,rowData(values(effectiveValue,formattedValue))))";
  /** Like `client`, and a grid read over its maxBytes is refused, as GoogleClient refuses it while it streams. */
  const cappedClient = (tabs: AnyRec = meta, cells: { sheets: AnyRec[] } = grids) => {
    const calls: { method: string; url: string; body?: any; params?: any; opts?: any }[] = [];
    const g = {
      get: async (url: string, params?: any, opts?: any) => {
        calls.push({ method: "get", url, params, opts });
        if (!isGridRead(params)) return tabs;
        const out = named(params, cells);
        if (opts?.maxBytes !== undefined && jsonLength(out) > opts.maxBytes) throw new ResponseTooLargeError("GET", url, opts.maxBytes);
        return out;
      },
      post: async (url: string, body: any) => (calls.push({ method: "post", url, body }), { replies: body.requests.map(() => ({})) }),
    } as any;
    return { g, calls };
  };
  /** A writeValues over `range` whose only value per row is in its last column: everything else is null (skipped). */
  const lastColumnOnly = (range: string, rows: number, cols: number, value: string) => ({
    writeValues: { range, values: Array.from({ length: rows }, () => [...Array.from({ length: cols - 1 }, () => null), value]) },
  });

  it("the verify re-read asks for the effective value only, capped in bytes: a text-heavy block over 8 MB is named, never downloaded", async () => {
    // Log!A1:G1000: one formula per row in G, nulls over A-F, which already hold 5,000-character text. The plan
    // counts 1,000 values; the re-read covers all 7,000 cells, and their text alone is over the byte cap.
    const write = lastColumnOnly("Log!A1:G1000", 1_000, 7, "=Data!A1*3");
    const { g, calls } = cappedClient();
    const r = wire(await batchUpdate.handler(batch({ requests: [write] }), ctx(g)));
    const [read] = gridReads(calls);
    expect(gridReads(calls)).toHaveLength(1);
    expect(read.params.ranges).toEqual(["Log!A1:G1000"]);
    expect(read.params.fields).toContain("values(effectiveValue)");
    expect(read.params.fields).not.toContain("formattedValue");
    expect(read.params).toMatchObject({ prettyPrint: false });
    expect(read.opts).toEqual({ maxBytes: GRID_READ_MAX_BYTES });
    // What the unbounded read of before would have downloaded: the text twice, far over the byte bound.
    expect(jsonLength(named({ ranges: read.params.ranges, fields: OLD_VERIFY_FIELDS }, grids))).toBeGreaterThan(2 * LOG_TEXT);
    expect(jsonLength(named({ ranges: read.params.ranges, fields: read.params.fields }, grids))).toBeGreaterThan(GRID_READ_MAX_BYTES);
    // Refused, and reported: the batch is applied and nothing is thrown.
    expect(posts(calls)).toHaveLength(1);
    expect(r.applied).toBe(1);
    expect(r.verification).toBeUndefined();
    expect(r.note).toBe("1 written range(s) not re-read: the re-read came back over the 8 MB read budget (Log!A1:G1000)");
  });

  it("a block whose text came back twice over the byte bound now fits: one copy is read and checked", async () => {
    // Log!F1:G1000: 1,000 text cells and 1,000 formulas. Twice the text is over 8 MB; once is under it.
    const write = lastColumnOnly("Log!F1:G1000", 1_000, 2, "=Data!A1*3");
    const { g, calls } = cappedClient();
    const r = wire(await batchUpdate.handler(batch({ requests: [write] }), ctx(g)));
    const [read] = gridReads(calls);
    expect(jsonLength(named({ ranges: read.params.ranges, fields: OLD_VERIFY_FIELDS }, grids))).toBeGreaterThan(GRID_READ_MAX_BYTES);
    expect(jsonLength(named({ ranges: read.params.ranges, fields: read.params.fields }, grids))).toBeLessThan(GRID_READ_MAX_BYTES);
    expect(r.verification).toEqual({ cells: 2_000, ok: true });
    expect(r.note).toBeUndefined();
  });

  it("the cell budget is charged the whole written block, not the values that are not null", async () => {
    // Big!A1:Z4000 with one value per row: 4,000 values, 104,000 grid cells re-read — over the 100,000-cell budget.
    const bigMeta = tabsMeta([[0, "Data", 100], [1, "Big", 5_000]]);
    const write = lastColumnOnly("Big!A1:Z4000", 4_000, 26, "x");
    const { g, calls } = cappedClient(bigMeta, { sheets: [] });
    const r = wire(await batchUpdate.handler(batch({ requests: [write] }), ctx(g)));
    expect(gridReads(calls)).toEqual([]);
    expect(r.note).toBe(`1 written range(s) not re-read: over the ${GRID_READ_MAX_CELLS}-cell re-read budget (Big!A1:Z4000)`);
    // The charges add up: a 60,000-cell block fits, a second 50,000-cell one no longer does, whatever they hold.
    const two = [lastColumnOnly("Big!A1:Z2308", 2_308, 26, "x"), lastColumnOnly("Big!A2401:Z4323", 1_923, 26, "x")];
    const second = cappedClient(bigMeta, { sheets: [] });
    const r2 = wire(await batchUpdate.handler(batch({ requests: two }), ctx(second.g)));
    expect(gridReads(second.calls).map((c) => c.params.ranges)).toEqual([["Big!A1:Z2308"]]);
    expect(r2.note).toBe(`1 written range(s) not re-read: over the ${GRID_READ_MAX_CELLS}-cell re-read budget (Big!A2401:Z4323)`);
  });

  it("an open-ended write is re-read as the closed block the grid holds, and charged that", async () => {
    // A '*' repeatCell over column C clears every value there: a value write over C1:C1000 of Log's grid.
    const clearC = { repeatCell: { range: { sheetId: 1, startColumnIndex: 2, endColumnIndex: 3 }, cell: {}, fields: "*" } };
    const { g, calls } = cappedClient();
    const r = wire(await batchUpdate.handler(batch({ requests: [clearC] }), ctx(g)));
    expect(gridReads(calls).map((c) => c.params.ranges)).toEqual([["Log!C1:C1000"]]);
    expect(r.note).toBeUndefined();
    expect(r.verification).toEqual({ cells: 1_000, ok: true });
  });

  // Review finding: a dry run's overwrite preview decided whether to read a range by the request's `cells` —
  // for writeValues the values that are not null, for updateCells with a `range` the cells in `rows` — and then
  // read the whole range with values:batchGet, with no byte cap.
  /** values:batchGet answered from `cells` (FORMULA rendering), refused over its maxBytes as GoogleClient refuses it. */
  const shown = (c: AnyRec) => c.userEnteredValue?.formulaValue ?? c.userEnteredValue?.stringValue ?? c.userEnteredValue?.numberValue ?? "";
  /** One range of a values:batchGet (FORMULA rendering), as Google returns it. */
  const valueRange = (range: string, cells: { sheets: AnyRec[] }) => {
    const block = named({ ranges: [range] }, cells).sheets[0]?.data?.[0];
    return { range, values: ((block?.rowData ?? []) as AnyRec[]).map((row) => ((row.values ?? []) as AnyRec[]).map(shown)) };
  };
  const previewClient = (cells: { sheets: AnyRec[] } = grids, tabs: AnyRec = meta) => {
    const calls: { method: string; url: string; params?: any; opts?: any }[] = [];
    const g = {
      get: async (url: string, params?: any, opts?: any) => {
        calls.push({ method: "get", url, params, opts });
        if (!url.includes("values:batchGet")) return tabs;
        const out = { valueRanges: (params.ranges as string[]).map((range) => valueRange(range, cells)) };
        if (opts?.maxBytes !== undefined && jsonLength(out) > opts.maxBytes) throw new ResponseTooLargeError("GET", url, opts.maxBytes);
        return out;
      },
      post: async () => {
        throw new Error("a dry run posts nothing");
      },
    } as any;
    return { g, calls, previews: () => calls.filter((c) => c.url.includes("values:batchGet")) };
  };

  it("a dry run's overwrite preview is charged the whole block it reads: a sparse writeValues over text is not read", async () => {
    // Log!A1:Z1000 with 200 values in column Z: 26,000 grid cells, 6,000 of them 5,000-character text.
    const sparse = { writeValues: { range: "Log!A1:Z1000", values: Array.from({ length: 1_000 }, (_, r) => [...Array.from({ length: 25 }, () => null), r < 200 ? "x" : null]) } };
    const { g, previews } = previewClient();
    const r = wire(await batchUpdate.handler(batch({ dry_run: true, requests: [sparse] }), ctx(g)));
    // What the read of before would have fetched: the whole block, text included, far over the byte cap.
    expect(jsonLength({ valueRanges: [valueRange("Log!A1:Z1000", grids)] })).toBeGreaterThan(3 * GRID_READ_MAX_BYTES);
    expect(previews()).toEqual([]);
    expect(r.requests[0]).toMatchObject({ type: "writeValues", range: "Log!A1:Z1000", cells: 200, warning: "overwrites values" });
    expect(r.requests[0].preview).toEqual({ note: "26000 cells in Log!A1:Z1000 — preview capped at 200 cells; read the range first if needed" });
    expect(r.totals).toEqual({ cellsWritten: 200 });
  });

  it("an updateCells over a large `range` with a short `rows` array is charged its range, not its rows", async () => {
    const update = { updateCells: { range: { sheetId: 1, startRowIndex: 0, endRowIndex: 1_000, startColumnIndex: 0, endColumnIndex: 7 }, rows: [{ values: [{ userEnteredValue: { stringValue: "x" } }] }], fields: "userEnteredValue" } };
    const { g, previews } = previewClient();
    const r = wire(await batchUpdate.handler(batch({ dry_run: true, requests: [update] }), ctx(g)));
    expect(previews()).toEqual([]);
    expect(r.requests[0].preview).toEqual({ note: "7000 cells in Log!A1:G1000 — preview capped at 200 cells; read the range first if needed" });
  });

  it("a preview within the cell cap is read with the byte cap; one over the byte cap says so and the plan is still returned", async () => {
    const { g, previews } = previewClient();
    const small = wire(await batchUpdate.handler(batch({ dry_run: true, requests: [{ writeValues: { range: "Log!G1:G2", values: [[1], [2]] } }] }), ctx(g)));
    expect(previews().map((c) => [c.params, c.opts])).toEqual([[{ ranges: ["Log!G1:G2"], valueRenderOption: "FORMULA", prettyPrint: false }, { maxBytes: GRID_READ_MAX_BYTES }]]);
    expect(small.requests[0].preview).toEqual({ range: "Log!G1:G2", currentValues: [["=Data!A1*2"], ["=Data!A2*2"]] });
    // 200 cells of 50,000 characters (Google's per-cell limit): within the cell cap, 10 MB of values.
    const huge = "y".repeat(50_000);
    const cells = { sheets: [{ properties: { sheetId: 0, title: "Data" }, data: [{ rowData: Array.from({ length: 200 }, () => ({ values: [{ userEnteredValue: { stringValue: huge } }] })) }] }] };
    const over = previewClient(cells, tabsMeta([[0, "Data", 200]]));
    const r = wire(await batchUpdate.handler(batch({ dry_run: true, requests: [{ writeValues: { range: "Data!A1:A200", values: Array.from({ length: 200 }, () => ["z"]) } }] }), ctx(over.g)));
    expect(over.previews()).toHaveLength(1);
    expect(r).toMatchObject({ dryRun: true, wrote: false });
    expect(r.requests[0]).toMatchObject({ type: "writeValues", cells: 200, preview: { note: "preview unavailable: the current values came back over the 8 MB read budget" } });
    expect(r.provenance).toBeUndefined();
  });
});

describe("a response over the byte budget is refused while it streams, never parsed", () => {
  const enc = new TextEncoder();
  /**
   * A real GoogleClient over an injected fetch. Grid reads answer with valid JSON whose one formula is `bytes` long,
   * streamed in 64 KB chunks; `pulled` counts what the client actually took from the stream.
   */
  function streamingClient(tabs: [number, string, number][], bytes: number) {
    let pulled = 0;
    const posts: any[] = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      if (url.startsWith("https://oauth2.googleapis.com/token")) return Response.json({ access_token: "AT", expires_in: 3600 });
      if (init?.method === "POST") return posts.push(JSON.parse(String(init.body))), Response.json({ replies: [{}] });
      if (new URL(url).searchParams.get("includeGridData") !== "true") return Response.json(tabsMeta(tabs));
      const parts = [enc.encode(`{"sheets":[{"properties":{"sheetId":1,"title":"Log"},"data":[{"rowData":[{"values":[{"userEnteredValue":{"formulaValue":"=`)];
      const chunk = enc.encode("x".repeat(64 * 1024));
      for (let n = 0; n < bytes; n += chunk.length) parts.push(chunk);
      parts.push(enc.encode(`"}}]}]}]}]}`));
      let i = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(ctrl) {
          if (i >= parts.length) return ctrl.close();
          pulled += parts[i].length;
          ctrl.enqueue(parts[i++]);
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    };
    return { g: new GoogleClient({ clientId: "id", clientSecret: "sec", refreshToken: "rt", fetch: fetchImpl as any }), pulled: () => pulled, posts };
  }
  const BIG = 20 * 1024 * 1024;
  const tabs: [number, string, number][] = [[0, "Data", 100], [1, "Log", 1_000]];
  const over = (n: number) => `${n} tab(s) under skipped not checked: over the ${GRID_READ_MAX_CELLS}-cell or ${GRID_READ_MAX_BYTES / 1024 / 1024} MB read budget — run sheets_audit_spreadsheet with ranges`;
  const delData = { deleteDimension: { range: { sheetId: 0, dimension: "ROWS", startIndex: 0, endIndex: 1 } } };

  it("the batch post-check lists every tab it covered as skipped — the batch is applied and reported, never thrown", async () => {
    const { g, pulled, posts } = streamingClient(tabs, BIG);
    const r = wire(await batchUpdate.handler({ spreadsheet_id: "sid", requests: [delData], dry_run: false, reply: "summary", verify: true, post_check: true, snapshot: false, include_spreadsheet_in_response: false }, ctx(g)));
    expect(posts).toHaveLength(1);
    expect(r.applied).toBe(1);
    expect(r.postCheck).toEqual({ skipped: ["Data", "Log"], note: over(2) });
    expect(pulled()).toBeLessThan(GRID_READ_MAX_BYTES + 256 * 1024);
  }, 20_000);

  it("sheets_delete_sheet still deletes, and its post-check says which tabs it could not check", async () => {
    const { g, posts } = streamingClient(tabs, BIG);
    const r = wire(await deleteSheet.handler({ spreadsheet_id: "sid", sheet_id: 0, snapshot: false, post_check: true }, ctx(g)));
    expect(posts).toEqual([{ requests: [{ deleteSheet: { sheetId: 0 } }] }]);
    expect(r).toEqual({ deleted: true, sheetId: 0, sheet: "Data", postCheck: { skipped: ["Log"], note: over(1) } });
  }, 20_000);

  it("a dry run keeps its plan and marks the preview unavailable", async () => {
    const { g } = streamingClient(tabs, BIG);
    const r = wire(await batchUpdate.handler({ spreadsheet_id: "sid", requests: [delData], dry_run: true, reply: "summary", verify: true, post_check: true, snapshot: false, include_spreadsheet_in_response: false }, ctx(g)));
    expect(r.requests[0]).toMatchObject({ type: "deleteDimension", warning: "destructive" });
    expect(r.requests[0].preview.note).toMatch(/^preview unavailable: the grid read failed \(.*over the 8 MB/);
  }, 20_000);

  it("a response just under the budget is read and checked as before", async () => {
    const { g } = streamingClient(tabs, 1024 * 1024);
    const r = wire(await batchUpdate.handler({ spreadsheet_id: "sid", requests: [delData], dry_run: false, reply: "summary", verify: true, post_check: true, snapshot: false, include_spreadsheet_in_response: false }, ctx(g)));
    expect(r.postCheck).toMatchObject({ sheets: ["Log"], errorCount: 0, ok: true });
  }, 20_000);
});
