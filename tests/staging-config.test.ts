/**
 * scripts/staging-config.mjs — the generator behind the `Staging` workflow.
 * The staging copies must never inherit production's KV namespace or
 * rate-limit namespace, and must keep everything else (code, vars, migrations) identical.
 */
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { mergeAllowList, requireAllowList, stagingConfig, stripJsonc, type WranglerConfig } from "../scripts/staging-config.mjs";

const SOURCE = readFileSync(new URL("../wrangler.oauth.jsonc", import.meta.url), "utf8");
const PROD = JSON.parse(stripJsonc(SOURCE)) as WranglerConfig;
const oauthKv = (cfg: WranglerConfig) => cfg.kv_namespaces.find((k) => k.binding === "OAUTH_KV")!;
const rateNs = (cfg: WranglerConfig) => cfg.ratelimits![0]!.namespace_id;
const KV_A = "0".repeat(31) + "1";

describe("requireAllowList", () => {
  /**
   * The shared rule behind both generators. It is strict on purpose: an empty or placeholder
   * allow-list does not fail loudly at deploy time, it produces a running worker that refuses
   * every sign-in — which reads as a broken service rather than as a variable nobody set.
   */
  it("accepts a real list and normalises its separators", () => {
    expect(requireAllowList("a@corp.example-real.net,@corp.example-real.net", "X")).toBe("a@corp.example-real.net, @corp.example-real.net");
    expect(requireAllowList("  a@corp.example-real.net \n b@other-real.net ", "X")).toBe("a@corp.example-real.net, b@other-real.net");
  });

  it("refuses an empty value, naming the variable to set", () => {
    for (const empty of [undefined, "", "   ", ",", " , "]) {
      expect(() => requireAllowList(empty as string | undefined, "ALLOWED_EMAILS"), String(empty)).toThrow(/ALLOWED_EMAILS is required/);
    }
  });

  it("refuses documentation-reserved domains, which can never receive mail", () => {
    // `@localhost` is refused too, but by the format rule below — it has no dot.
    for (const placeholder of ["you@example.com", "@example.com", "a@example.net", "a@example.org", "a@host.invalid", "a@host.test", "@sub.example.com"]) {
      expect(() => requireAllowList(placeholder, "X"), placeholder).toThrow(/documentation placeholder/);
    }
  });

  it("does not mistake a real domain that merely contains a reserved word", () => {
    for (const real of ["a@example-real.net", "@testing.co", "a@my.example-corp.com", "@invalid-name.com"]) {
      expect(requireAllowList(real, "X"), real).toBe(real);
    }
  });

  it("refuses an entry that is not an email or an @domain", () => {
    for (const bad of ["not-an-email", "@nodot", "a@b", "*"]) expect(() => requireAllowList(bad, "X"), bad).toThrow(/not an email or @domain/);
  });
});

describe("stripJsonc", () => {
  it("drops line and block comments but keeps them inside strings", () => {
    expect(JSON.parse(stripJsonc('{ // note\n "a": "http://x/y", /* b */ "c": 1, }'))).toEqual({ a: "http://x/y", c: 1 });
  });

  it("parses the real wrangler.oauth.jsonc", () => {
    expect(PROD.name).toBe("google-workspace-mcp-oauth");
    expect(PROD.main).toBe("src/oauth.ts");
  });
});

describe("stagingConfig", () => {
  const BASE = "ops@corp.example-real.net, @corp.example-real.net";
  const cfg = stagingConfig(SOURCE, "a", KV_A, { allowBase: BASE });

  it("renames the worker (a worker name is its Durable Object namespace)", () => {
    expect(cfg.name).toBe("google-workspace-mcp-oauth-a");
    expect(cfg.main).toBe(PROD.main);
    expect(cfg.migrations).toEqual(PROD.migrations);
    expect(cfg.durable_objects).toEqual(PROD.durable_objects);
    // Every var is carried over verbatim EXCEPT the allow-list, which is supplied by the caller
    // rather than inherited from a public template that holds a placeholder.
    const { ALLOWED_EMAILS: staged, ...rest } = cfg.vars as Record<string, string>;
    const { ALLOWED_EMAILS: template, ...prodRest } = PROD.vars as Record<string, string>;
    expect(rest).toEqual(prodRest);
    expect(staged).toBe(BASE);
    expect(template).toBe("you@example.com");
    expect(cfg.compatibility_flags).toEqual(PROD.compatibility_flags);
  });

  it("points OAUTH_KV at the staging namespace and nowhere near production's", () => {
    expect(oauthKv(cfg).id).toBe(KV_A);
    expect(JSON.stringify(cfg)).not.toContain(oauthKv(PROD).id);
  });

  it("gives each staging worker its own rate-limit namespace id", () => {
    const ns = (s: string) => rateNs(stagingConfig(SOURCE, s, KV_A, { allowBase: BASE }));
    expect(new Set([ns("a"), ns("b"), ns("c")]).size).toBe(3);
    expect([ns("a"), ns("b"), ns("c")]).not.toContain(rateNs(PROD));
  });

  it("refuses the production KV id named by the caller, a bad suffix and a malformed namespace id", () => {
    // The committed config is a public template holding a placeholder, so it cannot name the
    // live namespace any more. The workflow passes it in instead, and it is still refused —
    // pointing a staging worker at production's OAUTH_KV would overwrite real users' grants.
    const live = "0123456789abcdef0123456789abcdef";
    expect(() => stagingConfig(SOURCE, "a", live, { allowBase: BASE, refuseKvIds: [live] })).toThrow(/production OAUTH_KV/);
    expect(() => stagingConfig(SOURCE, "A/b", KV_A, { allowBase: BASE })).toThrow(/bad suffix/);
    expect(() => stagingConfig(SOURCE, "a", "nothex", { allowBase: BASE })).toThrow(/32-hex/);
  });

  it("still refuses whatever id the source config itself carries", () => {
    const filled = SOURCE.replace(oauthKv(PROD).id, "0123456789abcdef0123456789abcdef");
    expect(() => stagingConfig(filled, "a", "0123456789abcdef0123456789abcdef", { allowBase: BASE })).toThrow(/production OAUTH_KV/);
  });

  it("refuses a source whose worker name is not the production connector", () => {
    expect(() => stagingConfig(SOURCE.replace('"google-workspace-mcp-oauth"', '"something-else"'), "a", KV_A, { allowBase: BASE })).toThrow(/expected name/);
  });
});

