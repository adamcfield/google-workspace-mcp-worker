/**
 * Measurement plumbing (v1.5 PR-1): the byte statistics are deterministic, the committed
 * 1.4.4 baseline is immutable, and the tools/list a client gets today can be measured
 * without network. Token counts are local only (a vendored tokenizer; never an API).
 */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { stats, toApiTool, stripSchemaKey, renderReport, tokenStats, fidelity, SURFACES, FIDELITY_TOLERANCE } from "../scripts/lib/measure-core.mjs";
import { extractEvents, aggregate, renderTable, parseArgs } from "../scripts/tool-usage.mjs";
import { listToolsInMemory } from "./helpers/mcp.js";
import { toolsFor } from "../src/tools/index.js";

const BASELINE_DIR = "docs/measurements/1.4.4-136e2e7";
/** sha256 of every file in the 1.4.4 baseline. A baseline is written once; never regenerate it. */
const BASELINE_SHA256: Record<string, string> = {
  "report.json": "5660b1438517dd8221d4dfe3236c7f228128cd1af0b8511b91392db4def67cc9",
  "report.md": "50bb0e367e5681d9a58d2106eafa0434d164116f8db3745e670c3e00da0f0e07",
  "tools-list.full.json": "db3d8a1f08a90b29f924a4848d2f75cd1dc44cea33c323e7f46856280469e14d",
  "tools-list.group-gmail.json": "d51b46ec727864031577ffc6e56e6c1503bca0fd073c0868f2860255d4dd0ee5",
  "tools-list.group-sheets.json": "c8dfde16604ca0cd18482ab5e883318e8f78339b266d90e8c7c4ca1473809a61",
  "tools-list.profile-gmail-calendar-drive-docs-sheets.json": "36ed675a5a98fb9f5b9e9160539782494293f5f854f2390088852c0f6f124ac1",
};
const sha256 = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

const sample = [
  { name: "a_tool", description: "Alpha — does A.", inputSchema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: { x: { type: "string" } } }, annotations: { readOnlyHint: true } },
  { name: "b_tool", description: "B", inputSchema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: {} } },
  { name: "c_tool", description: "Gamma".repeat(20), inputSchema: { type: "object", properties: { long: { type: "string", description: "x".repeat(300) } } } },
];

