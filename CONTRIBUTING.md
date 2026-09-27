# Contributing

Thanks for looking at this. It is a Cloudflare Worker that exposes a Google Workspace account to
MCP clients, which means every change has a blast radius measured in somebody's real mail and real
files. The rules below exist because of that, not for their own sake.

## Getting set up

Node 22 or newer.

```bash
npm ci        # not `npm install` — the lockfile is the contract
npm test
```

You do not need a Cloudflare account, a Google account or any credential to build, test or review.
The whole suite runs offline: `fetch` is injected and mocked, and no test touches a network.

To run the worker locally you do need Google OAuth client credentials. Copy `.dev.vars.example` to
`.dev.vars` (gitignored) and fill it in — see [docs/GCP-SETUP.md](docs/GCP-SETUP.md) — then
`npm run dev` (bearer worker) or `npm run dev:oauth` (claude.ai connector).

## Before you open a pull request

```bash
npm run typecheck   # src/ against Workers types, tests/ with Node types
npm test
npm run gen:check   # the generated tables and measurements are current
```

CI runs all three, plus `npm audit`, a secret scan and a `wrangler deploy --dry-run` bundle of both
workers. Getting them green locally first is much faster than finding out from CI.

**Generated files are generated.** The tool and scope tables in `README.md`, the tool count in its
intro line, `bench/tool-aliases.json` and `docs/measurements/current.md` are written by
`npm run gen`. Editing them by hand makes `gen:check` fail. Baseline directories under
`docs/measurements/<version>-<sha>/` are immutable and hash-pinned by a test: add a new one, never
regenerate an existing one.

## What must not end up in a commit

This repository is public and its history is permanent.

- **No secrets, ever.** Client secrets, refresh or access tokens, API keys, private keys. They live
  in Worker secrets and in your local `.dev.vars`, and nowhere else. If one does reach a commit,
  say so immediately rather than quietly amending — it has to be treated as compromised and
  rotated, and a force-push is not a fix.
- **No account data.** Real email addresses, file or message ids, document contents, calendar
  entries. Use `example.com`, `example.org` and invented names in tests, fixtures and docs; a test
  enforces this for the benchmark cases.
- **No live or internal URLs.** Deployment hostnames, internal tools, private dashboards. Write
  `https://google-workspace-mcp-oauth.<sub>.workers.dev` rather than a real host.
- **No deployment-specific configuration.** `wrangler.jsonc` and `wrangler.oauth.jsonc` are
  templates holding `REPLACE_WITH_YOUR_*` placeholders. Your own ids go in repository variables or
  in a gitignored generated config — see [docs/OPERATIONS.md](docs/OPERATIONS.md).

## Adding or changing a tool

The conventions are in [CLAUDE.md](CLAUDE.md); the short version:

- `tool({ name, description, scope, input, write?, destructive?, idempotent?, handler })`. The name
  is `<service>_<verb>_<noun>` with the verb from the table in `src/tools/naming.ts`.
- Anything that mutates sets `write: true`. Anything irreversible — a delete, a send, ending a
  conference — also sets `destructive: true`. Sending mail additionally requires an explicit
  `confirm` argument. A lint fails if the flags do not match what the verb promises.
- Handlers return plain data and **throw** on bad input. Never return an error object yourself.
- Renaming a tool means adding the old and new names to the rename table, not editing the name in
  place: the old name keeps working as a hidden alias so existing client connections survive.
- A new Google scope goes in `src/google/scopes.ts`, and users have to reconnect to pick it up.

## Tests

Every behaviour change needs a test, and the useful kind is the one that would have caught the bug.
A test that restates the implementation passes forever and tells you nothing. Prefer asserting
against the real catalog over a three-item fixture when the claim is about what the server can be
made to do.

## Commits and pull requests

Write the commit message for someone reading `git log` in two years with no other context: what
changed, and why it needed to. The pull-request template asks for a test plan and the tests you
touched — fill both in.

## Reporting a security issue

**Do not open a public issue.** Use GitHub's private reporting:
<https://github.com/adamcfield/google-workspace-mcp-worker/security/advisories/new>. See
[SECURITY.md](SECURITY.md) for what to expect.

## Licence

By contributing you agree that your contribution is licensed under the [MIT Licence](LICENSE).
