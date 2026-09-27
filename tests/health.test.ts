/**
 * /health is the operator's contract (and what scripts/smoke.mjs asserts against). PR-5 adds
 * `surface`, `toolsListed`, `toolsCallable` and two warnings; `tools` keeps its meaning so
 * existing alerting does not move.
 */
import { describe, it, expect, vi } from "vitest";

// health.ts → agent.ts → `agents/mcp`, which pulls in the Workers runtime; stub it like the
// other worker-entry tests do.
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

import { healthBody } from "../src/health.js";
import { toolsFor } from "../src/tools/index.js";

const base = { MCP_OBJECT: {} as never, GOOGLE_CLIENT_ID: "gid", GOOGLE_CLIENT_SECRET: "gsecret", ALLOWED_EMAILS: "a@b.c", AUTH_RATE_LIMIT: {} };
const health = (extra: Record<string, unknown> = {}) => healthBody({ ...base, ...extra }, "n", "oauth");

describe("health: surface fields (PR-5)", () => {
  it("defaults to the full surface, with listed === callable === tools", () => {
    const h = health();
    expect(h.surface).toBe("full");
    // toolsFor() is the PR-4 count: the default deployment's three numbers are all still it.
    expect(h.toolsCallable).toBe(toolsFor({}).length);
    expect(h.toolsListed).toBe(toolsFor({}).length);
    expect(h.tools).toBe(toolsFor({}).length);
    expect(h.warnings).toBeUndefined();
  });

  it("compact reports the narrower listing while callable stays the whole manifest", () => {
    const h = health({ TOOL_SURFACE: "compact" });
    expect(h.surface).toBe("compact");
    expect(h.toolsListed).toBe(19);
    expect(h.toolsCallable).toBe(toolsFor({}).length);
    expect(h.tools).toBe(h.toolsCallable);
    expect(h.warnings).toBeUndefined();
  });

  it("TOOL_SURFACE_ADD widens toolsListed", () => {
    expect(health({ TOOL_SURFACE: "compact", TOOL_SURFACE_ADD: "drive_create_folder gmail_send_message" }).toolsListed).toBe(21);
  });

  it("tracks the group config and MCP_READONLY on all three counts", () => {
    // Literals, not the functions health.ts itself calls: these must fail if the split moves.
    const h = health({ ENABLED_TOOL_GROUPS: "gmail", TOOL_SURFACE: "compact" });
    expect(h.toolsCallable).toBe(toolsFor({ ENABLED_TOOL_GROUPS: "gmail" }).length);
    expect(h.toolsCallable).toBe(23);
    expect(h.toolsListed).toBe(7); // the 4 Gmail recipe tools + the 3 meta tools
    const ro = health({ MCP_READONLY: "true" });
    expect(ro.readOnly).toBe(true);
    expect(ro.toolsCallable).toBe(toolsFor({}).filter((t) => !t.write).length);
    expect(ro.toolsListed).toBe(ro.toolsCallable);
    // `tools` is the CALLABLE count, so a read-only deployment reports fewer than PR-4 did
    // (PR-4: toolsFor(env).length, which ignored MCP_READONLY). Documented in the CHANGELOG.
    expect(ro.tools).toBe(ro.toolsCallable);
    expect(ro.tools).toBeLessThan(toolsFor({}).length);
    const roCompact = health({ MCP_READONLY: "true", TOOL_SURFACE: "compact" });
    expect(roCompact.toolsListed).toBe(14); // the recipe set's 4 write tools AND google_api_request are gone
  });

  it("warns about an unknown TOOL_SURFACE and still reports the full surface", () => {
    const h = health({ TOOL_SURFACE: "compakt" });
    expect(h.surface).toBe("full");
    expect(h.toolsListed).toBe(h.toolsCallable);
    expect(h.warnings).toEqual(['unknown TOOL_SURFACE "compakt" ignored; using full']);
    expect(h.warningsCount).toBe(1);
  });

  it("warns about unknown TOOL_SURFACE_ADD names, and both warnings can appear at once", () => {
    expect(health({ TOOL_SURFACE: "compact", TOOL_SURFACE_ADD: "drive_create_folder, nope_not_a_tool" }).warnings).toEqual(["unknown TOOL_SURFACE_ADD tools ignored: nope_not_a_tool"]);
    const both = health({ TOOL_SURFACE: "tiny", TOOL_SURFACE_ADD: "nope_not_a_tool, also_nope" });
    expect(both.warnings).toEqual(['unknown TOOL_SURFACE "tiny" ignored; using full', "unknown TOOL_SURFACE_ADD tools ignored: nope_not_a_tool, also_nope"]);
    expect(both.warningsCount).toBe(2);
    // detail=false still counts them but withholds the texts.
    const quiet = healthBody({ ...base, TOOL_SURFACE: "tiny" }, "n", "bearer", {}, false);
    expect(quiet.warnings).toBeUndefined();
    expect(quiet.warningsCount).toBe(1);
  });

  it("omits `profiles` unless the config names one", () => {
    for (const env of [{}, { ENABLED_TOOL_GROUPS: "gmail" }, { DISABLED_TOOL_GROUPS: "photos" }]) expect(health(env).profiles).toBeUndefined();
    const h = health({ ENABLED_TOOL_GROUPS: "core" });
    expect(h.profiles).toEqual(["core"]);
    expect(h.groups).toEqual(["calendar", "docs", "drive", "gmail", "sheets"]);
    expect(h.warnings).toBeUndefined(); // a profile name is not an unknown group
    expect(h.toolsCallable).toBe(toolsFor({ ENABLED_TOOL_GROUPS: "gmail, calendar, drive, docs, sheets" }).length);
    // The key is absent, not present-and-undefined: an operator reading the object sees no dead key.
    expect("profiles" in health({})).toBe(false);
    expect("profiles" in h).toBe(true);
  });
});
