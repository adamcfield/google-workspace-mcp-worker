/**
 * One benchmark session = one task × one run, shared by every driver of scripts/bench-run.mjs:
 * filters the tool surface per config (first_tool scoring), applies the execution policy
 * (policy.mjs) to every recorded tool call, writes the transcript, grades the outcome (grade.mjs,
 * state tasks via a read-only verify call) and assembles the CSV row in the documented column
 * order. No driver runs a model: the calls come from a human-pass export or a
 * previously written harness transcript, so nothing is executed against the sandbox except the
 * read-only verify.
 *
 * Transcripts are written only under the harness's --out directory and never leave the machine:
 * they contain sandbox data. The harness transcript is a superset of the human export format
 * documented in bench/README.md (same snake_case keys + format/policy/grade), so the same file
 * feeds `--driver replay` and, for tester exports, `--driver transcripts`.
 */
import fs from "node:fs";
import path from "node:path";
import { readOnlyToolNames } from "../mcp-http.mjs";
import { allowExecute, DISCOVERY_TOOLS } from "./policy.mjs";
import { gradeSession, gradeState, resolvePlaceholders, shiftDate } from "./grade.mjs";
import { CSV_COLUMNS } from "./gates.mjs";

/** bench/results-template.csv header — exact order (the one definition lives in gates.mjs). */
export { CSV_COLUMNS };

/** Config B = the six core groups + meta, filtered client-side by name prefix. */
export const CONFIG_B_PREFIXES = ["google_", "gmail_", "calendar_", "drive_", "docs_", "sheets_", "tasks_"];
export const TRANSCRIPT_FORMAT = "bench-run/1";
/** Every driver reads recorded sessions (no driver runs a model). */
export const DRIVER_NAMES = ["replay", "transcripts"];

const list = (v) => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);
const utf8 = (s) => Buffer.byteLength(String(s ?? ""), "utf8");

/**
 * The tools presented to the model for a config: A = all, B = CONFIG_B_PREFIXES, C = `compact`
 * (names from bench/configs.json) when given, else the full list with a note.
 */
export function toolsForConfig(tools, config, { compact } = {}) {
  if (config === "B") return { tools: tools.filter((t) => CONFIG_B_PREFIXES.some((p) => t.name.startsWith(p))), note: "" };
  if (config === "C") {
    if (!compact?.length) return { tools, note: "config C = full surface (bench/configs.json has no compact list yet)" };
    const wanted = new Set(compact);
    const kept = tools.filter((t) => wanted.has(t.name));
    const missing = compact.filter((n) => !tools.some((t) => t.name === n));
    return { tools: kept, note: missing.length ? `config C: ${missing.length} compact names absent from the server (${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ", …" : ""})` : "" };
  }
  return { tools, note: "" };
}

/** Reads bench/configs.json's compact list for C (either { C: [names] } or { C: { tools: [names] } } or { compact: [...] }). */
export function compactListFrom(doc) {
  const c = doc?.C ?? doc?.c ?? doc?.compact;
  const names = Array.isArray(c) ? c : Array.isArray(c?.tools) ? c.tools : [];
  return names.filter((n) => typeof n === "string");
}

/** The system prompt of a session: the server's MCP instructions + the benchmark date line. */
export function buildSystem(instructions, benchDay) {
  const today = benchDay ? shiftDate(benchDay, -1) : undefined;
  return [String(instructions ?? "").trim(), today ? `Today is ${today} (Asia/Jerusalem).` : ""].filter(Boolean).join("\n\n");
}

/**
 * first_tool / first_tool_ok / tool_calls / discovery_calls / retries / result_bytes from the call
 * list. A session without any non-discovery call scores first_tool_ok only when the task says
 * `no_tool_call_ok` (T19: the correct "no Admin SDK tool" answer needs no call).
 */
export function summarizeCalls(calls, task, { aliases = {}, discoveryTools } = {}) {
  const canon = (n) => aliases[n] ?? n;
  const discovery = new Set((discoveryTools ?? task?.discovery_tools ?? DISCOVERY_TOOLS).map(canon));
  const expected = new Set(list(task?.expected_first_tools).map(canon));
  const first = calls.find((c) => !discovery.has(canon(c.name)));
  let retries = 0;
  for (let i = 1; i < calls.length; i++) if (calls[i].name === calls[i - 1].name && calls[i - 1].isError) retries++;
  return {
    firstTool: first ? canon(first.name) : "",
    firstToolOk: first ? expected.has(canon(first.name)) : !!task?.no_tool_call_ok,
    toolCalls: calls.length,
    discoveryCalls: calls.filter((c) => discovery.has(canon(c.name))).length,
    retries,
    resultBytes: calls.reduce((n, c) => n + (Number.isFinite(c.bytes) ? c.bytes : utf8(c.resultText)), 0),
  };
}

