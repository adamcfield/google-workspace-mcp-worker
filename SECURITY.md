# Security policy

## Reporting a vulnerability

**Report privately, not in a public issue.** Open a security advisory:
<https://github.com/adamcfield/google-workspace-mcp-worker/security/advisories/new>

What to expect:

| | |
| --- | --- |
| Acknowledgement | within **5 working days** |
| First assessment | within **10 working days** of acknowledgement |
| Fix or mitigation for a confirmed issue | as fast as the severity warrants; a released fix is announced in `CHANGELOG.md` |
| Credit | offered by default — say if you would rather not be named |

Useful things to include: what an attacker gains, the smallest reproduction you have, and the
commit or deployed `/health.version` you tested. Please do not test against a deployment that is
not yours.

This is a self-hosted server maintained in someone's own time, not a funded product, and there is
no bug bounty. Reports are still taken seriously — anything touching token handling, the allow-list
or the consent flow gets looked at first.

## Supported versions

| Version | Supported |
| --- | --- |
| Latest release on `main` | Yes |
| Anything older | No — upgrade first |

There is one supported version and it is the current one. Fixes are not backported: this is a
Worker you redeploy in seconds, so the answer to "is my version affected" is always "deploy the
current one and find out". Operators of a fork are on their own for anything they have changed.

## Threat model and controls

**Threat model.** The connector worker is a confidential OAuth client for Google and an OAuth 2.1 authorization server for MCP clients (claude.ai); the bearer worker is a confidential OAuth client for Google gated by a shared secret. Both hold long-lived Google refresh tokens, so the two things that matter are (1) who can obtain a grant / call the tools and (2) where the tokens live.

## Bearer worker
- Every MCP call needs `Authorization: Bearer <MCP_AUTH_TOKEN>` (constant-time compare, fails closed when unset). A leaked URL is not an open relay.
- The one-time Google login (`/google/auth`) is unlocked by the same secret or by a single-use 5-minute link minted with it (`POST /google/auth/link`), so the secret never has to travel in browser history; `/callback` is bound to a single-use 10-minute `state`. `ALLOWED_EMAILS` decides which Google account may become the owner; rejected sign-ins revoke the token Google just issued.
- The owner refresh token is stored in `TOKEN_KV` AES-GCM-encrypted under a key derived from **two** secrets the worker holds (`MCP_AUTH_TOKEN` + `GOOGLE_CLIENT_SECRET`); rotating either makes the record unreadable (reconnect). `DELETE /google/auth` revokes at Google and forgets it.

## Connector worker

