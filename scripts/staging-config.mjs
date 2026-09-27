#!/usr/bin/env node
/**
 * Generate a staging copy of wrangler.oauth.jsonc for one of the A/B/C benchmark
 * connectors: same code, same vars, its own worker name
 * (→ its own Durable Object namespace), its own OAUTH_KV id and its own rate-limit
 * namespace id. Never reuses the production KV id (docs/OPERATIONS.md §2, Staging).
 *
 *   node scripts/staging-config.mjs <suffix> <kvNamespaceId> [--source <file>] [--out <file>]
 *                                   [--allow-base <emails/@domains>] [--allow-extra <emails/@domains>]
 *                                   [--refuse-kv-id <id>]
 *
 * `--allow-base` (or the ALLOWED_EMAILS environment variable) is REQUIRED: it is the deployment's
 * real allow-list, which the committed config no longer carries. `--allow-extra` appends to it.
 *
 * `--refuse-kv-id` (or the OAUTH_KV_ID environment variable) names the production namespace, so
 * a staging worker can never be pointed at it. The committed config cannot supply that any more:
 * it is a public template holding a placeholder, not a live id.
 *
 * Writes wrangler.staging-<suffix>.jsonc (gitignored) and prints its path. Both paths
 * default to the CURRENT WORKING DIRECTORY, never to this script's location: the Staging
 * workflow copies this file to the runner temp dir (the deployed ref may not contain it)
 * and runs it from the checkout. The output must stay in the repo root because wrangler
 * resolves `main` and the other paths relative to the config file it is given.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const NAME_PREFIX = "google-workspace-mcp-oauth";
/** Production uses 1001; staging a/b/c get 1002/1003/1004 so the limiter state never collides. */
const RATE_LIMIT_NS = { a: 1002, b: 1003, c: 1004 };

/** The only shape a Cloudflare KV namespace id has. */
export const KV_ID_RE = /^[0-9a-f]{32}$/;

/**
 * Domains reserved for documentation (RFC 2606 and friends). No mailbox at one of these can
 * receive anything, so an allow-list entry pointing at one is a template value somebody forgot
 * to replace — never a deployment's real list.
 */
const RESERVED_DOMAIN_RE = /(^|@|\.)((example\.(com|net|org))|(test|invalid|localhost|example))$/i;

/** One allow-list entry: `user@host.tld` or `@domain.tld`. */
const ALLOW_ENTRY_RE = /^(@[^@\s]+\.[^@\s]+|[^@\s]+@[^@\s]+\.[^@\s]+)$/;

/** Split an allow-list value into its entries. */
export function parseAllowList(value) {
  return String(value ?? "")
    .split(/[,\s]+/)
    .map((e) => e.trim())
    .filter(Boolean);
}

/** The domain part of an allow-list entry (`@corp.com` and `a@corp.com` both give `corp.com`). */
const domainOf = (entry) => entry.slice(entry.lastIndexOf("@") + 1).toLowerCase();

/**
 * The allow-list a deployment must be given, or an error saying which way it was wrong.
 *
 * Required rather than optional, and this is the point of the check: with no list the server
 * fails closed and lets nobody in, so a deploy that quietly proceeded without one would lock
 * every existing user out of their own account's connector with no error anywhere. Falling back
 * to the committed template's `you@example.com` is the same outage wearing a plausible value.
 *
 * `label` names the variable to set, so the failure says what to do rather than what happened.
 */
export function requireAllowList(value, label) {
  const entries = parseAllowList(value);
  if (!entries.length) throw new Error(`${label} is required and was empty — with no allow-list nobody can sign in`);
  for (const entry of entries) {
    if (!ALLOW_ENTRY_RE.test(entry)) throw new Error(`${label} entry is not an email or @domain: ${entry}`);
    if (RESERVED_DOMAIN_RE.test(domainOf(entry))) {
      throw new Error(`${label} still holds the documentation placeholder ${entry} — set it to the real allow-list`);
    }
  }
  return entries.join(", ");
}

/** Strip line and block comments that sit outside of strings (wrangler's JSONC subset). */
export function stripJsonc(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
    } else {
      out += ch;
      i++;
    }
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/**
 * Merge extra allow-list entries (comma/space separated emails and/or @domains) into an
 * existing ALLOWED_EMAILS value, case-insensitively de-duplicated, original order first.
 * Staging only: production's allow-list is never touched.
 */
