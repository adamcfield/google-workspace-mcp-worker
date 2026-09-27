/**
 * End-to-end through the MCP SDK: a real McpServer with the production tool registry,
 * talked to by a real MCP Client over an in-memory transport. Proves the wire contract
 * (initialize, tools/list, tools/call, error shape) — not just the handler functions.
 */
import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerTools, toolsFor, MCP_INSTRUCTIONS } from "../src/tools/index.js";
import { RateLimiter } from "../src/tools/_shared.js";
import { GoogleApiError } from "../src/google/client.js";
import { COMPACT_TOOL_NAMES, META_ALWAYS } from "../src/tools/surface.js";

async function connect(env: Record<string, string> = {}, opts: { readOnly?: boolean; limiter?: RateLimiter; g?: any } = {}) {
  const g = opts.g ?? {
    get: async (url: string) => {
      if (url.includes("calendarList")) return { items: [{ id: "primary", summary: "Me", primary: true, accessRole: "owner" }] };
      throw new GoogleApiError(403, "GET", url, "Request had insufficient authentication scopes.", "ACCESS_TOKEN_SCOPE_INSUFFICIENT");
    },
  };
  const server = new McpServer({ name: "google-workspace", version: "test" }, { instructions: MCP_INSTRUCTIONS });
  registerTools(server, { g, readOnly: opts.readOnly ?? false, grantedScopes: [], email: "u@x.y", limiter: opts.limiter }, env);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "test-client", version: "0" });
  await client.connect(clientT);
  return { client, server };
}

describe("MCP wire contract", () => {
  it("initializes, advertises the full surface with annotations, and carries the instructions", async () => {
    const { client } = await connect();
    expect(client.getInstructions()).toContain("Provenance");
    const { tools } = await client.listTools();
    expect(tools.length).toBe(toolsFor({}).length);
    const send = tools.find((t) => t.name === "gmail_send_message")!;
    expect(send.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(send.inputSchema).toMatchObject({ type: "object" });
    expect((send.inputSchema as any).properties.confirm).toBeDefined();
    const read = tools.find((t) => t.name === "sheets_read_range")!;
    expect(read.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true });
  });

  it("calls a tool end to end and returns compact JSON", async () => {
    const { client } = await connect();
    const r: any = await client.callTool({ name: "calendar_list_calendars", arguments: {} });
    expect(r.isError).toBeFalsy();
    const body = JSON.parse(r.content[0].text);
    expect(body.items[0]).toMatchObject({ id: "primary", primary: true });
  });

  it("returns Google errors as tool errors with a remediation hint, never a protocol failure", async () => {
    const { client } = await connect();
    const r: any = await client.callTool({ name: "drive_search_files", arguments: { query: "x" } });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/Google API error 403/);
    expect(r.content[0].text).toMatch(/lacks the required Google scope \(https:\/\/www\.googleapis\.com\/auth\/drive\)/);
  });

  it("rejects invalid arguments before any handler runs", async () => {
    const { client } = await connect();
    const r: any = await client.callTool({ name: "sheets_read_range", arguments: { spreadsheet_id: 5 } }).catch((e) => e);
    // SDK surfaces validation as a JSON-RPC error (InvalidParams) — the handler is never reached.
    expect(String(r.message ?? r.content?.[0]?.text)).toMatch(/spreadsheet_id|Invalid|expected string/i);
  });

  it("enforces the per-session budget across the wire", async () => {
    const { client } = await connect({}, { limiter: new RateLimiter(2) });
    await client.callTool({ name: "google_list_tools", arguments: {} });
    await client.callTool({ name: "google_list_tools", arguments: {} });
    const r: any = await client.callTool({ name: "google_list_tools", arguments: {} });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/Rate limit/);
  });

  it("read-only deployments and disabled groups shrink the advertised surface", async () => {
    const ro = await connect({}, { readOnly: true });
    const roNames = (await ro.client.listTools()).tools.map((t) => t.name);
    expect(roNames).not.toContain("sheets_write_range");
    expect(roNames).toContain("sheets_read_range");
    const trimmed = await connect({ DISABLED_TOOL_GROUPS: "gmail,chat" });
    const names = (await trimmed.client.listTools()).tools.map((t) => t.name);
    expect(names.some((n) => n.startsWith("gmail_") || n.startsWith("chat_"))).toBe(false);
    expect(names).toContain("calendar_list_calendars");
  });
});

