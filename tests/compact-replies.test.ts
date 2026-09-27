/**
 * QA round on the JEV build (1.6): one reply format, one way to find tools, narrower access.
 *
 * Findings this file answers:
 *  - "Some replies are pretty-printed and others compact, even though the server instructions
 *    promise compact JSON." (ok() indented every reply under 3000 chars.)
 *  - "There are two overlapping ways to find tools: the app's own tool search, and the server's
 *    google_list_tools / google_select_tools. Pick one and say which in the server instructions."
 *  - "The access scope is still very broad — full Gmail and Drive to edit one spreadsheet."
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { connectInMemory } from "./helpers/mcp.js";
import { EVERY_TOOL, MCP_INSTRUCTIONS } from "../src/tools/index.js";
import { MAX_INSTRUCTIONS_CHARS } from "../src/tools/instructions.js";
import { manifestFor } from "../src/tools/surface.js";
import { enabledScopes } from "../src/google/scopes.js";
import { VERSION } from "../src/version.js";

const repo = (p: string) => readFileSync(fileURLToPath(new URL(`../${p}`, import.meta.url)), "utf8");
const textOf = (r: any): string => r.content.map((c: any) => c.text).join("");
const describeTool = (name: string) => EVERY_TOOL.find((t) => t.name === name)!.description;

/** A reply is compact JSON when re-serialising its parse gives back the exact same bytes. */
function expectCompactJson(text: string, label: string) {
  expect(text, label).not.toContain("\n");
  expect(text, label).toBe(JSON.stringify(JSON.parse(text)));
}

describe("replies are compact JSON over the wire, whatever their size", () => {
  it("a small reply (the size that used to be pretty-printed) and a large one are both compact", async () => {
    const small = { kind: "drive#about", user: { displayName: "Test User" }, storageQuota: { limit: "1", usage: "0" } };
    const large = { values: Array.from({ length: 300 }, (_, i) => [`A${i + 1}`, i, "x".repeat(8), null]) };
    const g: any = {
      tokenInfo: async () => ({ email: "u@example.com", scopes: ["openid", "https://www.googleapis.com/auth/userinfo.email"], expiresIn: 1200 }),
      get: async () => ({ hd: "example.com" }),
      request: async (_m: string, url: string) => (url.endsWith("/large") ? large : small),
    };
    const { client, close } = await connectInMemory({ ctx: { g } });
    try {
      const whoami = textOf(await client.callTool({ name: "google_whoami", arguments: {} }));
      const list = textOf(await client.callTool({ name: "google_list_tools", arguments: {} }));
      const smallRaw = textOf(await client.callTool({ name: "google_api_request", arguments: { method: "GET", url: "https://www.googleapis.com/drive/v3/about" } }));
      const largeRaw = textOf(await client.callTool({ name: "google_api_request", arguments: { method: "GET", url: "https://www.googleapis.com/drive/v3/large" } }));
      // The QA failure mode: these three are all under the old 3000-char threshold and came back indented.
      for (const [label, t] of [["google_whoami", whoami], ["google_list_tools", list], ["small google_api_request", smallRaw]] as const) {
        expect(t.length, label).toBeLessThan(3000);
        expectCompactJson(t, label);
      }
      expect(largeRaw.length).toBeGreaterThan(3000);
      expectCompactJson(largeRaw, "large google_api_request");
      expect(JSON.parse(smallRaw)).toEqual(small);
      expect(JSON.parse(whoami)).toMatchObject({ email: "u@example.com", hd: "example.com", serverVersion: VERSION });
    } finally {
      await close();
    }
  });
});

