// Regression tests for the 1.4.3 E2E round.
import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ALL_TOOLS, registerTools } from "../src/tools/index.js";
import { VERSION } from "../src/version.js";

const byName = (n: string) => ALL_TOOLS.find((t) => t.name === n)!;
const ctx = (g: any) => ({ g, email: "u@x.y", requestedScopes: undefined }) as any;
const ev = (i: number) => ({ id: `e${i}`, summary: `[MCP-TEST] E2E #${i}`, start: { dateTime: `2026-09-1${i}T20:00:00+03:00` }, end: { dateTime: `2026-09-1${i}T20:30:00+03:00` }, htmlLink: `https://www.google.com/calendar/event?eid=${i}` });

describe("E2E-1: calendar_list_events htmlLink ctz", () => {
  it("appends the list's zone to every link, never the array index", async () => {
    const g = { get: async () => ({ timeZone: "Asia/Jerusalem", items: [ev(0), ev(1), ev(2)] }) };
    const r: any = await byName("calendar_list_events").handler({ calendar_id: "primary", max_results: 10, single_events: true, order_by: "startTime", show_deleted: false }, ctx(g));
    expect(r.items.map((e: any) => e.htmlLink)).toEqual([
      "https://www.google.com/calendar/event?eid=0&ctz=Asia/Jerusalem",
      "https://www.google.com/calendar/event?eid=1&ctz=Asia/Jerusalem",
      "https://www.google.com/calendar/event?eid=2&ctz=Asia/Jerusalem",
    ]);
    const inst: any = await byName("calendar_list_event_instances").handler({ calendar_id: "primary", event_id: "rec", max_results: 10 }, ctx(g));
    expect(inst.items.map((e: any) => e.htmlLink)).toEqual(r.items.map((e: any) => e.htmlLink));
  });
  it("leaves a link alone when Google already set ctz or the zone is unknown/malformed", async () => {
    const withZone = { ...ev(1), htmlLink: "https://www.google.com/calendar/event?eid=1&ctz=Europe/Bucharest" };
    const r: any = await byName("calendar_list_events").handler({ calendar_id: "primary", max_results: 10, single_events: true, order_by: "startTime", show_deleted: false }, ctx({ get: async () => ({ items: [withZone, ev(2)] }) }));
    expect(r.items[0].htmlLink).toBe("https://www.google.com/calendar/event?eid=1&ctz=Europe/Bucharest");
    expect(r.items[1].htmlLink).toBe("https://www.google.com/calendar/event?eid=2");
    const bad: any = await byName("calendar_list_events").handler({ calendar_id: "primary", max_results: 10, single_events: true, order_by: "startTime", show_deleted: false }, ctx({ get: async () => ({ timeZone: "1", items: [ev(3)] }) }));
    expect(bad.items[0].htmlLink).toBe("https://www.google.com/calendar/event?eid=3");
  });
});

describe("E2E-2: serverVersion on google_whoami over the wire", () => {
  it("survives compaction and serialization end to end", async () => {
    const g: any = { tokenInfo: async () => ({ email: "u@x.y", scopes: ["openid", "https://www.googleapis.com/auth/userinfo.email"], expiresIn: 1448 }), get: async () => ({ picture: "https://lh3/x" }) };
    const server = new McpServer({ name: "google-workspace", version: VERSION });
    registerTools(server, { g, readOnly: false, grantedScopes: [], email: "u@x.y" } as any, {});
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(clientT);
    const r: any = await client.callTool({ name: "google_whoami", arguments: {} });
    const body = JSON.parse(r.content[0].text);
    expect(body).toMatchObject({ email: "u@x.y", allScopesGranted: false, tokenExpiresInSec: 1448, serverVersion: VERSION });
    expect(body.picture).toBeUndefined();
    const t: any = await client.callTool({ name: "google_list_tools", arguments: {} });
    expect(JSON.parse(t.content[0].text).serverVersion).toBe(VERSION);
  });
});