/**
 * v1.5 PR-5: TOOL_SURFACE=compact narrows what tools/list ADVERTISES; it never narrows what a
 * client may CALL. Every deployment that leaves the var unset is covered by the tests above
 * (and by the byte-identity cases in tests/contracts.test.ts).
 */
describe("compact surface (TOOL_SURFACE)", () => {
  const COMPACT = { TOOL_SURFACE: "compact" };

  it("advertises exactly the 19 compact tools (16 product + 3 meta)", async () => {
    const { client } = await connect(COMPACT);
    const listed = (await client.listTools()).tools.map((t) => t.name);
    expect(listed.length).toBe(19);
    expect([...listed].sort()).toEqual([...COMPACT_TOOL_NAMES, ...META_ALWAYS].sort());
    expect(listed.length).toBeLessThan(toolsFor({}).length);
  });

  it("a hidden tool is still callable by name and returns its normal result", async () => {
    const { client } = await connect(COMPACT);
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain("calendar_list_calendars");
    const r: any = await client.callTool({ name: "calendar_list_calendars", arguments: {} });
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(r.content[0].text).items[0]).toMatchObject({ id: "primary", primary: true });
  });

  it("a hidden alias of a hidden tool is still callable and still says it is deprecated", async () => {
    const g = { get: async (url: string) => (url.includes("/about") ? { user: { emailAddress: "u@x.y" }, storageQuota: { limit: "100", usage: "10" } } : {}) };
    const { client } = await connect(COMPACT, { g });
    const listed = (await client.listTools()).tools.map((t) => t.name);
    expect(listed).not.toContain("drive_get_quota"); // the canonical target is hidden
    expect(listed).not.toContain("drive_get_about"); // aliases are never listed, compact or not
    const r: any = await client.callTool({ name: "drive_get_about", arguments: {} });
    expect(r.isError).toBeFalsy();
    const body = JSON.parse(r.content[0].text);
    expect(body.user).toMatchObject({ emailAddress: "u@x.y" });
    expect(body.deprecated).toEqual({ alias: "drive_get_about", use: "drive_get_quota" });
  });

  it("MCP_READONLY plus compact lists no write tool, and a write tool stays uncallable", async () => {
    const { client } = await connect(COMPACT, { readOnly: true });
    const listed = (await client.listTools()).tools.map((t) => t.name);
    expect(listed).not.toContain("sheets_write_range");
    expect(listed).not.toContain("gmail_create_draft");
    expect(listed).toContain("sheets_read_range");
    const r: any = await client.callTool({ name: "sheets_write_range", arguments: { spreadsheet_id: "s", range: "A1", values: [["x"]] } }).catch((e) => e);
    expect(String(r.message ?? r.content?.[0]?.text)).toMatch(/not found|unknown tool|Tool sheets_write_range/i);
  });

  it("MCP_READONLY as an env var (not just ctx.readOnly) reaches the same compact listing", async () => {
    // registerTools filters the manifest with manifestFor(env), so the write tools are never
    // registered at all — a different code path from the ctx.readOnly guard tested above.
    const { client } = await connect({ ...COMPACT, MCP_READONLY: "true" });
    const listed = (await client.listTools()).tools.map((t) => t.name);
    expect(listed).not.toContain("sheets_write_range");
    expect(listed).not.toContain("gmail_create_draft");
    expect(listed).toContain("sheets_read_range");
    const r: any = await client.callTool({ name: "sheets_write_range", arguments: { spreadsheet_id: "s", range: "A1", values: [["x"]] } }).catch((e) => e);
    expect(String(r.message ?? r.content?.[0]?.text)).toMatch(/not found|unknown tool|Tool sheets_write_range/i);
  });

  it("TOOL_SURFACE_ADD advertises a named tool and ignores an unknown one", async () => {
    const { client } = await connect({ ...COMPACT, TOOL_SURFACE_ADD: "drive_create_folder, nope_not_a_tool" });
    const listed = (await client.listTools()).tools.map((t) => t.name);
    expect(listed).toContain("drive_create_folder");
    expect(listed).not.toContain("nope_not_a_tool");
    expect(listed.length).toBe(20);
  });
});