export function mergeAllowList(current, extra) {
  const entries = parseAllowList(current);
  const seen = new Set(entries.map((e) => e.toLowerCase()));
  for (const e of parseAllowList(extra)) {
    if (!ALLOW_ENTRY_RE.test(e)) throw new Error(`not an email or @domain: ${e}`);
    if (seen.has(e.toLowerCase())) continue;
    seen.add(e.toLowerCase());
    entries.push(e);
  }
  return entries.join(", ");
}

export function stagingConfig(source, suffix, kvId, { allowExtra = "", refuseKvIds = [], allowBase } = {}) {
  if (!/^[a-z0-9-]{1,20}$/.test(suffix)) throw new Error(`bad suffix "${suffix}" (a-z, 0-9, -)`);
  if (!KV_ID_RE.test(kvId)) throw new Error("kvNamespaceId must be a 32-hex Cloudflare KV namespace id");
  // The base allow-list comes from the CALLER, never from the source config. Since that config
  // became a public template it carries `you@example.com`, so inheriting from it would deploy a
  // staging worker whose allow-list permits nobody — the fail-closed server would refuse every
  // sign-in, and the failure would look like a broken deployment rather than a missing variable.
  const base = requireAllowList(allowBase, "ALLOWED_EMAILS (repository variable)");
  const cfg = JSON.parse(stripJsonc(source));
  if (cfg.name !== NAME_PREFIX) throw new Error(`expected name ${NAME_PREFIX} in wrangler.oauth.jsonc, got ${cfg.name}`);
  const prodKv = cfg.kv_namespaces.find((k) => k.binding === "OAUTH_KV");
  if (!prodKv) throw new Error("OAUTH_KV binding missing from wrangler.oauth.jsonc");
  // Two refusals, because the committed config no longer knows production's id. It holds a
  // REPLACE_WITH_YOUR_* placeholder (this repository is public), so comparing against it alone
  // would let a staging deploy inherit the live namespace and write over real users' grants.
  // The workflow therefore passes the same id the Deploy workflow uses, and both are refused.
  // Compared as written: the format check above already requires lowercase 32-hex, which is the
  // only shape a Cloudflare namespace id has, so there is no casing left to normalize.
  const refused = new Set([prodKv.id, ...refuseKvIds].filter(Boolean).map(String));
  if (refused.has(String(kvId))) throw new Error("refusing to point staging at the production OAUTH_KV id");
  cfg.name = `${NAME_PREFIX}-${suffix}`;
  cfg.kv_namespaces = cfg.kv_namespaces.map((k) => (k.binding === "OAUTH_KV" ? { ...k, id: kvId } : k));
  const ns = RATE_LIMIT_NS[suffix] ?? 1000 + 10 + [...suffix].reduce((n, c) => n + c.charCodeAt(0), 0) % 900;
  cfg.ratelimits = (cfg.ratelimits ?? []).map((r) => ({ ...r, namespace_id: String(ns) }));
  // Base first, extras appended. The source config's own value is discarded rather than merged:
  // whatever a public template holds, it is not this deployment's allow-list.
  cfg.vars = { ...cfg.vars, ALLOWED_EMAILS: allowExtra ? mergeAllowList(base, allowExtra) : base };
  return cfg;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const [suffix, kvId, ...rest] = process.argv.slice(2);
  if (!suffix || !kvId) {
    console.error("usage: node scripts/staging-config.mjs <suffix> <kvNamespaceId> [--source <file>] [--out <file>] [--allow-extra <emails>]");
    process.exit(2);
  }
  const flag = (name, fallback) => {
    const i = rest.indexOf(name);
    return i >= 0 && rest[i + 1] ? resolve(rest[i + 1]) : resolve(process.cwd(), fallback);
  };
  const value = (name) => {
    const i = rest.indexOf(name);
    return i >= 0 && rest[i + 1] ? rest[i + 1] : "";
  };
  const source = flag("--source", "wrangler.oauth.jsonc");
  const out = flag("--out", `wrangler.staging-${suffix}.jsonc`);
  const refuseKvIds = [value("--refuse-kv-id"), process.env.OAUTH_KV_ID].filter(Boolean);
  const allowBase = value("--allow-base") || process.env.ALLOWED_EMAILS || "";
  let text;
  try {
    text = readFileSync(source, "utf8");
  } catch {
    console.error(`cannot read ${source} — run this from the repository root or pass --source <wrangler.oauth.jsonc>`);
    process.exit(2);
  }
  writeFileSync(out, JSON.stringify(stagingConfig(text, suffix, kvId, { allowExtra: value("--allow-extra"), refuseKvIds, allowBase }), null, 2) + "\n");
  console.log(out);
}
