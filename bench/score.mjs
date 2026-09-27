#!/usr/bin/env node
/**
 * Scores benchmark run rows (bench/results-template.csv columns) against the release gates
 * G1–G8 (bench/README.md). The math lives in scripts/lib/bench/gates.mjs; this file is argv + files.
 * No network, no model, no Google — safe in CI on committed numeric exports.
 *
 *   node bench/score.mjs <runs.csv...> [--before before.csv] [--bench-day 2026-09-29] [--allow-stale]
 *        [--after-version 1.5.0] [--tokens compact=<n>,full=<n>] [--export out.csv] [--json]
 *   node bench/score.mjs --shuffle <seed>          # deterministic task order for a human pass (no CSV needed)
 *
 * Rows with wrong_mutation=1 score success=0. Rows sharing a run_id (a replay or a re-import of
 * the same session, across all the given files) count once — the last one wins, so pass the
 * re-scored file last. Rows whose bench_day ≠ --bench-day are rejected (exit 2) unless
 * --allow-stale. Prints a markdown summary per config + the gate table (--json: the same as JSON)
 * and exits 1 on any FAIL. --export writes the rows without `notes` (the only free-text column) —
 * the form that is committed under bench/results/.
 */
import fs, { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { anyFail, dedupeRows, evaluateGates, exportNumeric, loadRows, renderMarkdown, shuffle, summarize } from "../scripts/lib/bench/gates.mjs";

export const USAGE = `Usage:
  node bench/score.mjs <runs.csv...> [options]
  node bench/score.mjs --shuffle <seed> [--tasks bench/tasks.json]

Options:
  --before <before.csv>       "before" rows (config A on 1.4.4) for gate G6; may repeat
  --bench-day <YYYY-MM-DD>    reject rows recorded against another fixture week (exit 2)
  --allow-stale               keep those rows instead (they are listed in the summary)
  --after-version <v>         rows of this server_version form the "after" pass (G3, G7); default: every row
  --tokens compact=<n>,full=<n>
                              upfront tool tokens per surface (docs/measurements) — enables gate G4
  --export <out.csv>          write the rows without notes (numeric export for bench/results/)
  --shuffle <seed>            print a deterministic task order for the human pass and exit
  --tasks <tasks.json>        task list for --shuffle [bench/tasks.json]
  --json                      print { benchDay, afterVersion, tokens, sessions, stale: <count>, duplicates: <count>,
                              summaries (incl. "before <config>" rows), gates, exported } as JSON instead of markdown
  -h, --help                  this text

Exit codes: 0 no gate failed · 1 a gate FAILed · 2 usage error or stale rows without --allow-stale.
`;

/** Parses argv into options; throws on unknown flags or missing values. */
export function parseArgs(argv) {
  const o = { files: [], before: [], benchDay: undefined, allowStale: false, afterVersion: undefined, tokens: undefined, exportFile: undefined, shuffleSeed: undefined, tasksFile: "bench/tasks.json", json: false, help: false };
  const need = (i, name) => {
    if (argv[i + 1] === undefined) throw new Error(`${name} needs a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") o.help = true;
    else if (a === "--before") o.before.push(need(i++, a));
    else if (a === "--bench-day") o.benchDay = need(i++, a);
    else if (a === "--allow-stale") o.allowStale = true;
    else if (a === "--after-version") o.afterVersion = need(i++, a);
    else if (a === "--tokens") o.tokens = parseTokens(need(i++, a));
    else if (a === "--export") o.exportFile = need(i++, a);
    else if (a === "--shuffle") o.shuffleSeed = need(i++, a);
    else if (a === "--tasks") o.tasksFile = need(i++, a);
    else if (a === "--json") o.json = true;
    else if (a.startsWith("--")) throw new Error(`unknown flag ${a}`);
    else o.files.push(a);
  }
  if (o.benchDay !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(o.benchDay)) throw new Error(`--bench-day must be YYYY-MM-DD (got ${o.benchDay})`);
  return o;
}

/** "compact=8200,full=44000" → { compact: 8200, full: 44000 }. */
export function parseTokens(spec) {
  const out = {};
  for (const part of String(spec).split(",")) {
    const [k, v] = part.split("=");
    if (!["compact", "full"].includes(k) || !/^\d+$/.test(v ?? "")) throw new Error(`--tokens expects compact=<n>,full=<n> (got ${spec})`);
    out[k] = Number(v);
  }
  if (out.compact === undefined || out.full === undefined) throw new Error(`--tokens expects both compact=<n> and full=<n> (got ${spec})`);
  return out;
}

const readCsv = (file) => fs.readFileSync(file, "utf8");

/** The whole run: returns { exitCode, stdout } so tests can drive it without spawning. */
export function main(argv, { read = readCsv, write = fs.writeFileSync } = {}) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    return { exitCode: 2, stdout: `${e.message}\n\n${USAGE}` };
  }
  if (opts.help) return { exitCode: 0, stdout: USAGE };

  if (opts.shuffleSeed !== undefined) {
    const tasks = JSON.parse(read(opts.tasksFile));
    const ids = (tasks.tasks ?? []).map((t) => t.id);
    const order = shuffle(ids, opts.shuffleSeed);
    return { exitCode: 0, stdout: opts.json ? JSON.stringify({ seed: opts.shuffleSeed, order }, null, 2) + "\n" : `# task order for seed ${opts.shuffleSeed} (${ids.length} tasks)\n${order.join("\n")}\n` };
  }

  if (!opts.files.length) return { exitCode: 2, stdout: `no runs CSV given\n\n${USAGE}` };

  // Rows sharing a run_id count once (last wins): within a file (loadRows) and across files — a
  // <config>.rescored.csv passed after <config>.csv supersedes the original verdicts.
  const loaded = [];
  const stale = [];
  let duplicates = 0;
  for (const file of opts.files) {
    const r = loadRows(read(file), { benchDay: opts.benchDay, allowStale: opts.allowStale });
    loaded.push(...r.rows);
    stale.push(...r.stale);
    duplicates += r.duplicates;
  }
  const merged = dedupeRows(loaded);
  const rows = merged.rows;
  duplicates += merged.duplicates;
  if (stale.length && !opts.allowStale) {
    const days = [...new Set(stale.map((r) => r.bench_day))].join(", ");
    return { exitCode: 2, stdout: `${stale.length} row(s) carry bench_day ${days} ≠ --bench-day ${opts.benchDay}; rerun with --allow-stale to score them anyway\n` };
  }
  const before = opts.before.flatMap((file) => loadRows(read(file)).rows);

  const summaries = summarize(rows);
  const beforeSummaries = summarize(before).map((s) => ({ ...s, config: `before ${s.config}` }));
  const gates = evaluateGates({ rows, before, afterVersion: opts.afterVersion, tokens: opts.tokens });
  if (opts.exportFile) write(opts.exportFile, exportNumeric(rows));

  const exitCode = anyFail(gates) ? 1 : 0;
  if (opts.json) return { exitCode, stdout: JSON.stringify({ benchDay: opts.benchDay ?? null, afterVersion: opts.afterVersion ?? null, tokens: opts.tokens ?? null, sessions: rows.length, stale: stale.length, duplicates, summaries: [...summaries, ...beforeSummaries], gates, exported: opts.exportFile ?? null }, null, 2) + "\n" };
  const title = `Benchmark results — ${rows.length} session(s)${opts.afterVersion ? `, after-version ${opts.afterVersion}` : ""}${opts.benchDay ? `, bench_day ${opts.benchDay}` : ""}`;
  const md = renderMarkdown({ summaries: [...summaries, ...beforeSummaries], gates, stale, duplicates, title });
  return { exitCode, stdout: md + (opts.exportFile ? `\nNumeric export (no notes): ${opts.exportFile}\n` : "") };
}

const isMain = (() => {
  try {
    return !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  const { exitCode, stdout } = main(process.argv.slice(2));
  process.stdout.write(stdout);
  process.exit(exitCode);
}
