/** Types for scripts/staging-config.mjs (see tests/staging-config.test.ts). */

/** A wrangler config object as parsed from wrangler.oauth.jsonc. */
export interface WranglerConfig {
  name: string;
  main: string;
  kv_namespaces: { binding: string; id: string }[];
  ratelimits?: { name: string; namespace_id: string; simple: { limit: number; period: number } }[];
  [key: string]: unknown;
}

/** Strip the JSONC comments wrangler allows and return parseable JSON. */
export function stripJsonc(text: string): string;

/** Merge extra allow-list entries into an ALLOWED_EMAILS value (case-insensitive de-dupe, original order first). */
export function mergeAllowList(current: string | undefined, extra: string | undefined): string;

/** Build the staging variant of `source` for worker suffix `suffix` bound to KV namespace `kvId`. */
export function stagingConfig(
  source: string,
  suffix: string,
  kvId: string,
  opts?: { allowExtra?: string; refuseKvIds?: readonly string[]; allowBase?: string },
): WranglerConfig;

/** The only shape a Cloudflare KV namespace id has. */
export const KV_ID_RE: RegExp;

/** Split an allow-list value into its entries. */
export function parseAllowList(value: string | undefined): string[];

/** Validate a required allow-list, throwing when it is empty, malformed or still a placeholder. */
export function requireAllowList(value: string | undefined, label: string): string;
