/**
 * Public-repository hygiene, enforced rather than remembered.
 *
 * The leaks that actually happen here are not secrets — the secret scanner catches those — but
 * private context: a test account's address, a live deployment hostname, an internal tracker code,
 * one operator's values left in a config everybody clones. Each is individually harmless and
 * collectively tells a reader things about the operator that the project never meant to publish,
 * and every one of them was reintroduced at least once by an edit made in good faith.
 *
 * So the rule is a test. Adding one now fails CI in the pull request that adds it, which is the
 * only point at which removing it is still cheap — once it is in history, removing it means a
 * rewrite that breaks every clone.
 *
 * The rules are deliberately narrow. An earlier, broader draft flagged every invented address in
 * the suite (`a@b.com`, `someone@else.com`) and some Google API hostnames it mistook for
 * addresses. A lint that fails on ordinary test data teaches contributors to disable it.
 */

import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "coverage", ".wrangler"]);
/** Binary and generated payloads: nothing in them is prose a person wrote. */
const SKIP_EXT = /\.(png|jpe?g|gif|svg|ico|woff2?|pdf|zip)$/i;
/** npm owns the lockfile, and the immutable baselines are hash-pinned by tests/measure.test.ts. */
const SKIP_FILES = /^(package-lock\.json|docs\/measurements\/\d+\.\d+\.\d+-[0-9a-f]+\/)/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (!SKIP_EXT.test(entry)) out.push(full);
  }
  return out;
}

/** This file states the patterns it bans, so it is the one file it cannot check. */
const SELF = "tests/public-hygiene.test.ts";
const corpus = walk(ROOT)
  .map((f) => [relative(ROOT, f).split(sep).join("/"), f] as const)
  .filter(([path]) => path !== SELF && !SKIP_FILES.test(path))
  .map(([path, full]) => [path, readFileSync(full, "utf8")] as const);

/**
 * Every offending file and line at once: fixing these one CI run at a time is miserable.
 *
 * The per-line test runs on a NON-global copy of the pattern. `RegExp.prototype.test` on a `/g`
 * regex advances `lastIndex` and resumes from there on the next call, so a global pattern silently
 * skips every other matching line — which reads as a clean lint rather than a broken one.
 */
