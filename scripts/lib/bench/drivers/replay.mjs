/**
 * Replay driver: re-scores transcripts this harness recorded (format "bench-run/1", written by
 * scripts/lib/bench/session.mjs under --out) without a model or any network. Tool calls, final
 * answer and the recorded state verification are handed back to the session loop,
 * which re-applies the current policy and grader — so a policy or rubric fix re-grades every
 * recorded run in seconds.
 */
import path from "node:path";
import { findTranscript } from "../session.mjs";

const utf8 = (s) => Buffer.byteLength(String(s ?? ""), "utf8");

/** Maps a harness transcript to the driver result shape. */
export function fromHarnessTranscript(doc, file) {
  const calls = Array.isArray(doc.tool_calls) ? doc.tool_calls : [];
  return {
    finalText: doc.final_text ?? "",
    toolCalls: calls.map((c) => ({ name: c.name, args: c.args ?? {}, resultText: c.result_text ?? "", isError: !!c.is_error, ms: c.ms ?? null, bytes: Number.isFinite(c.bytes) ? c.bytes : utf8(c.result_text), blocked: !!c.blocked })),
    turns: doc.turns ?? 1,
    clarifyingQuestion: doc.clarifying_question ?? doc.clarifying_q,
    wallS: doc.wall_s,
    date: doc.date,
    runId: doc.run_id,
    tester: doc.tester,
    serverVersion: doc.server_version,
    benchDay: doc.bench_day,
    commit: doc.commit,
    verify: doc.grade?.verify,
    system: doc.system,
    prompt: doc.prompt,
    lang: doc.lang,
    toolsPresented: doc.tools_presented,
    notes: [`replayed from ${path.basename(file)}`],
    sourcePath: file,
  };
}

/** Driver interface: returns null when no transcript exists for this task/config/run. */
export async function run({ task, config, runNo, inDir, log }) {
  const found = findTranscript(inDir, config, task.id, runNo);
  if (!found) {
    log?.(`  no transcript for ${config}/${task.id}-${runNo} under ${inDir} — skipped`);
    return null;
  }
  if (!String(found.doc.format ?? "").startsWith("bench-run/")) {
    if ("final_text" in found.doc) throw new Error(`${found.file} is a human transcript export — use --driver transcripts`);
    throw new Error(`${found.file} is not a bench-run transcript (missing "format")`);
  }
  return fromHarnessTranscript(found.doc, found.file);
}
