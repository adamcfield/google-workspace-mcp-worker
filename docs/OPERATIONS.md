# Operations runbook

How to run this MCP server in production: deploy, watch, rotate, revoke, recover. Everything here is for the operator; end users only ever click *Connect* in Claude.

## 1. Topology

| | claude.ai connector (`google-workspace-mcp-oauth`) | bearer worker (`google-workspace-mcp`) |
|---|---|---|
| Who calls it | claude.ai (web/desktop/mobile), Claude Code, any OAuth MCP client | scripts and clients holding `MCP_AUTH_TOKEN` |
| Identity | one Google grant **per user** (their own consent) | one Google account for the whole worker |
| State | `OAUTH_KV` (provider clients/grants/tokens, login state, encrypted token cache) | `TOKEN_KV` (encrypted owner grant, login state, encrypted token cache) |
| Sessions | Durable Object `GoogleWorkspaceMCP` (SQLite), one per MCP session | same |

Both are stateless Workers apart from KV + the per-session Durable Object; a redeploy never loses grants.

## 2. Deploy

**Continuous:** every push to `main` runs `.github/workflows/deploy.yml` (both workers). Requires the repo Actions secrets `CLOUDFLARE_API_TOKEN` (template *Edit Cloudflare Workers* + *Workers KV Storage: Edit*, scoped to the account) and `CLOUDFLARE_ACCOUNT_ID`. Pause with the repo variable `DEPLOY_ENABLED=false`.

**On demand:** *Actions → Deploy → Run workflow* (any branch), or locally:

```bash
npm ci && npm run typecheck && npm test
npx wrangler deploy -c wrangler.oauth.jsonc     # connector
npx wrangler deploy                             # bearer
node scripts/smoke.mjs https://google-workspace-mcp-oauth.<sub>.workers.dev
node scripts/smoke.mjs https://google-workspace-mcp.<sub>.workers.dev
```

**After an upgrade that changes tool schemas** (new parameters, renamed fields): claude.ai keeps the tool list it fetched when the connector was added. Behaviour and server-side defaults change immediately; the visible schema does not until users toggle or re-add the connector. Say so in the release note.

**Rollback:** `npx wrangler rollback -c wrangler.oauth.jsonc` (and/or without `-c`) restores the previous version in seconds; `npx wrangler deployments list` shows history. Config changes (vars, bindings) ship with the code, so rolling back also restores them.

**Deploy-time configuration:** `wrangler.jsonc` and `wrangler.oauth.jsonc` are committed **templates**. This repository is public, so they hold `REPLACE_WITH_YOUR_*` placeholders for the KV namespace ids and `you@example.com` for `ALLOWED_EMAILS`, not one deployment's values. `scripts/deploy-config.mjs` fills them from the environment and writes a gitignored `wrangler[.oauth].deploy.jsonc` to deploy from; it **fails rather than emitting a config that still holds a placeholder**, because a deploy that went ahead would bind a namespace literally named `REPLACE_WITH_YOUR_OAUTH_KV_ID` and lose every existing grant. The `Deploy` workflow reads three repository *variables* (Settings → Secrets and variables → Actions → Variables) — `TOKEN_KV_ID`, `OAUTH_KV_ID` and `ALLOWED_EMAILS`. **All three are required** and are validated before anything is written: the namespace ids must be lowercase 32-hex (Cloudflare will happily create a namespace for a typo, leaving the worker bound to an empty one), and the allow-list must be a real one — empty or still holding a documentation-reserved address fails the job. That last check matters because the server fails closed: a deploy that proceeded without an allow-list would come up and refuse every sign-in, which reads as a broken service rather than as a variable nobody set. They are variables rather than secrets on purpose: a namespace id is an identifier, not a credential, and having it visible in the job log is how a wrong one gets noticed — the allow-list itself is never printed. **Set all three before the first deploy from a templated tree, or that deploy fails.** Locally, `./scripts/setup.sh` pastes the ids it creates straight into the templates, or export the same three names and run `node scripts/deploy-config.mjs wrangler.oauth.jsonc --out wrangler.oauth.deploy.jsonc` yourself. The `Staging` workflow takes the same `ALLOWED_EMAILS` as the **base** allow-list its copies start from, appends the run's `extra_allowed_emails` input to it, and fails before creating any namespace when that variable is absent — the committed config is a public template holding a placeholder, so there is nothing to inherit from it. It also takes `WORKERS_SUBDOMAIN` for its health-check URLs and passes `OAUTH_KV_ID` to the generator as an id it must refuse.

