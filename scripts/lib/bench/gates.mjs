/**
 * Gate math for the orientation benchmark: turns the run rows of
 * bench/results-template.csv into per-config summaries and the G1–G8 verdicts of docs/roadmap
 * doc2 §acceptance. Pure — no I/O, no dates, no network — so tests/bench.test.ts pins every rule
 * and bench/score.mjs is only argv + files around it.
 *
 *   loadRows(csvText, { benchDay, allowStale })   typed rows; wrong_mutation=1 forces success=0;
 *                                                 rows sharing a run_id collapse to the last one
 *                                                 (`duplicates` counts the replaced rows); rows
 *                                                 whose bench_day ≠ benchDay land in `stale`
 *   summarize(rows)                               one summary per config (A, B, C …)
 *   evaluateGates({ rows, before, afterVersion, tokens })
 *                                                 [{ gate, status: PASS|FAIL|N/A, value, threshold, detail }]
 *   shuffle(taskIds, seed)                        deterministic task order for the human pass
 *   exportNumeric(rows)                           CSV text without `notes` (the only free-text column)
 *
 * Percentiles use the nearest-rank method (the value at rank ceil(q·n)), the same as
 * scripts/lib/measure-core.mjs, so p95 result_bytes here and p95 tool bytes there mean one thing.
 */
import { parseRecords, serializeCsv } from "./csv.mjs";

/** bench/results-template.csv header — exact order (scripts/lib/bench/session.mjs writes the same). */
export const CSV_COLUMNS = ["run_id", "date", "server_version", "commit", "config", "task_id", "category", "run_no", "tester", "bench_day", "success", "wrong_mutation", "first_tool", "first_tool_ok", "tool_calls", "discovery_calls", "retries", "turns", "wall_s", "result_bytes", "input_tokens", "cache_read_tokens", "output_tokens", "clarifying_q", "notes"];

/** Columns `exportNumeric` keeps: everything but `notes` (first_tool is a tool name, never account data). */
export const EXPORT_COLUMNS = CSV_COLUMNS.filter((c) => c !== "notes");

/** 0/1 flags and counts (blank → 0). */
export const INT_COLUMNS = ["success", "wrong_mutation", "first_tool_ok", "tool_calls", "discovery_calls", "retries", "turns", "clarifying_q"];
/** Measurements that may be blank in human rows (blank → null, excluded from percentiles and sums). */
export const NUMBER_COLUMNS = ["wall_s", "result_bytes", "input_tokens", "cache_read_tokens", "output_tokens"];

/** The doc2 categories G5 averages over ("simple lookup" + "multi-step cross-service"). */
export const DISCOVERY_CATEGORIES = ["lookup", "multi_step"];

/** Gate thresholds (doc2 §acceptance as numbers; section C of the WS5 design). */
export const THRESHOLDS = {
  G1_SUCCESS: 0.9,
  G2_FIRST_TOOL: 0.85,
  G3_WRONG_MUTATIONS: 0,
  G4_RATIO: 0.3,
  G4_ABSOLUTE_TOKENS: 10_000,
  G5_MEDIAN_DISCOVERY: 1,
  G6_RATIO: 0.5,
  G7_SUCCESS_DELTA: 0.05,
  G7_EXTRA_CALLS: 1,
};

export const GATE_NAMES = ["G1", "G2", "G3", "G4", "G5", "G6", "G7", "G8"];

const list = (v) => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);

// ---------------------------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------------------------

/** Nearest-rank percentile of `values` (unsorted, finite numbers only): the value at rank ceil(q·n); null when empty. */
export function percentile(values, q) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)];
}

export const median = (values) => percentile(values, 0.5);

