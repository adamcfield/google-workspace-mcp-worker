/**
 * tools/list ownership. `installListing` replaces the SDK's own `tools/list` handler with
 * one that advertises `catalog.listed`: the manifest itself by default — so the wire stays
 * byte-identical to 1.4.4 — and a SUBSET of it under `TOOL_SURFACE=compact` (see surface.ts),
 * where every hidden tool is still registered and still callable by name.
 *
 * Public SDK API only (`server.server.setRequestHandler`), which REPLACES the handler the
 * SDK installs lazily on the first `registerTool` — so call this AFTER `registerAll`.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { annotationsFor, type Catalog, type ToolDef } from "./_shared.js";

export interface ListingOptions {
  /** Drop the `$schema` key the SDK adds to every inputSchema. Default false (1.4.4 bytes). */
  stripSchemaKey?: boolean;
}

/** What the SDK's `registerTool` stamps on every tool (1.30.0): tasks are not supported. Part of the 1.4.4 bytes. */
const EXECUTION = { taskSupport: "forbidden" } as const;

/** One tools/list entry, in the SDK's key order (name, description, inputSchema, annotations, execution; `title`/`_meta` are unset and vanish). */
export function toWireTool(def: ToolDef<any>, opts: ListingOptions = {}): { name: string; description: string; inputSchema: Record<string, unknown>; annotations: Record<string, unknown>; execution: typeof EXECUTION } {
  const inputSchema = z.toJSONSchema(z.object(def.input), { target: "draft-7", io: "input" }) as Record<string, unknown>;
  if (opts.stripSchemaKey) delete inputSchema.$schema;
  return { name: def.name, description: def.description, inputSchema, annotations: annotationsFor(def), execution: { ...EXECUTION } };
}

/**
 * Point `tools/list` at the catalog. Returns false (and installs nothing) on a server without
 * the low-level `setRequestHandler` (fakes in tests) — the caller must treat that as "the SDK's
 * own handler still answers", which lists every REGISTERED tool, aliases included.
 */
export function installListing(server: McpServer, catalog: Catalog, opts: ListingOptions = {}): boolean {
  const low = (server as { server?: { setRequestHandler?: unknown } }).server;
  if (!low || typeof low.setRequestHandler !== "function") return false;
  server.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: catalog.listed.map((def) => toWireTool(def, opts)) }));
  return true;
}
