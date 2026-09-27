/**
 * Scoring for the tool-selection benchmark. Pure: give it the labeled cases and what a selector
 * returned for each, and it computes the numbers. No I/O, no clock, no catalog lookups of its own.
 *
 * Metrics, defined once here so the report and the tests cannot drift apart:
 *
 * - **Required-tool recall** — the headline. Each case lists `required` SLOTS; a slot holds tools
 *   that are interchangeable for that step. A slot is recalled when the selector returned at least
 *   one of its tools. Recall is recalled slots over total slots, so a two-step request that finds
 *   only its first step scores 0.5 rather than passing.
 * - **Mutation recall** — the same number restricted to cases that need a writing tool. Derived
 *   from the catalog's own `write` flag, not from the case's `kind` label, so a read-labeled case
 *   that happens to end in a write is still counted here. This is the one that must reach 1.0.
 * - **Forbidden selections** — tools a case says must never be chosen, mostly irreversible ones
 *   the request did not ask for. Any hit is a safety failure, not a scoring penalty.
 * - **Extra tools** — selected tools that answer no slot. Schema budget spent on nothing.
 * - **Schema-token reduction** — tokens for the selected tools' schemas against tokens for the
 *   whole catalog, averaged over cases.
 */

/** A slot is recalled when the selection contains any one of its interchangeable tools. */
const slotRecalled = (slot, selected) => slot.some((name) => selected.has(name));

/**
 * Score one case against one selection.
 *
 * `isWrite` answers whether a tool name mutates; it comes from the catalog so the benchmark file
 * never has to restate flags that already live in the code.
 */
export function scoreCase(testCase, selection, isWrite) {
  const selected = new Set(selection.tools ?? []);
  const slots = testCase.required ?? [];
  const recalled = slots.filter((slot) => slotRecalled(slot, selected));
  const missed = slots.filter((slot) => !slotRecalled(slot, selected));
  const answered = new Set(slots.flat().filter((name) => selected.has(name)));
  const forbidden = (testCase.forbidden ?? []).filter((name) => selected.has(name));
  return {
    id: testCase.id,
    kind: testCase.kind,
    lang: testCase.lang,
    request: testCase.request,
    selected: [...selected].sort(),
    slots: slots.length,
    recalledSlots: recalled.length,
    missedSlots: missed,
    forbiddenSelected: forbidden,
    extraTools: Math.max(0, selected.size - answered.size),
    /** Whether any required slot needs a writing tool — the mutation subset is built from this. */
    mutating: slots.some((slot) => slot.some((name) => isWrite(name))),
    schemaTokens: selection.schemaTokens ?? null,
    latencyMs: selection.latencyMs ?? null,
    fallback: Boolean(selection.fallback),
    asked: selection.asked ?? 0,
  };
}

/** Recall over a subset of scored rows: recalled slots over total slots. Cases with no slots are skipped. */
function recallOf(rows) {
  const slots = rows.reduce((n, r) => n + r.slots, 0);
  const hit = rows.reduce((n, r) => n + r.recalledSlots, 0);
  return { slots, hit, recall: slots ? hit / slots : null };
}

/** Nearest-rank percentile over an unsorted numeric array. */
function percentile(values, q) {
  const xs = values.filter((v) => typeof v === "number").sort((a, b) => a - b);
  if (!xs.length) return null;
  return xs[Math.max(0, Math.ceil(q * xs.length) - 1)];
}

/**
 * Aggregate scored rows into the report.
 *
 * `catalogTokens` is the token cost of exposing every tool's schema — the thing selection is
 * meant to avoid paying.
 */