/** Mean of the finite values; null when there are none. */
export function mean(values) {
  const xs = values.filter((v) => Number.isFinite(v));
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

/** Sum of the finite values (0 when none). */
export const sum = (values) => values.filter((v) => Number.isFinite(v)).reduce((a, b) => a + b, 0);

// ---------------------------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------------------------

const toInt = (v) => {
  const s = String(v ?? "").trim().toLowerCase();
  if (s === "" || s === "false" || s === "no") return 0;
  if (s === "true" || s === "yes") return 1;
  const n = Number(s);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
};
const toNumber = (v) => {
  const s = String(v ?? "").trim();
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

/** One CSV record → a typed row. `wrong_mutation=1` forces `success=0` (rubric rule; gate G3 counts it). */
export function typeRow(record) {
  const row = {};
  for (const c of CSV_COLUMNS) {
    if (INT_COLUMNS.includes(c)) row[c] = toInt(record[c]);
    else if (NUMBER_COLUMNS.includes(c)) row[c] = toNumber(record[c]);
    else row[c] = String(record[c] ?? "").trim();
  }
  row.success = row.success ? 1 : 0;
  row.wrong_mutation = row.wrong_mutation ? 1 : 0;
  row.first_tool_ok = row.first_tool_ok ? 1 : 0;
  if (row.wrong_mutation === 1) row.success = 0;
  return row;
}

/**
 * Collapses rows that share a `run_id`: the LAST occurrence wins and takes the position of the last
 * occurrence, so a re-scored row (replay / a re-imported export) replaces the verdict recorded
 * earlier instead of being counted next to it. Rows with an empty run_id are never merged.
 * Returns { rows, duplicates } — `duplicates` = the number of rows that were replaced.
 */
export function dedupeRows(rows) {
  const byId = new Map();
  const loose = [];
  let duplicates = 0;
  for (const row of list(rows)) {
    const id = String(row?.run_id ?? "").trim();
    if (!id) {
      loose.push(row);
      continue;
    }
    if (byId.has(id)) {
      duplicates++;
      byId.delete(id);
    }
    byId.set(id, row);
  }
  return { rows: [...loose, ...byId.values()], duplicates };
}

/**
 * Parses a runs CSV. The header must carry every column of CSV_COLUMNS except `notes`, which is
 * optional (the committed `score.mjs --export` files drop it; a missing cell reads as ""); extra
 * columns are ignored. Rows sharing a run_id are collapsed to their last occurrence (dedupeRows —
 * `duplicates` reports how many were replaced). With `benchDay`, rows whose bench_day differs go
 * to `stale` and are kept in `rows` only when `allowStale` is set — a run recorded against an older
 * fixture week must not score silently.
 */
export function loadRows(csvText, { benchDay, allowStale = false } = {}) {
  const { header, records } = parseRecords(csvText);
  const missing = EXPORT_COLUMNS.filter((c) => !header.includes(c));
  if (missing.length) throw new Error(`runs CSV is missing column(s): ${missing.join(", ")} (header must match bench/results-template.csv)`);
  const { rows: unique, duplicates } = dedupeRows(records.map(typeRow));
  const rows = [];
  const stale = [];
  for (const row of unique) {
    const isStale = !!benchDay && row.bench_day !== benchDay;
    if (isStale) stale.push(row);
    if (!isStale || allowStale) rows.push(row);
  }
  return { header, rows, stale, duplicates };
}

/** Distinct values of a column, in first-seen order. */
export const distinct = (rows, col) => [...new Set(rows.map((r) => r[col]))];

const rate = (rows, col) => (rows.length ? sum(rows.map((r) => r[col])) / rows.length : null);

/** The summary of one set of rows (a config, or a config × version). */
export function summarizeRows(rows, label = "") {
  const numbers = (col) => rows.map((r) => r[col]).filter((v) => Number.isFinite(v));
  const discoveryRows = rows.filter((r) => DISCOVERY_CATEGORIES.includes(r.category));
  return {
    config: label,
    sessions: rows.length,
    tasks: distinct(rows, "task_id").length,
    versions: distinct(rows, "server_version").filter(Boolean),
    successCount: sum(rows.map((r) => r.success)),
    successRate: rate(rows, "success"),
    firstToolOkCount: sum(rows.map((r) => r.first_tool_ok)),
    firstToolOkRate: rate(rows, "first_tool_ok"),
    wrongMutations: sum(rows.map((r) => r.wrong_mutation)),
    toolCallsMedian: median(numbers("tool_calls")),
    toolCallsP90: percentile(numbers("tool_calls"), 0.9),
    discoveryMedian: median(discoveryRows.map((r) => r.discovery_calls)),
    discoveryP90: percentile(
      discoveryRows.map((r) => r.discovery_calls),
      0.9,
    ),
    discoverySessions: discoveryRows.length,
    resultBytesMedian: median(numbers("result_bytes")),
    resultBytesP90: percentile(numbers("result_bytes"), 0.9),
    resultBytesP95: percentile(numbers("result_bytes"), 0.95),
    wallSMedian: median(numbers("wall_s")),
    inputTokens: sum(numbers("input_tokens")),
    cacheReadTokens: sum(numbers("cache_read_tokens")),
    outputTokens: sum(numbers("output_tokens")),
    clarifyingQuestions: sum(rows.map((r) => r.clarifying_q)),
    retries: sum(rows.map((r) => r.retries)),
  };
}

/** One summary per config, configs sorted (A, B, C, …). */
export function summarize(rows) {
  return distinct(rows, "config")
    .sort()
    .map((config) => summarizeRows(rows.filter((r) => r.config === config), config));
}

// ---------------------------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------------------------

const fmtRate = (v) => (v === null || v === undefined ? "—" : `${(v * 100).toFixed(1)}%`);
const fmtNum = (v) => (v === null || v === undefined ? "—" : Number.isInteger(v) ? String(v) : v.toFixed(2));
const verdict = (gate, ok, value, threshold, detail) => ({ gate, status: ok ? "PASS" : "FAIL", value, threshold, detail });
const na = (gate, threshold, detail) => ({ gate, status: "N/A", value: null, threshold, detail });

/** Tasks passing in every A run while failing in every C run (G7's task-level rule). Both sides need ≥1 run of the task. */
export function taskRegressions(aRows, cRows) {
  const byTask = (rows) => {
    const m = new Map();
    for (const r of rows) m.set(r.task_id, [...(m.get(r.task_id) ?? []), r.success]);
    return m;
  };
  const a = byTask(aRows);
  const c = byTask(cRows);
  return [...a.keys()].filter((t) => c.has(t) && a.get(t).every((s) => s === 1) && c.get(t).every((s) => s === 0)).sort();
}

/**
 * G1–G8 on `rows` (the after pass). `afterVersion` restricts the after rows to that server_version
 * (unset → every row counts as "after"); `before` are the 1.4.4 rows for G6 (config A only is used);
 * `tokens` = { compact, full } enables G4. Every verdict has value/threshold/detail for the table.
 */
export function evaluateGates({ rows = [], before = [], afterVersion, tokens } = {}) {
  const T = THRESHOLDS;
  const after = afterVersion ? rows.filter((r) => r.server_version === afterVersion) : rows;
  const scope = afterVersion ? `server_version ${afterVersion}` : "all rows (no --after-version)";
  const C = after.filter((r) => r.config === "C");
  const A = after.filter((r) => r.config === "A");
  const beforeA = list(before).filter((r) => r.config === "A");
  const out = [];

  // G1 — success rate of config C
  if (!C.length) out.push(na("G1", `≥ ${fmtRate(T.G1_SUCCESS)}`, `no config C rows (${scope})`));
  else {
    const r = rate(C, "success");
    out.push(verdict("G1", r >= T.G1_SUCCESS, r, `≥ ${fmtRate(T.G1_SUCCESS)}`, `${sum(C.map((x) => x.success))}/${C.length} sessions succeeded (${fmtRate(r)})`));
  }

  // G2 — first-tool accuracy of config C
  if (!C.length) out.push(na("G2", `≥ ${fmtRate(T.G2_FIRST_TOOL)}`, `no config C rows (${scope})`));
  else {
    const r = rate(C, "first_tool_ok");
    out.push(verdict("G2", r >= T.G2_FIRST_TOOL, r, `≥ ${fmtRate(T.G2_FIRST_TOOL)}`, `${sum(C.map((x) => x.first_tool_ok))}/${C.length} first tools expected (${fmtRate(r)})`));
  }

  // G3 — wrong mutations over ALL after rows, every config
  if (!after.length) out.push(na("G3", `== ${T.G3_WRONG_MUTATIONS}`, `no rows (${scope})`));
  else {
    const n = sum(after.map((x) => x.wrong_mutation));
    const offenders = after.filter((x) => x.wrong_mutation).map((x) => `${x.config}/${x.task_id}#${x.run_no}`);
    out.push(verdict("G3", n === T.G3_WRONG_MUTATIONS, n, `== ${T.G3_WRONG_MUTATIONS}`, n ? `${n} wrong mutation(s): ${offenders.join(", ")} — release blocked` : `0 wrong mutations over ${after.length} sessions (${scope})`));
  }

  // G4 — upfront tool tokens (only with --tokens)
  if (!tokens || !Number.isFinite(tokens.compact) || !Number.isFinite(tokens.full)) out.push(na("G4", `≤ ${T.G4_RATIO}×full and < ${T.G4_ABSOLUTE_TOKENS}`, "no --tokens compact=<n>,full=<n> given"));
  else {
    const bound = Math.floor(T.G4_RATIO * tokens.full);
    const ratio = tokens.full ? tokens.compact / tokens.full : Infinity;
    const ok = tokens.compact <= T.G4_RATIO * tokens.full && tokens.compact < T.G4_ABSOLUTE_TOKENS;
    out.push(verdict("G4", ok, tokens.compact, `≤ ${bound} (${T.G4_RATIO}×${tokens.full}) and < ${T.G4_ABSOLUTE_TOKENS}`, `compact/full = ${fmtNum(ratio)} (saving ${fmtRate(1 - ratio)})`));
  }

  // G5 — discovery calls in C over lookup + multi_step
  const C5 = C.filter((r) => DISCOVERY_CATEGORIES.includes(r.category));
  if (!C5.length) out.push(na("G5", `median ≤ ${T.G5_MEDIAN_DISCOVERY}`, `no config C rows in ${DISCOVERY_CATEGORIES.join("+")}`));
  else {
    const m = median(C5.map((r) => r.discovery_calls));
    const p90 = percentile(
      C5.map((r) => r.discovery_calls),
      0.9,
    );
    out.push(verdict("G5", m <= T.G5_MEDIAN_DISCOVERY, m, `median ≤ ${T.G5_MEDIAN_DISCOVERY}`, `median ${fmtNum(m)}, p90 ${fmtNum(p90)} over ${C5.length} sessions`));
  }

  // G6 — p95 result_bytes of C vs the before rows of config A
  const cBytes = C.map((r) => r.result_bytes).filter((v) => Number.isFinite(v));
  const bBytes = beforeA.map((r) => r.result_bytes).filter((v) => Number.isFinite(v));
  if (!cBytes.length || !bBytes.length) out.push(na("G6", `≤ ${T.G6_RATIO}× before p95`, !bBytes.length ? "no --before rows of config A with result_bytes" : "no config C rows with result_bytes"));
  else {
    const p95C = percentile(cBytes, 0.95);
    const p95B = percentile(bBytes, 0.95);
    const bound = T.G6_RATIO * p95B;
    out.push(
      verdict("G6", p95C <= bound, p95C, `≤ ${fmtNum(bound)} (${T.G6_RATIO}× before p95 ${p95B})`, `C: median ${fmtNum(median(cBytes))}, p90 ${fmtNum(percentile(cBytes, 0.9))}, p95 ${p95C}; before A: median ${fmtNum(median(bBytes))}, p90 ${fmtNum(percentile(bBytes, 0.9))}, p95 ${p95B}; ratio ${fmtNum(p95B ? p95C / p95B : Infinity)}`),
    );
  }

  // G7 — no regression of C against A on the same version
  if (!C.length || !A.length) out.push(na("G7", `success(C) ≥ success(A) − ${T.G7_SUCCESS_DELTA}; median calls(C) ≤ median(A) + ${T.G7_EXTRA_CALLS}; no task-level regression`, !A.length ? `no config A rows (${scope})` : `no config C rows (${scope})`));
  else {
    const sC = rate(C, "success");
    const sA = rate(A, "success");
    const mC = median(C.map((r) => r.tool_calls));
    const mA = median(A.map((r) => r.tool_calls));
    const regressions = taskRegressions(A, C);
    const okSuccess = sC >= sA - T.G7_SUCCESS_DELTA - 1e-9;
    const okCalls = mC <= mA + T.G7_EXTRA_CALLS;
    const okTasks = regressions.length === 0;
    out.push(
      verdict(
        "G7",
        okSuccess && okCalls && okTasks,
        `Δsuccess ${sC - sA >= 0 ? "+" : ""}${((sC - sA) * 100).toFixed(1)} pts, Δmedian calls ${mC - mA >= 0 ? "+" : ""}${fmtNum(mC - mA)}, regressions ${regressions.length}`,
        `success(C) ≥ success(A) − ${T.G7_SUCCESS_DELTA}; median calls(C) ≤ median(A) + ${T.G7_EXTRA_CALLS}; no task-level regression`,
        `success C ${fmtRate(sC)} vs A ${fmtRate(sA)} (${okSuccess ? "ok" : "FAIL"}); median tool_calls C ${fmtNum(mC)} vs A ${fmtNum(mA)} (${okCalls ? "ok" : "FAIL"}); tasks passing in every A run and failing in every C run: ${regressions.length ? regressions.join(", ") : "none"}`,
      ),
    );
  }

  // G8 — schema regression guard lives in CI
  out.push({ gate: "G8", status: "N/A", value: "see CI", threshold: "tasks.json references resolve", detail: "tests/bench.test.ts validates every tool reference in bench/tasks.json against ALL_TOOLS (npx vitest run tests/bench.test.ts)" });

  return out;
}

/** True when any verdict FAILed. */
export const anyFail = (gates) => gates.some((g) => g.status === "FAIL");

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

const cell = (v) => (v === null || v === undefined ? "—" : typeof v === "number" ? (Number.isInteger(v) ? String(v) : v.toFixed(3)) : String(v));

/** Markdown: one summary table (row per config) and the gate table. */
export function renderMarkdown({ summaries = [], gates = [], stale = [], duplicates = 0, title = "Benchmark results" } = {}) {
  const lines = [`## ${title}`, ""];
  if (!summaries.length) lines.push("_No rows._", "");
  else {
    lines.push("| Config | Sessions | Tasks | Versions | Success | First tool | Wrong mut. | tool_calls median / p90 | discovery median (p90) | result_bytes p95 | wall_s median | Σ input_tokens | Σ cache_read |");
    lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
    for (const s of summaries) {
      lines.push(
        `| ${s.config || "—"} | ${s.sessions} | ${s.tasks} | ${s.versions.join(" ") || "—"} | ${fmtRate(s.successRate)} (${s.successCount}/${s.sessions}) | ${fmtRate(s.firstToolOkRate)} | ${s.wrongMutations} | ${cell(s.toolCallsMedian)} / ${cell(s.toolCallsP90)} | ${cell(s.discoveryMedian)} (${cell(s.discoveryP90)}) | ${cell(s.resultBytesP95)} | ${cell(s.wallSMedian)} | ${s.inputTokens} | ${s.cacheReadTokens} |`,
      );
    }
    lines.push("");
  }
  if (duplicates) lines.push(`_${duplicates} duplicate run_id row(s) replaced by their last occurrence (a replay or re-import supersedes the earlier verdict)._`, "");
  if (stale.length) lines.push(`_${stale.length} row(s) with another bench_day (${distinct(stale, "bench_day").join(", ")}) ${gates.length ? "included via --allow-stale" : "rejected"}._`, "");
  if (gates.length) {
    lines.push("| Gate | Status | Value | Threshold | Detail |", "|---|---|---|---|---|");
    const gateValue = (g) => (["G1", "G2"].includes(g.gate) && typeof g.value === "number" ? fmtRate(g.value) : cell(g.value));
    for (const g of gates) lines.push(`| ${g.gate} | ${g.status} | ${gateValue(g)} | ${g.threshold} | ${g.detail} |`);
    lines.push("", anyFail(gates) ? "**Result: FAIL** — at least one gate failed." : "**Result: PASS** — no gate failed.");
  }
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------------------------
// Task order + export
// ---------------------------------------------------------------------------------------------

/** FNV-1a 32-bit of the seed's string form — a stable integer for any seed the tester types. */
export function hashSeed(seed) {
  let h = 0x811c9dc5;
  for (const ch of String(seed)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32: a tiny deterministic PRNG in [0, 1). */
export function prng(seed) {
  let a = hashSeed(seed);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates with the seeded PRNG: the same seed always yields the same order; the input is not modified. */
export function shuffle(taskIds, seed) {
  const out = [...list(taskIds)];
  const next = prng(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * CSV text of the rows without `notes` (the only free-text column) — what gets committed under
 * bench/results/. Values are the typed ones, so success already reflects wrong_mutation.
 */
export function exportNumeric(rows) {
  return serializeCsv(
    EXPORT_COLUMNS,
    list(rows).map((r) => EXPORT_COLUMNS.map((c) => (r[c] === null || r[c] === undefined ? "" : r[c]))),
  );
}
