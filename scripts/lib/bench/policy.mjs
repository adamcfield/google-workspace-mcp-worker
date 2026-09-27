/**
 * Execution policy of the benchmark harness: for every recorded
 * tool call, decide whether it was permitted (execute=false ⇒ the call is scored as blocked) and
 * whether the attempt counts as a wrong mutation. Pure — no I/O — so tests/bench.test.ts can pin it.
 *
 * allow-list   = task.expected_first_tools ∪ task.acceptable_tools ∪ discovery tools ∪ readOnlySet
 *                (readOnlySet = the tools the server marks readOnlyHint, see readOnlyToolNames()).
 * HARD_DENY    = calls that never execute even when allow-listed: sends and shares by name, every
 *                tool whose name carries a write infix (_delete_, _trash_, _clear_, _move_,
 *                _update_, _batch_update, _write, _append_, _create_, _send_, _share_, _modify,
 *                _complete_, _upload_, _insert_, _replace_, _rsvp_, _respond_, _quick_add, _end_,
 *                _add_, _copy_, _fill_, _remove_, _untrash_, _set_, _find_replace, trailing
 *                _create/_update/_delete — together they cover every write tool of the server
 *                except google_api_request, CANONICAL NAMES AND HIDDEN ALIASES ALIKE (the old
 *                names stay callable until 2.0); tests/bench.test.ts pins that both ways),
 *                every other name in opts.writeSet (the server's non-read-only annotations, passed
 *                by session.mjs — belt and braces for a future tool the patterns miss),
 *                google_api_request with a method other than GET, calendar_* with send_updates
 *                all/externalOnly and drive_delete_file permanent=true — unless task.mutation.allowed
 *                matches the call (same tool and every args_match regex matches that argument). The
 *                argument-level rules additionally require the allowed spec to name that argument in
 *                args_match, so a task that allows drive_delete_file cannot accidentally permit a
 *                permanent delete and a task that allows calendar_create_event cannot mail attendees.
 * wrongMutation = a write outside task.mutation.allowed was ATTEMPTED, blocked or not — in a human
 *                claude.ai run the same call would have executed.
 */

/** Meta tools a session may call without them counting against first-tool accuracy. */
export const DISCOVERY_TOOLS = ["google_list_tools", "google_whoami"];

/** Name-level hard denies. Patterns are tested against the tool name. */
export const HARD_DENY = {
  names: ["gmail_send_message", "gmail_send_draft", "drive_share_file"],
  patterns: [
    /_delete_/, /_trash_/, /_clear_/, /_move_/, /_update_/, /_batch_update/, /_write/, /_append_/, /_create_/, /_send_/, /_share_/,
    // writes whose names carry none of the infixes above (gmail_modify_message_labels, tasks_complete_task, calendar_rsvp_event, …)
    /_modify/, /_(un)?complete_/, /_upload_/, /_insert_/, /_replace_/, /_rsvp_/, /_quick_add/, /_end_/, /_add_/, /_copy_/, /_fill_/, /_untrash_/,
    // Patterns that match no CANONICAL name any more, kept because they are the only cover for the
    // eight pre-1.5 write names that stay callable as hidden aliases until 2.0 (see RENAMES in
    // src/tools/naming.ts / bench/tool-aliases.json); tests/bench.test.ts pins the alias side too.
    /_remove_/, /_set_/, /_find_replace$/, /_respond_/, /_(create|update|delete)$/,
  ],
};

/** Argument-level hard denies: the argument must be named in an allowed spec's args_match to pass. */
export const GUARDED_ARGS = [
  { applies: (name) => name === "google_api_request", key: "method", denies: (v) => String(v ?? "GET").toUpperCase() !== "GET", why: "google_api_request with a method other than GET mutates data" },
  { applies: (name) => name.startsWith("calendar_"), key: "send_updates", denies: (v) => v === "all" || v === "externalOnly", why: "send_updates=all/externalOnly would email attendees" },
  { applies: (name) => name === "drive_delete_file", key: "permanent", denies: (v) => v === true || v === "true", why: "permanent=true is irreversible" },
];

const toSet = (v) => (v instanceof Set ? v : new Set(Array.isArray(v) ? v : []));
const list = (v) => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);
const argString = (v) => (v === undefined || v === null ? "" : typeof v === "string" ? v : JSON.stringify(v));