describe("measure-core", () => {
  it("counts UTF-8 bytes, model-facing bytes and the $schema overhead deterministically", () => {
    const s1 = stats(sample);
    const s2 = stats([...sample].reverse());
    expect(s1).toEqual(s2); // order-independent
    expect(s1.tools).toBe(3);
    expect(s1.wireBytes).toBe(Buffer.byteLength(JSON.stringify({ tools: sample })));
    expect(s1.modelFacingBytes).toBeLessThan(s1.wireBytes); // annotations are not model-facing
    expect(s1.modelFacingBytesNoSchemaKey).toBeLessThan(s1.modelFacingBytes);
    expect(s1.descriptionChars).toBe("Alpha — does A.".length + 1 + 100);
    expect(s1.top10[0].name).toBe("c_tool"); // heaviest first
    expect(s1.p95WireBytes).toBeGreaterThanOrEqual(s1.p50WireBytes);
  });

  it("builds the Messages API tool shape and strips only $schema", () => {
    expect(toApiTool(sample[0])).toEqual({ name: "a_tool", description: "Alpha — does A.", input_schema: sample[0].inputSchema });
    expect(toApiTool(sample[0], { stripSchema: true }).input_schema).toEqual({ type: "object", properties: { x: { type: "string" } } });
    expect(stripSchemaKey(sample[2].inputSchema)).toEqual(sample[2].inputSchema);
    expect((toApiTool(sample[0]) as any).annotations).toBeUndefined();
  });

  it("renders a report without timestamps and with the tokenizer section only when present", () => {
    const base = { version: "9.9.9", commit: "abc1234", generatedFrom: "test", instructionsChars: 10, surfaces: { full: stats(sample) } };
    const md = renderReport(base);
    expect(md).toContain("# tools/list measurement — 9.9.9 @ abc1234");
    expect(renderReport({ ...base, commit: undefined })).not.toContain("9.9.9"); // current.md: no version, no sha
    expect(md).toContain("| full | 3 |");
    expect(md).not.toContain("## Local tokenizer");
    expect(md).not.toMatch(/20\d\d-\d\d-\d\dT/);
    const withTokens = renderReport({ ...base, commit: undefined, tokens: { tokenizer: { name: "tok", version: "9.9" }, surfaces: { full: { tools: 3, asEmitted: 300, stripped: 270, perTool: 90 } } } });
    expect(withTokens).toContain("# tools/list measurement (working tree)");
    expect(withTokens).toContain("## Local tokenizer (tok 9.9)");
    expect(withTokens).toContain("| full | 3 | 300 | 270 | 90 |");
  });

  it("counts tokens locally through an injected tokenizer and checks fidelity against reference counts", () => {
    const count = (text: string) => Math.ceil(text.length / 4);
    const t = tokenStats(sample, count);
    expect(t.tools).toBe(3);
    expect(t.asEmitted).toBe(count(JSON.stringify(sample.map((x) => toApiTool(x)))));
    expect(t.stripped).toBeLessThan(t.asEmitted);
    expect(t.perTool).toBe(Math.round(t.stripped / 3));
    const f = fidelity([{ label: "a", text: "x".repeat(400), referenceTokens: 100 }, { label: "b", text: "y".repeat(400), referenceTokens: 95, model: "m" }], count);
    expect(f.ok).toBe(true);
    expect(f.rows[1]).toMatchObject({ model: "m", localTokens: 100, ok: true });
    expect(f.maxRatio).toBeCloseTo(100 / 95, 5);
    const bad = fidelity([{ label: "c", text: "z".repeat(400), referenceTokens: 50 }], count);
    expect(bad.ok).toBe(false);
    expect(FIDELITY_TOLERANCE).toBe(0.1);
  });

  it("the real tokenizer counts without network and the report carries its version", () => {
    const report = JSON.parse(fs.readFileSync(path.join(BASELINE_DIR, "report.json"), "utf8"));
    expect(report.tokens.tokenizer).toMatchObject({ name: "@anthropic-ai/tokenizer" });
    expect(report.tokens.tokenizer.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(report.tokens.surfaces.full.stripped).toBeGreaterThan(10_000);
    expect(report.tokens.surfaces.full.stripped).toBeLessThan(report.tokens.surfaces.full.asEmitted);
  });
});

describe("1.4.4 baseline", () => {
  it("is immutable (hash-pinned) and complete", () => {
    const files = fs.readdirSync(BASELINE_DIR).sort();
    expect(files).toEqual(Object.keys(BASELINE_SHA256).sort());
    for (const f of files) expect(sha256(path.join(BASELINE_DIR, f)), f).toBe(BASELINE_SHA256[f]);
  });

  it("p95 is a nearest-rank value that is not simply the maximum on a 20-tool surface", () => {
    const { tools } = JSON.parse(fs.readFileSync(path.join(BASELINE_DIR, "tools-list.group-sheets.json"), "utf8"));
    const sizes = tools.map((t: any) => Buffer.byteLength(JSON.stringify(t))).sort((a: number, b: number) => a - b);
    expect(stats(tools).p95WireBytes).toBe(sizes[Math.ceil(0.95 * sizes.length) - 1]);
    expect(stats(tools).p95WireBytes).toBeLessThan(sizes[sizes.length - 1]);
  });

  it("report.json equals stats() over the committed tools-list files", () => {
    const report = JSON.parse(fs.readFileSync(path.join(BASELINE_DIR, "report.json"), "utf8"));
    expect(report.version).toBe("1.4.4");
    expect(report.commit).toBe("136e2e7");
    for (const name of Object.keys(SURFACES)) {
      const file = path.join(BASELINE_DIR, `tools-list.${name.replace(/[^a-z0-9]+/gi, "-")}.json`);
      const { tools } = JSON.parse(fs.readFileSync(file, "utf8"));
      expect(stats(tools), name).toEqual(report.surfaces[name]);
      expect(report.tokens.surfaces[name].tools, name).toBe(tools.length);
    }
    expect(report.surfaces.full.tools).toBe(163);
  });
});

describe("tools/list measured in memory", () => {
  it("matches the tool surface for every default profile", async () => {
    for (const [name, env] of Object.entries(SURFACES)) {
      const tools = await listToolsInMemory(env);
      expect(tools.length, name).toBe(toolsFor(env).length);
      expect(stats(tools).wireBytes, name).toBeGreaterThan(0);
    }
  });

  // Self-retiring: only meaningful while src/tools is byte-identical to the baseline commit.
  const toolsUntouched = (() => {
    try {
      execSync("git diff --quiet 136e2e7 -- src/tools", { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();
  it.skipIf(!toolsUntouched)("the full surface still serializes exactly as the 1.4.4 baseline while src/tools is untouched", async () => {
    const tools = await listToolsInMemory({});
    const baseline = JSON.parse(fs.readFileSync(path.join(BASELINE_DIR, "tools-list.full.json"), "utf8")).tools;
    expect(tools).toEqual(baseline);
  });
});

describe("tool-usage aggregator", () => {
  const raw = JSON.stringify({ evt: "tool_call", tool: "gmail_search_messages", user: "a@x.y", ms: 120, ok: true });
  // wrangler tail --format json emits the raw TraceItem: eventTimestamp at the top, a timestamp per log entry.
  const tail = JSON.stringify({ outcome: "ok", scriptName: "gws", eventTimestamp: Date.UTC(2026, 8, 9), logs: [{ level: "log", timestamp: Date.UTC(2026, 8, 10), message: [JSON.stringify({ evt: "tool_call", tool: "gmail_search_messages", user: "b@x.y", ms: 80, ok: true, client: "claude-ai" })] }], event: { request: { url: "https://example.invalid/mcp" } } });
  const tailNoLogTs = JSON.stringify({ eventTimestamp: Date.UTC(2026, 8, 2), logs: [{ message: [JSON.stringify({ evt: "tool_call", tool: "docs_read_document", ms: 5, ok: true })] }] });
  const logpush = JSON.stringify({ EventTimestampMs: Date.UTC(2026, 8, 1), Logs: [{ Message: [JSON.stringify({ evt: "tool_call", tool: "sheets_read_range", user: "a@x.y", ms: 0, ok: false, error: "rate_limited" })] }] });
  const noise = JSON.stringify({ logs: [{ message: ["GET /health 200"] }] });

  it("extracts access-log events from raw, wrangler-tail and Logpush lines", () => {
    expect(extractEvents(raw)).toHaveLength(1);
    expect(extractEvents(tail)[0]).toMatchObject({ tool: "gmail_search_messages", client: "claude-ai", ts: Date.UTC(2026, 8, 10) });
    expect(extractEvents(tailNoLogTs)[0]).toMatchObject({ tool: "docs_read_document", ts: Date.UTC(2026, 8, 2) });
    expect(extractEvents(logpush)[0]).toMatchObject({ tool: "sheets_read_range", error: "rate_limited" });
    expect(extractEvents(noise)).toEqual([]);
    expect(extractEvents("not json")).toEqual([]);
  });

  it("aggregates per tool × client, honours --since and never prints addresses", () => {
    const events = [raw, tail, tailNoLogTs, logpush].flatMap(extractEvents);
    const agg = aggregate(events);
    expect(agg.total).toBe(4);
    expect(agg.rows.filter((r: any) => r.tool === "gmail_search_messages").map((r: any) => r.client).sort()).toEqual(["claude-ai", "unknown"]);
    expect(agg.rows.find((r: any) => r.tool === "sheets_read_range")).toMatchObject({ client: "unknown", errors: 1, rateLimited: 1, distinctUsers: 1, p50Ms: 0 });
    const since = aggregate(events, { since: Date.UTC(2026, 8, 5) });
    expect(since.dropped).toBe(2); // the Logpush and the older tail event predate --since; the raw line has no timestamp and is kept
    const table = renderTable(agg);
    expect(table).toContain("| `gmail_search_messages` | claude-ai | 1 |");
    expect(table).not.toContain("@x.y");
  });

  it("parses --since / --since= and rejects unknown flags or a missing date", () => {
    expect(parseArgs(["a.ndjson", "--since", "2026-09-01", "--json", "b.ndjson"])).toEqual({ files: ["a.ndjson", "b.ndjson"], since: Date.parse("2026-09-01"), asJson: true });
    expect(parseArgs(["--since=2026-09-01"])).toMatchObject({ since: Date.parse("2026-09-01") });
    expect(() => parseArgs(["--since"])).toThrow(/needs a date/);
    expect(() => parseArgs(["--since", "yesterday-ish"])).toThrow(/cannot parse/);
    expect(() => parseArgs(["--sinc", "x"])).toThrow(/unknown flag/);
  });
});
