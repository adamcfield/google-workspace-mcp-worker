/**
 * v1.5 PR-5 (WS1a): the manifest/surface split. `manifest` = callable, `listed` = advertised.
 * With TOOL_SURFACE unset they are the same object, so every current deployment is untouched
 * (the byte-identity proof lives in tests/contracts.test.ts, "Rule #1").
 */
import { describe, it, expect } from "vitest";
import { connectInMemory } from "./helpers/mcp.js";
import { readFileSync } from "node:fs";
import { ALL_TOOLS, TOOL_GROUPS, toolsFor } from "../src/tools/index.js";
import { COMPACT_TOOL_NAMES, META_ALWAYS, filteredAdditionsWarning, manifestFor, surfaceAdditions, surfaceFor, surfaceWarnings, toolSurface, unknownAdditionsWarning, unknownSurfaceWarning } from "../src/tools/surface.js";

const names = (tools: { name: string }[]) => tools.map((t) => t.name);
const ALL_NAMES = new Set(ALL_TOOLS.map((t) => t.name));

describe("compact tool list", () => {
  it("every COMPACT_TOOL_NAMES and META_ALWAYS entry is a real canonical tool", () => {
    // This is the test that must fail if a name in surface.ts is wrong or a rename moves it.
    for (const n of [...COMPACT_TOOL_NAMES, ...META_ALWAYS]) expect(ALL_NAMES.has(n), `${n} is not a tool`).toBe(true);
  });
  it("is exactly the recipe set the spec names, in recipe order", () => {
    // The literal, not just the count: swapping an entry for another real tool must fail here.
    expect([...COMPACT_TOOL_NAMES]).toEqual([
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
    ]);
  });
  it("has no duplicates, no overlap between the two lists, and the sizes the PR states", () => {
    expect(COMPACT_TOOL_NAMES.length).toBe(16);
    expect(new Set(COMPACT_TOOL_NAMES).size).toBe(16);
    expect(META_ALWAYS.length).toBe(3);
    expect(new Set(META_ALWAYS).size).toBe(3);
    expect(COMPACT_TOOL_NAMES.filter((n) => (META_ALWAYS as readonly string[]).includes(n))).toEqual([]);
    expect([...META_ALWAYS].sort()).toEqual(["google_api_request", "google_list_tools", "google_whoami"]);
  });
  it("META_ALWAYS IS the Meta group, so a meta tool added later is advertised on compact too", async () => {
    const meta = TOOL_GROUPS.find((g) => g.group === "Meta")!;
    expect([...META_ALWAYS]).toEqual(meta.tools.map((t) => t.name));
    expect([...META_ALWAYS].sort()).toEqual(["google_api_request", "google_list_tools", "google_whoami"]);
    // google_list_tools derives that list from the session catalog rather than from a copy, so
    // this goes through a real session: a compact surface must never advertise a meta tool the
    // catalog tool does not mention, or the other way round.
    const { client, close } = await connectInMemory({ env: { TOOL_SURFACE: "compact" } });
    const res: any = await client.callTool({ name: "google_list_tools", arguments: {} });
    await close();
    const catalog = JSON.parse(res.content[0].text) as { meta: string[] };
    expect([...catalog.meta].sort()).toEqual([...META_ALWAYS].sort());
  });
  it("scripts/smoke.mjs mirrors COMPACT_TOOL_NAMES exactly (the post-deploy check cannot drift)", () => {
    const src = readFileSync(new URL("../scripts/smoke.mjs", import.meta.url), "utf8");
    const start = src.indexOf("const COMPACT_TOOL_NAMES = [");
    expect(start, "scripts/smoke.mjs no longer declares COMPACT_TOOL_NAMES").toBeGreaterThan(-1);
    const block = src.slice(start, src.indexOf("];", start));
    expect([...block.matchAll(/"([a-z_]+)"/g)].map((m) => m[1])).toEqual([...COMPACT_TOOL_NAMES]);
  });
  it("names no deprecated alias (aliases are never advertised)", () => {
    for (const n of [...COMPACT_TOOL_NAMES, ...META_ALWAYS]) expect(ALL_TOOLS.find((t) => t.name === n)!.alias).toBeUndefined();
  });
});

