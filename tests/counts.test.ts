/**
 * One number, one meaning (instruction 7, finding 1).
 *
 * The manual QA acceptance pass met three numbers that all looked like "how many tools does this
 * server have": a catalog header saying 163, an enumeration producing 162, and
 * `google_list_tools.count` returning 13 — which counted GROUPS. Two of those were different
 * builds and one was a field whose name did not say what it counted.
 *
 * So every count this server reports now says what it counts, and this pins them to each other
 * across the configurations that change them: a disabled group, a compact surface and a read-only
 * deployment. If any two of them ever disagree again, this fails.
 */
import { describe, it, expect, vi } from "vitest";

// health.ts → agent.ts → `agents/mcp`, which pulls in the Workers runtime; stub it like the
// other tests that read /health do.
vi.mock("agents/mcp", () => ({
  McpAgent: class {
    static serve() {
      return { fetch: async () => new Response("mcp-served") };
    }
    static serveSSE() {
      return { fetch: async () => new Response("sse-served") };
    }
  },
}));

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { connectInMemory } from "./helpers/mcp.js";
import { ALL_TOOLS, TOOL_GROUPS } from "../src/tools/index.js";
import { manifestFor, surfaceFor, type SurfaceConfig } from "../src/tools/surface.js";
import { groupOf } from "../src/tools/_manifest.js";
import { healthBody } from "../src/health.js";
import type { AgentEnv } from "../src/agent.js";

const repo = (p: string) => readFileSync(fileURLToPath(new URL(`../${p}`, import.meta.url)), "utf8");
const HEALTH_BASE = { GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret", ALLOWED_EMAILS: "ops@example.com" };

interface Listing {
  serverVersion: string;
  groupCount: number;
  toolsCallable: number;
  toolsListed: number;
  groups: { group: string; prefix: string; hint: string; toolsCallable: number; toolsListed: number }[];
  meta: string[];
}

async function listToolsTool(env: SurfaceConfig): Promise<{ payload: Listing; listed: string[] }> {
  const { client, close } = await connectInMemory({ env });
  const { tools } = await client.listTools();
  const res: any = await client.callTool({ name: "google_list_tools", arguments: {} });
  await close();
  expect(res.isError, res.content?.[0]?.text).toBeFalsy();
  return { payload: JSON.parse(res.content[0].text) as Listing, listed: tools.map((t) => t.name) };
}

const ENVS: [string, SurfaceConfig][] = [
  ["default", {}],
  ["two groups disabled", { DISABLED_TOOL_GROUPS: "gmail,chat" }],
  ["compact surface", { TOOL_SURFACE: "compact" }],
  ["read-only", { MCP_READONLY: "true" }],
  ["one group only", { ENABLED_TOOL_GROUPS: "sheets" }],
];

describe("the numbers this server reports", () => {
  it.each(ENVS)("agree with each other and with the wire — %s", async (_label, env) => {
    const { payload, listed } = await listToolsTool(env);
    const health = healthBody({ ...HEALTH_BASE, ...env } as AgentEnv, "w", "bearer");

    // What a client may CALL.
    expect(payload.toolsCallable).toBe(manifestFor(env).length);
    expect(health.toolsCallable).toBe(payload.toolsCallable);
    // `/health.tools` is the same number under its older name — kept because alerting reads it,
    // and unambiguous precisely because this asserts the two can never diverge.
    expect(health.tools).toBe(payload.toolsCallable);

    // What tools/list ADVERTISES, which is the manifest itself unless a compact surface hides some.
    expect(payload.toolsListed).toBe(listed.length);
    expect(health.toolsListed).toBe(listed.length);
    expect(surfaceFor(env).length).toBe(listed.length);

    // Groups: only those this deployment actually registers, counted once each.
    const present = new Set(manifestFor(env).map((t) => groupOf(t.name.split("_")[0])));
    expect(payload.groupCount).toBe(present.size);
    expect(payload.groups.length).toBe(payload.groupCount);
    expect(payload.groups.map((g) => g.group).sort()).toEqual([...present].sort());

    // The parts sum to the whole, in both senses.
    expect(payload.groups.reduce((n, g) => n + g.toolsCallable, 0)).toBe(payload.toolsCallable);
    expect(payload.groups.reduce((n, g) => n + g.toolsListed, 0)).toBe(payload.toolsListed);
    for (const g of payload.groups) expect(g.toolsListed, g.group).toBeLessThanOrEqual(g.toolsCallable);

    // The meta list is the Meta group of this deployment, not a copy of it.
    expect(payload.meta).toEqual(manifestFor(env).filter((t) => groupOf(t.name.split("_")[0]) === "Meta").map((t) => t.name));
  });

  it("no longer reports a field called `count`, which meant groups", async () => {
    const { payload } = await listToolsTool({});
    expect("count" in payload).toBe(false);
    for (const g of payload.groups) expect("count" in g).toBe(false);
  });

  it("counts the Meta group as a group, like the README does", async () => {
    const { payload } = await listToolsTool({});
    expect(payload.groups[0].group).toBe("Meta");
    expect(payload.groupCount).toBe(TOOL_GROUPS.length);
    // The generated README line is the same two numbers, so a reader comparing them cannot be
    // told 14 by one and 13 by the other.
    expect(repo("README.md")).toContain(`Total: **${ALL_TOOLS.length} tools** in ${TOOL_GROUPS.length} groups`);
    expect(payload.toolsCallable).toBe(ALL_TOOLS.length);
  });

  it("narrows every number together when a group is disabled", async () => {
    const full = (await listToolsTool({})).payload;
    const less = (await listToolsTool({ DISABLED_TOOL_GROUPS: "gmail" })).payload;
    expect(less.groupCount).toBe(full.groupCount - 1);
    expect(less.toolsCallable).toBeLessThan(full.toolsCallable);
    expect(less.groups.some((g) => g.group === "Gmail")).toBe(false);
    // Asking for a group this deployment does not have says so rather than answering with zeros.
    const { client, close } = await connectInMemory({ env: { DISABLED_TOOL_GROUPS: "gmail" } });
    const res: any = await client.callTool({ name: "google_list_tools", arguments: { group: "Gmail" } });
    await close();
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Unknown group 'Gmail'");
  });
});