/** CSV cell: quoted when it holds a comma, quote or line break; undefined/null → empty. */
export function csvEscape(v) {
  if (v === undefined || v === null) return "";
  const s = typeof v === "boolean" ? (v ? "1" : "0") : String(v).replace(/\r?\n/g, " ");
  return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export const toCsvLine = (row) => CSV_COLUMNS.map((c) => csvEscape(row[c])).join(",");

/** Appends one row to `file`, writing the header first when the file does not exist yet. */
export function appendCsvRow(file, row) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fresh = !fs.existsSync(file) || fs.statSync(file).size === 0;
  fs.appendFileSync(file, (fresh ? CSV_COLUMNS.join(",") + "\n" : "") + toCsvLine(row) + "\n");
}

/**
 * The CSV file a harness run writes its rows to: <out>/<config>.rescored.csv. The tester's own
 * <out>/<config>.csv (rows recorded per bench/results-template.csv) is never written by the harness.
 */
export function rowsFile(out, config) {
  return path.join(out, `${config}.rescored.csv`);
}

/**
 * Prepares the rows file: the rescored file is truncated to the header so one invocation = one
 * clean set of rows (the same run_ids as the tester's file — bench/score.mjs keeps the last row per
 * run_id).
 */
export function startRowsFile(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, CSV_COLUMNS.join(",") + "\n");
}

export const transcriptPath = (dir, config, taskId, runNo) => path.join(dir, config, `${taskId}-${runNo}.json`);

/**
 * Finds a transcript for task/config/run under `dir`: the canonical <dir>/<config>/<task>-<run>.json,
 * else any *.json in <dir> or <dir>/<config> whose task_id/config/run_no match. Returns { file, doc } or null.
 */
export function findTranscript(dir, config, taskId, runNo) {
  const canonical = transcriptPath(dir, config, taskId, runNo);
  const read = (file) => {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return null;
    }
  };
  if (fs.existsSync(canonical)) {
    const doc = read(canonical);
    if (doc) return { file: canonical, doc };
  }
  for (const d of [dir, path.join(dir, config)]) {
    if (!fs.existsSync(d) || !fs.statSync(d).isDirectory()) continue;
    for (const name of fs.readdirSync(d).filter((n) => n.endsWith(".json")).sort()) {
      const file = path.join(d, name);
      const doc = read(file);
      if (doc && doc.task_id === taskId && (doc.config ?? config) === config && Number(doc.run_no ?? 1) === Number(runNo)) return { file, doc };
    }
  }
  return null;
}

/**
 * The verify specs of a task, in execution order: ground_truth.verify for state tasks (falling back
 * to mutation.verify), mutation.verify for every other task that carries a mutation object, then
 * mutation.verify_also. Every one of them must pass.
 */
export function verifySpecs(task) {
  const gt = task?.ground_truth ?? {};
  const m = task?.mutation && typeof task.mutation === "object" ? task.mutation : null;
  const primary = gt.type === "state" ? list(gt.verify ?? m?.verify) : list(m?.verify);
  return [...primary, ...list(m?.verify_also)];
}

/** Runs every verify spec through the MCP client; each result = { ok, reason, tool, args, checks }. */
export async function verifyState(client, specs, ctx) {
  const out = [];
  for (const spec of list(specs)) {
    if (!spec?.tool) {
      out.push({ ok: false, reason: "verify spec has no tool" });
      continue;
    }
    const args = resolvePlaceholders(spec.args ?? {}, ctx);
    try {
      const r = await client.callTool(spec.tool, args);
      if (r.isError) out.push({ ok: false, reason: `${spec.tool} failed: ${String(r.text).slice(0, 200)}`, tool: spec.tool, args });
      else {
        const g = gradeState(r.data, spec.expect);
        out.push({ ok: g.ok, reason: g.reason, tool: spec.tool, args, checks: g.checks.map((c) => ({ path: c.path, ok: c.ok, reason: c.reason })) });
      }
    } catch (e) {
      out.push({ ok: false, reason: `${spec.tool} threw: ${e.message}`, tool: spec.tool, args });
    }
  }
  return out;
}

