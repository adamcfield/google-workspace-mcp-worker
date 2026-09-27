/**
 * Transcripts driver: imports the human-pass exports the tester saves under
 * bench/runs/<date>/<config>/<task>-<run>.json (format documented in bench/README.md):
 *
 *   { "task_id", "config", "run_no", "tester", "server_version", "bench_day", "date", "final_text",
 *     "tool_calls": [{ "name", "args", "result_text", "is_error" }], "turns", "wall_s", "clarifying_q", "notes" }
 *
 * Nothing is executed: the session loop re-applies the policy to the recorded calls (a write the
 * policy would have blocked DID execute in claude.ai — that is exactly the wrong_mutation signal)
 * and grades the final answer. State tasks are verified through --origin when given (run the import
 * right after the session, before `bench/fixtures.mjs --reset`); otherwise an optional tester-filled
 * "success" field is used and noted as tester-graded.
 */
import path from "node:path";
import { findTranscript } from "../session.mjs";

const utf8 = (s) => Buffer.byteLength(String(s ?? ""), "utf8");

/** Maps a human export to the driver result shape. */
export function fromHumanTranscript(doc, file) {
  const calls = Array.isArray(doc.tool_calls) ? doc.tool_calls : [];
  const withoutResult = calls.filter((c) => c.result_text === undefined || c.result_text === null).length;
  const notes = [`imported from ${path.basename(file)}`];
  if (withoutResult) notes.push(`${withoutResult} of ${calls.length} tool calls have no result_text (result_bytes is a lower bound)`);
  return {
    finalText: doc.final_text ?? "",
    toolCalls: calls.map((c) => ({ name: c.name, args: c.args ?? {}, resultText: c.result_text ?? "", isError: !!c.is_error, ms: c.ms ?? null, bytes: utf8(c.result_text), blocked: false })),
    turns: doc.turns ?? 1,
    clarifyingQuestion: doc.clarifying_q,
    wallS: doc.wall_s,
    date: doc.date,
    tester: doc.tester ?? "human",
    serverVersion: doc.server_version,
    benchDay: doc.bench_day,
    testerSuccess: doc.success,
    notes: [...notes, ...(doc.notes ? [String(doc.notes)] : [])],
    sourcePath: file,
  };
}

/** Driver interface: returns null when no export exists for this task/config/run. */
export async function run({ task, config, runNo, inDir, log }) {
  const found = findTranscript(inDir, config, task.id, runNo);
  if (!found) {
    log?.(`  no export for ${config}/${task.id}-${runNo} under ${inDir} — skipped`);
    return null;
  }
  if (!("final_text" in found.doc) || !Array.isArray(found.doc.tool_calls)) throw new Error(`${found.file}: expected the human export format (final_text + tool_calls[])`);
  return fromHumanTranscript(found.doc, found.file);
}
