/**
 * The manifest/surface split (v1.5 PR-5).
 *
 * `manifest` = every tool this deployment may CALL (groups + scopes + MCP_READONLY).
 * `surface`  = the subset tools/list ADVERTISES. They are the same set unless
 * `TOOL_SURFACE=compact` is set, so with the var unset every client sees exactly the
 * 1.4.4/PR-4 listing. A hidden tool is still registered and still callable by name —
 * that is what keeps a cached connector (and every deprecated alias) working.
 *
 * Everything here fails OPEN: an unparseable value never hides a tool, it falls back to
 * the full surface and reports a /health warning.
 */
import type { GroupConfig } from "../google/scopes.js";
import type { JevConfig } from "../routing/runtime.js";
import type { ToolDef } from "./_shared.js";
// `_groups.ts` is the leaf catalog module: importing `./index.js` here would make the two
// modules import each other, and that cycle only ever resolved by accident of hoisting.
import { ALL_TOOLS, META_GROUP, TOOL_GROUPS, toolsFor } from "./_groups.js";

/** How much of the manifest tools/list advertises. */
export type Surface = "compact" | "full";

/** Deployment vars this module reads (a superset of the group config). */
export interface SurfaceConfig extends GroupConfig, JevConfig {
  /** Exactly "compact" → advertise the recipe set only; "full", unset, blank or a typo → everything (default). */
  TOOL_SURFACE?: string;
  /** Comma/space-separated extra tool names to advertise on a compact surface. */
  TOOL_SURFACE_ADD?: string;
  /** "true" → only read tools are callable (and therefore listable). */
  MCP_READONLY?: string;
}

/**
 * The compact surface's product tools, in recipe order: find → read → act, per product.
 * Canonical post-PR-4 names; `tests/surface.test.ts` asserts every one exists in ALL_TOOLS,
 * so a typo fails the suite instead of silently shrinking the listing.
 */
export const COMPACT_TOOL_NAMES: readonly string[] = [
  "gmail_search_messages",
  "gmail_read_message",
  "gmail_read_thread",
  "gmail_create_draft",
  "drive_search_files",
  "drive_read_file",
  "docs_read_document",
  "calendar_list_events",
  "calendar_get_free_busy",
  "calendar_create_event",
  "sheets_list_spreadsheets",
  "sheets_get_spreadsheet",
  "sheets_read_range",
  "sheets_write_range",
  "sheets_batch_update_spreadsheet",
  "tasks_list_tasks",
];

/**
 * The Meta group is always advertised — identity, the catalog and the escape hatch are how a
 * client finds its way when most of the manifest is hidden. DERIVED from the group, not copied:
 * a meta tool added later (PR-6's discovery tools) is listed on a compact surface automatically.
 * `tests/surface.test.ts` pins today's membership so the change is still visible in a diff.
 */
export const META_ALWAYS: readonly string[] = (TOOL_GROUPS.find((g) => g.group === META_GROUP)?.tools ?? []).map((t) => t.name);

/** Warning text for a TOOL_SURFACE value that is neither "compact" nor "full". */
export const unknownSurfaceWarning = (raw: string): string => `unknown TOOL_SURFACE "${raw}" ignored; using full`;

/** Warning text for TOOL_SURFACE_ADD entries that are no tool of this server at all. */
export const unknownAdditionsWarning = (names: string[]): string => `unknown TOOL_SURFACE_ADD tools ignored: ${names.join(", ")}`;

/** Warning text for TOOL_SURFACE_ADD entries that exist but this deployment does not register. */
export const filteredAdditionsWarning = (names: string[]): string =>
  `TOOL_SURFACE_ADD tools not enabled here (disabled group, missing scope or MCP_READONLY), ignored: ${names.join(", ")}`;

/**
 * The value is matched EXACTLY (after trimming surrounding whitespace), like `MCP_READONLY`
 * only accepts the literal "true": "COMPACT" is a typo, and a typo falls open to full with a
 * warning rather than silently hiding 143 tools from a live connector.
 */
