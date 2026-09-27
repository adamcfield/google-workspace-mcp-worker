#!/usr/bin/env node
/**
 * Fill a committed Wrangler template with this deployment's own values.
 *
 * `wrangler.jsonc` and `wrangler.oauth.jsonc` are checked into a public repository, so they
 * carry placeholders (`REPLACE_WITH_YOUR_*`) and an example allow-list rather than one
 * operator's KV namespace ids and email addresses. Real values arrive here from the
 * environment — GitHub repository variables in the Deploy workflow, or a shell locally — and
 * this script writes the filled config next to the template.
 *
 *   node scripts/deploy-config.mjs <source.jsonc> [--out <file>]
 *
 * Environment (all three required for a deploy):
 *   TOKEN_KV_ID        id for the bearer worker's TOKEN_KV namespace (lowercase 32-hex)
 *   OAUTH_KV_ID        id for the connector's OAUTH_KV namespace (lowercase 32-hex)
 *   ALLOWED_EMAILS     this deployment's real allow-list
 *
 * The output is gitignored and MUST stay in the repository root: wrangler resolves `main`
 * and every other path relative to the config file it is handed, so a config written to a
 * temp directory deploys nothing.
 *
 * Refuses to emit a config that is not fully filled in. Each refusal prevents a specific silent
 * outage rather than a theoretical one:
 *
 *  - A placeholder KV id would bind a namespace literally named `REPLACE_WITH_YOUR_OAUTH_KV_ID`.
 *    The worker comes up, and every stored grant is gone with no error anywhere.
 *  - A malformed KV id does the same thing more quietly: Cloudflare is happy to create a
 *    namespace for a typo, so the worker comes up bound to an empty one.
 *  - A missing allow-list leaves the server failing closed, which is safe and also means every
 *    existing user is locked out of their own connector. Inheriting the template's
 *    `you@example.com` is that same outage wearing a plausible-looking value.
 *
 * All of them are better as a failed job than as a deploy nobody notices until someone tries
 * to sign in.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { stripJsonc, requireAllowList, KV_ID_RE } from "./staging-config.mjs";

/** A placeholder left for the operator to fill in. */
export const PLACEHOLDER = /^REPLACE_WITH_YOUR_/;

/** Environment variable holding the id for each KV binding this project uses. */
export const KV_ID_ENV = { TOKEN_KV: "TOKEN_KV_ID", OAUTH_KV: "OAUTH_KV_ID" };

/**
 * Fill one parsed config from `env`, returning the new config.
 *
 * Throws when a placeholder has no value to replace it: refusing to deploy is the only safe
 * response, since every alternative silently points a live worker at the wrong storage.
 */
export function fillConfig(config, env = process.env) {
  const filled = structuredClone(config);
  const missing = [];
  const reported = new Set();

  for (const namespace of filled.kv_namespaces ?? []) {
    const placeholder = String(namespace.id ?? "");
    if (!PLACEHOLDER.test(placeholder)) continue;
    const name = KV_ID_ENV[namespace.binding];
    const value = name ? String(env[name] ?? "").trim() : "";
    if (!value) {
      reported.add(placeholder);
      missing.push(`${namespace.binding}.id — set ${name ?? "the matching environment variable"}`);
      continue;
    }
    if (!KV_ID_RE.test(value)) {
      reported.add(placeholder);
      missing.push(`${name} is not a Cloudflare namespace id (expected 32 lowercase hex characters, got "${value}")`);
      continue;
    }
    namespace.id = value;
  }

  // Required, not optional. Validated before anything is written, so a bad value fails the job
  // rather than deploying a worker that refuses every sign-in.
  if (filled.vars) filled.vars.ALLOWED_EMAILS = requireAllowList(env.ALLOWED_EMAILS, "ALLOWED_EMAILS");

  // A sweep for anything the loop above does not know how to fill, so a placeholder added to
  // the template later cannot reach a deploy just because this script was not taught about it.
  for (const name of JSON.stringify(filled).match(/REPLACE_WITH_YOUR_[A-Z0-9_]+/g) ?? []) {
    if (reported.has(name)) continue;
    reported.add(name);
    missing.push(name);
  }
  if (missing.length) throw new Error(`Wrangler config is not ready to deploy: ${missing.join("; ")}`);
  return filled;
}

/** Read a template, fill it and return the JSON text to write. */
export function renderConfig(sourceText, env = process.env) {
  return JSON.stringify(fillConfig(JSON.parse(stripJsonc(sourceText)), env), null, 2) + "\n";
}

// CLI. Kept below the exports so the functions above stay unit-testable without running it.
const invokedDirectly = process.argv[1] && resolve(process.argv[1]).endsWith("deploy-config.mjs");
if (invokedDirectly) {
  const [source, ...rest] = process.argv.slice(2);
  if (!source) {
    console.error("usage: node scripts/deploy-config.mjs <source.jsonc> [--out <file>]");
    process.exit(2);
  }
  const outFlag = rest.indexOf("--out");
  const sourcePath = resolve(process.cwd(), source);
  const out = outFlag >= 0 && rest[outFlag + 1] ? resolve(process.cwd(), rest[outFlag + 1]) : sourcePath.replace(/\.jsonc$/, ".deploy.jsonc");
  writeFileSync(out, renderConfig(readFileSync(sourcePath, "utf8")));
  console.log(out);
}