/** The argument-level rules a call trips, as [{ key, why }]. */
export function guardedArgs(call) {
  const name = String(call?.name ?? "");
  const args = call?.args && typeof call.args === "object" ? call.args : {};
  return GUARDED_ARGS.filter((g) => g.applies(name) && g.key in args && g.denies(args[g.key])).map((g) => ({ key: g.key, why: g.why }));
}

/**
 * Why a call is hard-denied (before any task override), or null when it is not a HARD_DENY match.
 * `writeSet` (optional) adds every tool the server does not mark read-only, except google_api_request
 * whose GETs read (its method is guarded above).
 */
export function hardDenyReason(call, writeSet) {
  const name = String(call?.name ?? "");
  const args = call?.args && typeof call.args === "object" ? call.args : {};
  const guards = guardedArgs({ name, args });
  if (guards.length) return `${name} ${guards.map((g) => `${g.key}=${argString(args[g.key])}`).join(" ")}: ${guards[0].why}`;
  if (HARD_DENY.names.includes(name)) return `${name} sends or shares data outside the sandbox`;
  if (HARD_DENY.patterns.some((p) => p.test(name))) return `${name} is a mutation`;
  if (name !== "google_api_request" && toSet(writeSet).has(name)) return `${name} is a write tool (server annotation)`;
  return null;
}

/** task.mutation.allowed as an array of { tool, args_match } specs ("none" → []). */
export function allowedSpecs(task) {
  const m = task?.mutation;
  if (!m || m === "none" || typeof m !== "object") return [];
  return list(m.allowed).filter((s) => s && typeof s === "object" && typeof s.tool === "string");
}

/** True when the spec names this tool and every args_match regex matches the call's argument (missing → ""). */
export function matchesAllowed(call, spec) {
  if (!spec || spec.tool !== call?.name) return false;
  const args = call.args && typeof call.args === "object" ? call.args : {};
  return Object.entries(spec.args_match ?? {}).every(([key, pattern]) => new RegExp(String(pattern)).test(argString(args[key])));
}

const describeSpec = (spec) => `${spec.tool}${spec.args_match ? " " + Object.entries(spec.args_match).map(([k, v]) => `${k}~/${v}/`).join(" ") : ""}`;

/**
 * The decision for one call. `opts.writeSet` (names the server does not mark read-only) widens the
 * hard deny beyond the HARD_DENY name patterns; `opts.discoveryTools` overrides the task's.
 */
export function allowExecute(call, task, readOnlySet, opts = {}) {
  const name = String(call?.name ?? "");
  const args = call?.args && typeof call.args === "object" ? call.args : {};
  const c = { name, args };
  const readOnly = toSet(readOnlySet);
  const discovery = new Set(opts.discoveryTools ?? task?.discovery_tools ?? DISCOVERY_TOOLS);
  const listed = new Set([...list(task?.expected_first_tools), ...list(task?.acceptable_tools), ...discovery, ...readOnly]);
  const specs = allowedSpecs(task);
  const allowed = specs.find((s) => matchesAllowed(c, s));
  const deny = hardDenyReason(c, opts.writeSet);
  const isWrite = !!deny;
  const base = { hardDeny: !!deny, isWrite, allowedBy: allowed ? describeSpec(allowed) : null };

  if (allowed) {
    const unnamed = guardedArgs(c).filter((g) => !(allowed.args_match && g.key in allowed.args_match));
    if (unnamed.length) return { ...base, execute: false, wrongMutation: true, reason: `${deny}; task.mutation.allowed (${describeSpec(allowed)}) does not name ${unnamed.map((g) => g.key).join(", ")}` };
    return { ...base, execute: true, wrongMutation: false, reason: `mutation allowed by task (${describeSpec(allowed)})` };
  }
  if (deny) return { ...base, execute: false, wrongMutation: true, reason: specs.length ? `${deny}; outside task.mutation.allowed` : `${deny}; the task allows no mutation` };
  if (!listed.has(name)) return { ...base, execute: false, wrongMutation: false, reason: `${name} is not in the task allow-list (expected/acceptable/discovery/read-only)` };
  return { ...base, execute: true, wrongMutation: false, reason: discovery.has(name) ? "discovery tool" : readOnly.has(name) ? "read-only tool" : "allow-listed by the task" };
}