describe("toolSurface", () => {
  it("defaults to full for unset, blank and whitespace", () => {
    expect(toolSurface({})).toBe("full");
    expect(toolSurface({ TOOL_SURFACE: "" })).toBe("full");
    expect(toolSurface({ TOOL_SURFACE: "   " })).toBe("full");
    expect(toolSurface({ TOOL_SURFACE: "full" })).toBe("full");
    expect(toolSurface({ TOOL_SURFACE: " full " })).toBe("full");
  });
  it("accepts only the exact value \"compact\" (surrounding whitespace aside)", () => {
    expect(toolSurface({ TOOL_SURFACE: "compact" })).toBe("compact");
    expect(toolSurface({ TOOL_SURFACE: "  compact  " })).toBe("compact");
    // Exact match, like MCP_READONLY's literal "true": a different spelling is a typo, and a
    // typo falls open to full rather than hiding 143 tools from a live connector.
    expect(toolSurface({ TOOL_SURFACE: "COMPACT" })).toBe("full");
    expect(toolSurface({ TOOL_SURFACE: "Compact" })).toBe("full");
    expect(surfaceWarnings({ TOOL_SURFACE: "COMPACT" })).toEqual([unknownSurfaceWarning("COMPACT")]);
  });
  it("fails open on an unknown value and says so in the health warnings", () => {
    expect(toolSurface({ TOOL_SURFACE: "compakt" })).toBe("full");
    expect(toolSurface({ TOOL_SURFACE: "minimal" })).toBe("full");
    expect(surfaceWarnings({ TOOL_SURFACE: "compakt" })).toEqual([unknownSurfaceWarning("compakt")]);
    expect(unknownSurfaceWarning("compakt")).toBe('unknown TOOL_SURFACE "compakt" ignored; using full');
    // A mistyped value must never hide tools: the listing is the full one.
    expect(surfaceFor({ TOOL_SURFACE: "compakt" }).length).toBe(manifestFor({}).length);
  });
  it("emits no warning for the values it understands", () => {
    for (const TOOL_SURFACE of ["", "  ", "full", "compact"]) expect(surfaceWarnings({ TOOL_SURFACE })).toEqual([]);
    expect(surfaceWarnings({})).toEqual([]);
  });
});

describe("manifestFor", () => {
  it("is toolsFor() unless MCP_READONLY is exactly \"true\"", () => {
    expect(names(manifestFor({}))).toEqual(names(toolsFor({})));
    expect(names(manifestFor({ MCP_READONLY: "false" }))).toEqual(names(toolsFor({})));
    expect(names(manifestFor({ MCP_READONLY: "TRUE" }))).toEqual(names(toolsFor({}))); // only the literal "true" opts in
    expect(names(manifestFor({ ENABLED_TOOL_GROUPS: "gmail" }))).toEqual(names(toolsFor({ ENABLED_TOOL_GROUPS: "gmail" })));
  });
  it("drops every write tool on MCP_READONLY=true, keeping order", () => {
    const ro = manifestFor({ MCP_READONLY: "true" });
    expect(ro.some((t) => t.write)).toBe(false);
    expect(names(ro)).toEqual(names(toolsFor({}).filter((t) => !t.write)));
    expect(ro.length).toBeLessThan(toolsFor({}).length);
  });
});

describe("surfaceFor", () => {
  it("full returns the manifest itself (same array), so nothing is copied or reordered", () => {
    const manifest = manifestFor({});
    expect(surfaceFor({}, manifest)).toBe(manifest);
    expect(surfaceFor({ TOOL_SURFACE: "full" }, manifest)).toBe(manifest);
    expect(names(surfaceFor({}))).toEqual(names(toolsFor({})));
  });
  it("compact lists exactly the 16 product tools plus the 3 meta tools", () => {
    const listed = names(surfaceFor({ TOOL_SURFACE: "compact" }));
    expect(listed.length).toBe(19);
    expect([...listed].sort()).toEqual([...COMPACT_TOOL_NAMES, ...META_ALWAYS].sort());
  });
  it("compact preserves manifest order, not the order of COMPACT_TOOL_NAMES", () => {
    const manifest = names(manifestFor({}));
    const listed = names(surfaceFor({ TOOL_SURFACE: "compact" }));
    expect(listed).toEqual(manifest.filter((n) => listed.includes(n)));
  });
  it("never advertises a tool the manifest does not contain: a disabled group wins", () => {
    const env = { TOOL_SURFACE: "compact", ENABLED_TOOL_GROUPS: "gmail" };
    const listed = names(surfaceFor(env));
    const manifest = new Set(names(manifestFor(env)));
    expect(listed.every((n) => manifest.has(n))).toBe(true);
    expect(listed.some((n) => n.startsWith("sheets_"))).toBe(false);
    expect(listed).toContain("gmail_search_messages");
    expect(listed).toContain("google_whoami");
  });
  it("read-only wins over the compact list: no write tool is advertised", () => {
    const env = { TOOL_SURFACE: "compact", MCP_READONLY: "true" };
    const listed = surfaceFor(env);
    expect(listed.some((t) => t.write)).toBe(false);
    expect(names(listed)).not.toContain("sheets_write_range");
    expect(names(listed)).not.toContain("gmail_create_draft");
    expect(names(listed)).toContain("sheets_read_range");
  });
  it("TOOL_SURFACE_ADD widens a compact surface and is ignored on a full one", () => {
    const listed = names(surfaceFor({ TOOL_SURFACE: "compact", TOOL_SURFACE_ADD: "drive_create_folder, chat_list_spaces" }));
    expect(listed).toContain("drive_create_folder");
    expect(listed).toContain("chat_list_spaces");
    expect(listed.length).toBe(21);
    expect(names(surfaceFor({ TOOL_SURFACE_ADD: "drive_create_folder" })).length).toBe(toolsFor({}).length);
  });
});

