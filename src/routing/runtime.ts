/**
 * Turning the JEV adapter on inside a deployed Worker.
 *
 * `jev.ts` answers selection questions and `select.ts` decides what to do with the answers;
 * neither reads configuration. This module is the one place that looks at the environment,
 * decides whether the path is on, and builds the client — so there is exactly one answer to
 * "is JEV running here, and with what", and the safety argument in `select.ts` is untouched.
 *
 * Three properties this file exists to hold:
 *
 * **Off unless explicitly on.** `JEV_ENABLED` must be exactly `"true"`. Unset, blank, `"1"`,
 * `"yes"` and a typo all mean off, because a flag that guesses is a flag that turns itself on.
 *
 * **Never throws.** A missing key, an SDK that fails to load, a constructor that rejects its
 * options — every one of them returns `null`, which the caller reads as "no model configured"
 * and answers deterministically. There is no failure here that can produce an empty or
 * ungated selection; the worst case is the baseline selector.
 *
 * **Never handles the key.** `TYPESAFE_API_KEY` is read once, handed to the SDK constructor,
 * and never logged, returned, stored on a result or included in any error. `jevConfigured`
 * reports only whether a non-blank value exists.
 */

import { createJevAsk, type JevOptions, type JevStats, type SystemOneClient } from "./jev.js";
import type { AskFn } from "./select.js";

/** The deployment vars this path reads. QA/test plumbing: none of them belong in production. */
export interface JevConfig {
  /** Exactly "true" turns the path on. Anything else — unset, blank, "1", a typo — is off. */
  JEV_ENABLED?: string;
  /** TypeSafe API key. A Worker SECRET, never a var, never committed, never logged. */
  TYPESAFE_API_KEY?: string;
  /** Optional API base URL override (the SDK defaults to https://api.typesafe.ai). */
  TYPESAFE_BASE_URL?: string;
  /** Optional model override (the SDK defaults to jev-latest). */
  TYPESAFE_DEFAULT_MODEL?: string;
}

/** True only for the exact string "true". */
export function jevEnabled(env: JevConfig): boolean {
  return (env.JEV_ENABLED ?? "").trim() === "true";
}

/** True when the path is on AND a non-blank key is present. Reports existence, never the value. */
export function jevConfigured(env: JevConfig): boolean {
  return jevEnabled(env) && (env.TYPESAFE_API_KEY ?? "").trim().length > 0;
}

/** What a tool handler needs to run — or deliberately not run — the optional stage. */
export interface JevRuntime {
  enabled: boolean;
  configured: boolean;
  /** An asker, or `null` when the path is off, unconfigured, or the SDK could not be built. */
  ask(opts?: JevOptions): Promise<{ ask: AskFn; stats: JevStats } | null>;
}

/**
 * Load the SDK and construct a client.
 *
 * Dynamically imported so that a deployment with the flag off never evaluates the package, and
 * so a bundling or version problem degrades to the deterministic selector instead of breaking
 * the Worker on startup. The import is resolved at build time — this is about evaluation and
 * failure containment, not about keeping bytes out of the bundle.
 */
async function client(env: JevConfig): Promise<SystemOneClient | null> {
  const key = (env.TYPESAFE_API_KEY ?? "").trim();
  if (!key) return null;
  try {
    const { TypeSafeClient } = (await import("@typesafe-ai/sdk")) as { TypeSafeClient: new (opts: Record<string, unknown>) => SystemOneClient };
    return new TypeSafeClient({
      apiKey: key,
      // `off`: at `debug` the SDK logs request bodies, and a body carries the user's request text.
      logLevel: "off",
      ...(env.TYPESAFE_BASE_URL?.trim() ? { baseURL: env.TYPESAFE_BASE_URL.trim() } : {}),
      ...(env.TYPESAFE_DEFAULT_MODEL?.trim() ? { defaultModel: env.TYPESAFE_DEFAULT_MODEL.trim() } : {}),
    });
  } catch {
    // No key material can be in scope here: the SDK either loaded or it did not, and the
    // constructor's own errors are not re-thrown precisely so nothing it carries escapes.
    return null;
  }
}

/**
 * The runtime a session gets, built from its environment.
 *
 * `make` exists for tests: a stub client proves the enabled path without a network or a key,
 * which is the only way the fallback branches below are testable at all.
 */
export function jevRuntime(env: JevConfig, make: (env: JevConfig) => Promise<SystemOneClient | null> = client): JevRuntime {
  return {
    enabled: jevEnabled(env),
    configured: jevConfigured(env),
    async ask(opts: JevOptions = {}) {
      if (!jevEnabled(env)) return null;
      let c: SystemOneClient | null = null;
      try {
        c = await make(env);
      } catch {
        return null;
      }
      if (!c || typeof c.systemOne !== "function") return null;
      return createJevAsk(c, opts);
    },
  };
}
