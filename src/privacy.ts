/**
 * Privacy policy served at /privacy on both workers (public, no auth).
 *
 * Google's OAuth consent-screen branding requires a homepage URL (the landing page at /) and a
 * privacy-policy URL for an app in External / In-production status. The policy has to name the
 * operator and give a real way to reach them, and only the operator knows those — so they are
 * configuration, not constants, and the defaults are written for a private deployment.
 *
 * `PRIVACY_PUBLIC_APP="true"` says this deployment backs a public Google app. In that state a
 * policy that names nobody is not a document Google should be shown and not one a user should be
 * asked to accept, so /privacy refuses to serve it and says which variables to set. Serving a
 * plausible-looking policy with a placeholder contact would be the worse failure: it passes
 * review, and the person who needs to reach the operator finds nobody at the other end.
 */

/** Date the policy text below last changed. Bump it when the wording changes. */
export const PRIVACY_UPDATED = "2026-09-20";

/** Where the policy points when the operator has not named themselves. */
const DEFAULT_CONTACT_URL = "https://github.com/adamcfield/google-workspace-mcp-worker";

/** The operator-supplied parts of the policy. */
export interface PrivacyEnv {
  /** Who operates this deployment, e.g. "Example Ltd" or a person's name. */
  PRIVACY_OPERATOR_NAME?: string;
  /** A URL a user can reach the operator through (a contact page, a repository, a mailto:). */
  PRIVACY_CONTACT_URL?: string;
  /** "true" when this deployment backs a Google app in External / In-production status. */
  PRIVACY_PUBLIC_APP?: string;
}

const trim = (value: string | undefined) => String(value ?? "").trim();

/** Whether this deployment says it backs a public Google app. Matched exactly, like the other flags. */
export function privacyPublicApp(env: PrivacyEnv): boolean {
  return env.PRIVACY_PUBLIC_APP === "true";
}

/**
 * The settings a public app must supply, and does not have yet.
 *
 * Empty for a private deployment whatever it sets: the defaults describe it accurately, and a
 * hobby deployment should not be blocked from serving a policy it is not obliged to publish.
 */
export function privacyGaps(env: PrivacyEnv): string[] {
  if (!privacyPublicApp(env)) return [];
  const gaps: string[] = [];
  if (!trim(env.PRIVACY_OPERATOR_NAME)) gaps.push("PRIVACY_OPERATOR_NAME");
  if (!trim(env.PRIVACY_CONTACT_URL)) gaps.push("PRIVACY_CONTACT_URL");
  return gaps;
}

/** The policy text for this deployment. */
export function privacyText(origin: string, env: PrivacyEnv = {}): string {
  const operator = trim(env.PRIVACY_OPERATOR_NAME) || "its owner";
  const contact = trim(env.PRIVACY_CONTACT_URL) || DEFAULT_CONTACT_URL;
  return `Google Workspace MCP — Privacy Policy (updated ${PRIVACY_UPDATED})

${origin} is a self-hosted Model Context Protocol (MCP) server operated by ${operator}. It lets an MCP client (for example Claude) act on the Google account of the person who signs in — Google Sheets, Drive, Docs, Gmail, Calendar, Tasks, Contacts, Chat, Slides, Forms, Photos, YouTube and Meet — strictly on that person's instructions. When you sign in, Google shows you exactly which permissions are requested and you can decline any of them.

What we store: the OAuth refresh token Google issues for your account (encrypted at rest in Cloudflare Workers KV) and short-lived access tokens derived from it (cached encrypted for up to one hour), your email address as the key of your grant, and operational logs that contain tool names and resource ids but never the contents of your documents, messages or files. We do not store copies of your Google data: every request reads or writes it live through Google's APIs and returns the result to the MCP client you connected.

What we do not do: we do not sell, share, or transfer your data to any third party, do not use it for advertising or profiling, and do not use it to train models. Data is transmitted only between your MCP client, this server (running on Cloudflare's network) and Google's APIs, over HTTPS.

Your control: you can revoke this server's access at any time at https://myaccount.google.com/permissions and remove the connector in your MCP client; revoking the Google grant immediately invalidates the stored tokens. The server's use of Google user data complies with the Google API Services User Data Policy, including the Limited Use requirements.

Contact: ${contact}
`;
}

/** What /privacy says instead of a policy when a public deployment has not been configured. */
export function privacyUnconfiguredText(gaps: readonly string[]): string {
  return `Google Workspace MCP — privacy policy not configured

This deployment is marked as backing a public Google app (PRIVACY_PUBLIC_APP="true") but has not been told who operates it, so there is no policy to serve. A privacy policy that names nobody and gives no way to reach anyone is worse than none: it passes review and then fails the one person who needs it.

Set ${gaps.join(" and ")} on this Worker and redeploy.

  PRIVACY_OPERATOR_NAME   who operates this deployment, e.g. "Example Ltd"
  PRIVACY_CONTACT_URL     a URL a user can reach that operator through

Until then this endpoint returns 503 and Google's consent-screen verification will not pass. A private deployment (PRIVACY_PUBLIC_APP unset) is unaffected and serves the default policy.
`;
}

const plainText = (body: string, status: number, cache: string) =>
  new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": cache } });

/** The /privacy response: the policy, or a 503 naming what a public deployment still has to set. */
export function privacyResponse(origin: string, env: PrivacyEnv = {}): Response {
  const gaps = privacyGaps(env);
  if (gaps.length) return plainText(privacyUnconfiguredText(gaps), 503, "no-store");
  return plainText(privacyText(origin, env), 200, "public, max-age=3600");
}
