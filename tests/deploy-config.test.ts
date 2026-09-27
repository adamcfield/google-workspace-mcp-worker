/**
 * scripts/deploy-config.mjs — fills the committed Wrangler templates from the environment.
 *
 * The committed configs are public, so they carry `REPLACE_WITH_YOUR_*` placeholders instead of
 * one deployment's KV namespace ids. The risk this file guards is a deploy that goes ahead with a
 * placeholder still in place: Cloudflare would bind a namespace literally named
 * `REPLACE_WITH_YOUR_OAUTH_KV_ID`, and every existing grant would silently be gone.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fillConfig, renderConfig, KV_ID_ENV } from "./../scripts/deploy-config.mjs";
import { stripJsonc } from "./../scripts/staging-config.mjs";

const read = (name: string) => readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), "utf8");
const TEMPLATES = ["wrangler.jsonc", "wrangler.oauth.jsonc"];

describe("the committed templates", () => {
  it("carry a placeholder for every KV namespace id, never a real one", () => {
    for (const name of TEMPLATES) {
      const config = JSON.parse(stripJsonc(read(name)));
      for (const namespace of config.kv_namespaces ?? []) {
        expect(namespace.id, `${name} ${namespace.binding}`).toMatch(/^REPLACE_WITH_YOUR_/);
      }
    }
  });

  it("ship an example allow-list rather than anyone's address", () => {
    for (const name of TEMPLATES) {
      const config = JSON.parse(stripJsonc(read(name)));
      expect(config.vars.ALLOWED_EMAILS, name).toMatch(/@example\.(com|org|net)$/);
    }
  });

  it("name an environment variable for every placeholder they contain", () => {
    // A placeholder the filler has never heard of can only ever fail a deploy.
    for (const name of TEMPLATES) {
      const config = JSON.parse(stripJsonc(read(name)));
      for (const namespace of config.kv_namespaces ?? []) expect(KV_ID_ENV[namespace.binding], namespace.binding).toBeTruthy();
    }
  });
});

describe("filling a template", () => {
  const ALLOW = "ops@corp.example-real.net, @corp.example-real.net";
  const env = { TOKEN_KV_ID: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", OAUTH_KV_ID: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", ALLOWED_EMAILS: ALLOW };

  it("substitutes each binding's id from its own variable", () => {
    const bearer = JSON.parse(renderConfig(read("wrangler.jsonc"), env));
    const oauth = JSON.parse(renderConfig(read("wrangler.oauth.jsonc"), env));
    expect(bearer.kv_namespaces.find((k: { binding: string }) => k.binding === "TOKEN_KV").id).toBe(env.TOKEN_KV_ID);
    expect(oauth.kv_namespaces.find((k: { binding: string }) => k.binding === "OAUTH_KV").id).toBe(env.OAUTH_KV_ID);
  });

  it("writes the deployment's own allow-list over the template's", () => {
    for (const name of TEMPLATES) {
      const filled = JSON.parse(renderConfig(read(name), env));
      expect(filled.vars.ALLOWED_EMAILS, name).toBe(ALLOW);
      expect(JSON.stringify(filled), name).not.toContain("you@example.com");
    }
  });

  it("refuses to deploy without an allow-list, rather than inheriting the template's", () => {
    // A missing list is not a harmless default. The server fails closed, so the worker comes up
    // and refuses every sign-in — every existing user locked out, with no error anywhere. The
    // template's `you@example.com` is the same outage wearing a plausible-looking value.
    const { ALLOWED_EMAILS: _drop, ...noList } = env;
    for (const bad of [undefined, "", "   ", "you@example.com", "@example.com", "someone@example.org"]) {
      const candidate = bad === undefined ? noList : { ...env, ALLOWED_EMAILS: bad };
      expect(() => renderConfig(read("wrangler.oauth.jsonc"), candidate), String(bad)).toThrow(/ALLOWED_EMAILS/);
    }
  });

  it("refuses a malformed allow-list entry", () => {
    for (const bad of ["not-an-email", "@nodot", "a@b"]) {
      expect(() => renderConfig(read("wrangler.oauth.jsonc"), { ...env, ALLOWED_EMAILS: bad }), bad).toThrow(/not an email or @domain/);
    }
  });

  it("validates a namespace id as lowercase 32-hex before writing anything", () => {
    // Cloudflare will happily create a namespace for a typo, so the worker comes up bound to an
    // empty one and the grants look as though they vanished.
    for (const bad of ["NOTHEX", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "aaaa-aaaa-aaaa-aaaa-aaaa-aaaaaaaa"]) {
      expect(() => renderConfig(read("wrangler.oauth.jsonc"), { ...env, OAUTH_KV_ID: bad }), bad).toThrow(/32 lowercase hex/);
    }
  });

  it("trims surrounding whitespace on an id rather than rejecting it", () => {
    // A value pasted into repository settings very often arrives with a trailing newline.
    const filled = JSON.parse(renderConfig(read("wrangler.oauth.jsonc"), { ...env, OAUTH_KV_ID: `  ${env.OAUTH_KV_ID}\n` }));
    expect(filled.kv_namespaces.find((k: { binding: string }) => k.binding === "OAUTH_KV").id).toBe(env.OAUTH_KV_ID);
  });

  it("refuses to emit a config when a required id is missing, naming the variable to set", () => {
    expect(() => renderConfig(read("wrangler.oauth.jsonc"), { ALLOWED_EMAILS: ALLOW })).toThrow(/OAUTH_KV\.id.*OAUTH_KV_ID/);
    expect(() => renderConfig(read("wrangler.jsonc"), { OAUTH_KV_ID: env.OAUTH_KV_ID, ALLOWED_EMAILS: ALLOW })).toThrow(/TOKEN_KV\.id/);
  });

  it("refuses a placeholder it was never taught to fill, wherever it appears", () => {
    const config = { vars: { SOMETHING: "REPLACE_WITH_YOUR_FUTURE_VALUE", ALLOWED_EMAILS: "you@example.com" }, kv_namespaces: [] };
    expect(() => fillConfig(config, env)).toThrow(/REPLACE_WITH_YOUR_FUTURE_VALUE/);
  });

  it("reports every missing id at once rather than one per run", () => {
    const config = { kv_namespaces: [{ binding: "TOKEN_KV", id: "REPLACE_WITH_YOUR_TOKEN_KV_ID" }, { binding: "OAUTH_KV", id: "REPLACE_WITH_YOUR_OAUTH_KV_ID" }] };
    try {
      fillConfig(config, { ALLOWED_EMAILS: ALLOW });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as Error).message).toContain("TOKEN_KV_ID");
      expect((err as Error).message).toContain("OAUTH_KV_ID");
    }
  });

  it("does not modify the config it was given", () => {
    const config = { kv_namespaces: [{ binding: "TOKEN_KV", id: "REPLACE_WITH_YOUR_TOKEN_KV_ID" }], vars: { ALLOWED_EMAILS: "you@example.com" } };
    fillConfig(config, env);
    expect(config.kv_namespaces[0].id).toBe("REPLACE_WITH_YOUR_TOKEN_KV_ID");
    expect(config.vars.ALLOWED_EMAILS).toBe("you@example.com");
  });
});

describe("the Deploy workflow", () => {
  const workflow = read(".github/workflows/deploy.yml");

  it("fills the templates before it deploys, and deploys the filled configs", () => {
    expect(workflow).toContain("scripts/deploy-config.mjs");
    expect(workflow).toContain("wrangler deploy -c wrangler.oauth.deploy.jsonc");
    expect(workflow).toContain("wrangler deploy -c wrangler.deploy.jsonc");
  });

  it("passes every variable the filler reads", () => {
    for (const name of [...Object.values(KV_ID_ENV), "ALLOWED_EMAILS"]) expect(workflow, name).toContain(`vars.${name}`);
  });

  it("never prints the allow-list into the job log", () => {
    // The ids are identifiers worth seeing; the addresses are personal data.
    const leaks = workflow
      .split("\n")
      .filter((l) => l.includes("echo") || l.includes("jq"))
      .filter((l) => /vars\.ALLOWED_EMAILS|\$ALLOWED_EMAILS|\.vars\.ALLOWED_EMAILS/.test(l));
    expect(leaks).toEqual([]);
  });

  it("skips a push to a clone that has no deployment configured, but not a manual run", () => {
    // A fresh copy of the public repository has no namespace to deploy to; failing every push
    // there is noise. A manual dispatch still runs and fails loudly on the missing values.
    const guard = workflow.split("\n").find((l) => /^\s{4}if:/.test(l));
    expect(guard).toContain("vars.DEPLOY_ENABLED != 'false'");
    expect(guard).toContain("github.event_name == 'workflow_dispatch' || vars.TOKEN_KV_ID != ''");
  });

  it("keeps the generated configs out of the repository", () => {
    const ignored = read(".gitignore");
    expect(ignored).toMatch(/wrangler\.deploy\.jsonc/);
    expect(ignored).toMatch(/wrangler\.\*\.deploy\.jsonc/);
  });
});

describe("scripts/setup.sh", () => {
  it("substitutes the same placeholder names the templates actually contain", () => {
    // setup.sh rewrites the config in place with `sed`. When the two drifted apart it silently
    // reported "already configured" and deployed a worker bound to the literal placeholder.
    const setup = read("scripts/setup.sh");
    for (const name of TEMPLATES) {
      const config = JSON.parse(stripJsonc(read(name)));
      for (const namespace of config.kv_namespaces ?? []) expect(setup, namespace.id).toContain(namespace.id);
    }
  });
});
