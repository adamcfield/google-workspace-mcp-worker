#!/usr/bin/env bash
# One-shot deploy helper for BOTH Google Workspace MCP workers:
#   google-workspace-mcp-oauth  (claude.ai custom connector — primary)
#   google-workspace-mcp        (bearer token — Claude Code / scripts)
#
#   ./scripts/setup.sh                 # interactive: login → KV namespaces → deploy both → secrets → smoke
#   ./scripts/setup.sh --no-secrets    # skip the secret prompts (set them later)
#   ./scripts/setup.sh --oauth-only    # only the claude.ai connector worker
#   ./scripts/setup.sh --bearer-only   # only the bearer worker
#
# Prereqs: Node 22+, a Cloudflare account (free tier). The Google OAuth client can
# be created AFTER the first deploy — you need the worker URLs for its redirect
# URIs, and secrets take effect without a redeploy.
set -euo pipefail
cd "$(dirname "$0")/.."

WRANGLER="npx wrangler"
export WRANGLER_SEND_METRICS=false
DO_OAUTH=1; DO_BEARER=1; DO_SECRETS=1
for arg in "$@"; do
  case "$arg" in
    --no-secrets) DO_SECRETS=0 ;;
    --oauth-only) DO_BEARER=0 ;;
    --bearer-only) DO_OAUTH=0 ;;
    *) echo "unknown flag $arg"; exit 2 ;;
  esac
done

echo "==> Installing dependencies"
[ -d node_modules ] || npm ci --no-audit --no-fund

echo "==> Cloudflare login"
if ! $WRANGLER whoami >/dev/null 2>&1; then
  if [ -n "${CLOUDFLARE_API_TOKEN:-}" ]; then echo "CLOUDFLARE_API_TOKEN is set but invalid"; exit 1; fi
  $WRANGLER login
fi
$WRANGLER whoami | sed -n '1,12p'

# kv_ns <binding> <config-file> <placeholder>
kv_ns() {
  local binding=$1 cfg=$2 placeholder=$3
  if grep -q "$placeholder" "$cfg"; then
    echo "==> Creating KV namespace $binding"
    local out id
    out=$($WRANGLER kv namespace create "$binding" 2>&1 | tee /dev/stderr)
    id=$(echo "$out" | grep -oE '"?id"?\s*[:=]\s*"?[0-9a-f]{32}"?' | grep -oE '[0-9a-f]{32}' | head -1)
    [ -n "$id" ] || { echo "Could not parse the KV namespace id — paste it into $cfg manually"; exit 1; }
    sed -i.bak "s/$placeholder/$id/" "$cfg" && rm -f "$cfg.bak"
    echo "    $cfg updated with $binding id $id"
  else
    echo "==> KV namespace $binding already configured in $cfg"
  fi
}

deploy_url() { grep -oE 'https://[a-z0-9.-]+\.workers\.dev' | head -1; }

OAUTH_URL=""; BEARER_URL=""
if [ $DO_OAUTH = 1 ]; then
  kv_ns OAUTH_KV wrangler.oauth.jsonc REPLACE_WITH_YOUR_OAUTH_KV_ID
  echo "==> Deploying OAuth worker (claude.ai connector)"
  OAUTH_URL=$($WRANGLER deploy -c wrangler.oauth.jsonc 2>&1 | tee /dev/stderr | deploy_url)
  [ -n "$OAUTH_URL" ] || { echo "Deploy did not print a workers.dev URL — check the output above"; exit 1; }
fi
if [ $DO_BEARER = 1 ]; then
  kv_ns TOKEN_KV wrangler.jsonc REPLACE_WITH_YOUR_TOKEN_KV_ID
  echo "==> Deploying bearer worker"
  BEARER_URL=$($WRANGLER deploy 2>&1 | tee /dev/stderr | deploy_url)
  [ -n "$BEARER_URL" ] || { echo "Deploy did not print a workers.dev URL — check the output above"; exit 1; }
fi

echo
echo "==> Deployed"
[ -n "$OAUTH_URL" ]  && echo "    claude.ai connector URL:   $OAUTH_URL/mcp      (redirect URI for Google: $OAUTH_URL/callback)"
[ -n "$BEARER_URL" ] && echo "    bearer MCP URL:            $BEARER_URL/mcp     (redirect URI for Google: $BEARER_URL/callback)"
echo "    Add EVERY redirect URI above to the Google OAuth client (docs/GCP-SETUP.md)."
echo

if [ $DO_SECRETS = 1 ]; then
  echo "==> Google OAuth client secrets (create the client first — see docs/GCP-SETUP.md)"
  read -r -p "GOOGLE_CLIENT_ID (…apps.googleusercontent.com, blank to skip): " CID
  if [ -n "$CID" ]; then
    read -r -s -p "GOOGLE_CLIENT_SECRET: " CSEC; echo
    if [ $DO_OAUTH = 1 ]; then
      printf '%s' "$CID"  | $WRANGLER secret put GOOGLE_CLIENT_ID     -c wrangler.oauth.jsonc
      printf '%s' "$CSEC" | $WRANGLER secret put GOOGLE_CLIENT_SECRET -c wrangler.oauth.jsonc
    fi
    if [ $DO_BEARER = 1 ]; then
      printf '%s' "$CID"  | $WRANGLER secret put GOOGLE_CLIENT_ID
      printf '%s' "$CSEC" | $WRANGLER secret put GOOGLE_CLIENT_SECRET
    fi
  else
    echo "    skipped — later: npx wrangler secret put GOOGLE_CLIENT_ID [-c wrangler.oauth.jsonc] (and …_SECRET)"
  fi
  if [ $DO_BEARER = 1 ]; then
    echo "==> Bearer secret for the bearer worker"
    read -r -p "MCP_AUTH_TOKEN (blank = generate one): " MTOK
    if [ -z "$MTOK" ]; then
      MTOK=$(openssl rand -hex 32 2>/dev/null || node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')
      echo "    generated: $MTOK   (keep it — this is what MCP clients send as the bearer)"
    fi
    printf '%s' "$MTOK" | $WRANGLER secret put MCP_AUTH_TOKEN
  fi
fi

echo "==> Smoke tests"
[ -n "$OAUTH_URL" ]  && { node scripts/smoke.mjs "$OAUTH_URL"  || true; }
[ -n "$BEARER_URL" ] && { node scripts/smoke.mjs "$BEARER_URL" || true; }

cat <<MSG

Next steps
  1. Google Cloud console: OAuth client (Web application) with the redirect URI(s) printed above,
     the APIs enabled and the consent screen published — docs/GCP-SETUP.md has the exact clicks.
MSG
[ -n "$OAUTH_URL" ]  && echo "  2. Claude (web/desktop/mobile) → Settings → Connectors → Add custom connector → URL: $OAUTH_URL/mcp"
[ -n "$BEARER_URL" ] && echo "  3. Bearer worker: connect your Google account once → open $BEARER_URL/google/auth?key=<MCP_AUTH_TOKEN>"
[ -n "$BEARER_URL" ] && echo "     then: MCP_TOKEN=<MCP_AUTH_TOKEN> E2E_SPREADSHEET_ID=<id> node scripts/smoke.mjs $BEARER_URL --e2e"
echo
