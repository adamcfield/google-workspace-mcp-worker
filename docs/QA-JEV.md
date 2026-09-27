# Running the QA connector with JEV on

How the independent gate turns the model-backed selection path on for
`google-workspace-mcp-oauth-qa`, and how to A/B it against the deterministic selector.

Nothing here applies to production. `JEV_ENABLED` is not in `wrangler.oauth.jsonc` or
`wrangler.jsonc`, and `TYPESAFE_API_KEY` is not a repository secret consumed by `deploy.yml`.

## What the flag does

| `JEV_ENABLED` | Registered tools | Selection |
| --- | --- | --- |
| unset, blank, `1`, `yes`, `TRUE`, a typo | unchanged | — |
| exactly `true` | one more: `google_select_tools` | deterministic, or model-backed when `TYPESAFE_API_KEY` is set |

With the flag off, `tools/list` is byte-for-byte what it was before this path existed, and
`/health` carries no `jev*` field. `tests/jev-runtime.test.ts` asserts both.

`google_select_tools` takes the user's request **as an argument**. MCP's `tools/list` carries no
prompt, so a listing cannot be request-aware; this tool is the shape that can be.

## Setting it up on the QA worker

1. **The key, as a Worker secret** — never a var, never a repository secret, never in a config
   file:

   ```
   npx wrangler secret put TYPESAFE_API_KEY --name google-workspace-mcp-oauth-qa
   ```

   A secret survives redeploys, so this is done once per worker.

2. **Deploy the exact reviewed commit** with the `QA` workflow: dispatch it on `main` and pass the
   40-hex commit as the `ref` **input**. The workflow refuses anything that is not an immutable
   commit contained in `main` or a `release/*` branch, builds it in a credential-free job, and
   publishes that digest-verified artifact.

3. **The flag itself.** `JEV_ENABLED` is a plain var, and `wrangler deploy` replaces a worker's
   vars with the ones in its config — so a var set by hand in the Cloudflare dashboard is wiped by
   the next deployment. Two honest options, and no third:

   - set it in the dashboard (Workers → `google-workspace-mcp-oauth-qa` → Settings → Variables)
     **after** each QA deployment, and re-check `/health` shows `jevEnabled: true`; or
   - add an input to `.github/workflows/qa.yml` that appends `JEV_ENABLED` to the generated
     config. That is a change to `main` and needs its own review; it is not in this PR.

4. **Confirm before measuring.** `GET /health` on the QA worker must show:

   ```json
   { "jevEnabled": true, "jevConfigured": true }
   ```

   `jevConfigured: false` means the key is missing: the tool is registered and answering, but every
   answer is the deterministic one, and an A/B run in that state measures nothing. `/health` says so
   in `warnings` too.

## The A/B

Run the same prompts twice — once with `JEV_ENABLED` unset, once with it `true` and the key set —
and compare `google_select_tools` results. The labelled cases in `bench/jev/cases.json` and the
eight manual acceptance prompts are the input set.

Per request, the tool returns the evidence to compare on:

| Field | What it tells the gate |
| --- | --- |
| `tools`, `toolCount` | the selection itself, canonical names in rank order |
| `prefiltered`, `prefilteredCount` | what the deterministic stage offered before any question |
| `gate.pinned`, `gate.pinnedCount` | the mutation tools pinned unconditionally |
| `gate.mutating`, `gate.verbs`, `gate.services` | why the gate pinned them |
| `model.asked` | binary questions put to the model (0 = deterministic run) |
| `model.fallback` | true when the model answered but the answers were unusable |
| `model.used` | true only when the model's answers were applied |
| `model.calls`, `model.failures`, `model.apiMs` | API calls, failed batches, wall-clock in the API |
| `note` | present only when nothing matched, so an empty result is never silent |

What must hold in both arms, and is the thing to check first:

- every tool in `gate.pinned` appears in `tools` — the model can only remove READ candidates, and
  the gate's tools are unioned back afterwards;
- no write tool appears that the gate did not pin;
- `model.fallback: true` runs return exactly the deterministic arm's `tools`.

Worth measuring beyond that: required-tool recall per case, mean extra tools, and the latency the
questions cost (`model.apiMs`). The deterministic arm is the baseline for all three.

## What is never in scope

The key is read in one place (`src/routing/runtime.ts`), handed to the SDK constructor, and never
logged, returned, cached or included in an error. The SDK's log level is pinned to `off` because at
`debug` it logs request bodies, and a body carries the user's request text. The payload sent to the
model is the request plus public tool metadata — `tests/jev-runtime.test.ts` asserts the key appears
in neither the payload nor the tool's result.

If the key is missing, the SDK fails to load, the call times out, the API refuses, or an answer is
malformed, the selection falls back to the deterministic router and reports `fallback: true`. There
is no failure path that returns an empty or ungated selection.