function offenders(pattern: RegExp, keep: (line: string) => boolean = () => true): string[] {
  const probe = new RegExp(pattern.source, pattern.flags.replace("g", ""));
  const hits: string[] = [];
  for (const [path, text] of corpus) {
    text.split("\n").forEach((line, i) => {
      if (probe.test(line) && keep(line)) hits.push(`${path}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
  }
  return hits;
}

describe("no private references in a public repository", () => {
  it("actually reports what it finds, on every matching line", () => {
    // A lint that quietly matches nothing is worse than no lint. Two guards: the corpus is real,
    // and a global pattern reports consecutive hits rather than every other one.
    const probe = offenders(/\bdescribe\(/g);
    expect(probe.length).toBeGreaterThan(10);
    const consecutive = offenders(/./g).length;
    expect(consecutive).toBeGreaterThan(1000);
  });

  it("reads the whole repository", () => {
    // Guard against the walk silently covering nothing — an empty corpus passes every rule below.
    expect(corpus.length).toBeGreaterThan(50);
    expect(corpus.some(([p]) => p === "README.md")).toBe(true);
    expect(corpus.some(([p]) => p.startsWith("src/"))).toBe(true);
  });

  it("carries no internal tracker or decision codes", () => {
    // Codes of the shape AFC-XXXX, "decision 13-B", "owner decision 14": meaningless to anyone
    // outside the project, and whatever they annotated belongs in the sentence instead.
    expect(offenders(/\bAFC-[A-Z0-9]{4}\b|\bowner decisions?\b|\bdecision \d+-[A-Z]\b/)).toEqual([]);
  });

  it("names nobody's mailbox at a real mail provider", () => {
    /**
     * The rule is about a REAL person's address, not about the domain. A provider domain is
     * sometimes load-bearing test data: `src/tools/meet.ts` refuses a non-TRUSTED Meet space for a
     * consumer account by matching `@gmail.com`, so the test that covers that branch has to use
     * one, and rewriting it to example.com silently stopped exercising the branch at all.
     *
     * So an anonymous local part is allowed and a named one is not. Both addresses this
     * repository actually leaked were a person's name at a provider; none of the legitimate test
     * data is. If you need a new placeholder, add it here rather than widening the rule.
     */
    const ANONYMOUS = /^(someone|somebody|anyone|nobody|user|users|test|tester|example|sample|you|me|a|b|c|x|y|z|ops|admin|owner|sandbox|consumer|person|intruder)[0-9]*$/i;
    const PROVIDER = /([\w.+-]+)@(?:gmail|googlemail|outlook|hotmail|yahoo|icloud|proton|protonmail|aol)\.(?:com|me)\b/gi;
    // The decision is made on the WHOLE line, through `keep`, never on the truncated string the
    // report prints. Re-parsing that string missed every address past its 120th character.
    expect(
      offenders(PROVIDER, (line) => [...line.matchAll(PROVIDER)].some((m) => !ANONYMOUS.test(m[1]))),
    ).toEqual([]);
  });

  it("names no private organisation, not even in test data", () => {
    /**
     * Some names are private in themselves: the operator's employer, an internal team. A rule that
     * spelled them out would publish them, so it holds SHA-256 digests of the lower-cased word and
     * reports only where a match is, never the word. To add one:
     *   node -e 'console.log(require("crypto").createHash("sha256").update("word").digest("hex"))'
     * An address at the employer's domain was reintroduced as "realistic" routing test data after
     * the provider-mailbox rule above shipped; that rule never looked at company domains.
     */
    const PRIVATE_WORDS = new Set([
      "d25e715a1ce00764951fcf764f3de002e766a320c4e699c78fc055d6a4dc17b0",
      "26e59d6a3c92de8027609f4f2bff399c3cdb20c68cfb2be587f6452c0377cdb8",
    ]);
    const digest = (word: string) => createHash("sha256").update(word).digest("hex");
    const privateWords = (line: string, digests: Set<string>) => (line.toLowerCase().match(/[a-z0-9]+/g) ?? []).some((w) => digests.has(digest(w)));
    // The probe proves the tokenising and hashing see real words before an empty result counts.
    expect(corpus.some(([, text]) => text.split("\n").some((line) => privateWords(line, new Set([digest("describe")]))))).toBe(true);
    const hits: string[] = [];
    for (const [path, text] of corpus) {
      text.split("\n").forEach((line, i) => {
        if (privateWords(line, PRIVATE_WORDS)) hits.push(`${path}:${i + 1}`);
      });
    }
    expect(hits).toEqual([]);
  });

  it("commits no live deployment hostname", () => {
    // A workers.dev host is useful documentation when its subdomain is a placeholder or comes
    // from a variable. A real one names somebody's running deployment.
    expect(offenders(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/i, (line) => !/<[a-z-]+>|\$\{?[A-Z_]+/.test(line))).toEqual([]);
  });

  it("ships deployment configuration as a template, not as one operator's values", () => {
    // The configs are the highest-risk file: they are what a deploy reads, so a real value here
    // is both a leak and a booby trap for whoever clones this next.
    for (const name of ["wrangler.jsonc", "wrangler.oauth.jsonc"]) {
      const text = corpus.find(([path]) => path === name)?.[1];
      expect(text, `${name} not found`).toBeDefined();
      expect(text, name).toMatch(/"ALLOWED_EMAILS":\s*"[^"]*@(example\.(com|net|org)|your-company\.com)/);
      for (const id of text!.matchAll(/"id":\s*"([^"]+)"/g)) expect(id[1], `${name} kv id`).toMatch(/^REPLACE_WITH_YOUR_/);
    }
  });
});