describe("google_list_tools reports what THIS deployment enables", () => {
  const call = async (opts: Parameters<typeof connectInMemory>[0], args: Record<string, unknown> = {}) => {
    const { client, close } = await connectInMemory(opts);
    try {
      const r: any = await client.callTool({ name: "google_list_tools", arguments: args });
      expect(r.isError, textOf(r)).toBeFalsy();
      return JSON.parse(textOf(r));
    } finally {
      await close();
    }
  };
  const countFor = (env: Record<string, string>, prefix: string) => manifestFor(env).filter((t) => t.name.startsWith(prefix)).length;

  // The counts themselves (groupCount / toolsCallable / toolsListed) are pinned in counts.test.ts;
  // this block pins what the discovery rule adds on top: which groups are OFF here, and why.
  it("default deployment: nothing is switched off, and the meta tools are named", async () => {
    const out = await call({});
    expect(out.serverVersion).toBe(VERSION);
    expect(out.disabledCount).toBe(0);
    expect(out.disabled).toBeUndefined(); // strip() drops the empty list; the count carries the answer
    expect(out.toolsCallable).toBe(manifestFor({}).length);
    const sheets = out.groups.find((g: any) => g.group === "Sheets");
    expect(sheets).toMatchObject({ prefix: "sheets_", toolsCallable: countFor({}, "sheets_") });
    expect(sheets.hint.length).toBeGreaterThan(20);
    expect(out.meta).toEqual(["google_whoami", "google_api_request", "google_list_tools"]);
  });

  it("a sheets-only deployment names the groups it switched off", async () => {
    const env = { ENABLED_TOOL_GROUPS: "sheets" };
    const out = await call({ env });
    // Meta is always registered, so it is the one group beside Sheets (rows keep GROUP_HINTS order).
    expect(out.groups.map((g: any) => g.group)).toEqual(["Meta", "Sheets"]);
    // sheets_list_spreadsheets needs the Drive scope, so a sheets-only deployment does not register it.
    expect(out.groups.find((g: any) => g.group === "Sheets").toolsCallable).toBe(countFor({}, "sheets_") - 1);
    expect(out.disabledCount).toBe(12);
    expect(out.disabled).toEqual(expect.arrayContaining(["Gmail", "Drive", "Docs", "Calendar"]));
    expect(out.disabled).not.toContain("Sheets");
    expect(out.disabledCount + out.groupCount).toBe(14);
  });

  it("the group filter names the groups this deployment has when asked for one it switched off", async () => {
    const env = { ENABLED_TOOL_GROUPS: "sheets_power_user" };
    const { client, close } = await connectInMemory({ env });
    try {
      const r: any = await client.callTool({ name: "google_list_tools", arguments: { group: "gmail" } });
      expect(r.isError).toBe(true);
      expect(textOf(r)).toMatch(/Unknown group 'gmail'\. Known groups: .*Sheets.*Drive/);
    } finally {
      await close();
    }
    const drive = await call({ env }, { group: "Drive" });
    expect(drive).toMatchObject({ groupCount: 1, groups: [{ group: "Drive", toolsCallable: countFor(env, "drive_") }] });
    expect(drive.groups[0].toolsCallable).toBeGreaterThan(0);
  });

  it("read-only sessions and the JEV flag are reflected in the meta tools", async () => {
    const ro = await call({ ctx: { readOnly: true } });
    expect(ro.meta).toEqual(["google_whoami", "google_list_tools"]); // google_api_request is a write tool
    const jev = await call({ env: { JEV_ENABLED: "true" } });
    expect(jev.meta).toContain("google_select_tools");
  });
});

describe("one discovery rule, stated once and echoed by both discovery tools", () => {
  it("MCP_INSTRUCTIONS: find tools with the client's tool search; google_list_tools only for what is enabled", () => {
    expect(MCP_INSTRUCTIONS.length).toBeLessThanOrEqual(MAX_INSTRUCTIONS_CHARS);
    expect(MCP_INSTRUCTIONS).toContain("Find tools by name with your client's tool search; google_list_tools only shows what this deployment enables.");
    // The instructions are one static string for every deployment (agent.ts passes them to the
    // McpServer constructor), and google_select_tools exists only with JEV_ENABLED="true" — so the
    // instructions must not send a default deployment's client to a tool it does not have.
    expect(MCP_INSTRUCTIONS).not.toContain("google_select_tools");
  });

  it("google_list_tools and google_select_tools each say when to use them, without overlapping", () => {
    const list = describeTool("google_list_tools");
    const select = describeTool("google_select_tools");
    expect(list).toContain("What this deployment enables");
    expect(list).toContain("Use it only to check whether a product is available here");
    expect(list).toContain("search your client's tool list by name instead");
    expect(list).not.toMatch(/rank|request needs/i);
    expect(select).toContain("Use it only to test or explain that selection");
    expect(select).toContain("to find a tool to call, search your client's tool list by name");
    expect(select).toContain("to see what this deployment enables, use google_list_tools");
  });
});

describe("narrower access is documented and true", () => {
  const short = (s: string) => s.replace("https://www.googleapis.com/auth/", "");

  it("ENABLED_TOOL_GROUPS=sheets asks Google for spreadsheets only; sheets_power_user adds drive, never Gmail", () => {
    expect(enabledScopes({ ENABLED_TOOL_GROUPS: "sheets" }).map(short)).toEqual(["openid", "userinfo.email", "spreadsheets"]);
    expect(enabledScopes({ ENABLED_TOOL_GROUPS: "sheets_power_user" }).map(short)).toEqual(["openid", "userinfo.email", "spreadsheets", "drive"]);
    expect(enabledScopes({}).map(short)).toContain("gmail.modify");
  });

  it("OPERATIONS.md and the README show the sheets-only setup and why an existing grant must be revoked", () => {
    const ops = repo("docs/OPERATIONS.md");
    const section = ops.slice(ops.indexOf("### Narrow access for one job"), ops.indexOf("## 4. Monitoring"));
    expect(section).toContain("Scopes follow the enabled groups");
    expect(section).toContain("| `sheets` | `spreadsheets` |");
    expect(section).toContain("| `sheets_power_user` (sheets + drive) | `spreadsheets`, `drive` |");
    expect(section).toContain("include_granted_scopes=true");
    expect(section).toContain("https://myaccount.google.com/permissions");
    const readme = repo("README.md");
    expect(readme).toContain("`ENABLED_TOOL_GROUPS=sheets`, and Google then asks only for `spreadsheets`");
    expect(readme).toContain("docs/OPERATIONS.md#narrow-access-for-one-job");
  });
});