function parseSurface(env: SurfaceConfig): { surface: Surface; unknown?: string } {
  const raw = (env.TOOL_SURFACE ?? "").trim();
  if (!raw || raw === "full") return { surface: "full" };
  if (raw === "compact") return { surface: "compact" };
  // Fail open: a mistyped value must never hide tools from a live connector.
  return { surface: "full", unknown: raw };
}

/** Which surface this deployment advertises. Unset, blank and anything unrecognized ⇒ "full". */
export function toolSurface(env: SurfaceConfig): Surface {
  return parseSurface(env).surface;
}

/** Every tool this deployment may call: the enabled groups/scopes, minus writes on MCP_READONLY. */
export function manifestFor(env: SurfaceConfig): ToolDef<any>[] {
  const all = toolsFor(env);
  return env.MCP_READONLY === "true" ? all.filter((t) => !t.write) : all;
}

/**
 * TOOL_SURFACE_ADD split three ways, so /health can tell an operator WHY a name was ignored:
 * `names` are advertisable tools of this deployment, `filtered` are real tools this deployment
 * does not register (disabled group, missing scope, MCP_READONLY) and `unknown` are names that
 * are no tool of this server at all — a typo. Only `names` ever widens the surface.
 */
export function surfaceAdditions(env: SurfaceConfig, manifest: ToolDef<any>[] = manifestFor(env)): { names: string[]; unknown: string[]; filtered: string[] } {
  const known = new Set(manifest.map((t) => t.name));
  const real = new Set(ALL_TOOLS.map((t) => t.name));
  const names: string[] = [];
  const unknown: string[] = [];
  const filtered: string[] = [];
  const seen = new Set<string>();
  for (const raw of (env.TOOL_SURFACE_ADD ?? "").split(/[,\s]+/).filter(Boolean)) {
    if (seen.has(raw)) continue;
    seen.add(raw);
    (known.has(raw) ? names : real.has(raw) ? filtered : unknown).push(raw);
  }
  return { names, unknown, filtered };
}

/**
 * What tools/list advertises. `full` returns the manifest ITSELF (same array), so the default
 * deployment keeps one single set and a byte-identical listing. `compact` intersects the
 * manifest with COMPACT_TOOL_NAMES ∪ TOOL_SURFACE_ADD ∪ META_ALWAYS, in manifest order:
 * a disabled group or a read-only session always wins over the compact list.
 *
 * `manifest` may be passed explicitly when the caller already narrowed it (registerTools
 * applies the session's ctx.readOnly on top of the env).
 */
export function surfaceFor(env: SurfaceConfig, manifest: ToolDef<any>[] = manifestFor(env)): ToolDef<any>[] {
  if (parseSurface(env).surface !== "compact") return manifest;
  const keep = new Set<string>([...COMPACT_TOOL_NAMES, ...surfaceAdditions(env, manifest).names, ...META_ALWAYS]);
  return manifest.filter((t) => keep.has(t.name));
}

/**
 * The /health warnings this module owns (empty for every deployment that sets neither var).
 *
 * The TOOL_SURFACE_ADD warnings are reported on a FULL surface too, where the variable has no
 * effect: an operator preparing the switch to compact should learn about a typo now, not after
 * the flip. The docs say so; the listing itself is untouched either way.
 */
export function surfaceWarnings(env: SurfaceConfig, manifest: ToolDef<any>[] = manifestFor(env)): string[] {
  const out: string[] = [];
  const { unknown } = parseSurface(env);
  if (unknown) out.push(unknownSurfaceWarning(unknown));
  const add = surfaceAdditions(env, manifest);
  if (add.unknown.length) out.push(unknownAdditionsWarning(add.unknown));
  if (add.filtered.length) out.push(filteredAdditionsWarning(add.filtered));
  return out;
}
