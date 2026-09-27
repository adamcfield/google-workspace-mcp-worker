#!/usr/bin/env node
/**
 * Benchmark harness: re-scores recorded bench/tasks.json sessions
 * per config and driver, applies the execution policy to every recorded call, grades each session and
 * emits one CSV row per session (bench/results-template.csv columns) to stdout and to a file under
 * --out, plus a local transcript under <out>/<config>/<task>-<run>.json. Both drivers are
 * file-backed: they keep the recorded run_ids and write a fresh <out>/<config>.rescored.csv, so a
 * re-score never doubles the rows of the tester's <out>/<config>.csv (bench/score.mjs also
 * collapses rows sharing a run_id).
 *
 *   node scripts/bench-run.mjs --driver replay --config A --in bench/runs/2026-09-29/     # re-score, no network
 *   node scripts/bench-run.mjs --driver transcripts --config B --in bench/runs/2026-09-29/ \
 *        --origin https://google-workspace-mcp.<sub>.workers.dev                          # import human exports
 *
 * Drivers: replay (harness transcripts, no model, no network) and transcripts (human-pass exports).
 * No driver runs a model: zero model API use — no key, no SDK, anywhere in this repository.
 * MCP_TOKEN in the environment authenticates against the bearer worker's /mcp, used only to verify
 * sandbox state. The harness writes only under --out.
 */
import { execSync } from "node:child_process";
import fs, { realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createMcpHttpClient } from "./lib/mcp-http.mjs";
import { CSV_COLUMNS, appendCsvRow, compactListFrom, rowsFile, runSession, startRowsFile, toCsvLine } from "./lib/bench/session.mjs";

export const DRIVERS = ["replay", "transcripts"];
export const CONFIGS = ["A", "B", "C"];

export const USAGE = `Usage: node scripts/bench-run.mjs --driver replay|transcripts [options]

  --driver <name>       replay       re-score transcripts this harness recorded (no model, no network)
                        transcripts  import human-pass exports (format in bench/README.md)
                        (no driver runs a model)
  --config A|B|C        tool surface the session was run against [A]
                        A = every tool, B = gmail,calendar,drive,docs,sheets,tasks + meta, C = bench/configs.json
  --tasks T01,T05       task ids from bench/tasks.json [all]
  --runs <n>            sessions per task [1]
  --origin <url>        bearer worker origin (MCP_TOKEN in the environment), optional: verifies the
                        sandbox state of imported human runs and of replayed runs whose transcript
                        recorded no verify (run it BEFORE the fixture reset — a replay whose
                        transcript carries a verify reuses it and never re-reads)
  --fixtures <file>     ids + benchDay written by bench/fixtures.mjs [bench/fixtures.local.json]
  --out <dir>           the ONLY directory this harness writes: transcripts + <config>.rescored.csv
                        (rewritten per invocation; the tester's <config>.csv is never touched) [bench/runs/<today>/]
  --in <dir>            where replay/transcripts read <config>/<task>-<run>.json from [--out]
  --lang en|he          prompt language [en]
  --tester <name>       tester column override [the transcript's tester]
  --tools-list <file>   tools/list JSON ({ tools: [...] }) for the offline policy when there is no --origin
                        [newest docs/measurements/*/tools-list.full.json]
  --bench-day <date>    benchDay override (YYYY-MM-DD) [from --fixtures]
  --commit <sha>        commit column [git rev-parse --short HEAD]
  --tasks-file <file>   [bench/tasks.json]
  --aliases <file>      old→new tool names for first-tool scoring [bench/tool-aliases.json]
  --configs-file <file> compact list for config C [bench/configs.json]
  -h, --help

Output: the CSV header once, then one CSV row per session on stdout; the same rows go to
<out>/<config>.rescored.csv (truncated at the start of the invocation — the tester's <config>.csv is
never touched; run_ids are kept, so bench/score.mjs keeps the last row per run_id when both files
are passed). Progress goes to stderr.
Transcripts contain sandbox data and stay local (bench/runs/ is gitignored).`;