describe("the CLI the Staging workflow runs", () => {
  const script = fileURLToPath(new URL("../scripts/staging-config.mjs", import.meta.url));
  const source = fileURLToPath(new URL("../wrangler.oauth.jsonc", import.meta.url));
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));

  /**
   * The workflow copies the script to the runner temp dir (the deployed ref need not carry
   * it), so paths must come from --source / --out or the cwd, never from the script's own
   * location — resolving them from the script is what broke run 35433290822.
   */
  it("works when the script is run from outside the repository", () => {
    const away = mkdtempSync(join(tmpdir(), "staging-cli-"));
    const copied = join(away, "staging-config.mjs");
    const out = join(away, "wrangler.staging-a.jsonc");
    execFileSync("cp", [script, copied]);
    const printed = execFileSync("node", [copied, "a", KV_A, "--source", source, "--out", out], {
      cwd: away,
      encoding: "utf8",
      env: { ...process.env, ALLOWED_EMAILS: "ops@corp.example-real.net" },
    }).trim();
    expect(printed).toBe(out);
    const written = JSON.parse(readFileSync(out, "utf8"));
    expect(written.name).toBe("google-workspace-mcp-oauth-a");
    // The environment variable is a real input path, not only the flag.
    expect(written.vars.ALLOWED_EMAILS).toBe("ops@corp.example-real.net");
  });

  it("exits 2 with an explanation when the source config is not there", () => {
    const away = mkdtempSync(join(tmpdir(), "staging-cli-"));
    try {
      execFileSync("node", [script, "a", KV_A, "--out", join(away, "x.jsonc")], {
        cwd: away,
        encoding: "utf8",
        stdio: "pipe",
        env: { ...process.env, ALLOWED_EMAILS: "ops@corp.example-real.net" },
      });
      throw new Error("expected a non-zero exit");
    } catch (err) {
      const e = err as { status?: number; stderr?: string };
      expect(e.status).toBe(2);
      expect(e.stderr).toMatch(/cannot read .*wrangler\.oauth\.jsonc/);
    }
  });

  /** wrangler resolves `main` relative to the config file, so the config must be written into the checkout. */
  it("the workflow generates the config inside the checkout and passes an explicit source", () => {
    const wf = readFileSync(join(repoRoot, ".github/workflows/staging.yml"), "utf8");
    const call = wf.split("\n").find((l) => l.includes("staging-config.mjs") && l.includes("--out"));
    expect(call).toBeDefined();
    expect(call).toContain('--source "$GITHUB_WORKSPACE/wrangler.oauth.jsonc"');
    expect(call).toContain('--out "$GITHUB_WORKSPACE/wrangler.staging-$x.jsonc"');
    expect(call).not.toContain('--out "$RUNNER_TEMP');
  });
});