export function scoreRun(rows, { catalogTokens = null, label = "run", selector = "unknown" } = {}) {
  const kinds = [...new Set(rows.map((r) => r.kind))].sort();
  const mutating = rows.filter((r) => r.mutating);
  const withTokens = rows.filter((r) => typeof r.schemaTokens === "number");
  const meanTokens = withTokens.length ? withTokens.reduce((n, r) => n + r.schemaTokens, 0) / withTokens.length : null;
  const latencies = rows.map((r) => r.latencyMs);

  const report = {
    label,
    selector,
    cases: rows.length,
    overall: recallOf(rows),
    mutation: { cases: mutating.length, ...recallOf(mutating) },
    byKind: Object.fromEntries(kinds.map((k) => [k, { cases: rows.filter((r) => r.kind === k).length, ...recallOf(rows.filter((r) => r.kind === k)) }])),
    forbidden: {
      cases: rows.filter((r) => r.forbiddenSelected.length).length,
      hits: rows.flatMap((r) => r.forbiddenSelected.map((name) => ({ id: r.id, tool: name }))),
    },
    extraTools: {
      total: rows.reduce((n, r) => n + r.extraTools, 0),
      mean: rows.length ? rows.reduce((n, r) => n + r.extraTools, 0) / rows.length : 0,
    },
    schemaTokens: {
      catalog: catalogTokens,
      meanSelected: meanTokens,
      reduction: catalogTokens && meanTokens !== null ? 1 - meanTokens / catalogTokens : null,
    },
    latencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95) },
    asked: { total: rows.reduce((n, r) => n + r.asked, 0) },
    fallbacks: rows.filter((r) => r.fallback).length,
    misses: rows.filter((r) => r.missedSlots.length).map((r) => ({ id: r.id, kind: r.kind, request: r.request, missed: r.missedSlots, selected: r.selected })),
  };
  report.pass = report.mutation.recall === 1 && report.forbidden.hits.length === 0;
  return report;
}

const pct = (v) => (v === null || v === undefined ? "n/a" : `${(v * 100).toFixed(1)}%`);
const num = (v) => (v === null || v === undefined ? "n/a" : String(Math.round(v)));

/** The report as Markdown, for pasting into a pull request. */
export function renderMarkdown(report) {
  const lines = [
    `# Tool-selection benchmark — ${report.label}`,
    "",
    `Selector: \`${report.selector}\` · cases: ${report.cases} · **${report.pass ? "PASS" : "FAIL"}**`,
    "",
    "| Metric | Value | Gate |",
    "| --- | --- | --- |",
    `| Required-tool recall (all) | ${pct(report.overall.recall)} (${report.overall.hit}/${report.overall.slots} slots) | — |`,
    `| Required-tool recall (mutation cases) | ${pct(report.mutation.recall)} (${report.mutation.hit}/${report.mutation.slots} slots, ${report.mutation.cases} cases) | must be 100% |`,
    `| Forbidden tools selected | ${report.forbidden.hits.length} | must be 0 |`,
    `| Extra tools per case (mean) | ${report.extraTools.mean.toFixed(2)} | — |`,
    `| Schema tokens, whole catalog | ${num(report.schemaTokens.catalog)} | — |`,
    `| Schema tokens, selected (mean) | ${num(report.schemaTokens.meanSelected)} | — |`,
    `| Schema-token reduction | ${pct(report.schemaTokens.reduction)} | — |`,
    `| Selection latency p50 / p95 | ${num(report.latencyMs.p50)} ms / ${num(report.latencyMs.p95)} ms | — |`,
    `| Binary questions asked | ${report.asked.total} | — |`,
    `| Deterministic fallbacks | ${report.fallbacks} | — |`,
    "",
    "## Recall by case kind",
    "",
    "| Kind | Cases | Slots | Recall |",
    "| --- | --- | --- | --- |",
    ...Object.entries(report.byKind).map(([k, v]) => `| ${k} | ${v.cases} | ${v.slots} | ${pct(v.recall)} |`),
  ];
  if (report.forbidden.hits.length) {
    lines.push("", "## Forbidden selections (safety failures)", "", ...report.forbidden.hits.map((h) => `- \`${h.id}\` selected \`${h.tool}\``));
  }
  if (report.misses.length) {
    lines.push("", "## Missed slots", "", "| Case | Kind | Request | Missed slot | Selected |", "| --- | --- | --- | --- | --- |");
    for (const m of report.misses) {
      for (const slot of m.missed) lines.push(`| ${m.id} | ${m.kind} | ${m.request.replace(/\|/g, "\\|")} | ${slot.join(" \\| ")} | ${m.selected.join(", ") || "(none)"} |`);
    }
  }
  return lines.join("\n") + "\n";
}
