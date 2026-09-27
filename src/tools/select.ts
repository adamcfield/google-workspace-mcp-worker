/**
 * `google_select_tools`: which of this server's tools a request actually needs.
 *
 * Why a tool and not `tools/list`: MCP's listing carries no user prompt. A server answering
 * `tools/list` knows the client, not the task, so a listing cannot be request-aware without
 * pretending to know something it does not. This tool takes the request as an argument, which
 * is the honest shape for the question, and leaves the listing alone.
 *
 * It is registered ONLY when `JEV_ENABLED="true"` (see `_groups.ts`). With the flag off, a
 * deployment's registration and listing are byte-for-byte what they were before this file
 * existed — `tests/jev-runtime.test.ts` pins that rather than trusting it.
 *
 * The answer comes from `selectTools`, so the safety argument is the one in `select.ts` and
 * not a new one: the prefilter ranks READ tools only, the model may only remove from that set,
 * and the mutation gate's tools are unioned back afterwards, unconditionally. A model failure
 * of any kind — no key, timeout, malformed answer, an SDK that will not load — lands on the
 * deterministic selection with `fallback` reported. There is no path here to an empty or
 * ungated result.
 */

import { z } from "zod";
import { selectTools, SELECT_PARAMS } from "../routing/select.js";
import { buildManifest, type ManifestEntry } from "./_manifest.js";
import { tool, type Catalog } from "./_shared.js";

/**
 * The manifest a session's catalog describes, built once per catalog.
 *
 * `buildManifest` returns a fresh array every call and `_router.ts` memoises its index on that
 * array's IDENTITY, so rebuilding per call would rebuild the router index per call too. Keyed
 * on the catalog object, which lives as long as the session does.
 */
const manifests = new WeakMap<Catalog, readonly ManifestEntry[]>();

export function manifestOf(catalog: Catalog): readonly ManifestEntry[] {
  const cached = manifests.get(catalog);
  if (cached) return cached;
  const built = buildManifest(catalog.manifest, new Set(catalog.listed.map((t) => t.name)));
  manifests.set(catalog, built);
  return built;
}

export const selectionTools = [
  tool({
    name: "google_select_tools",
    description:
      "Ask which of this server's tools a specific request needs, as this server's selector ranks them. Use it only to test or explain that selection: to find a tool to call, search your client's tool list by name, and to see what this deployment enables, use google_list_tools. Pass the user's request in its own words (any language); the answer is a short list of canonical tool names in rank order, plus the evidence behind it: what the deterministic prefilter offered, which tools the mutation gate pinned (anything that changes data is pinned there and can never be dropped), how many questions were put to the model, and whether the model's answers were usable at all. When they are not — no key, a timeout, an unusable answer — the deterministic selection is returned and fallback=true says so. nextAction=ask_user means the request asked for a change without naming what to change: ask the user which object they mean before calling anything. This tool calls no Google API and reads no account data.",
    // Selection is a judgement about this server's own catalog: no external system is touched.
    annotations: { openWorldHint: false },
    input: {
      request: z.string().min(1).describe("The user's request, in their own words (English or Hebrew)"),
      max_tools: z.number().int().min(1).max(50).optional().describe(`Ceiling on the returned list (default ${SELECT_PARAMS.maxTools}); tools the mutation gate pinned are never dropped to meet it`),
    },
    handler: async (a, ctx) => {
      const catalog = ctx.catalog;
      if (!catalog) throw new Error("tool catalog unavailable in this session");
      const manifest = manifestOf(catalog);
      // Null when the flag is off, no key is set, or the SDK could not be built. `selectTools`
      // without an `ask` IS the deterministic selector, which is the same answer as a fallback.
      const jev = ctx.jev ? await ctx.jev.ask() : null;
      const selection = await selectTools(a.request, manifest, {
        ...(jev ? { ask: jev.ask } : {}),
        ...(a.max_tools ? { maxTools: a.max_tools } : {}),
      });
      const stats = jev?.stats;
      return {
        request: selection.request,
        nextAction: selection.nextAction,
        toolCount: selection.tools.length,
        tools: selection.tools,
        // An empty list is a real answer — nothing this deployment registers serves the request,
        // usually because the group it needs is disabled here. Said out loud, because `strip()`
        // drops the empty array and a bare `toolCount: 0` reads like a bug rather than a verdict.
        ...(selection.tools.length ? {} : { note: "No tool in this deployment matches this request. The group it would need may be disabled here (see google_list_tools), or the request may name nothing this server can do." }),
        // Counts sit beside every list: `strip()` drops an empty array outright, so a bare
        // `pinned: []` would read as "field missing" rather than "the gate pinned nothing".
        prefilteredCount: selection.prefiltered.length,
        prefiltered: selection.prefiltered,
        gate: {
          mutating: selection.gate.intent.mutating,
          needsTarget: selection.gate.needsTarget,
          verbCount: selection.gate.intent.verbs.length,
          verbs: selection.gate.intent.verbs,
          serviceCount: selection.gate.intent.services.length,
          services: selection.gate.intent.services,
          pinnedCount: selection.gate.tools.length,
          pinned: selection.gate.tools,
        },
        model: {
          enabled: ctx.jev?.enabled === true,
          // Whether a key is present, never anything about its value.
          configured: ctx.jev?.configured === true,
          used: Boolean(jev) && selection.asked > 0 && !selection.fallback,
          asked: selection.asked,
          fallback: selection.fallback,
          ...(stats ? { calls: stats.calls, questions: stats.questions, failures: stats.failures, apiMs: stats.apiMs } : {}),
        },
      };
    },
  }),
];