const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, "").slice(0, 15);

/**
 * Runs one session and returns { row, transcript, file } (or null when the driver has no transcript
 * for this cell). See the module comment for what goes where.
 *
 * @param {object} o
 * @param {{ run: Function }} o.driver          driver module (replay | transcripts)
 * @param {string} o.driverName
 * @param {object} o.task                        a bench/tasks.json task (placeholders unresolved)
 * @param {"A"|"B"|"C"} o.config
 * @param {number} o.runNo
 * @param {object|null} o.client                 createMcpHttpClient() — optional, used only for state verification
 * @param {object[]} o.tools                     the server's full tools/list (policy + config filtering)
 * @param {string} o.instructions                the server's MCP instructions (initialize result)
 * @param {object} o.fixtures                    fixture ids ($fixtures.<key>)
 * @param {string} o.benchDay                    YYYY-MM-DD
 * @param {string} o.serverVersion
 * @param {string} o.commit
 * @param {string} o.out                         the only directory written to
 * @param {string} [o.inDir]                     where file-backed drivers read from (default out)
 * @param {string} [o.tester]                    tester column override
 * @param {"en"|"he"} [o.lang]
 * @param {Record<string,string>} [o.aliases]    old→new tool names for first-tool scoring and forbidden-tool grading
 * @param {string[]} [o.compact]                 config C tool names
 * @param {(msg: string) => void} [o.log]        progress sink (stderr)
 */
