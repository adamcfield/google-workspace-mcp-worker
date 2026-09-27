#!/usr/bin/env node
/**
 * Run the tool-selection benchmark and write an inspectable report.
 *
 *   node scripts/jev-bench.mjs                      # deterministic selector, report to stdout
 *   node scripts/jev-bench.mjs --out bench/jev/results/<name>
 *   node scripts/jev-bench.mjs --live              # JEV answers the binary questions
 *
 * The default run needs no credentials and no network: it is the baseline every other selector is
 * compared against, and it is what CI runs on every push. Nothing about it changed when `--live`
 * was added — the deterministic path still reads no key, and a run without the flag cannot reach
 * the network however the environment is configured.
 *
 * `--live` puts one binary question per prefiltered candidate to TypeSafe's System One model,
 * reading `TYPESAFE_API_KEY` from the environment and nothing else. The key is never printed,
 * written to a report, or passed anywhere but the SDK client; the SDK's own logging is pinned off
 * because at `debug` it logs request bodies. Run it from `.github/workflows/jev-live.yml`, where
 * the key comes from a repository secret, rather than holding a key locally.
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { countTokens } from "@anthropic-ai/tokenizer";
import { scoreCase, scoreRun, renderMarkdown } from "../bench/jev/score.mjs";

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

// Bundle the tool registry the way scripts/measure-tools.mjs does (NodeNext ".js" specifiers).
// node_modules/.cache is the output dir so bare imports (zod, the SDK) resolve from this repo.
fs.mkdirSync("node_modules/.cache", { recursive: true });
const tmp = fs.mkdtempSync(path.join("node_modules", ".cache", "gws-jev-"));
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));
await build({
  entryPoints: ["src/tools/_groups.ts", "src/tools/_manifest.ts", "src/routing/select.ts", "src/routing/jev.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  outdir: tmp,
  outbase: "src",
  logLevel: "silent",
  external: ["@modelcontextprotocol/sdk/*", "agents/*", "cloudflare:*", "zod"],
});
const load = async (rel) => import(pathToFileURL(path.join(tmp, rel)).href);
const { ALL_TOOLS } = await load("tools/_groups.js");
const { buildManifest } = await load("tools/_manifest.js");
const { selectTools } = await load("routing/select.js");
const { z } = await import("zod");

const listed = new Set(ALL_TOOLS.map((t) => t.name));
const manifest = buildManifest(ALL_TOOLS, listed);
const isWrite = (name) => Boolean(manifest.find((e) => e.name === name)?.write);

// Schema cost per tool, in the shape a model is actually billed for: name + description + input
// schema. Counted with the vendored local tokenizer — this repo never calls a token-count API.
const schemaTokens = new Map(
  ALL_TOOLS.map((t) => {
    const shape = { name: t.name, description: t.description ?? "", input_schema: z.toJSONSchema(z.object(t.input ?? {}), { target: "draft-7", io: "input" }) };
    return [t.name, countTokens(JSON.stringify(shape))];
  }),
);
const catalogTokens = [...schemaTokens.values()].reduce((a, b) => a + b, 0);

// The live selector, or nothing at all. Building the client is what reads the key, so a run
// without --live cannot touch the network even if the environment holds one.
const live = argv.includes("--live");
let ask;
let jevStats;
let model = null;
if (live) {
  const { createJevAsk } = await load("routing/jev.js");
  const { TypeSafeClient } = await import("@typesafe-ai/sdk");
  let client;
  try {
    client = new TypeSafeClient({
      // The SDK logs request bodies at `debug`, and a body carries the user's request text.
      // Off is the only setting that is correct here whatever TYPESAFE_LOG_LEVEL happens to say.
      logLevel: "off",
      ...(opt("--model") ? { defaultModel: opt("--model") } : {}),
    });
  } catch (err) {
    // The SDK throws when TYPESAFE_API_KEY is absent. Say so plainly and stop: a live run that
    // quietly measured the deterministic selector would be worse than no measurement, because the
    // numbers would look like JEV's.
    console.error(`--live needs TYPESAFE_API_KEY in the environment: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
  model = client.defaultModel;
  ({ ask, stats: jevStats } = createJevAsk(client, opt("--threshold") ? { threshold: Number(opt("--threshold")) } : {}));
}

/** The live run's own counters, appended under the scorer's table. */
function renderJev(stats) {
  return [
    "",
    "## JEV calls",
    "",
    "| Measure | Value |",
    "| --- | --- |",
    `| Model | \`${stats.model}\` |`,
    `| systemOne calls | ${stats.calls} |`,
    `| Binary questions | ${stats.questions} |`,
    `| Writes answered without asking | ${stats.pinnedWrites} |`,
    `| Calls that came back unusable | ${stats.failures} |`,
    `| Input tokens | ${stats.inputTokens} |`,
    `| Output tokens | ${stats.outputTokens} |`,
    `| Mean time inside systemOne | ${stats.calls ? Math.round(stats.apiMs / stats.calls) : 0} ms |`,
    "",
  ].join("\n");
}

const { cases } = JSON.parse(fs.readFileSync("bench/jev/cases.json", "utf8"));
const rows = [];
for (const testCase of cases) {
  const started = performance.now();
  const selection = await selectTools(testCase.request, manifest, ask ? { ask } : {});
  const latencyMs = performance.now() - started;
  const tokens = selection.tools.reduce((n, name) => n + (schemaTokens.get(name) ?? 0), 0);
  rows.push(scoreCase(testCase, { ...selection, latencyMs, schemaTokens: tokens }, isWrite));
}

const report = scoreRun(rows, {
  catalogTokens,
  label: opt("--label") ?? (live ? "jev live" : "deterministic baseline"),
  selector: live
    ? `jev via TypeSafe System One (${model}) + deterministic prefilter and mutation gate`
    : "deterministic (prefilter + mutation gate, no model)",
});
// Counters only: how many calls, how many questions, what the API reported spending. No request
// text, no answers, and nothing that came back from the API verbatim.
if (jevStats) report.jev = { ...jevStats, model };
const md = renderMarkdown(report) + (jevStats ? renderJev(report.jev) : "");

const out = opt("--out");
if (out) {
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "report.md"), md);
  fs.writeFileSync(path.join(out, "report.json"), JSON.stringify({ ...report, rows }, null, 1) + "\n");
  console.log(`wrote ${path.join(out, "report.md")} and report.json`);
}
process.stdout.write(md);
process.exit(report.pass ? 0 : 1);
