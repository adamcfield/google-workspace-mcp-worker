/**
 * Browser check: can a real browser actually submit the consent form?
 *
 * A Content-Security-Policy header is only correct if the browser agrees, and `form-action`
 * is the directive that is easiest to get wrong: it is enforced against every URL in the
 * submission's redirect chain, so a policy that allows the form's own action can still block
 * the click — and Chromium reports that block against the action URL, which reads as if the
 * same-origin POST had been refused. Header assertions cannot see that. This drives a real
 * Chromium, clicks "Continue with Google", and fails if any CSP violation is logged or if the
 * browser never gets as far as Google's authorization endpoint.
 *
 *   node scripts/consent-csp-browser-check.mjs --offline          # renders src/auth.ts locally, no network at all
 *   node scripts/consent-csp-browser-check.mjs https://<origin>   # drives a deployed worker's consent page
 *
 * Needs a Chromium and Playwright's driver, neither of which is a dependency of this project:
 *   npm i --no-save playwright-core && npx playwright install chromium
 * Set CHROMIUM_PATH to use a Chromium you already have. Nothing in CI runs this; it is the
 * evidence generator for a change to the consent page's policy.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const args = process.argv.slice(2);
const OFFLINE = args.includes("--offline");
const ORIGIN = (args.find((a) => a.startsWith("http")) ?? "").replace(/\/+$/, "");
if (!OFFLINE && !ORIGIN) {
  console.error("Usage: node scripts/consent-csp-browser-check.mjs [--offline | <worker origin>]");
  process.exit(2);
}

let failures = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${extra ? `  ${extra}` : ""}`);
  if (!cond) failures++;
};

async function chromium() {
  let mod;
  try {
    mod = await import("playwright-core");
  } catch {
    console.error("playwright-core is not installed — `npm i --no-save playwright-core` first (it is deliberately not a dependency).");
    process.exit(2);
  }
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  const found =
    process.env.CHROMIUM_PATH ??
    (root && fs.existsSync(root)
      ? fs
          .readdirSync(root)
          .filter((d) => d.startsWith("chromium-"))
          .map((d) => path.join(root, d, "chrome-linux", "chrome"))
          .find((p) => fs.existsSync(p))
      : undefined);
  return mod.chromium.launch({ ...(found ? { executablePath: found } : {}), args: ["--no-sandbox"] });
}

/** Serve the consent page this repository renders, with a POST that answers the way the worker does. */
async function localWorker() {
  const esbuild = await import("esbuild");
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "consent-csp-")), "auth.mjs");
  await esbuild.build({ entryPoints: ["src/auth.ts"], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "warning" });
  const { consentPage } = await import(out);
  const reqInfo = { responseType: "code", clientId: "cid", redirectUri: "https://claude.ai/api/mcp/auth_callback", scope: [], state: "browser-check" };
  const server = http.createServer(async (req, res) => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    if (req.method === "GET") {
      const rendered = consentPage(reqInfo, "Claude", null, true, "browser-check-csrf", undefined, origin);
      res.writeHead(200, Object.fromEntries(rendered.headers));
      res.end(await rendered.text());
    } else {
      for await (const _ of req) void _;
      res.writeHead(302, { location: `${GOOGLE_AUTH}?client_id=browser-check&response_type=code&access_type=offline&prompt=consent` });
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, url: `http://127.0.0.1:${server.address().port}/authorize?client_id=cid` };
}

/** Register a client on a deployed worker and build the consent URL claude.ai would open. */
async function liveConsentUrl() {
  const reg = await fetch(`${ORIGIN}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "gws-mcp-consent-browser-check", redirect_uris: ["http://127.0.0.1:8976/callback"], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }),
  });
  const client = await reg.json();
  if (!client?.client_id) throw new Error(`dynamic client registration failed (${reg.status})`);
  const q = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: "http://127.0.0.1:8976/callback", code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", code_challenge_method: "S256", state: "browser-check" });
  return `${ORIGIN}/authorize?${q}`;
}

const local = OFFLINE ? await localWorker() : null;
const url = local ? local.url : await liveConsentUrl();
const browser = await chromium();
const page = await browser.newPage();
const violations = [];
const googleRequests = [];
page.on("console", (m) => {
  if (m.type() === "error" && /Content Security Policy|Refused to send form data/i.test(m.text())) violations.push(m.text());
});
page.on("request", (r) => {
  if (r.url().startsWith(GOOGLE_AUTH)) googleRequests.push(r.url());
});

console.log(`consent page: ${url}\n`);
const loaded = await page.goto(url, { waitUntil: "domcontentloaded" });
check("consent page loads", loaded?.status() === 200, `(${loaded?.status()})`);
console.log(`     form-action: ${(loaded?.headers()["content-security-policy"] ?? "").split(";").map((d) => d.trim()).find((d) => d.startsWith("form-action")) ?? "(no CSP)"}`);
console.log(`     action attr: ${await page.getAttribute("form", "action")}`);

await page.click("button[type=submit]").catch((e) => check("the consent button is clickable", false, e.message));
await page.waitForTimeout(2000);

check("no CSP violation when the consent button is clicked", violations.length === 0, violations[0] ?? "");
check("the submission reaches Google's OAuth authorization endpoint", googleRequests.length > 0, googleRequests[0] ? `→ ${googleRequests[0].slice(0, 72)}…` : "(the browser never navigated to Google)");

await browser.close();
if (local) await new Promise((r) => local.server.close(r));
console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