export async function runSession(o) {
  const log = o.log ?? (() => {});
  const missing = [];
  const task = resolvePlaceholders(o.task, { fixtures: o.fixtures ?? {}, benchDay: o.benchDay, strict: false, missing });
  const discoveryTools = list(task.discovery_tools ?? DISCOVERY_TOOLS);
  const readOnlySet = readOnlyToolNames(o.tools ?? []);
  const writeSet = new Set((o.tools ?? []).filter((t) => !readOnlySet.has(t.name)).map((t) => t.name));
  const { tools: modelTools, note: configNote } = toolsForConfig(o.tools ?? [], o.config, { compact: o.compact });
  const system = buildSystem(o.instructions, o.benchDay);
  const prompt = (o.lang === "he" ? task.prompt_he : task.prompt_en) ?? task.prompt_en ?? task.prompt ?? "";
  const policyFor = (call) => allowExecute(call, task, readOnlySet, { writeSet, discoveryTools });

  const t0 = Date.now();
  let result;
  let error;
  try {
    result = await o.driver.run({ task, tools: modelTools, system, prompt, config: o.config, runNo: o.runNo, inDir: o.inDir ?? o.out, log });
  } catch (e) {
    error = e;
    result = { finalText: "", toolCalls: [] };
  }
  if (result === null) return null; // nothing recorded for this cell
  const wallS = Number.isFinite(result.wallS) ? result.wallS : Math.round((Date.now() - t0) / 100) / 10;

  // The policy is re-applied to every recorded call: a call it would not have permitted is
  // marked blocked/wrong_mutation even though the human session did execute it.
  const calls = list(result.toolCalls).map((c) => {
    const call = { name: String(c.name ?? ""), args: c.args && typeof c.args === "object" ? c.args : {} };
    const decision = policyFor(call);
    const resultText = c.resultText ?? c.result_text ?? "";
    const blocked = c.blocked ?? !decision.execute;
    log(`  ${blocked ? "BLOCK" : c.isError ?? c.is_error ? "err  " : "ok   "} ${call.name} ${JSON.stringify(call.args).slice(0, 120)}${decision.wrongMutation ? "  WRONG MUTATION" : ""}`);
    return { ...call, resultText, isError: !!(c.isError ?? c.is_error), ms: c.ms ?? null, bytes: Number.isFinite(c.bytes) ? c.bytes : utf8(resultText), blocked, wrongMutation: decision.wrongMutation, policy: decision.reason };
  });

  // Verification: a transcript that recorded one (replay of a harness run) is reused as is — the
  // sandbox was reset right after that session, so re-reading it now would grade a clean sandbox.
  // Otherwise (human import, transcript without a verify) the specs run on the sandbox
  // now, before any reset: state tasks run ground_truth.verify (else mutation.verify); every task
  // with a mutation object also runs mutation.verify (behavior tasks such as T20) and
  // mutation.verify_also — all must pass.
  const gt = task.ground_truth ?? {};
  const specs = verifySpecs(task);
  let verify;
  const notes = [configNote, ...list(result.notes)];
  const recordedVerify = list(result.verify);
  if (specs.length) {
    if (recordedVerify.length) {
      verify = recordedVerify;
      if (o.client) notes.push("verify taken from the transcript (not re-run against the sandbox)");
    } else if (o.client) verify = await verifyState(o.client, specs, { fixtures: o.fixtures ?? {}, benchDay: o.benchDay, strict: false, missing });
    else if (gt.type === "state" && result.testerSuccess !== undefined) {
      verify = [{ ok: Number(result.testerSuccess) === 1, reason: "tester-graded (no verify call)" }];
      notes.push("state graded by the tester, not re-verified");
    } else notes.push(`${gt.type === "state" ? "state" : "mutation"} not verified (no --origin and no recorded verify)`);
  } else if (gt.type === "state") notes.push("state not verified (no verify spec)");
  const grade = gradeSession(task, { finalText: result.finalText ?? "", toolCalls: calls, verify, aliases: o.aliases ?? {} });
  const m = summarizeCalls(calls, task, { aliases: o.aliases ?? {}, discoveryTools });
  if (error) notes.push(`driver error: ${error.message}`);
  if (missing.length) notes.push(`unresolved placeholders: ${[...new Set(missing)].join(" ")}`);
  if (grade.humanReview) notes.push("human review pending");
  if (!grade.success) notes.push(...grade.reasons);
  const noteText = [...new Set(notes.filter(Boolean))].join("; ");

  const date = result.date ?? new Date().toISOString().slice(0, 10);
  const row = {
    run_id: result.runId ?? `${o.driverName}-${o.config}-${task.id}-r${o.runNo}-${stamp()}`,
    date,
    server_version: result.serverVersion ?? o.serverVersion ?? "",
    commit: result.commit ?? o.commit ?? "",
    config: o.config,
    task_id: task.id,
    category: task.category ?? "",
    run_no: o.runNo,
    tester: o.tester ?? result.tester ?? "human",
    bench_day: result.benchDay ?? o.benchDay ?? "",
    success: grade.success,
    wrong_mutation: grade.wrongMutation,
    first_tool: m.firstTool,
    first_tool_ok: m.firstToolOk ? 1 : 0,
    tool_calls: m.toolCalls,
    discovery_calls: m.discoveryCalls,
    retries: m.retries,
    turns: Number.isFinite(Number(result.turns)) ? Number(result.turns) : 1,
    wall_s: wallS,
    result_bytes: m.resultBytes,
    input_tokens: "", // template columns kept for the CSV contract; no driver runs a model
    cache_read_tokens: "",
    output_tokens: "",
    clarifying_q: result.clarifyingQuestion ? (Number.isFinite(Number(result.clarifyingQuestion)) ? Number(result.clarifyingQuestion) : 1) : 0,
    notes: noteText,
  };

  const transcript = {
    format: TRANSCRIPT_FORMAT,
    ...Object.fromEntries(["run_id", "date", "server_version", "commit", "config", "task_id", "category", "run_no", "tester", "bench_day"].map((k) => [k, row[k]])),
    driver: o.driverName,
    lang: result.lang ?? o.lang ?? "en",
    system: result.system ?? system,
    prompt: result.prompt ?? prompt,
    tools_presented: result.toolsPresented ?? modelTools.length,
    final_text: result.finalText ?? "",
    tool_calls: calls.map((c) => ({ name: c.name, args: c.args, result_text: c.resultText, is_error: c.isError, ms: c.ms, bytes: c.bytes, blocked: c.blocked, wrong_mutation: c.wrongMutation, policy: c.policy })),
    turns: row.turns,
    wall_s: wallS,
    clarifying_q: row.clarifying_q,
    clarifying_question: typeof result.clarifyingQuestion === "string" ? result.clarifyingQuestion : undefined,
    grade: { success: grade.success, wrong_mutation: grade.wrongMutation, human_review_pending: grade.humanReview || undefined, reasons: grade.reasons, verify },
    notes: noteText,
  };

  // Never write outside --out; never overwrite the file a replay/transcript run was read from.
  const target = transcriptPath(o.out, o.config, task.id, o.runNo);
  const source = result.sourcePath ? path.resolve(result.sourcePath) : null;
  let file = null;
  if (source !== path.resolve(target)) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(transcript, null, 1) + "\n");
    file = target;
  }
  return { row, transcript, file };
}