## Who can connect
- Any MCP client can register (`/register`, dynamic client registration — required by Claude's custom-connector flow). Registration alone grants nothing.
- A grant is only issued after **a human** (a) clicks *Continue with Google* on the consent page that names the requesting client, then (b) passes Google's own account chooser + permission screen for **your** OAuth client. A malicious MCP client therefore cannot silently obtain a grant (confused-deputy protection), and only Google accounts that can consent to your OAuth client can connect at all (an *Internal* Workspace app restricts that to your organisation).
- `ALLOWED_EMAILS` (comma-separated emails and/or `@domains`) hard-limits which Google accounts may complete `/callback`. It **fails closed**: with no list, nobody can sign in unless `ALLOW_ANY_GOOGLE_ACCOUNT="true"` is set deliberately (and `/health` then warns). `GOOGLE_HOSTED_DOMAIN` adds Google's `hd` hint but is not the control.
- The unauthenticated auth surface (`/authorize`, `/callback`, `/register`, `/token`) is rate limited per IP (Workers `ratelimits` binding `AUTH_RATE_LIMIT`, 30/min); missing binding = `/health` warning, not a silent gap.
- The consent click itself is CSRF-protected: the GET sets an `HttpOnly; Secure; SameSite=Lax` nonce cookie that the POST must echo in a hidden field (plus a `Sec-Fetch-Site: cross-site` rejection), so a rogue client cannot forge the approval with a cross-site form post.
- PKCE (S256) is enforced by `workers-oauth-provider`; the `state` linking the Google round-trip to the MCP request is a random UUID stored in KV for 10 minutes and deleted on first use.
- Sign-ins rejected after Google already issued tokens (allow-list miss, unverified email, expired MCP request) revoke the freshly issued refresh token at Google so no dangling offline grant is left on the account.

## Where the tokens live
- **Google refresh token** → only inside the OAuth grant `props`, which `@cloudflare/workers-oauth-provider` stores **encrypted** in `OAUTH_KV` (the encryption key is wrapped by the access/refresh tokens handed to the MCP client, so KV contents alone are useless). It is never logged.
- **Google access tokens** (1 h) → cached in `OAUTH_KV` **AES-GCM-encrypted** under a key derived from the refresh token, so a KV read alone yields nothing usable; also held in memory in the session's Durable Object.
- **MCP tokens** issued to Claude → managed by the provider (hashed at rest), 1 h access tokens with refresh.
- Secrets `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` are Worker secrets (never in the repo; `.dev.vars` is gitignored).

## Blast radius controls
- **Least privilege by configuration:** `ENABLED_TOOL_GROUPS` / `DISABLED_TOOL_GROUPS` remove whole products from the tool list *and* from the scopes requested at consent, so a stolen grant for a "Sheets only" deployment cannot read mail.
- **Per-session budget:** `TOOL_RATE_LIMIT_PER_MIN` (default 120) bounds what one MCP session can do per minute; the client gets a clear retry-after tool error.
- **Upstream timeouts:** every Google call is bounded (30 s; 120 s uploads), so a hung API cannot pin sessions.
- `MCP_READONLY="true"` deploys a read-only tool surface (no writes/sends/deletes at all).
- Sending requires `confirm: true` on `gmail_send_message` / `gmail_send_draft` / `chat_send_message`; destructive tools carry `destructiveHint` so clients can ask before calling.
- The deprecated pre-1.5 tool names are registered as hidden aliases (not listed, removed in 2.0). An alias reuses its target's input schema, scope and flags, so no `confirm` gate, read-only mode or scope check can be bypassed by calling the old name.
- Write tools emit non-PII audit lines (`[gws-mcp audit] …`) visible in Workers Logs / `wrangler tail`.
- `google_api_request` (raw escape hatch) only accepts `https://*.googleapis.com` URLs, requires `confirm=true` for any mutation, and refuses endpoints whose dedicated tool carries a safeguard (Gmail send / permanent delete, Drive permanent delete / empty trash, Chat space delete).
- **Prompt-injection posture:** content read from the account (mail, docs, cells, chat) is returned as data; the MCP instructions and read-tool descriptions tell the model it is never an instruction. The server cannot enforce that on the model side — treat it as defence in depth, not a control.

## Observability
- One JSON line per tool call (`evt: tool_call`: tool, user email, latency, outcome) and one per grant / owner login / rejected sign-in / auth rate-limit hit. No tokens, no message bodies, no cell contents are logged. Ship via Logpush to a SIEM if required.
- Every HTML/JSON page carries CSP (`default-src 'none'`), `X-Frame-Options: DENY`, nosniff, `Referrer-Policy: no-referrer`, HSTS and a Permissions-Policy; consent and landing pages are `noindex`.
- CI runs `npm audit --audit-level=high` and a gitleaks secret scan on every push; Dependabot keeps `wrangler`, `agents`, the MCP SDK and dev tooling current.

## Revocation
- Google side: <https://myaccount.google.com/permissions> → remove the app (kills all refresh tokens for that account).
- Claude side: Settings → Connectors → remove; or rotate the Google client secret.
- Everything in `OAUTH_KV` has a TTL; `OAuthProvider.purgeExpiredData` can be scheduled if you want faster cleanup.

## Scope

In scope: anything that lets a party who should not have access obtain a grant, call a tool, read
another user's data, or escalate past the allow-list, the `confirm` gates or `MCP_READONLY`. Also
in scope: token handling, the consent and CSRF flows, and the raw `google_api_request` escape
hatch.

Out of scope: a deployment's own misconfiguration (`ALLOW_ANY_GOOGLE_ACCOUNT="true"`, a leaked
`MCP_AUTH_TOKEN`, an over-broad Google OAuth client), anything requiring an already-compromised
Cloudflare or Google account, and the prompt-injection posture noted above — the server marks
account content as data, but it cannot make a model treat it that way, and that limit is documented
rather than defended.
