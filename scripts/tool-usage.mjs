#!/usr/bin/env node
/**
 * Calls per tool (and per client, once the access log carries one) from the workers'
 * structured access log — the evidence for which tools belong on the compact surface.
 *
 * Input: newline-delimited JSON on stdin or in the given files, in any of these shapes:
 *   - `wrangler tail --format json` events  ({ logs: [{ message: [ "<json line>" ] }], timestamp })
 *   - Logpush (Workers Trace Events) lines     ({ Logs: [{ Message: [ "<json line>" ] }], EventTimestampMs })
 *   - raw access-log lines                     ({ evt: "tool_call", tool, user, ms, ok, error?, client? })
 *
 *   wrangler tail -c wrangler.oauth.jsonc --format json > oauth.ndjson     # capture for a while
 *   node scripts/tool-usage.mjs oauth.ndjson bearer.ndjson [--since 2026-09-01] [--json]
 *
 * Prints a markdown table (calls, errors, rate-limited, p50 ms) per tool × client, busiest first.
 * Never prints user addresses; `user` is only counted as "distinct users".
 */
import fs, { realpathSync } from "node:fs";
import readline from "node:readline";
import { pathToFileURL } from "node:url";

/** Parses argv: positional files, `--since <date>` / `--since=<date>`, `--json`; unknown flags are errors. */
export function parseArgs(argv) {
  const files = [];
  let sinceArg;
  let asJson = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--since") {
      sinceArg = argv[++i];
      if (sinceArg === undefined) throw new Error("--since needs a date");
    } else if (a.startsWith("--since=")) sinceArg = a.slice("--since=".length);
    else if (a === "--json") asJson = true;
    else if (a.startsWith("--")) throw new Error(`unknown flag ${a}`);
    else files.push(a);
  }
  const since = sinceArg === undefined ? undefined : Date.parse(sinceArg);
  if (sinceArg !== undefined && Number.isNaN(since)) throw new Error(`--since: cannot parse ${sinceArg}`);
  return { files, since, asJson };
}

/** Pulls every access-log object out of one input line, whatever wrapper it came in. */
export function extractEvents(line) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return [];
  }
  return eventsIn(obj, timestampOf(obj));
}

/** Event time in epoch ms: wrangler tail (`eventTimestamp`), Logpush (`EventTimestampMs`), or a plain `timestamp`. */
function timestampOf(obj) {
  for (const v of [obj?.eventTimestamp, obj?.EventTimestampMs, obj?.timestamp, obj?.TimestampMs]) {
    if (typeof v === "number") return v;
    if (typeof v === "string" && !Number.isNaN(Date.parse(v))) return Date.parse(v);
  }
  return undefined;
}

function eventsIn(obj, ts) {
  if (!obj || typeof obj !== "object") return [];
  if (obj.evt === "tool_call" && typeof obj.tool === "string") return [{ ...obj, ts }];
  const out = [];
  const entries = obj.logs ?? obj.Logs;
  if (Array.isArray(entries)) {
    for (const e of entries) {
      const msgs = e?.message ?? e?.Message;
      const entryTs = timestampOf(e) ?? ts; // each log line carries its own time; fall back to the event's
      for (const m of Array.isArray(msgs) ? msgs : [msgs]) {
        if (typeof m === "string") {
          try {
            out.push(...eventsIn(JSON.parse(m), entryTs));
          } catch {
            /* not JSON */
          }
        } else if (m && typeof m === "object") out.push(...eventsIn(m, entryTs));
      }
    }
  }
  return out;
}

/** Aggregates events into rows keyed by tool × client. */
export function aggregate(events, { since } = {}) {
  const rows = new Map();
  let dropped = 0;
  for (const e of events) {
    if (since !== undefined && e.ts !== undefined && e.ts < since) {
      dropped++;
      continue;
    }
    const client = typeof e.client === "string" && e.client ? e.client : "unknown";
    const key = `${e.tool}\u0000${client}`;
    const row = rows.get(key) ?? { tool: e.tool, client, calls: 0, errors: 0, rateLimited: 0, users: new Set(), ms: [] };
    row.calls++;
    if (e.ok === false) row.errors++;
    if (e.error === "rate_limited") row.rateLimited++;
    if (typeof e.user === "string" && e.user) row.users.add(e.user);
    if (typeof e.ms === "number") row.ms.push(e.ms);
    rows.set(key, row);
  }
  const list = [...rows.values()]
    .map((r) => {
      const ms = r.ms.sort((a, b) => a - b);
      return { tool: r.tool, client: r.client, calls: r.calls, errors: r.errors, rateLimited: r.rateLimited, distinctUsers: r.users.size, p50Ms: ms.length ? ms[Math.floor((ms.length - 1) / 2)] : null };
    })
    .sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool) || a.client.localeCompare(b.client));
  return { rows: list, total: list.reduce((n, r) => n + r.calls, 0), dropped };
}

export function renderTable({ rows, total, dropped }) {
  const lines = [`Tool calls: ${total} (${rows.length} tool×client rows${dropped ? `, ${dropped} before --since dropped` : ""})`, "", "| Tool | Client | Calls | Errors | Rate-limited | Distinct users | p50 ms |", "|---|---|---|---|---|---|---|"];
  for (const r of rows) lines.push(`| \`${r.tool}\` | ${r.client} | ${r.calls} | ${r.errors} | ${r.rateLimited} | ${r.distinctUsers} | ${r.p50Ms ?? "—"} |`);
  return lines.join("\n") + "\n";
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  const { files, since, asJson } = opts;
  const inputs = files.length ? files.map((f) => fs.createReadStream(f)) : [process.stdin];
  const events = [];
  for (const stream of inputs) {
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) if (line.trim()) events.push(...extractEvents(line));
  }
  const agg = aggregate(events, { since });
  process.stdout.write(asJson ? JSON.stringify(agg, null, 1) + "\n" : renderTable(agg));
}

const isMain = (() => {
  try {
    return !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();
if (isMain) await main();