**Staging:** the `Staging` workflow (Actions → Staging → Run workflow) deploys the A/B/C connector copies `google-workspace-mcp-oauth-a|b|c` from any ref: it creates each worker's own `OAUTH_KV` namespace when missing, generates its config with `node scripts/staging-config.mjs <suffix> <kvId>` (same code and vars as production, own worker name → own Durable Object namespace, own rate-limit namespace id) and then checks every `/health` against production's `version` and `tools`. It refuses to reuse the production KV id. `extra_allowed_emails` (input, empty by default) appends to that base on the staging copies only — production's allow-list is never touched. Because vars ship with every deploy, an address passed here is only allowed until the next staging deploy that omits it. The health check reads the repo variable `WORKERS_SUBDOMAIN` and fails with a clear message when it is unset. Google credentials: the workflow sets `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` on each staging worker when those repo secrets exist, otherwise set them once per worker with `npx wrangler secret put <NAME> --name google-workspace-mcp-oauth-<x>` (worker secrets persist across deploys; without them `/health` reports `configured:false` and sign-in fails). Each staging worker needs its own `/callback` redirect URI in the Google OAuth client. Never point staging at the production KV ids.

## 3. Configuration that matters in production

**Privacy policy (`/privacy`).** Google's consent screen needs a privacy-policy URL once the OAuth app is External / In-production. Three optional vars shape what that endpoint serves:

| Var | Effect |
| --- | --- |
| `PRIVACY_OPERATOR_NAME` | Who operates this deployment, named in the policy. Default: "its owner". |
| `PRIVACY_CONTACT_URL` | Where a user reaches that operator. Default: the project repository. |
| `PRIVACY_PUBLIC_APP` | `"true"` when the Google app is External / In-production. |

Unset, all three leave `/privacy` serving the generic policy with a 200 and the same cache header; only three lines of that policy differ from the previous release (its date, a dropped "for personal and internal use", and a bare contact URL). Set `PRIVACY_PUBLIC_APP="true"` **and** the endpoint starts refusing — a 503 naming the variables to set — until the operator and contact are filled in, with a matching `/health` warning. That is deliberate: a public app whose policy names nobody passes Google's review and then fails the one person who ever reads it for real, someone trying to find out who is holding their mail. Better to fail the review.

| Var | Production value | Why |
|---|---|---|
| `ALLOWED_EMAILS` | the accounts / `@domains` that may connect | **Fail closed**: empty means nobody can sign in. |
| `ALLOW_ANY_GOOGLE_ACCOUNT` | `false` | Only set `true` on a deliberately public deployment. `/health` warns when it is on. |
| `GOOGLE_HOSTED_DOMAIN` | your Workspace domain (optional) | Pre-selects it on Google's chooser; enforcement is still `ALLOWED_EMAILS`. |
| `ENABLED_TOOL_GROUPS` / `DISABLED_TOOL_GROUPS` | the products you actually need | Least privilege: only their Google scopes are requested, so the consent screen (and the blast radius of a stolen token) shrinks. Changing them requires users to reconnect. Accepts group keys (`sheets, drive, docs, gmail, calendar, tasks, contacts, chat, slides, forms, photos, youtube, meet`) or a **profile**: `core` (gmail+calendar+drive+docs+sheets), `gmail`, `calendar`, `drive_docs`, `personal` (core+tasks+contacts), `sheets_power_user` (sheets+drive), `company_admin` (core+chat+meet+contacts). A group name always wins over a profile of the same name, so existing values are unchanged (`gmail` and `calendar` are shadowed by their groups and so never show up in `/health.profiles`); a name that is neither still raises the `unknown tool groups ignored` warning. **If one of these variables already contains `core`, `drive_docs`, `personal`, `sheets_power_user` or `company_admin`, it is ignored today with that warning and starts selecting groups — and so widening the requested scopes — from 1.5: check `/health.profiles` and have users re-consent.** |
| `TOOL_SURFACE` | unset (= `full`) today; pin it explicitly if your client caches or drives off the advertised list | Chooses what `tools/list` **advertises**: `full` (every enabled tool) or `compact` (a 19-tool recipe set). It is a listing filter only — every tool the groups enable stays registered and callable by name, so no client breaks and no scope changes. Blank or an unrecognised value falls back to `full` and raises a `/health` warning. `/health` reports `surface`, `toolsListed` (advertised) and `toolsCallable` (registered); `tools` is the callable count — the same number as before on every deployment except a read-only one, where it now excludes write tools (re-baseline an alert on `/health.tools` there). |
| `TOOL_SURFACE_ADD` | unset | Extra tool names (comma/space separated) to advertise on a `compact` surface — the escape hatch when one team needs a tool the recipe set omits. No effect on `full`, though `/health` still reports a name it could not use even there, so a typo shows up before you switch: the warning says whether the name is no tool at all or a real tool this deployment does not register (disabled group, missing scope, `MCP_READONLY`). |
| `TOOL_RATE_LIMIT_PER_MIN` | `120` (default) | Per-session budget; caps a runaway agent's Google-quota burn. `0` disables. |
| `MCP_READONLY` | `true` for read-only audiences | Registers no write/send/delete tools at all. |
| `ratelimits` binding `AUTH_RATE_LIMIT` (connector) | 30 req/min per IP (in `wrangler.oauth.jsonc`) | Throttles `/authorize`, `/callback`, `/register`, `/token`. |