describe("surfaceAdditions", () => {
  it("splits on commas and whitespace, de-duplicates and keeps order", () => {
    expect(surfaceAdditions({ TOOL_SURFACE_ADD: "drive_create_folder, chat_list_spaces  meet_get_space" })).toEqual({
      names: ["drive_create_folder", "chat_list_spaces", "meet_get_space"],
      unknown: [],
      filtered: [],
    });
    expect(surfaceAdditions({ TOOL_SURFACE_ADD: "drive_create_folder,drive_create_folder" }).names).toEqual(["drive_create_folder"]);
  });
  it("is empty for unset and blank values", () => {
    expect(surfaceAdditions({})).toEqual({ names: [], unknown: [], filtered: [] });
    expect(surfaceAdditions({ TOOL_SURFACE_ADD: "  , ," })).toEqual({ names: [], unknown: [], filtered: [] });
  });
  it("separates a typo (unknown) from a real tool this deployment does not register (filtered)", () => {
    const env = { TOOL_SURFACE_ADD: "drive_create_folder, nope_not_a_tool, gmail_send_message" };
    expect(surfaceAdditions({ ...env, ENABLED_TOOL_GROUPS: "drive" })).toEqual({ names: ["drive_create_folder"], unknown: ["nope_not_a_tool"], filtered: ["gmail_send_message"] });
    expect(surfaceWarnings(env)).toEqual([unknownAdditionsWarning(["nope_not_a_tool"])]);
    expect(unknownAdditionsWarning(["a", "b"])).toBe("unknown TOOL_SURFACE_ADD tools ignored: a, b");
    // A write tool dropped by MCP_READONLY is a REAL tool: /health must not call it a typo.
    expect(surfaceAdditions({ TOOL_SURFACE_ADD: "gmail_send_message", MCP_READONLY: "true" })).toEqual({ names: [], unknown: [], filtered: ["gmail_send_message"] });
    expect(surfaceWarnings({ TOOL_SURFACE_ADD: "gmail_send_message", MCP_READONLY: "true" })).toEqual([filteredAdditionsWarning(["gmail_send_message"])]);
    expect(filteredAdditionsWarning(["a"])).toBe("TOOL_SURFACE_ADD tools not enabled here (disabled group, missing scope or MCP_READONLY), ignored: a");
  });
  it("all three warnings can appear together, on a full surface too (the operator wants the typo now)", () => {
    expect(surfaceWarnings({ TOOL_SURFACE: "tiny", TOOL_SURFACE_ADD: "nope_not_a_tool" })).toEqual([unknownSurfaceWarning("tiny"), unknownAdditionsWarning(["nope_not_a_tool"])]);
    expect(surfaceWarnings({ TOOL_SURFACE: "tiny", TOOL_SURFACE_ADD: "nope_not_a_tool, gmail_send_message", ENABLED_TOOL_GROUPS: "drive" })).toEqual([
      unknownSurfaceWarning("tiny"),
      unknownAdditionsWarning(["nope_not_a_tool"]),
      filteredAdditionsWarning(["gmail_send_message"]),
    ]);
  });
});