/** Parses argv; unknown flags are errors. */
export function parseArgs(argv) {
  const o = { driver: undefined, config: "A", tasks: [], runs: 1, origin: undefined, fixtures: "bench/fixtures.local.json", out: undefined, in: undefined, lang: "en", tester: undefined, toolsList: undefined, benchDay: undefined, commit: undefined, tasksFile: "bench/tasks.json", aliasesFile: "bench/tool-aliases.json", configsFile: "bench/configs.json", help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.startsWith("--") ? a.indexOf("=") : -1;
    const flag = eq > 0 ? a.slice(0, eq) : a;
    const value = () => {
      const v = eq > 0 ? a.slice(eq + 1) : argv[++i];
      if (v === undefined) throw new Error(`${flag} needs a value`);
      return v;
    };
    switch (flag) {
      case "--driver": o.driver = value(); break;
      case "--config": o.config = value().toUpperCase(); break;
      case "--tasks": o.tasks = value().split(",").map((s) => s.trim()).filter(Boolean); break;
      case "--runs": o.runs = Number(value()); break;
      case "--origin": o.origin = value(); break;
      case "--fixtures": o.fixtures = value(); break;
      case "--out": o.out = value(); break;
      case "--in": o.in = value(); break;
      case "--lang": o.lang = value(); break;
      case "--tester": o.tester = value(); break;
      case "--tools-list": o.toolsList = value(); break;
      case "--bench-day": o.benchDay = value(); break;
      case "--commit": o.commit = value(); break;
      case "--tasks-file": o.tasksFile = value(); break;
      case "--aliases": o.aliasesFile = value(); break;
      case "--configs-file": o.configsFile = value(); break;
      case "-h":
      case "--help": o.help = true; break;
      default:
        if (/^https?:\/\//.test(a)) o.origin = a;
        else throw new Error(`unknown argument ${a}`);
    }
  }
  if (o.help) return o;
  if (!DRIVERS.includes(o.driver)) throw new Error(`--driver must be one of ${DRIVERS.join("|")}`);
  if (!CONFIGS.includes(o.config)) throw new Error(`--config must be one of ${CONFIGS.join("|")}`);
  if (!Number.isInteger(o.runs) || o.runs < 1) throw new Error("--runs must be a positive integer");
  if (!["en", "he"].includes(o.lang)) throw new Error("--lang must be en or he");
  o.origin = o.origin?.replace(/\/mcp\/?$/, "").replace(/\/+$/, "");
  o.out = o.out ?? path.join("bench", "runs", new Date().toISOString().slice(0, 10));
  o.in = o.in ?? o.out;
  return o;
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const readJsonIfExists = (file) => (file && fs.existsSync(file) ? readJson(file) : undefined);

/** Fixture file → { ids, benchDay } (accepts { benchDay, ids: {...} } or a flat map). */
export function loadFixtures(doc) {
  if (!doc || typeof doc !== "object") return { ids: {}, benchDay: undefined };
  const { benchDay, ids, fixtures, ...rest } = doc;
  const map = ids ?? fixtures ?? rest;
  return { ids: { ...rest, ...(map && typeof map === "object" ? map : {}) }, benchDay };
}

/** The newest committed tools/list snapshot, for the offline policy. */
export function newestToolsListFile(root = "docs/measurements") {
  if (!fs.existsSync(root)) return undefined;
  const dirs = fs.readdirSync(root).filter((d) => fs.existsSync(path.join(root, d, "tools-list.full.json"))).sort();
  return dirs.length ? path.join(root, dirs[dirs.length - 1], "tools-list.full.json") : undefined;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`${e.message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (opts.help) {
    console.log(USAGE);
    return;
  }
  const log = (msg) => console.error(msg);
  const driver = await import(`./lib/bench/drivers/${opts.driver}.mjs`);

  if (!fs.existsSync(opts.tasksFile)) throw new Error(`${opts.tasksFile} not found`);
  const doc = readJson(opts.tasksFile);
  const all = (doc.tasks ?? []).map((t) => ({ discovery_tools: doc.discovery_tools, ...t }));
  const unknown = opts.tasks.filter((id) => !all.some((t) => t.id === id));
  if (unknown.length) throw new Error(`unknown task ids: ${unknown.join(", ")}`);
  const tasks = opts.tasks.length ? all.filter((t) => opts.tasks.includes(t.id)) : all;
  if (!tasks.length) throw new Error("no tasks selected");

  const { ids: fixtures, benchDay: fixtureDay } = loadFixtures(readJsonIfExists(opts.fixtures));
  const benchDay = opts.benchDay ?? fixtureDay;
  const aliasDoc = readJsonIfExists(opts.aliasesFile);
  const aliases = aliasDoc?.aliases ?? aliasDoc ?? {};
  const compact = opts.config === "C" ? compactListFrom(readJsonIfExists(opts.configsFile)) : undefined;
  const commit = opts.commit ?? (() => {
    try {
      return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    } catch {
      return "";
    }
  })();

  let client = null;
  let tools = [];
  let instructions = "";
  let serverVersion = "";
  if (opts.origin) {
    const token = process.env.MCP_TOKEN;
    if (!token) throw new Error("MCP_TOKEN is not set in the environment (the bearer worker's MCP_AUTH_TOKEN)");
    client = createMcpHttpClient({ origin: opts.origin, token, clientName: "gws-bench-run", clientVersion: "1" });
    const init = await client.initialize();
    instructions = init.instructions ?? "";
    serverVersion = init.serverInfo?.version ?? "";
    tools = await client.listTools();
    log(`connected to ${opts.origin} (server ${serverVersion}, ${tools.length} tools)`);
  } else {
    const file = opts.toolsList ?? newestToolsListFile();
    if (file) {
      tools = readJson(file).tools ?? [];
      log(`offline: read-only set from ${file} (${tools.length} tools)`);
    } else log("offline: no tools/list available — every non-hard-denied call counts as allow-listed only if the task lists it");
  }

  fs.mkdirSync(opts.out, { recursive: true });
  const csvFile = rowsFile(opts.out, opts.config);
  startRowsFile(csvFile);
  log(`rows → ${csvFile} (fresh; ${opts.config}.csv is not modified)`);
  const shared = { driver, driverName: opts.driver, config: opts.config, client, tools, instructions, fixtures, benchDay, serverVersion, commit, out: opts.out, inDir: opts.in, tester: opts.tester, lang: opts.lang, aliases, compact, log };
  const totals = { sessions: 0, success: 0, wrongMutation: 0, skipped: 0, errors: 0 };
  process.stdout.write(CSV_COLUMNS.join(",") + "\n");
  for (const task of tasks) {
    for (let runNo = 1; runNo <= opts.runs; runNo++) {
      log(`▶ ${opts.config} ${task.id} run ${runNo} (${task.category})`);
      const session = await runSession({ ...shared, task, runNo });
      if (!session) {
        totals.skipped++;
        continue;
      }
      const { row } = session;
      process.stdout.write(toCsvLine(row) + "\n");
      appendCsvRow(csvFile, row);
      totals.sessions++;
      totals.success += row.success;
      totals.wrongMutation += row.wrong_mutation;
      if (/driver error/.test(row.notes)) totals.errors++;
      log(`  ${row.success ? "PASS" : "FAIL"} first=${row.first_tool || "-"}${row.first_tool_ok ? "" : " (not expected)"} calls=${row.tool_calls} bytes=${row.result_bytes}${row.wrong_mutation ? " WRONG MUTATION" : ""}${row.notes ? `  ${row.notes}` : ""}`);
    }
  }
  log(`${totals.sessions} sessions → ${totals.success} pass, ${totals.wrongMutation} wrong mutations, ${totals.errors} driver errors, ${totals.skipped} skipped; rows in ${csvFile}`);
  if (totals.errors) process.exitCode = 1;
}

const isMain = (() => {
  try {
    return !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();
if (isMain) {
  try {
    await main();
  } catch (e) {
    console.error(`bench-run: ${e.message}`);
    process.exit(1);
  }
}