`GET /health` on either worker reflects the effective configuration and lists `warnings` for anything unsafe or misconfigured — alert on a non-empty `warnings` array.

### Narrow access for one job

Scopes follow the enabled groups. Google's consent screen asks only for the scopes of the groups that `ENABLED_TOOL_GROUPS` / `DISABLED_TOOL_GROUPS` leave on, plus `openid` and `userinfo.email` to identify the account. A deployment used for spreadsheet work does not need full Gmail and Drive access:

| `ENABLED_TOOL_GROUPS` | Google asks for | Trade-off |
|---|---|---|
| `sheets` | `spreadsheets` | You cannot find a spreadsheet by name, because `sheets_list_spreadsheets` needs Drive. Open it by URL or id. |
| `sheets_power_user` (sheets + drive) | `spreadsheets`, `drive` | No Gmail, Calendar or Docs. Drive access is still full (Google classes it as restricted). |

The connector asks Google to carry earlier grants forward (`include_granted_scopes=true`). So after narrowing a deployment, a user who has already connected must revoke the app at <https://myaccount.google.com/permissions> and then reconnect. Otherwise their token keeps the old scopes. On the bearer worker, `DELETE /google/auth` and connect again. `google_whoami` shows the scopes a token really holds, and `google_list_tools` shows which groups the deployment enables.

## 4. Monitoring and logs

- **Workers Logs** (dashboard → Worker → Logs, or `npm run tail` / `npm run tail:oauth`) receive one JSON line per tool call: `{"evt":"tool_call","tool":"sheets_write_range","user":"a@b.c","ms":412,"ok":true,"outChars":214,"client":"example-client"}` (errors carry `error` after `ok`; `via` names the dispatch path when a call was proxied, `outChars` is the result text length, `client` the MCP client name — each omitted when unknown; `scripts/tool-usage.mjs` groups on `client`) plus `evt: grant` / `owner_login` / `signin_rejected` / `auth_rate_limited` events and `[gws-mcp audit] …` lines for every write. No tokens or message bodies are ever logged.
- **Logpush** (paid plans) can ship these to your SIEM; filter on `evt`.
- Source maps are uploaded (`upload_source_maps`), so stack traces reference `src/*.ts`.
- **Alerts worth having:** `/health.warnings` non-empty; error-rate spikes on `tool_call` with `ok:false`; `auth_rate_limited` bursts (someone probing the auth surface); Google 429s (`Google API error 429` in tool errors → project quota).

### Tool usage and connect cost

- Which tools are actually called: capture the access log for a while (`wrangler tail -c wrangler.oauth.jsonc --format json > oauth.ndjson`, same for the bearer worker) and run `npm run tool-usage -- oauth.ndjson bearer.ndjson [--since <date>]` — calls, errors, rate-limits and p50 latency per tool (× client once the log carries one). No addresses are printed. A call through a pre-1.5 **alias** logs the old name the caller used (not the canonical one), so this report is the evidence for dropping the aliases in 2.0 — a row for an old name means a client is still on it.
- What a client pays on connect: `npm run measure` prints the `tools/list` bytes and local-tokenizer tokens per surface from the working tree; `Actions → Measure → Run workflow` does the same for any ref on a clean runner. Token counting is local only (no API key anywhere); validate the tokenizer against reference counts on each model-version update with `node scripts/measure-tools.mjs --fidelity <samples.json>`. Baselines live in `docs/measurements/` (see its README).

### Orientation benchmark (A/B/C)

`bench/README.md` is the protocol. Sandbox: a dedicated Google account connected to the bearer worker — never a personal or production one; `npm run bench:fixtures -- <bearer origin> --yes` builds the `[MCP-BENCH]` fixtures idempotently (`--reset` between mutation tasks, `--rebase` when `benchDay` has passed, `--teardown` to remove everything). Human pass: fresh claude.ai chats, one connector per config, rows recorded per `bench/results-template.csv`; unattended re-scoring: `npm run bench:run -- --driver transcripts|replay …` (imports the human exports / re-grades recorded transcripts; no driver runs a model, and this repository calls no model API and holds no model API key anywhere). Verdicts: `npm run bench:score -- bench/results/<pass>.csv --before … --after-version …`; `Actions → Bench` re-scores committed CSVs on a clean runner (no model, no Google).

