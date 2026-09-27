/**
 * Operator-facing /health body shared by both workers: what is on, what is off and
 * what is misconfigured — never secrets. `warnings` is the thing to alert on.
 */
import { VERSION, toolRateLimit, type AgentEnv } from "./agent.js";
import { allowListOpen, allowRules, googleConfigured } from "./auth.js";
import { enabledGroups, enabledScopes } from "./google/scopes.js";
import { privacyGaps } from "./privacy.js";
import { manifestFor, surfaceFor, surfaceWarnings, toolSurface } from "./tools/surface.js";
import { jevConfigured, jevEnabled } from "./routing/runtime.js";

/** `AgentEnv` already carries the group + surface vars (it extends `SurfaceConfig`). */
export type HealthEnv = AgentEnv & { AUTH_RATE_LIMIT?: unknown };

/** Operator-facing health: what is on, what is off, and what is misconfigured (never secrets). */
/**
 * `detail=false` withholds the warning texts (they can describe weaknesses, e.g. a short bearer
 * secret) and reports only their count — the bearer worker uses it for unauthenticated callers.
 */
export function healthBody(env: HealthEnv, name: string, mode: "oauth" | "bearer", extra: Record<string, unknown> = {}, detail = true): Record<string, unknown> {
  // `profiles` names the bundles (PROFILES in scopes.ts) this config expanded, if any.
  const { groups, unknownGroups, profiles } = enabledGroups(env);
  const manifest = manifestFor(env);
  const warnings: string[] = [];
  if (!googleConfigured(env)) warnings.push("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set");
  if (!allowRules(env.ALLOWED_EMAILS).length) warnings.push(allowListOpen(env) ? "ALLOWED_EMAILS empty and ALLOW_ANY_GOOGLE_ACCOUNT=true: any Google account may connect" : "ALLOWED_EMAILS empty: sign-in is disabled until it is set (or ALLOW_ANY_GOOGLE_ACCOUNT=true)");
  if (unknownGroups.length) warnings.push(`unknown tool groups ignored: ${unknownGroups.join(", ")}`);
  warnings.push(...surfaceWarnings(env, manifest));
  if (mode === "oauth" && !env.AUTH_RATE_LIMIT) warnings.push("AUTH_RATE_LIMIT binding missing: auth endpoints are not rate limited");
  // A public app whose policy names nobody: /privacy returns 503 until this is set, so the
  // operator should hear about it here rather than from Google's verification failing.
  const privacy = privacyGaps(env);
  if (privacy.length) warnings.push(`PRIVACY_PUBLIC_APP=true but ${privacy.join(" and ")} not set: /privacy returns 503`);
  // Enabled without a key is the case worth alerting on: google_select_tools is registered and
  // answering, but every answer is the deterministic one, so a QA A/B would measure nothing.
  if (jevEnabled(env) && !jevConfigured(env)) warnings.push("JEV_ENABLED=true but TYPESAFE_API_KEY is not set: tool selection falls back to the deterministic router");
  return {
    ok: true,
    name,
    mode,
    version: VERSION,
    configured: googleConfigured(env),
    // `tools` = what a client may CALL (the manifest). Unchanged for every deployment except a
    // read-only one, where it now excludes write tools — `toolsCallable` is the same number and
    // `toolsListed` is what tools/list advertises (smaller only on a compact surface).
    tools: manifest.length,
    toolsListed: surfaceFor(env, manifest).length,
    toolsCallable: manifest.length,
    surface: toolSurface(env),
    scopes: enabledScopes(env).length,
    groups: [...groups].filter((g) => g !== "identity").sort(),
    // Spread, not an `undefined` value: an operator reading the object sees no dead key.
    ...(profiles.length ? { profiles } : {}),
    readOnly: env.MCP_READONLY === "true",
    // Present only where the flag is, so a deployment that never sets it keeps the /health body
    // it had. Both are booleans about configuration; no part of the key is reported.
    ...(jevEnabled(env) ? { jevEnabled: true, jevConfigured: jevConfigured(env) } : {}),
    allowList: allowRules(env.ALLOWED_EMAILS).length ? "set" : allowListOpen(env) ? "open" : "unset",
    toolRateLimitPerMin: toolRateLimit(env),
    ...extra,
    warningsCount: warnings.length,
    warnings: detail && warnings.length ? warnings : undefined,
  };
}

