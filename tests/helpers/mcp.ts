/**
 * In-memory MCP client ↔ server pair over the production tool registry.
 * Shared by wire-level tests so each does not re-implement the connect dance.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerTools, MCP_INSTRUCTIONS } from "../../src/tools/index.js";
import type { ToolCtx } from "../../src/tools/_shared.js";
import type { SurfaceConfig } from "../../src/tools/surface.js";

export interface ConnectOptions {
  /** Deployment env (ENABLED_TOOL_GROUPS, DISABLED_TOOL_GROUPS, TOOL_SURFACE, …). */
  env?: SurfaceConfig;
  /** Overrides for the ToolCtx handed to every handler; `g` defaults to a client that throws. */
  ctx?: Partial<ToolCtx>;
}

const throwingClient = new Proxy({}, { get: (_t, prop) => () => Promise.reject(new Error(`unexpected Google call: ${String(prop)}`)) });

/**
 * Connects a real MCP Client to a real McpServer with the production tools registered.
 * `ctx` is the very object the handlers get (so `ctx.catalog` is readable after registration)
 * and `close()` shuts both ends down.
 */
export async function connectInMemory(opts: ConnectOptions = {}) {
  const ctx = { g: throwingClient as any, readOnly: false, grantedScopes: [], email: "u@x.y", ...opts.ctx } as ToolCtx;
  const server = new McpServer({ name: "google-workspace", version: "test" }, { instructions: MCP_INSTRUCTIONS });
  registerTools(server, ctx, opts.env ?? {});
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "test-client", version: "0" });
  await client.connect(clientT);
  return {
    client,
    server,
    ctx,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** The tools/list result as a client sees it (what scripts/measure-tools.mjs measures). */
export async function listToolsInMemory(env: SurfaceConfig = {}) {
  const { client, close } = await connectInMemory({ env });
  const { tools } = await client.listTools();
  await close();
  return tools;
}
