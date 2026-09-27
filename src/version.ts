/**
 * Server version — mirrored in package.json (a test enforces it) and surfaced by
 * `/health`, the MCP `initialize` serverInfo, `google_whoami` and `google_list_tools`
 * so a client can tell which build answered.
 */
export const VERSION = "1.6.0";
