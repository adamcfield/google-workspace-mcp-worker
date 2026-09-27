## Summary

<!-- What changed and why. Link the issue / QA finding. -->

## Checklist

- [ ] `npm run typecheck` and `npm test` pass locally
- [ ] Generated files refreshed if tools changed (`npm run gen`: README tables + `docs/measurements/current.md`)
- [ ] New Google scope? Added to `src/google/scopes.ts` (+ `REQUIRED_APIS`), and noted that users must reconnect
- [ ] No secrets, tokens, or personal data in code, tests, fixtures, or this description
- [ ] `CHANGELOG.md` updated; `VERSION` in `src/agent.ts` and `package.json` bumped together if user-visible
- [ ] Write tools: `write: true`, `destructive: true` where irreversible, `confirm` where the action contacts people

## Test plan

<!-- How this was verified: unit tests, smoke run, live checks. -->

## Tests touched

<!-- Added / changed / removed test names and the total before → after (from `npx vitest run --reporter=json`). -->