## 5. Google-side limits

- Per-project quotas (Sheets 300 read/min/project, Gmail 250 quota units/s/user, …). The client retries 429/5xx with backoff and honours `Retry-After`; daily-quota 429s are not retried. Raise quotas in the GCP console if a team hits them.
- Refresh tokens from an OAuth app in **Testing** status die after 7 days — keep the consent screen *In production* (External) or use an *Internal* Workspace app.
- Restricted scopes (`gmail.modify`, `drive`) on an **External** app: Google shows the *unverified app* interstitial and caps the app at 100 users until it passes verification, which for restricted scopes includes a CASA security assessment. An **Internal** app (Workspace org) skips verification entirely. See `docs/GCP-SETUP.md`.

## 6. Rotating secrets

| Secret | How | Effect |
|---|---|---|
| `GOOGLE_CLIENT_SECRET` | Create a new secret on the same OAuth client in GCP, `npx wrangler secret put GOOGLE_CLIENT_SECRET` on both workers, then delete the old one in GCP | Existing refresh tokens keep working (they belong to the client id). The bearer worker's owner grant is encrypted with this secret too, so reconnect it (`/google/auth`). |
| `MCP_AUTH_TOKEN` (bearer) | `openssl rand -hex 32` → `npx wrangler secret put MCP_AUTH_TOKEN`, update the clients | The owner grant becomes unreadable by design → reconnect via `/google/auth?key=<new token>`. |
| Cloudflare API token (CI) | Roll it in the dashboard, update the repo secret | Next deploy uses it. |

## 7. Revoking a user or everything

- **One user (connector):** the user removes the connector in Claude (Settings → Connectors) *and/or* revokes the app at <https://myaccount.google.com/permissions>. To force it from the operator side, remove them from `ALLOWED_EMAILS` (stops re-connecting) and delete their grant: `npx wrangler kv key list --namespace-id <OAUTH_KV id> --prefix grant:` (provider keys; this code's own keys are prefixed `gws:`) → `npx wrangler kv key delete --namespace-id <id> "<key>"`. Their next call fails with a re-authorize error.
- **Everything:** rotate `GOOGLE_CLIENT_SECRET` *and* revoke the app for the accounts at Google, or delete the OAuth client in GCP (kills every refresh token at once).
- **Bearer worker:** `DELETE /google/auth` (with the bearer) revokes at Google and forgets the grant.

## 8. Incident playbook

| Symptom | First move |
|---|---|
| Users see "Re-authorize required" | A refresh token died (Testing-status expiry, password change, admin revocation). They reconnect. If everyone at once: check the consent screen status and the client secret. |
| Tool errors `403 … insufficient scope` | The grant predates a scope/group change → reconnect. Check `google_whoami.missingScopes`. |
| `503 Google OAuth client not configured` | Secrets missing on that worker (`/health.configured=false`). |
| `429` from Google | Project quota; look at the GCP quota page; lower `TOOL_RATE_LIMIT_PER_MIN` if one client is the cause. |
| Suspected token leak | Rotate `GOOGLE_CLIENT_SECRET`, delete grants (7), review Workers Logs for `evt:grant` / `tool_call` by user. Tokens at rest are encrypted; the KV contents alone are not usable. |
| Deploy went wrong | `npx wrangler rollback` (2), then fix forward. |

## 9. Change management

- **Protect `main` (setup, not a description of the current state).** Nothing in this repository can enforce a branch rule, so treat the list below as what to configure rather than as what is already true — **check GitHub → Settings → Rules → Rulesets before relying on any of it.** A runbook that claims a protection which turns out not to exist is worse than one that claims nothing. Target `main`, and enable: require a pull request before merging; require the `build` and `secrets-scan` status checks to pass; require review from Code Owners (`.github/CODEOWNERS`); block force pushes and deletion. Note that `main` deploys on merge (`.github/workflows/deploy.yml`), so a rule that lets something reach `main` unreviewed also lets it reach production.
- Dependabot opens weekly PRs (grouped: Cloudflare, MCP, dev).
- `CHANGELOG.md` + `VERSION` (`src/version.ts`, mirrored in `package.json`; a test enforces the mirror) are bumped in the same PR as user-visible changes. `/health.version` tells you what is live.