/** Staging-only allow-list widening. Production's allow-list is never touched. */
describe("allow-list merging", () => {
  it("appends extra entries, keeps the original order and de-duplicates case-insensitively", () => {
    expect(mergeAllowList("a@b.com, @x.io", "A@B.COM, c@d.org, @X.IO")).toBe("a@b.com, @x.io, c@d.org");
    expect(mergeAllowList("", "a@b.com")).toBe("a@b.com");
    expect(mergeAllowList("a@b.com", "")).toBe("a@b.com");
    expect(mergeAllowList(undefined, "a@b.com b@c.com")).toBe("a@b.com, b@c.com");
  });

  it("refuses anything that is not an email or an @domain", () => {
    for (const bad of ["not-an-email", "@nodot", "a@b", "*", "@"]) expect(() => mergeAllowList("a@b.com", bad)).toThrow(/not an email or @domain/);
  });

  const BASE_LIST = "ops@corp.example-real.net, @corp.example-real.net";
  const allowOf = (cfg: WranglerConfig) => (cfg.vars as Record<string, string>).ALLOWED_EMAILS;

  it("starts the generated allow-list from the caller's base, not from the committed template", () => {
    // The committed config is a public template holding `you@example.com`. Inheriting from it
    // would deploy a staging worker whose fail-closed allow-list permits nobody, and the failure
    // would read as a broken deployment rather than as a variable nobody set.
    expect(allowOf(stagingConfig(SOURCE, "a", KV_A, { allowBase: BASE_LIST }))).toBe(BASE_LIST);
  });

  it("appends extras to that base, in order", () => {
    const widened = stagingConfig(SOURCE, "a", KV_A, { allowBase: BASE_LIST, allowExtra: "sandbox@corp.example-real.net" });
    expect(allowOf(widened)).toBe(`${BASE_LIST}, sandbox@corp.example-real.net`);
  });

  it("never lets the committed template address reach a generated config", () => {
    for (const opts of [{ allowBase: BASE_LIST }, { allowBase: BASE_LIST, allowExtra: "sandbox@corp.example-real.net" }]) {
      expect(JSON.stringify(stagingConfig(SOURCE, "a", KV_A, opts))).not.toContain("you@example.com");
    }
  });

  it("refuses to generate anything when the base allow-list is missing, blank or still a placeholder", () => {
    for (const bad of [undefined, "", "   ", "you@example.com", "@example.com", "a@example.org"]) {
      expect(() => stagingConfig(SOURCE, "a", KV_A, { allowBase: bad }), String(bad)).toThrow(/ALLOWED_EMAILS/);
    }
  });

  it("leaves the production source untouched", () => {
    // Both the parsed config this suite shares and the file on disk.
    stagingConfig(SOURCE, "a", KV_A, { allowBase: BASE_LIST, allowExtra: "sandbox@corp.example-real.net" });
    expect(allowOf(PROD)).toMatch(/@example\.com$/);
    const onDisk = readFileSync(fileURLToPath(new URL("../wrangler.oauth.jsonc", import.meta.url)), "utf8");
    expect(onDisk).not.toContain("sandbox@corp.example-real.net");
    expect(onDisk).not.toContain(BASE_LIST);
  });

  it("the workflow passes its extra_allowed_emails input to the generator", () => {
    const wf = readFileSync(fileURLToPath(new URL("../.github/workflows/staging.yml", import.meta.url)), "utf8");
    expect(wf).toContain("extra_allowed_emails:");
    const call = wf.split("\n").find((l) => l.includes("staging-config.mjs") && l.includes("--out"));
    expect(call).toContain("--allow-extra");
    // The default is EMPTY. This repository is public, so no address is committed to a workflow
    // file; an operator who wants a test account allowed across staging deploys sets the default
    // in their own fork. Pinned here so it cannot drift back.
    expect(wf).toMatch(/extra_allowed_emails:[\s\S]*?default: ''/);
  });

  it("names the production namespace to the generator so staging can never inherit it", () => {
    const wf = readFileSync(fileURLToPath(new URL("../.github/workflows/staging.yml", import.meta.url)), "utf8");
    const call = wf.split("\n").find((l) => l.includes("staging-config.mjs") && l.includes("--out"));
    expect(call).toContain("--refuse-kv-id");
  });

  it("passes the repository allow-list as the generator's base", () => {
    const wf = readFileSync(fileURLToPath(new URL("../.github/workflows/staging.yml", import.meta.url)), "utf8");
    const call = wf.split("\n").find((l) => l.includes("staging-config.mjs") && l.includes("--out"));
    expect(call).toContain("--allow-base");
    expect(call).toContain("vars.ALLOWED_EMAILS");
  });

  it("fails the job before deploying anything when that variable is absent", () => {
    const wf = readFileSync(fileURLToPath(new URL("../.github/workflows/staging.yml", import.meta.url)), "utf8");
    const guard = wf.indexOf("Require the allow-list this deployment actually uses");
    expect(guard).toBeGreaterThan(-1);
    // Before the namespace lookup/creation step, so a missing variable costs nothing.
    expect(guard).toBeLessThan(wf.indexOf("staging-config.mjs"));
    expect(wf.slice(guard, guard + 800)).toMatch(/::error::/);
  });

  it("keeps the allow-list out of the job log", () => {
    // Addresses are personal data. The count is what an operator needs to sanity-check a run.
    const wf = readFileSync(fileURLToPath(new URL("../.github/workflows/staging.yml", import.meta.url)), "utf8");
    // Lines that print the VALUE — an interpolation or a jq read of the generated config. A line
    // that merely names the variable, like the error telling an operator to set it, is fine.
    const leaks = wf
      .split("\n")
      .filter((l) => l.includes("echo"))
      .filter((l) => /\$\{\{\s*vars\.ALLOWED_EMAILS|\$ALLOWED_EMAILS|\.vars\.ALLOWED_EMAILS/.test(l));
    for (const line of leaks) expect(line, line).toMatch(/length|entries/);
  });

  it("builds its health-check URLs from a repository variable, committing no live host", () => {
    const wf = readFileSync(fileURLToPath(new URL("../.github/workflows/staging.yml", import.meta.url)), "utf8");
    expect(wf).toContain("vars.WORKERS_SUBDOMAIN");
    // Every host is either built from that variable or a documentation placeholder. Anything
    // else is a live URL someone pasted into a file this repository publishes.
    for (const url of wf.match(/https:\/\/[^\s"']*workers\.dev/g) ?? []) {
      expect(url, url).toMatch(/\$WORKERS_SUBDOMAIN|<[a-z-]+>/);
    }
  });
});

describe("the QA worker", () => {
  const QA = () => stagingConfig(SOURCE, "qa", KV_A, { allowBase: "ops@corp.example-real.net" });

  it("is its own worker, not production and not a/b/c", () => {
    const qa = QA();
    expect(qa.name).toBe("google-workspace-mcp-oauth-qa");
    expect(qa.name).not.toBe(PROD.name);
    for (const suffix of ["a", "b", "c"]) expect(qa.name).not.toBe(`google-workspace-mcp-oauth-${suffix}`);
  });

  it("gets a rate-limit namespace that collides with nothing already deployed", () => {
    // Production is 1001 and a/b/c are 1002/1003/1004. A collision would make two workers share
    // one limiter, so QA traffic could rate-limit a real user.
    const taken = new Set([rateNs(PROD), "1002", "1003", "1004"]);
    expect(taken.has(rateNs(QA()))).toBe(false);
  });

  it("cannot be pointed at production's KV namespace", () => {
    const live = "0123456789abcdef0123456789abcdef";
    expect(() => stagingConfig(SOURCE, "qa", live, { allowBase: "ops@corp.example-real.net", refuseKvIds: [live] })).toThrow(/production OAUTH_KV/);
  });

  it("keeps the code, migrations and every other binding identical to production", () => {
    const qa = QA();
    expect(qa.main).toBe(PROD.main);
    expect(qa.migrations).toEqual(PROD.migrations);
    expect(qa.durable_objects).toEqual(PROD.durable_objects);
    expect(oauthKv(qa).id).not.toBe(oauthKv(PROD).id);
  });
});

const QA_WORKFLOW = readFileSync(fileURLToPath(new URL("../.github/workflows/qa.yml", import.meta.url)), "utf8");

/**
 * One job of qa.yml as text, comments included: the comment block directly above its key through
 * to the comment block above the next job's key (or the end of the file). A job that does not
 * exist throws — slicing from `indexOf(...) === -1` would quietly hand a test the whole file, and
 * a test that asserts something is ABSENT from a job would then pass on the wrong text.
 */
function jobText(wf: string, name: string): string {
  const lines = wf.split("\n");
  const key = lines.indexOf(`  ${name}:`);
  if (key < 0) throw new Error(`qa.yml has no job "${name}"`);
  const isJobKey = (l: string) => /^ {2}[A-Za-z0-9_-]+:\s*$/.test(l);
  const isLeadIn = (l: string) => /^ {2}#/.test(l) || l.trim() === "";
  let start = key;
  while (start > 0 && /^ {2}#/.test(lines[start - 1]!)) start--;
  let end = lines.findIndex((l, i) => i > key && isJobKey(l));
  if (end < 0) end = lines.length;
  else while (end > key && isLeadIn(lines[end - 1]!)) end--;
  return lines.slice(start, end).join("\n");
}

describe("the QA workflow", () => {
  const wf = QA_WORKFLOW;
  const verifyJob = jobText(wf, "verify");
  const deployJob = jobText(wf, "deploy");

  it("cannot name the v1.5 workstream's a/b/c copies", () => {
    // The reason this exists rather than a Staging dispatch: Staging takes a LIST of suffixes, so
    // a typo there reaches another workstream's environment. Here the suffix is fixed, and the
    // file may not name those workers at all.
    expect(wf).toMatch(/SUFFIX:\s*qa/);
    for (const suffix of ["a", "b", "c"]) expect(wf).not.toContain(`google-workspace-mcp-oauth-${suffix}`);
  });

  it("refuses production's KV id, in the generator and again before publishing", () => {
    expect(verifyJob).toContain("--refuse-kv-id");
    expect(deployJob).toContain('"$QA_KV_ID" = "$PROD_KV_ID"');
    for (const line of wf.split("\n").filter((l) => l.includes("wrangler deploy") || l.includes("WRANGLER\" deploy"))) {
      expect(line, line).toMatch(/-c "\$/);
    }
  });

  it("requires an explicit ref, so a QA deploy is always bound to a reviewed commit", () => {
    const ref = wf.slice(wf.indexOf("      ref:"), wf.indexOf("extra_allowed_emails:"));
    expect(ref).toMatch(/required:\s*true/);
    expect(ref).not.toMatch(/default:/);
  });

  it("takes only an immutable 40-hex commit id, never a branch or tag", () => {
    // A branch or tag can be moved between the moment it is validated and the moment it is
    // checked out; a commit id cannot, which is what closes that window.
    expect(wf).toContain('[ "${#REF}" -ne 40 ]');
    expect(wf).toMatch(/tr -d '0-9a-f'/);
    expect(wf).toMatch(/git checkout --detach "\$SHA"/);
    expect(wf).toMatch(/git rev-parse HEAD.*= "\$SHA"/);
  });

  it("refuses a commit that is not contained in a reviewed branch", () => {
    // An arbitrary work branch's tip is not an ancestor of main or release/*, so this workflow
    // cannot be used to run unreviewed code with deployment credentials.
    expect(verifyJob).toContain("git merge-base --is-ancestor");
    expect(verifyJob).toContain("refs/remotes/origin/main");
    expect(verifyJob).toContain("refs/remotes/origin/release/*");
  });

  it("runs the dispatcher's code in a job that holds no credential at all", () => {
    expect(verifyJob).not.toContain("secrets.");
    for (const step of ["npm ci", "npm run typecheck", "npm test"]) {
      expect(verifyJob, step).toContain(step);
    }
  });

  it("builds the deployable worker in that credential-free job and publishes it with digests", () => {
    // The build is the dangerous part — it executes the selected commit's own tooling. It happens
    // once, where there is nothing to steal, and what comes out is fixed by a hash.
    expect(verifyJob).toContain("--dry-run --outdir");
    expect(verifyJob).toContain("MANIFEST.sha256");
    expect(verifyJob).toContain("provenance.json");
    expect(verifyJob).toContain("upload-artifact");
  });

  it("never installs the project's dependencies or rebuilds under credentials", () => {
    // The credentialed job publishes bytes. It does not check out the selected commit, does not
    // install its dependencies, and does not bundle.
    expect(deployJob).not.toContain("npm ci");
    expect(deployJob).not.toContain("git checkout --detach");
    expect(deployJob).toContain("--no-bundle");
    // The one thing it does install is the pinned Wrangler that built the artifact, with no
    // lifecycle scripts and nothing from the commit being deployed.
    expect(deployJob).toMatch(/npm i --no-save --ignore-scripts[^\n]*"wrangler@\$WRANGLER_VERSION"/);
  });

  it("verifies the artifact before it publishes it", () => {
    expect(deployJob).toContain("sha256sum -c --strict");
    expect(deployJob).toContain('"$got" = "$EXPECTED_DIGEST"');
    expect(deployJob).toContain('.source_sha provenance.json)" = "$SHA"');
    // And the verification has to come first, or it proves nothing.
    expect(deployJob.indexOf("sha256sum -c --strict")).toBeLessThan(deployJob.indexOf("deploy --no-bundle"));
  });

  it("lets the credentialed job change nothing but the KV namespace id", () => {
    expect(deployJob).toMatch(/diff <\(norm wrangler\.qa\.json\) <\(norm wrangler\.qa\.deploy\.json\)/);
    expect(deployJob).toContain('.name wrangler.qa.json)" = "$WORKER"');
  });

  it("never puts a secret in job or workflow scope", () => {
    // Job-level env keys sit at 6 spaces, a step's at 10. Anything shallower than a step's env
    // would hand every step in the job the credential.
    for (const line of wf.split("\n").filter((l) => l.includes("secrets."))) {
      expect(line.length - line.trimStart().length, line).toBeGreaterThanOrEqual(10);
    }
  });

  it("does not gate on production parity", () => {
    // Staging fails unless version and tools EQUAL production's. A QA build is meant to differ,
    // so this workflow reports them and gates on liveness instead.
    expect(wf).not.toContain("production: version=");
    expect(wf).toContain("mode=$m");
  });

  it("keeps the allow-list out of the job log", () => {
    const leaks = wf
      .split("\n")
      .filter((l) => l.includes("echo"))
      .filter((l) => /\$\{\{\s*vars\.ALLOWED_EMAILS|\$ALLOWED_EMAILS|\.vars\.ALLOWED_EMAILS/.test(l));
    for (const line of leaks) expect(line, line).toMatch(/length|entries/);
  });

  it("commits no live host", () => {
    expect(wf).toContain("vars.WORKERS_SUBDOMAIN");
    for (const url of wf.match(/https:\/\/[^\s"']*workers\.dev/g) ?? []) {
      expect(url, url).toMatch(/\$WORKERS_SUBDOMAIN|<[a-z-]+>/);
    }
  });
});

describe("the QA workflow turns JEV on, for QA and nowhere else", () => {
  const wf = QA_WORKFLOW;
  const verifyJob = jobText(wf, "verify");
  const deployJob = jobText(wf, "deploy");
  const buildStep = verifyJob.slice(verifyJob.indexOf("Build the deployable Worker"), verifyJob.indexOf("upload-artifact"));

  it("sets the flag in the credential-free job, before the artifact is built", () => {
    // Inside the reviewed artifact, not bolted on by the credentialed job afterwards: that is what
    // keeps the digest boundary meaningful rather than merely unchanged on paper.
    expect(buildStep).toContain(`jq '.vars.JEV_ENABLED = "true"'`);
    expect(buildStep.indexOf("JEV_ENABLED")).toBeLessThan(buildStep.indexOf("wrangler deploy --dry-run"));
    expect(buildStep).toContain(`[ "$(jq -r '.vars.JEV_ENABLED' "$cfg")" = "true" ]`);
    // The credentialed job must not be the one that introduces it.
    expect(deployJob).not.toContain(`.vars.JEV_ENABLED =`);
  });

  it("leaves every committed config without the flag, so production and a/b/c cannot inherit it", () => {
    for (const f of ["wrangler.oauth.jsonc", "wrangler.jsonc"]) {
      expect(readFileSync(fileURLToPath(new URL(`../${f}`, import.meta.url)), "utf8"), f).not.toContain("JEV_ENABLED");
    }
    // Staging builds the a/b/c copies from the same generator and must stay untouched by this.
    expect(readFileSync(fileURLToPath(new URL("../.github/workflows/staging.yml", import.meta.url)), "utf8")).not.toContain("JEV_ENABLED");
    expect(readFileSync(fileURLToPath(new URL("../.github/workflows/deploy.yml", import.meta.url)), "utf8")).not.toContain("JEV_ENABLED");
    // And the generator itself learns nothing about it: the flag is the workflow's, not a default.
    expect(readFileSync(fileURLToPath(new URL("../scripts/staging-config.mjs", import.meta.url)), "utf8")).not.toContain("JEV_ENABLED");
  });

  it("keeps the TypeSafe key out of the job that runs the dispatcher's code", () => {
    expect(verifyJob).not.toContain("TYPESAFE_API_KEY");
    // Exactly one step is given the secret. Another step NAMES it — the health gate says which
    // secret is missing when the worker comes up unconfigured — and naming it is the point.
    const holders = deployJob.split(/\n      - /).filter((s) => s.includes("secrets.TYPESAFE_API_KEY"));
    expect(holders).toHaveLength(1);
    expect(holders[0]).toContain(`"$WRANGLER" secret put TYPESAFE_API_KEY`);
    // Step-level env only — the indentation rule the other tests use.
    for (const line of wf.split("\n").filter((l) => l.includes("secrets.TYPESAFE_API_KEY"))) {
      expect(line.length - line.trimStart().length, line).toBeGreaterThanOrEqual(10);
    }
  });

  it("never echoes the key, puts it on a command line, or lets it reach an artifact", () => {
    const step = deployJob.split(/\n      - /).find((s) => s.includes("secrets.TYPESAFE_API_KEY"))!;
    // stdin, never an argument: a command line is visible in a process listing and in traces.
    expect(step).toContain(`printf '%s' "$TYPESAFE_API_KEY" | "$WRANGLER" secret put`);
    for (const line of step.split("\n").filter((l) => l.includes("echo"))) {
      expect(line, line).not.toContain("$TYPESAFE_API_KEY");
    }
    // Not into an output, the manifest, the provenance record or the uploaded artifact.
    for (const sink of ["GITHUB_OUTPUT", "GITHUB_ENV", "GITHUB_STEP_SUMMARY", "MANIFEST", "provenance"]) {
      expect(step, sink).not.toContain(sink);
    }
    expect(buildStep).not.toContain("TYPESAFE");
  });

  it("proves readiness from /health, and fails when either half is missing", () => {
    expect(deployJob).toContain(".jevEnabled // false");
    expect(deployJob).toContain(".jevConfigured // false");
    expect(deployJob).toContain('[ "$je" = "true" ]');
    expect(deployJob).toContain('[ "$jc" = "true" ]');
    // Reported as evidence too, not only gated on.
    expect(deployJob).toContain("| JEV enabled |");
    expect(deployJob).toContain("| JEV configured |");
    // The two booleans are all that is read: no part of the key is echoed from the body.
    expect(deployJob).not.toMatch(/jq -r '\.typesafe|TYPESAFE_API_KEY.*echo/);
  });

  it("changes nothing about the exact-SHA rule or the artifact boundary", () => {
    // The guarantees the earlier gate rounds bought, re-asserted here so this PR cannot erode them.
    expect(wf).toContain('[ "${#REF}" -ne 40 ]');
    expect(verifyJob).toContain("git merge-base --is-ancestor");
    expect(deployJob).toContain("sha256sum -c --strict");
    expect(deployJob).toContain("--no-bundle");
    expect(deployJob).not.toContain("npm ci");
    expect(deployJob.indexOf("sha256sum -c --strict")).toBeLessThan(deployJob.indexOf("deploy --no-bundle"));
  });
});

type WorkflowStep = { name?: string; uses?: string; with?: Record<string, unknown>; env?: Record<string, string>; run?: string };
type WorkflowJob = {
  needs?: string | string[];
  if?: string;
  "runs-on"?: string;
  permissions?: Record<string, string>;
  env?: Record<string, string>;
  steps: WorkflowStep[];
};
type Workflow = { env?: Record<string, string>; permissions?: Record<string, string>; jobs: Record<string, WorkflowJob> };

describe("the QA workflow smokes the deployed commit with that commit's own script", () => {
  /**
   * The failure this block exists for: the post-deploy checks were a step at the end of `deploy`,
   * which checked out the branch the workflow was DISPATCHED on (main) rather than the commit it
   * deployed. A QA run of a release/* commit therefore ran main's scripts/smoke.mjs, and the
   * checks that shipped with the deployed commit — the consent-submission assertions — never
   * printed at all. Nothing failed; the run just proved less than it appeared to.
   */
  const wf = QA_WORKFLOW;
  const doc = parseYaml(wf) as Workflow;
  // An empty stand-in rather than a throw, so a missing job fails each rule below by name instead
  // of failing the whole file at collection.
  const smoke: WorkflowJob = doc.jobs.smoke ?? { steps: [] };
  const deploy = doc.jobs.deploy!;
  const verify = doc.jobs.verify!;
  const checkouts = (job: WorkflowJob) => job.steps.filter((s) => s.uses?.startsWith("actions/checkout@"));
  const setupNode = (job: WorkflowJob) => job.steps.find((s) => s.uses?.startsWith("actions/setup-node@"));
  const runSteps = (job: WorkflowJob) => job.steps.filter((s) => typeof s.run === "string");
  const needs = (job: WorkflowJob) => [job.needs ?? []].flat();

  it("parses, and every job-level env reads only contexts GitHub allows there", () => {
    // GitHub checks each key's expression contexts before it schedules anything. A `runner.*`
    // expression in a job-level `env:` got this whole file rejected once — a run with zero jobs
    // and nothing in the log pointing at the line. `runner`, `steps`, `job` and `env` are the ones
    // that are not available at that level.
    expect(Object.keys(doc.jobs)).toEqual(["verify", "deploy", "smoke"]);
    const roots = (value: string) =>
      [...value.matchAll(/\$\{\{(.*?)\}\}/g)].flatMap((m) => [...m[1]!.matchAll(/(?<![\w.'"-])([A-Za-z_][\w-]*)\s*\./g)].map((r) => r[1]!));
    const JOB_ENV = new Set(["github", "needs", "strategy", "matrix", "vars", "secrets", "inputs"]);
    for (const [name, job] of Object.entries(doc.jobs)) {
      for (const [key, value] of Object.entries(job.env ?? {})) {
        for (const ctx of roots(String(value))) expect(JOB_ENV.has(ctx), `jobs.${name}.env.${key} reads ${ctx}.*`).toBe(true);
      }
    }
    const WORKFLOW_ENV = new Set(["github", "vars", "secrets", "inputs"]);
    for (const [key, value] of Object.entries(doc.env ?? {})) {
      for (const ctx of roots(String(value))) expect(WORKFLOW_ENV.has(ctx), `env.${key} reads ${ctx}.*`).toBe(true);
    }
    // The checker itself has to see a context, or it proves nothing.
    expect(roots("${{ needs.verify.outputs.sha }}")).toEqual(["needs"]);
    expect(roots("${{ runner.temp }}/x")).toEqual(["runner"]);
    // A `}` inside a string literal must not end the expression early and hide what follows it.
    expect(roots("${{ format('{0}/x', runner.temp) }}")).toEqual(["runner"]);
  });

  it("runs scripts/smoke.mjs only from a checkout of exactly the deployed SHA", () => {
    // The QA report's failure, stated as a rule: whichever job runs the smoke script must have
    // checked out the commit `verify` resolved, not whatever the dispatcher's branch holds.
    const smokers = Object.entries(doc.jobs).filter(([, job]) => runSteps(job).some((s) => s.run!.includes("scripts/smoke.mjs")));
    expect(smokers.map(([name]) => name)).toEqual(["smoke"]);
    for (const [name, job] of smokers) {
      expect(checkouts(job), name).toHaveLength(1);
      expect(checkouts(job)[0]!.with?.ref, name).toBe("${{ needs.verify.outputs.sha }}");
    }
  });

  it("proves HEAD is that SHA before it runs anything from the checkout", () => {
    const steps = smoke.steps;
    const co = steps.findIndex((s) => s.uses?.startsWith("actions/checkout@"));
    const head = steps.findIndex((s) => s.run?.includes("git rev-parse HEAD"));
    const run = steps.findIndex((s) => s.run?.includes("scripts/smoke.mjs"));
    expect(co).toBe(0);
    expect(head).toBeGreaterThan(co);
    expect(run).toBeGreaterThan(head);
    expect(steps[head]!.run).toMatch(/\[ "\$got" = "\$SHA" \] \|\| \{[^}]*exit 1; \}/);
    // `$SHA` in that comparison is the one verify resolved, and `$WORKER` the one it built.
    expect(steps[head]!.env?.SHA ?? smoke.env?.SHA).toBe("${{ needs.verify.outputs.sha }}");
    expect(steps[run]!.env?.WORKER ?? smoke.env?.WORKER).toBe("${{ needs.verify.outputs.worker }}");
    expect(steps[run]!.run).toBe('node scripts/smoke.mjs "https://$WORKER.$WORKERS_SUBDOMAIN.workers.dev"');
  });

  it("runs only after a successful deploy, and holds no credential", () => {
    // `verify` must be a direct need for its outputs to be readable; `deploy` so that the checks
    // run against the worker this run published, after its health gate passed.
    expect(needs(smoke)).toEqual(expect.arrayContaining(["verify", "deploy"]));
    expect(smoke.if).toBeUndefined();
    expect(smoke["runs-on"]).toBe("ubuntu-latest");
    expect(smoke.permissions).toEqual({ contents: "read" });
    // Anywhere in the job, comments included. A repository variable is not a credential.
    const smokeJob = jobText(wf, "smoke");
    expect(smokeJob).toContain("  smoke:");
    expect(smokeJob).not.toContain("secrets.");
    // Nor any other way of reaching a credential: index syntax, the whole context, or the token.
    expect(smokeJob).not.toMatch(/\bsecrets\b/);
    expect(smokeJob).not.toMatch(/\bgithub\.token\b|\bGITHUB_TOKEN\b/);
    expect(smokeJob).toContain("vars.WORKERS_SUBDOMAIN");
    // The checkout's token is not written into .git/config, where the checked-out code could read it.
    expect(checkouts(smoke)[0]!.with?.["persist-credentials"]).toBe(false);
  });

  it("uses the pinned actions the file already uses, and installs nothing", () => {
    expect(checkouts(smoke)[0]!.uses).toBe(checkouts(verify)[0]!.uses);
    expect(setupNode(smoke)?.uses).toBe(setupNode(verify)?.uses);
    expect(String(setupNode(smoke)?.with?.["node-version"])).toBe("22");
    for (const s of runSteps(smoke)) expect(s.run, s.name).not.toMatch(/\bnpm\s+(ci|i|install)\b|\bnpx\b|\byarn\b|\bpnpm\b/);
    // Which only works because the script needs nothing installed: Node built-ins only.
    const src = readFileSync(fileURLToPath(new URL("../scripts/smoke.mjs", import.meta.url)), "utf8");
    const specifiers = [
      ...src.matchAll(/^\s*import\s[^"']*?\bfrom\s*["']([^"']+)["']/gm),
      ...src.matchAll(/^\s*import\s*["']([^"']+)["']/gm),
      ...src.matchAll(/\bimport\(\s*["']([^"']+)["']/g),
      ...src.matchAll(/\brequire\(\s*["']([^"']+)["']/g),
    ].map((m) => m[1]!);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const s of specifiers) expect(s, s).toMatch(/^node:/);
  });

  it("leaves the credentialed deploy job with no checkout and no smoke step", () => {
    // The checkout there existed only for smoke.mjs. With it gone, the job that holds the
    // Cloudflare token runs no code from the repository at all — not even the dispatching branch's.
    expect(checkouts(deploy)).toHaveLength(0);
    for (const s of runSteps(deploy)) {
      expect(s.run, s.name).not.toContain("scripts/");
      expect(s.run, s.name).not.toMatch(/(^|[\s;|&(])git\s/m);
    }
    // Node stays: the pinned Wrangler install needs it, and it comes first.
    const node = deploy.steps.findIndex((s) => s.uses?.startsWith("actions/setup-node@"));
    const wrangler = deploy.steps.findIndex((s) => s.run?.includes('"wrangler@$WRANGLER_VERSION"'));
    expect(node).toBeGreaterThanOrEqual(0);
    expect(wrangler).toBeGreaterThan(node);
    // And the health gate the smoke job waits behind is still there.
    const health = runSteps(deploy).find((s) => s.run!.includes('[ "$code" = "200" ]'));
    expect(health?.run).toContain('[ "$m" = "oauth" ]');
    expect(health?.run).toContain('[ "$c" = "true" ]');
  });
});
