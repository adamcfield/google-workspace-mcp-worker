/**
 * Tool selection: request in, a short list of tools whose full schemas are worth exposing out.
 *
 * The pipeline has three stages and only the middle one involves a model:
 *
 *   1. **Prefilter** (deterministic) — rank the catalog and keep a working set. Cheap, total, and
 *      the only thing that runs when no model is configured.
 *   2. **Ask** (optional, one binary question per candidate) — "is this tool required for this
 *      request?". Answers only ever REMOVE tools from the working set.
 *   3. **Gate union** (deterministic) — put the mutation gate's tools back in, unconditionally.
 *
 * The prefilter ranks READ TOOLS ONLY. Every writing tool in a selection was put there by the
 * mutation gate in stage 3 and by nothing else. That is a stronger property than "the model cannot
 * drop a write": the model is never offered a write to drop, and the ranker cannot volunteer one
 * either. A request with no stated change therefore cannot surface a send or a delete schema at
 * all, however the words happen to score — which is where a similarity ranker on its own leaks,
 * since "find the emails from the supplier" and "send an email to the supplier" look alike to it.
 *
 * Stage 3 is also what makes stage 2 safe to be wrong. Any failure there — a throw, a timeout, an
 * unparseable answer — drops the whole stage and leaves the deterministic answer standing, which
 * is why `fallback` is reported rather than hidden.
 */

import { route } from "../tools/_router.js";
import type { ManifestEntry } from "../tools/_manifest.js";
import { gateTools, type GateResult } from "./gate.js";

/** Tuning constants, in one object so a change is visible in a diff. */
export const SELECT_PARAMS = {
  /** Candidates the prefilter keeps from the whole-catalog pass. */
  globalDepth: 10,
  /** Candidates the prefilter keeps from each named service's pass. */
  perServiceDepth: 6,
  /** Ceiling on the returned set. Gate tools are exempt: a cap may never evict a safety pin. */
  maxTools: 14,
} as const;

/**
 * One binary question to whatever answers them. Returns true when the tool is required for the
 * request. It may throw or reject; the caller treats that as "no usable answer" and falls back.
 */
export type AskFn = (request: string, tool: ManifestEntry) => Promise<boolean>;

export interface SelectOptions {
  /** Omit for a deterministic-only selection — the baseline, and the fallback. */
  ask?: AskFn;
  /** Ceiling on the returned set; gate tools are never dropped to meet it. */
  maxTools?: number;
}

export interface Selection {
  request: string;
  /** The final set: expose these tools' full schemas and nothing else. */
  tools: string[];
  /** What the deterministic prefilter offered, before any question was asked. */
  prefiltered: string[];
  /** The mutation gate's verdict, carried through for logging and for the caller's next step. */
  gate: GateResult;
  /** How many binary questions were put to the model. Zero in a deterministic run. */
  asked: number;
  /** True when a model was configured but its answers could not be used. */
  fallback: boolean;
  /** What the caller should do: call the tools, or ask the user which object they meant. */
  nextAction: "select" | "ask_user";
}

/**
 * Merge ranked lists round-robin, keeping the first occurrence of each name.
 *
 * Concatenating instead would let one pass fill the whole budget: a request naming two services
 * would spend its entire allowance on whichever the whole-catalog pass happened to favour, and the
 * second service would be cut by the cap downstream. Round-robin gives every pass its turn, so the
 * order that survives the cap is "best of each", not "all of one".
 */
function interleave(lists: readonly (readonly string[])[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const depth = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < depth; i++) {
    for (const list of lists) {
      const name = list[i];
      if (name && !seen.has(name)) {
        seen.add(name);
        out.push(name);
      }
    }
  }
  return out;
}

/**
 * The deterministic working set, BEST FIRST: a whole-catalog pass plus one pass per service the
 * request named, over the READ tools only, with the gate's writing tools ahead of all of them.
 *
 * Rank order is the point. An earlier revision returned this set sorted by name, and the cap
 * downstream then kept the alphabetically-first candidates — `chat_find_direct_message` survived
 * while `gmail_search_messages` was cut from a request about finding an email. Nothing between
 * here and the cap may reorder this list.
 */
function prefilter(request: string, manifest: readonly ManifestEntry[], gate: GateResult): string[] {
  const reads = manifest.filter((e) => !e.write);
  const byName = new Map(manifest.map((e) => [e.name, e]));
  // Read passes cover the services the request named AND the services the gate is about to write
  // to. The second half matters on its own: "find the Q3 deck and share it with the whole team"
  // names Slides, but the tool that shares it is Drive's — and so is the tool that finds the file
  // to share. Without this the selection could write to a service it had no way to read from.
  const services = [...new Set([...gate.intent.services, ...gate.tools.map((name) => byName.get(name)?.service).filter((s): s is string => Boolean(s))])];
  const passes = [
    route(request, reads, { limit: SELECT_PARAMS.globalDepth }).candidates.map((c) => c.name),
    ...services.map((service) => route(request, reads, { service, limit: SELECT_PARAMS.perServiceDepth }).candidates.map((c) => c.name)),
  ];
  return interleave([gate.tools, ...passes]);
}

/**
 * Select the tools worth exposing for one request.
 *
 * Never rejects: a model that throws is a fallback, not an error, because the deterministic answer
 * is always available. The gate's tools are in the result whatever happens.
 */
export async function selectTools(request: string, manifest: readonly ManifestEntry[], opts: SelectOptions = {}): Promise<Selection> {
  const gate = gateTools(request, manifest);
  const prefiltered = prefilter(request, manifest, gate);
  const byName = new Map(manifest.map((e) => [e.name, e]));

  let kept = prefiltered;
  let asked = 0;
  let fallback = false;
  if (opts.ask && prefiltered.length) {
    try {
      const answers = await Promise.all(
        prefiltered.map(async (name) => {
          const entry = byName.get(name);
          if (!entry) return false;
          asked += 1;
          return await opts.ask!(request, entry);
        }),
      );
      const chosen = prefiltered.filter((_, i) => answers[i]);
      // An answer of "none of these" is not an answer; it is the model declining to route. Keeping
      // the deterministic set is strictly better than returning an empty schema list.
      kept = chosen.length ? chosen : prefiltered;
    } catch {
      kept = prefiltered;
      fallback = true;
    }
  }

  // Stage 3. The cap is applied to the model's picks only — a gate tool is never evicted by it —
  // and it cuts from the BACK of a rank-ordered list, so what it drops is what ranked worst.
  const max = opts.maxTools ?? SELECT_PARAMS.maxTools;
  const pinned = new Set(gate.tools);
  const rest = kept.filter((n) => !pinned.has(n)).slice(0, Math.max(0, max - pinned.size));
  const tools = [...new Set([...gate.tools, ...rest])];

  return {
    request,
    tools,
    prefiltered,
    gate,
    asked,
    fallback,
    nextAction: gate.needsTarget && !tools.length ? "ask_user" : "select",
  };
}
