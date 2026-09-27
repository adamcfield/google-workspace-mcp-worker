#!/usr/bin/env node
/**
 * Regenerates the generated artifacts that describe the tool surface, from the source of truth:
 * src/tools/index.ts, src/tools/naming.ts and src/google/scopes.ts.
 *
 *   - README.md tool table       (between the TOOLS markers)
 *   - README.md scope table      (between the SCOPES markers)
 *   - README.md migration table  (between the RENAMES markers) — old name → new name, from RENAMES
 *   - bench/tool-aliases.json    — { "aliases": RENAMES }, so bench scoring maps pre-rename rows
 *
 *   node scripts/gen-tools-md.mjs          # rewrite them
 *   node scripts/gen-tools-md.mjs --check  # exit 1 if any of them is stale (CI)
 */
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Output goes under node_modules/.cache so bare imports (zod, the MCP SDK) resolve from this repo.
fs.mkdirSync("node_modules/.cache", { recursive: true });
const tmp = fs.mkdtempSync(path.join("node_modules", ".cache", "gws-tools-"));
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));
const out = path.join(tmp, "catalog.mjs");
await build({
  entryPoints: ["src/tools/index.ts", "src/tools/naming.ts", "src/google/scopes.ts"],
  bundle: true,
  format: "esm",
  platform: "neutral",
  outdir: tmp,
  outbase: "src",
  logLevel: "silent",
  // listing.ts imports the SDK at runtime; it resolves from node_modules next to the cache dir.
  external: ["@modelcontextprotocol/sdk/*", "agents/*", "cloudflare:*"],
});
const { TOOL_GROUPS, ALL_TOOLS } = await import(pathToFileURL(path.join(tmp, "tools/index.js")).href);
const { RENAMES, ALIAS_ARGS, ALIAS_REMOVAL_VERSION } = await import(pathToFileURL(path.join(tmp, "tools/naming.js")).href);
const { SCOPES, REQUIRED_APIS } = await import(pathToFileURL(out.replace("catalog.mjs", "google/scopes.js")).href);

const short = (s) => s.replace("https://www.googleapis.com/auth/", "");
let tools = `Total: **${ALL_TOOLS.length} tools** in ${TOOL_GROUPS.length} groups. R = read-only, W = writes, D = destructive/irreversible.\n\n`;
for (const g of TOOL_GROUPS) {
  tools += `<details><summary><b>${g.group}</b> — ${g.tools.length} tools (<code>${g.prefix}*</code>)</summary>\n\n| Tool | Mode | Scope | What it does |\n|---|---|---|---|\n`;
  for (const t of g.tools) {
    const mode = t.destructive ? "D" : t.write ? "W" : "R";
    const desc = t.description.split(/\.\s|\n/)[0].replace(/\|/g, "\\|").slice(0, 140);
    tools += `| \`${t.name}\` | ${mode} | ${t.scope ? `\`${short(t.scope)}\`` : "—"} | ${desc} |\n`;
  }
  tools += `\n</details>\n\n`;
}

let scopes = `| Group | Scope URL | Class | Why |\n|---|---|---|---|\n`;
for (const s of SCOPES) scopes += `| ${s.group} | \`${s.scope}\` | ${s.sensitivity} | ${s.why} |\n`;
scopes += `\nAPIs to enable (${REQUIRED_APIS.length}): ${REQUIRED_APIS.map((a) => `\`${a.service}\``).join(", ")}.\n`;

const renameRows = Object.entries(RENAMES);
let renames = `${renameRows.length} tools were renamed in 1.5. Every old name stays callable as a hidden alias (it is not in \`tools/list\`, and the result carries a \`deprecated\` marker) until it is removed in **${ALIAS_REMOVAL_VERSION}**.\n\n`;
renames += `| Old name (alias) | New name | Removed in |\n|---|---|---|\n`;
for (const [old, current] of renameRows) renames += `| \`${old}\` | \`${current}\` | ${ALIAS_REMOVAL_VERSION} |\n`;
// The aliases with an argument rewrite are the only ones that are not a pure rename — call them out
// where the table is read, not only in the CHANGELOG (ALIAS_ARGS is the source of truth).
const impure = Object.keys(ALIAS_ARGS);
if (impure.length) {
  renames += `\nNot a pure rename: ${impure.map((n) => `\`${n}\``).join(", ")}. It was a thin wrapper over \`${RENAMES[impure[0]]}\`, so the alias clears the free-text \`query\` and keeps the old \`folder_id\` default (\`"root"\` = My Drive root). Two defaults it cannot restore differ: \`page_size\` is 25 (was 50) and \`order_by\` is \`modifiedTime desc\` (was \`folder,name\`). Everything else passes straight through — see the CHANGELOG entry for 1.5 PR-4.\n`;
}
renames += "\n";

const readme = fs.readFileSync("README.md", "utf8");
const replace = (src, tag, body) => {
  const re = new RegExp(`(<!-- ${tag}:START -->)[\\s\\S]*?(<!-- ${tag}:END -->)`);
  if (!re.test(src)) throw new Error(`README.md is missing the ${tag} markers`);
  return src.replace(re, `$1\n${body}$2`);
};
/**
 * Inline variant: no surrounding newlines, for a count that sits mid-sentence.
 *
 * The intro line used to carry a hand-typed number. It said 160 while the generated table below
 * it said 163, which is the kind of contradiction a reader notices before anything else. Owning
 * it here means it cannot drift again.
 */
const replaceInline = (src, tag, body) => {
  const re = new RegExp(`(<!-- ${tag}:START -->)[\\s\\S]*?(<!-- ${tag}:END -->)`);
  if (!re.test(src)) throw new Error(`README.md is missing the ${tag} markers`);
  return src.replace(re, `$1${body}$2`);
};
const next = replaceInline(replace(replace(replace(readme, "TOOLS", tools), "SCOPES", scopes), "RENAMES", renames), "TOOLCOUNT", String(ALL_TOOLS.length));

const aliasesFile = "bench/tool-aliases.json";
const aliases = JSON.stringify({ aliases: RENAMES }, null, 2) + "\n";
const aliasesCurrent = fs.existsSync(aliasesFile) ? fs.readFileSync(aliasesFile, "utf8") : "";

if (process.argv.includes("--check")) {
  const stale = [];
  if (next !== readme) stale.push("README.md tool/scope/rename tables");
  if (aliases !== aliasesCurrent) stale.push(aliasesFile);
  if (stale.length) {
    console.error(`${stale.join(" and ")} stale — run: node scripts/gen-tools-md.mjs`);
    process.exit(1);
  }
  console.log("README.md tables and bench/tool-aliases.json are up to date.");
} else {
  fs.writeFileSync("README.md", next);
  fs.writeFileSync(aliasesFile, aliases);
  console.log(`README.md updated: ${ALL_TOOLS.length} tools, ${SCOPES.length} scopes, ${renameRows.length} renames. ${aliasesFile} updated.`);
}
fs.rmSync(tmp, { recursive: true, force: true });
