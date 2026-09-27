/**
 * Wires the tool catalog (`_groups.ts`) onto an MCP server: which tools a deployment
 * registers (the manifest) and which of them `tools/list` advertises (the surface).
 *
 * The catalog itself lives in `./_groups.js` so that `surface.ts` can read it without
 * importing this module back (no cycle); everything it exports is re-exported here.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { aliasDefs, registerAll, type ToolCtx, type ToolDef } from "./_shared.js";
import { installListing } from "./listing.js";
import { manifestFor, surfaceFor, type SurfaceConfig } from "./surface.js";

export { MCP_INSTRUCTIONS } from "./instructions.js";
export { TOOL_GROUPS, ALL_TOOLS, EVERY_TOOL, FLAGGED_TOOLS, toolsFor } from "./_groups.js";

/**
 * Register the deployment's tool surface on a server and take over its tools/list. Sets
 * `ctx.catalog` (mutating the ctx handlers see): `manifest` = every callable canonical tool
 * after MCP_READONLY, `listed` = what tools/list advertises (`surfaceFor`: the manifest itself
 * unless TOOL_SURFACE=compact narrows it — every manifest tool stays REGISTERED either way, so
 * a hidden tool is still callable by name),
 * `aliases` = the deprecated old names (see `aliasDefs`), which are registered and callable
 * but never listed — a write alias is dropped on MCP_READONLY exactly like its target.
 * `installListing` must follow `registerAll` — the SDK installs its own tools/list handler on
 * the first registerTool and ours replaces it; if it cannot (a server without the low-level
 * handler API), the aliases would leak into tools/list, so that case warns.
 *
 * Returns every registered name: the canonical tools first, then the aliases.
 */
export function registerTools(server: McpServer, ctx: ToolCtx, env: SurfaceConfig = {}): string[] {
  const callable = (t: ToolDef<any>) => !(ctx.readOnly && t.write);
  const all = manifestFor(env);
  const manifest = all.filter(callable);
  const aliases = aliasDefs(all).filter(callable);
  // The session's own read-only flag narrows the manifest further than the env does, so the
  // surface is computed against the narrowed set: compact can never re-expose a write tool.
  ctx.catalog = { manifest, listed: surfaceFor(env, manifest), aliases };
  const names = registerAll(server, ctx, [...all, ...aliases]);
  // Without our handler the SDK's own tools/list answers, and that one lists every REGISTERED
  // tool — the hidden aliases included. Only a fake server can get here, but say so loudly.
  if (!installListing(server, ctx.catalog) && aliases.length) console.warn(`[gws-mcp] tools/list not taken over: ${aliases.length} deprecated aliases would be advertised`);
  return names;
}
