#!/usr/bin/env node
/**
 * Measures what a client pays to connect: the real tools/list payload per surface,
 * produced by the production tool registry on an in-memory MCP server, plus token
 * counts from the vendored tokenizer. No network, no Google, no API key — ever.
 *
 *   node scripts/measure-tools.mjs                         # print the report to stdout
 *   node scripts/measure-tools.mjs --current               # (re)write docs/measurements/current.md
 *   node scripts/measure-tools.mjs --check                 # exit 1 if docs/measurements/current.md is stale (CI)
 *   node scripts/measure-tools.mjs --out docs/measurements/<label> [--commit <sha>]
 *                                                          # write tools-list.<surface>.json + report.{json,md} (a baseline);
 *                                                          # --commit names the commit whose src/tools is measured (default: HEAD)
 *   node scripts/measure-tools.mjs --fidelity <samples.json>
 *                                                          # compare the local tokenizer with reference counts
 *                                                          # ([{label, text, referenceTokens, model?}]); exit 1 beyond ±10 %
 *
 * Baseline directories under docs/measurements/ are immutable once committed
 * (tests/measure.test.ts pins their hashes); only current.md is regenerated.
 */
import { build } from "esbuild";
import { execSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { countTokens } from "@anthropic-ai/tokenizer";
import { SURFACES, stats, tokenStats, fidelity, renderReport } from "./lib/measure-core.mjs";

const require = createRequire(import.meta.url);
const TOKENIZER = { name: "@anthropic-ai/tokenizer", version: require("@anthropic-ai/tokenizer/package.json").version };

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const CURRENT = "docs/measurements/current.md";

if (flag("--fidelity")) {
  // Local tokenizer vs reference counts obtained outside this repo (never an API call here).
  const samples = JSON.parse(fs.readFileSync(opt("--fidelity"), "utf8"));
  const r = fidelity(samples, countTokens);
  console.log(`| Sample | Model | reference | local (${TOKENIZER.name} ${TOKENIZER.version}) | ratio | ok |\n|---|---|---|---|---|---|`);
  for (const row of r.rows) console.log(`| ${row.label} | ${row.model} | ${row.referenceTokens} | ${row.localTokens} | ${row.ratio.toFixed(3)} | ${row.ok ? "yes" : "NO"} |`);
  console.log(`\nratio range ${r.minRatio.toFixed(3)}–${r.maxRatio.toFixed(3)}, tolerance ±${r.tolerance * 100}% → ${r.ok ? "OK" : "OUT OF TOLERANCE"}`);
  process.exit(r.ok ? 0 : 1);
}

// Bundle the tool registry the same way scripts/gen-tools-md.mjs does (NodeNext ".js" specifiers).
// Output goes under node_modules/.cache so bare imports (zod, the MCP SDK) resolve from this repo.
fs.mkdirSync("node_modules/.cache", { recursive: true });
const tmp = fs.mkdtempSync(path.join("node_modules", ".cache", "gws-measure-"));
// Remove the bundle on every exit path (stale --check exits 1, API errors throw).
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));
await build({
  entryPoints: ["src/tools/index.ts", "src/version.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  outdir: tmp,
  outbase: "src",
  logLevel: "silent",
  external: ["@modelcontextprotocol/sdk/*", "agents/*", "cloudflare:*", "zod"],
  // zod stays external so the registry and this script share one zod instance (the SDK's
  // registerTool inspects zod schemas); node_modules/.cache resolves it from this repo.
});
const { registerTools, MCP_INSTRUCTIONS } = await import(pathToFileURL(path.join(tmp, "tools/index.js")).href);
const { VERSION } = await import(pathToFileURL(path.join(tmp, "version.js")).href);

async function listTools(env) {
  const server = new McpServer({ name: "google-workspace", version: VERSION }, { instructions: MCP_INSTRUCTIONS });
  registerTools(server, { g: {}, readOnly: false, grantedScopes: [], email: "measure@example.com" }, env);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "measure-tools", version: VERSION });
  await client.connect(clientT);
  const { tools } = await client.listTools();
  await client.close();
  await server.close();
  return tools;
}

const commit = opt("--commit") ?? (() => {
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "unknown";
  }
})();

const lists = {};
const report = { version: VERSION, commit, generatedFrom: "src/tools/index.ts via an in-memory McpServer", instructionsChars: MCP_INSTRUCTIONS.length, surfaces: {}, tokens: { tokenizer: TOKENIZER, surfaces: {} } };
for (const [name, env] of Object.entries(SURFACES)) {
  lists[name] = await listTools(env);
  report.surfaces[name] = stats(lists[name]);
  report.tokens.surfaces[name] = tokenStats(lists[name], countTokens);
}

const out = opt("--out");
// current.md must not carry the commit (it would change on every commit and fail --check).
const md = renderReport(out ? report : { ...report, commit: undefined });
if (out) {
  fs.mkdirSync(out, { recursive: true });
  for (const [name, tools] of Object.entries(lists)) fs.writeFileSync(path.join(out, `tools-list.${name.replace(/[^a-z0-9]+/gi, "-")}.json`), JSON.stringify({ tools }));
  fs.writeFileSync(path.join(out, "report.json"), JSON.stringify(report, null, 1) + "\n");
  fs.writeFileSync(path.join(out, "report.md"), md);
  console.log(`wrote ${out}/ (${Object.keys(lists).length} surfaces)`);
} else if (flag("--check")) {
  const committed = fs.existsSync(CURRENT) ? fs.readFileSync(CURRENT, "utf8") : "";
  if (committed !== md) {
    console.error(`${CURRENT} is stale — run: npm run gen`);
    process.exitCode = 1;
  } else console.log(`${CURRENT} is up to date.`);
} else if (flag("--current")) {
  fs.mkdirSync(path.dirname(CURRENT), { recursive: true });
  fs.writeFileSync(CURRENT, md);
  console.log(`${CURRENT} updated (${report.surfaces.full.tools} tools, ${report.surfaces.full.wireBytes} bytes on full).`);
} else {
  process.stdout.write(md);
}
