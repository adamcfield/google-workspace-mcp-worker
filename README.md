# Google Workspace MCP — Cloudflare Workers

A remote [MCP](https://modelcontextprotocol.io) server that gives Claude (or any MCP client) **full read/write access to your own Google Workspace** — Sheets first, plus Drive, Docs, Gmail, Calendar, Tasks, Contacts, Chat, Slides, Forms, Photos, YouTube and Meet — running on **Cloudflare Workers** (free tier) with **real Google OAuth user consent**. No service account: when you connect you get Google's standard "choose an account / allow" screen and the server acts as you.

Two deployments from the same code (the same two-mode layout as the author's `zoho-analytics-mcp-worker`):

| | **claude.ai connector** — primary | **bearer worker** |
|---|---|---|
| Entry / config | `src/oauth.ts` · `wrangler.oauth.jsonc` | `src/index.ts` · `wrangler.jsonc` |
| Worker name | `google-workspace-mcp-oauth` | `google-workspace-mcp` |
| For | Claude web / desktop / mobile custom connectors, Claude Code, any OAuth-capable MCP client | Claude Code, scripts, clients that send a bearer header |
| Auth in front | `@cloudflare/workers-oauth-provider`: OAuth 2.1, PKCE, dynamic client registration, `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource[/mcp]`, `/register` `/authorize` `/token` | `Authorization: Bearer <MCP_AUTH_TOKEN>` |
| Google identity | every user signs in with their own account; the refresh token lives in that grant's encrypted props | one account (yours), connected once via `/google/auth` (refresh token AES-GCM-encrypted in KV) or the `GOOGLE_REFRESH_TOKEN` secret |
| Deploy | `npm run deploy:oauth` | `npm run deploy` |

Both expose the identical <!-- TOOLCOUNT:START -->168<!-- TOOLCOUNT:END -->-tool surface via `McpAgent` (Cloudflare `agents`) + `@modelcontextprotocol/sdk`: Streamable HTTP at `/mcp`, SSE at `/sse`, compact JSON responses.

> Based on the author's earlier Workers: the two-mode layout and the upstream-OAuth grant handling come from **`zoho-analytics-mcp-worker`** (its bearer + multi-user OAuth workers), the one-time `/google/auth` owner login and single-use link from **`podio-mcp-worker`**, tool/registry conventions, CI and `SECURITY.md`/`CLAUDE.md` layout from **`make-mcp-worker`** and **`solaredge-mcp-worker`**, and the read-file/base64 lessons from **`github-mcp-proxy`**.

## Contents
1. [Quick start](#quick-start)
2. [Google Cloud setup](#google-cloud-setup)
3. [Deploy](#deploy)
4. [Connect Claude (claude.ai connector)](#connect-claude-claudeai-connector)
5. [Bearer worker](#bearer-worker)
6. [Verify end-to-end](#verify-end-to-end)
7. [Scopes](#scopes)
8. [Tools](#tools)
9. [How auth works](#how-auth-works)
10. [Configuration](#configuration)
11. [Production checklist](#production-checklist)
12. [Development](#development)
13. [Troubleshooting](#troubleshooting)

## Quick start

```bash
git clone https://github.com/adamcfield/google-workspace-mcp-worker && cd google-workspace-mcp-worker
npm ci
./scripts/setup.sh --no-secrets      # wrangler login → creates OAUTH_KV + TOKEN_KV → deploys both workers → prints URLs + redirect URIs
# → Google Cloud: enable the APIs, create the OAuth client with BOTH /callback redirect URIs (docs/GCP-SETUP.md)
npx wrangler secret put GOOGLE_CLIENT_ID     -c wrangler.oauth.jsonc     # claude.ai connector worker
npx wrangler secret put GOOGLE_CLIENT_SECRET -c wrangler.oauth.jsonc
node scripts/smoke.mjs https://google-workspace-mcp-oauth.<sub>.workers.dev
# → Claude → Settings → Connectors → Add custom connector → https://google-workspace-mcp-oauth.<sub>.workers.dev/mcp
```

Only want the connector? `./scripts/setup.sh --oauth-only`. Only the bearer worker? `--bearer-only`.

## Google Cloud setup

Full click-by-click (and `gcloud`) guide: **[docs/GCP-SETUP.md](docs/GCP-SETUP.md)**. In short:

1. **Project** — create or reuse one (`gcloud projects create …`). No billing needed.
2. **Enable 14 APIs** — Sheets, Drive, Docs, Gmail, Calendar, Tasks, People, Chat, Slides, Forms, Photos Library, Photos Picker, YouTube Data v3, Meet REST:
   ```bash
   gcloud services enable sheets.googleapis.com drive.googleapis.com docs.googleapis.com gmail.googleapis.com \
     calendar-json.googleapis.com tasks.googleapis.com people.googleapis.com chat.googleapis.com slides.googleapis.com \
     forms.googleapis.com photoslibrary.googleapis.com photospicker.googleapis.com youtube.googleapis.com meet.googleapis.com
   ```
   Chat additionally needs a *Chat app* configuration (name + avatar) under *Google Chat API → Configuration*, or every Chat call is a 403.
3. **OAuth consent screen** — *Internal* if your account is a Google Workspace account in that org (no verification, no 7-day token expiry, no warning screen). Otherwise *External* and **Publish app → In production** — *Testing* status expires refresh tokens every 7 days. You will see Google's *"unverified app"* interstitial once per sign-in: **Advanced → Go to … (unsafe)**; expected for a self-owned client.
4. **OAuth client** — *Web application*, authorized redirect URIs (one per deployed worker, exact, https, no trailing slash):
   - `https://google-workspace-mcp-oauth.<your-subdomain>.workers.dev/callback`
   - `https://google-workspace-mcp.<your-subdomain>.workers.dev/callback`

   Copy the client id + secret. One client serves both workers.

## Deploy

Requirements: Node 22+, a Cloudflare account. Everything runs on the free plan (Workers + KV + Durable Objects with SQLite storage).

```bash
npm ci
npx wrangler login
# claude.ai connector worker (primary)
npx wrangler kv namespace create OAUTH_KV        # paste the id into wrangler.oauth.jsonc
npx wrangler deploy -c wrangler.oauth.jsonc      # → https://google-workspace-mcp-oauth.<sub>.workers.dev
npx wrangler secret put GOOGLE_CLIENT_ID     -c wrangler.oauth.jsonc
npx wrangler secret put GOOGLE_CLIENT_SECRET -c wrangler.oauth.jsonc
# bearer worker (optional)
npx wrangler kv namespace create TOKEN_KV        # paste the id into wrangler.jsonc
npx wrangler deploy                              # → https://google-workspace-mcp.<sub>.workers.dev
npx wrangler secret put MCP_AUTH_TOKEN           # e.g. openssl rand -hex 32
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

`scripts/setup.sh` runs exactly these steps interactively (both workers, or `--oauth-only` / `--bearer-only`). Secrets apply immediately (no redeploy).

**Public pages:** `/` (landing page — doubles as the *application home page* for Google's consent-screen branding) and `/privacy` (plain-text privacy policy — use `https://<oauth-worker>/privacy` as the *privacy policy* URL when the consent screen is External).

**CI/CD:** `.github/workflows/ci.yml` typechecks, tests, checks the README tables and dry-run-bundles both workers on every push; `.github/workflows/deploy.yml` deploys both on push to `main` when the repo has `CLOUDFLARE_API_TOKEN` (template *Edit Cloudflare Workers* + *Workers KV Storage: Edit*) and `CLOUDFLARE_ACCOUNT_ID` secrets — or connect the repo to Cloudflare *Workers Builds*. Worker secrets persist across deploys.

## Connect Claude (claude.ai connector)

Works in Claude web, desktop and mobile (Pro/Max/Team/Enterprise; org admins may need to allow custom connectors) — the connector settings sync across your devices.

1. Claude → **Settings → Connectors → Add custom connector**.
2. **Name:** `Google Workspace` · **Remote MCP server URL:** `https://google-workspace-mcp-oauth.<sub>.workers.dev/mcp`. Leave *OAuth client ID / secret* empty (the server supports dynamic registration — Claude registers itself).
3. **Add** → **Connect**. A window opens on the Worker's consent page (it names *Claude* as the requesting client and lists the Google permissions) → **Continue with Google** → Google account chooser → *(External app: "Google hasn't verified this app" → Advanced → Go to Google Workspace MCP)* → allow all permissions → **Continue**.
4. Back in Claude the connector shows *Connected*; enable it in a chat's tools menu. Ask: *"Run google_whoami"* to confirm the account and granted scopes.

Under the hood claude.ai fetches `/.well-known/oauth-protected-resource/mcp` (from the `WWW-Authenticate` hint on the 401), then `/.well-known/oauth-authorization-server`, registers a client at `/register`, runs PKCE through `/authorize` → `/token`, and calls `/mcp` with the bearer it received. All of that is served by `workers-oauth-provider`; `node scripts/smoke.mjs <url>` checks every piece.

Claude Code: `claude mcp add --transport http google-workspace https://google-workspace-mcp-oauth.<sub>.workers.dev/mcp` runs the same OAuth flow.

## Bearer worker

For clients that send a static header instead of doing OAuth.

1. Deploy (above) and set `MCP_AUTH_TOKEN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.
2. Connect **your** Google account once — open `https://google-workspace-mcp.<sub>.workers.dev/google/auth?key=<MCP_AUTH_TOKEN>` in a browser (or keep the secret out of browser history: `curl -X POST -H "Authorization: Bearer <MCP_AUTH_TOKEN>" https://…/google/auth/link` → open the single-use `url` it returns). Google's consent screen → done. The refresh token is stored AES-GCM-encrypted in `TOKEN_KV` (key derived from `MCP_AUTH_TOKEN` + `GOOGLE_CLIENT_SECRET`). Alternative: set a `GOOGLE_REFRESH_TOKEN` secret and skip the browser.
3. Check: `curl -H "Authorization: Bearer <MCP_AUTH_TOKEN>" https://…/google/status`. Disconnect: `curl -X DELETE …/google/auth` (revokes at Google).
4. Use it: `claude mcp add --transport http google-workspace https://…/mcp --header "Authorization: Bearer <MCP_AUTH_TOKEN>"`, or any MCP client with a bearer header. `ALLOWED_EMAILS` limits which account may complete step 2.

## Verify end-to-end

After connecting, in Claude:

1. *"Use sheets_read_range on spreadsheet `<id>` range `Sheet1!A1:D10` with formulas"* — you get `values` + `formulas`.
2. *"Write 'hello' into `Sheet1!Z1000` then clear it"* — `sheets_write_range` then `sheets_clear_range`.
3. *"List my next 3 calendar events"* — `calendar_list_events` with `max_results: 3`.
4. *"Create a Gmail draft to me with subject 'MCP test', then delete that draft"* — `gmail_create_draft` → `gmail_delete_draft`.

Can't reach `*.workers.dev` from where you are (locked-down network)? The **Smoke** GitHub Actions workflow (`Actions → Smoke → Run workflow`) runs the same script from a GitHub runner; give it the worker URL(s), and with an `MCP_AUTH_TOKEN` repo secret plus a spreadsheet id it runs the bearer `--e2e` checks too.

The same four checks run without Claude against either worker: `E2E_SPREADSHEET_ID=<id> node scripts/smoke.mjs <origin> --e2e` — it reads a range, writes one cell and reverts it, lists the next 3 events, and creates + deletes a draft. For the connector worker get a token first with `node scripts/login.mjs <origin>` (runs the OAuth flow in your browser, saves `.mcp-token.local`); for the bearer worker pass `MCP_TOKEN=<MCP_AUTH_TOKEN>`.

## Scopes

Requested at sign-in (single source of truth: [`src/google/scopes.ts`](src/google/scopes.ts)); you can untick any on Google's screen and the matching tools will return a clear "missing scope" error.

**Narrower access.** The table lists every scope, but a deployment only asks for the scopes of the groups it enables, plus `openid` and `userinfo.email`. A deployment used for spreadsheet work can set `ENABLED_TOOL_GROUPS=sheets`, and Google then asks only for `spreadsheets` (you open files by URL or id, because finding one by name needs Drive). The `sheets_power_user` profile (sheets + drive) adds full `drive` and still asks for no Gmail. Someone who connected before the change must revoke the app at <https://myaccount.google.com/permissions> and reconnect, because Google carries earlier grants forward. See [docs/OPERATIONS.md](docs/OPERATIONS.md#narrow-access-for-one-job).

<!-- SCOPES:START -->
| Group | Scope URL | Class | Why |
|---|---|---|---|
| Identity | `openid` | non-sensitive | Identify the signed-in Google account |
| Identity | `https://www.googleapis.com/auth/userinfo.email` | non-sensitive | Read the account email (grant key + allow-list) |
| Sheets | `https://www.googleapis.com/auth/spreadsheets` | sensitive | Read/write all spreadsheets |
| Drive | `https://www.googleapis.com/auth/drive` | restricted | Full Drive access: search, read, upload, share, folders |
| Docs | `https://www.googleapis.com/auth/documents` | sensitive | Read/write all Google Docs |
| Gmail | `https://www.googleapis.com/auth/gmail.modify` | restricted | Read, search, draft, send, label (no permanent delete) |
| Calendar | `https://www.googleapis.com/auth/calendar` | sensitive | Read/write calendars and events |
| Tasks | `https://www.googleapis.com/auth/tasks` | sensitive | Read/write task lists and tasks |
| Contacts (People) | `https://www.googleapis.com/auth/contacts` | sensitive | Read/write personal contacts |
| Chat | `https://www.googleapis.com/auth/chat.spaces.readonly` | sensitive | List/get Chat spaces |
| Chat | `https://www.googleapis.com/auth/chat.messages` | sensitive | Read, send, edit, delete Chat messages as you |
| Slides | `https://www.googleapis.com/auth/presentations` | sensitive | Read/write presentations |
| Forms | `https://www.googleapis.com/auth/forms.body` | sensitive | Create/edit forms |
| Forms | `https://www.googleapis.com/auth/forms.responses.readonly` | sensitive | Read form responses |
| Photos | `https://www.googleapis.com/auth/photoslibrary.appendonly` | sensitive | Upload photos/videos and create albums |
| Photos | `https://www.googleapis.com/auth/photoslibrary.readonly.appcreateddata` | sensitive | List/search albums and media this app created |
| Photos | `https://www.googleapis.com/auth/photoslibrary.edit.appcreateddata` | sensitive | Edit albums/media this app created |
| Photos | `https://www.googleapis.com/auth/photospicker.mediaitems.readonly` | sensitive | Read media you pick in a Photos Picker session (any library photo) |
| YouTube | `https://www.googleapis.com/auth/youtube.readonly` | sensitive | Read your channels, playlists, videos, stats |
| Meet | `https://www.googleapis.com/auth/meetings.space.created` | sensitive | Create Meet spaces; read records of meetings you created |
| Meet | `https://www.googleapis.com/auth/meetings.space.readonly` | sensitive | Read Meet spaces, conference records, participants, transcripts |

APIs to enable (14): `sheets.googleapis.com`, `drive.googleapis.com`, `docs.googleapis.com`, `gmail.googleapis.com`, `calendar-json.googleapis.com`, `tasks.googleapis.com`, `people.googleapis.com`, `chat.googleapis.com`, `slides.googleapis.com`, `forms.googleapis.com`, `photoslibrary.googleapis.com`, `photospicker.googleapis.com`, `youtube.googleapis.com`, `meet.googleapis.com`.
<!-- SCOPES:END -->

Why these differ slightly from the original spec:
- **Photos:** Google removed `photoslibrary`, `photoslibrary.readonly` and `photoslibrary.sharing` on 2025-03-31 (requesting them fails the whole consent). The Library API now only returns media/albums created by this app; `photos_upload_media_item` / `photos_search_media_items` work on that. For *any* photo in your library use the Picker flow: `photos_create_picker_session` → open the URL, select → `photos_list_picked_media_items`.
- **Meet:** the REST API v2 scopes are `meetings.space.created` and `meetings.space.readonly` (covering spaces, conference records, participants, recordings, transcripts). `meet.conference.media.readonly` does not exist.
- `openid` + `userinfo.email` identify the account so grants are keyed by email and `ALLOWED_EMAILS` can be enforced.

## Tools

Sheets safety features (added in 1.2.0):

- **Write verification** — `sheets_write_range`, `sheets_batch_write_ranges`, `sheets_append_rows` and `sheets_batch_update_spreadsheet` re-read what they wrote (`verify`, default on) and return `verification: {cells, errors: [{cell, type, message}], ok}` plus a `warning` line when a formula evaluates to `#REF!`, `#DIV/0!`, `#N/A`, … A broken formula is never a silent success.
- **`sheets_batch_update_spreadsheet`** — requests apply in order and all-or-nothing, and `{writeValues: {range, values}}` (or `{sheetId, range: "A1:C2", values}`) inside `requests` writes values in the same call as structural changes (insert/delete rows, …). `dry_run: true` returns a plan without writing (per request: type, sheet, A1 range, cell count, plain-language effect, warning, and the current contents of ranges that would be overwritten); for `deleteDimension` / `deleteRange` / `deleteSheet` it also shows the contents about to be lost and the formulas elsewhere that read them (`becomes: "#REF!"`). A real run answers with `reply: "summary"` by default — `applied`, `totals` (`rowsInserted`, `cellsFormatted`, `cellsWritten`, `sheetsAdded`, …), warnings grouped by text and only the notable changes — or every request's effect with `reply: "full"`. After structural changes `post_check` (default on) re-reads the tabs and reports error cells as `postCheck`; `snapshot: true` first copies each tab a destructive request touches to a hidden backup tab (delete it when no longer needed). These grid reads, and the re-read `verify` makes after a batch, cover at most 100,000 grid cells and 8 MB of response each and ask only for the cell fields they use; tabs and written ranges left out are named. A dry run reads the current contents of a range only when its whole block is at most 200 grid cells, within 8 MB.
- **`sheets_delete_sheet` / `sheets_clear_range`** — the same opt-in `snapshot` (a hidden backup of the tab first). `sheets_delete_sheet` also checks (`post_check`, default on) the tabs whose formulas read the deleted tab and reports their error cells as `postCheck`.
- **`sheets_read_cells` `fields`** — pick facets (`value`, `formula`, `note`, `link`, `validation`, `number_format`, `text`, `fill`, `align`, `borders`, `format`); colors are hex, identical borders collapse to `{all}`, and the API field mask matches the selection so both the request and the output stay small.
- **Model checks** — `sheets_audit_spreadsheet` (error cells with Google's message, circular references, references to missing sheets, formulas that break their column/row pattern, ranges that stop before the data does), `sheets_trace_precedents` (where a number comes from) and `sheets_trace_dependents` (what breaks if a cell changes).

<!-- TOOLS:START -->
Total: **168 tools** in 14 groups. R = read-only, W = writes, D = destructive/irreversible.

<details><summary><b>Meta</b> — 3 tools (<code>google_*</code>)</summary>

| Tool | Mode | Scope | What it does |
|---|---|---|---|
| `google_whoami` | R | `userinfo.email` | Identity check for the connected Google account: email, hosted domain (hd, Workspace accounts only), the OAuth scopes actually granted (shor |
| `google_api_request` | D | — | Escape hatch: call ANY Google REST endpoint (https://*.googleapis.com/...) with the signed-in user's token |
| `google_list_tools` | R | — | What this deployment enables: its tool groups (name, prefix such as 'gmail_', one-line hint, counts), the groups switched off here (disabled |

</details>

<details><summary><b>Sheets</b> — 19 tools (<code>sheets_*</code>)</summary>

| Tool | Mode | Scope | What it does |
|---|---|---|---|
| `sheets_list_spreadsheets` | R | `drive` | List Google Sheets spreadsheets in Drive (optionally filtered by name/full-text query or folder) |
| `sheets_get_spreadsheet` | R | `spreadsheets` | Spreadsheet metadata: title, locale/timezone, every tab (sheetId, title, index, grid rowCount/columnCount, frozen rows/cols, hidden), named  |
| `sheets_read_range` | R | `spreadsheets` | Read cell values from a range in A1 notation (e.g |
| `sheets_batch_read_ranges` | R | `spreadsheets` | Read several ranges in one call (values.batchGet) |
| `sheets_read_cells` | R | `spreadsheets` | Full-fidelity cell read for a range: values, formulas, notes, hyperlinks, data validation and formatting — pick exactly which with `fields`  |
| `sheets_write_range` | W | `spreadsheets` | Overwrite a range with values (values.update) |
| `sheets_batch_write_ranges` | W | `spreadsheets` | Write several ranges in one call (values.batchUpdate) |
| `sheets_fill_range` | W | `spreadsheets` | Fill one formula or value across a range, relative references adjusting as with the fill handle |
| `sheets_append_rows` | W | `spreadsheets` | Append rows after the last row of the table that starts at `range` (values.append) |
| `sheets_clear_range` | D | `spreadsheets` | Clear values in a range (formatting is kept). |
| `sheets_batch_update_spreadsheet` | W | `spreadsheets` | Run spreadsheets.batchUpdate requests — the full Sheets API: repeatCell/updateCells (formats, number formats, colors), updateBorders, insert |
| `sheets_add_sheet` | W | `spreadsheets` | Add a new tab (sheet) to a spreadsheet. |
| `sheets_delete_sheet` | D | `spreadsheets` | Delete a tab by sheetId (irreversible — the tab and its data are gone). |
| `sheets_create_spreadsheet` | W | `spreadsheets` | Create a new spreadsheet (optionally with named tabs, initial data in the first tab, and inside a Drive folder) |
| `sheets_replace_text` | W | `spreadsheets` | Find & replace text across a tab or the whole spreadsheet (supports regex, match case, entire cell, inside formulas). |
| `sheets_copy_sheet` | W | `spreadsheets` | Copy a tab into another spreadsheet (sheets.copyTo). |
| `sheets_audit_spreadsheet` | R | `spreadsheets` | Health check of a spreadsheet (or selected ranges): formula errors, plus warnings about broken fill-downs and short ranges |
| `sheets_trace_precedents` | R | `spreadsheets` | Dependency tree of a cell: its formula, the cells/ranges it reads (resolving sheet-qualified and named ranges), their values, and recursivel |
| `sheets_trace_dependents` | R | `spreadsheets` | Reverse dependency lookup: every formula in the spreadsheet that reads a given cell (directly, through a range that contains it, via a sheet |

</details>

<details><summary><b>Drive</b> — 15 tools (<code>drive_*</code>)</summary>

| Tool | Mode | Scope | What it does |
|---|---|---|---|
| `drive_search_files` | R | `drive` | Search Drive files (files.list across My Drive + shared drives) |
| `drive_get_file` | R | `drive` | File/folder metadata by id: name, mimeType, size (omitted for native Google files — Drive reports a placeholder there), timestamps, parents, |
| `drive_read_file` | R | `drive` | Read a file's content |
| `drive_upload_file` | W | `drive` | Create a file in Drive from inline content (multipart upload) |
| `drive_update_file_content` | W | `drive` | Replace the content of an existing (non-Google-native) file with new bytes (media upload) |
| `drive_create_folder` | W | `drive` | Create a new Drive folder / directory (optionally inside parent_id; default My Drive root) |
| `drive_update_file` | W | `drive` | Update file metadata: rename, set description, star/unstar, trash/untrash |
| `drive_move_file` | W | `drive` | Move a file/folder into another folder (Drive files have exactly one parent, so the current parent is replaced; to make a file appear in a s |
| `drive_copy_file` | W | `drive` | Copy a file (not folders — Drive cannot copy folders) |
| `drive_delete_file` | D | `drive` | Move a file/folder to trash (default, recoverable for 30 days) or delete it permanently (permanent=true — irreversible, also deletes a folde |
| `drive_list_permissions` | R | `drive` | List who has access to a file/folder: permission id, type (user/group/domain/anyone), role, emailAddress/domain, displayName, expirationTime |
| `drive_share_file` | W | `drive` | Share a file/folder: grant a role to a user/group (email), a whole domain, or anyone with the link |
| `drive_delete_permission` | D | `drive` | Revoke access by deleting a permission (id from drive_list_permissions) |
| `drive_list_shared_drives` | R | `drive` | List shared drives (Team Drives) the account can access: id, name, createdTime |
| `drive_get_quota` | R | `drive` | Signed-in Drive user (email, display name) and storage quota (limit, usage, usageInDrive, usageInDriveTrash — bytes; limit absent = unlimite |

</details>

<details><summary><b>Docs</b> — 15 tools (<code>docs_*</code>)</summary>

| Tool | Mode | Scope | What it does |
|---|---|---|---|
| `docs_read_document` | R | `documents` | Read a Google Doc |
| `docs_get_document` | R | `documents` | Document skeleton without the prose: heading outline [{heading, level, startIndex, endIndex}], endIndex (append point is endIndex-1), tables |
| `docs_create_document` | W | `documents` | Create a new Google Doc (optionally with initial body text and inside a Drive folder — moving needs the drive scope) |
| `docs_append_text` | W | `documents` | Append text at the end of the document body (a newline is added first when the document already has content, so the text starts a new paragr |
| `docs_insert_text` | W | `documents` | Insert text at a body index (1 = start of the document; use outline/endIndex from docs_get_document) |
| `docs_replace_text` | W | `documents` | Replace every occurrence of a string in the whole document (body, headers, footers, footnotes) — plain substring match, no regex |
| `docs_delete_range` | D | `documents` | Delete body content between two indexes [start_index, end_index) — irreversible |
| `docs_insert_table` | W | `documents` | Insert a rows x columns table at a body index (a newline is inserted before it, so the table starts at index+1) and fill its cells from a 2- |
| `docs_replace_section` | W | `documents` | Replace the body under a heading (up to the next heading of the same or higher level, or the document end) with plain text in one atomic edi |
| `docs_update_paragraph_style` | W | `documents` | Set paragraph spacing, line spacing, alignment or named style on an index range [start_index, end_index) or on the body of a section by head |
| `docs_batch_update_document` | W | `documents` | Run raw documents.batchUpdate requests — the full Docs API surface: insertText{location:{index},text}, deleteContentRange{range}, replaceAll |
| `docs_export_document` | R | `drive` | Export a Google Doc through Drive as PDF, plain text, HTML, Markdown or .docx |
| `docs_list_comments` | R | `drive` | List a Google Doc's comments: id, author, content, quotedText, resolved, createdTime, replyCount (include_replies adds the replies) |
| `docs_create_comment` | W | `drive` | Add a comment to a Google Doc |
| `docs_create_reply` | W | `drive` | Reply to a comment on a Google Doc (comment_id from docs_list_comments); resolve=true also marks the comment resolved. |

</details>

<details><summary><b>Gmail</b> — 20 tools (<code>gmail_*</code>)</summary>

| Tool | Mode | Scope | What it does |
|---|---|---|---|
| `gmail_search_messages` | R | `gmail.modify` | Search messages with Gmail query syntax and return a compact list (id, threadId, date, from, to, subject, snippet, labelIds) + nextPageToken |
| `gmail_read_message` | R | `gmail.modify` | Read one message by id |
| `gmail_read_thread` | R | `gmail.modify` | Get a whole conversation thread by threadId: every message in order |
| `gmail_download_attachment` | R | `gmail.modify` | Download an attachment (attachmentId from gmail_read_message) |
| `gmail_list_labels` | R | `gmail.modify` | List all labels: system ones (INBOX, UNREAD, STARRED, SENT, DRAFT, SPAM, TRASH, IMPORTANT, CATEGORY_*) and user labels (id like Label_123) |
| `gmail_get_label` | R | `gmail.modify` | Get one label with its counts (messagesTotal, messagesUnread, threadsTotal, threadsUnread) and visibility settings |
| `gmail_create_label` | W | `gmail.modify` | Create a user label |
| `gmail_modify_message_labels` | W | `gmail.modify` | Add/remove labels on ONE message |
| `gmail_batch_modify_message_labels` | W | `gmail.modify` | Add/remove labels on up to 1000 messages in one call (messages.batchModify) |
| `gmail_modify_thread_labels` | W | `gmail.modify` | Add/remove labels on every message of a thread (threads.modify) |
| `gmail_trash_message` | D | `gmail.modify` | Move a message to Trash (auto-deleted permanently after 30 days; undo with gmail_untrash_message). |
| `gmail_untrash_message` | W | `gmail.modify` | Restore a message from Trash. |
| `gmail_create_draft` | W | `gmail.modify` | Create a draft (does NOT send) |
| `gmail_update_draft` | W | `gmail.modify` | Replace a draft's content (drafts.update) |
| `gmail_list_drafts` | R | `gmail.modify` | List drafts (newest first) with draftId, messageId, threadId, to, subject, date, snippet |
| `gmail_read_draft` | R | `gmail.modify` | Read a draft in full: { draftId, message: {to, cc, bcc, subject, body, attachments, threadId, …} }. |
| `gmail_delete_draft` | D | `gmail.modify` | Permanently delete a draft (irreversible; drafts do not go to Trash). |
| `gmail_send_draft` | D | `gmail.modify` | Sends an existing draft |
| `gmail_send_message` | D | `gmail.modify` | Sends email immediately as the user |
| `gmail_get_profile` | R | `gmail.modify` | The signed-in mailbox: emailAddress, messagesTotal, threadsTotal, historyId. |

</details>

<details><summary><b>Calendar</b> — 12 tools (<code>calendar_*</code>)</summary>

| Tool | Mode | Scope | What it does |
|---|---|---|---|
| `calendar_list_calendars` | R | `calendar` | List all calendars the user has (calendar list: own, subscribed, shared, secondary) — the way to get calendar ids |
| `calendar_list_events` | R | `calendar` | List/search events in a calendar (events.list) |
| `calendar_get_event` | R | `calendar` | Get one event by id with its full description, attendees and response statuses, Meet link, recurrence and reminders. |
| `calendar_create_event` | W | `calendar` | Create an event |
| `calendar_update_event` | W | `calendar` | Update an event (PATCH: only the fields you pass change) |
| `calendar_delete_event` | D | `calendar` | Delete an event (irreversible) |
| `calendar_quick_add_event` | W | `calendar` | Create an event from natural-language text (events.quickAdd), e.g |
| `calendar_move_event` | W | `calendar` | Move an event to another calendar (events.move) |
| `calendar_rsvp_event` | W | `calendar` | RSVP to an invitation as the signed-in user: sets your attendee responseStatus (accepted / declined / tentative / needsAction) and optional  |
| `calendar_get_free_busy` | R | `calendar` | Free/busy intervals for one or more calendars in a time window (freeBusy.query) |
| `calendar_list_event_instances` | R | `calendar` | List the individual occurrences of a recurring event (events.instances) |
| `calendar_get_colors` | R | `calendar` | Color palette for events and calendars (colors.get): maps color id → background hex, so color_id values for calendar_create_event/calendar_u |

</details>

<details><summary><b>Tasks</b> — 13 tools (<code>tasks_*</code>)</summary>

| Tool | Mode | Scope | What it does |
|---|---|---|---|
| `tasks_list_tasklists` | R | `tasks` | List all Google Tasks lists (to-do lists) of the account — the way to get tasklist ids |
| `tasks_create_tasklist` | W | `tasks` | Create a new task list |
| `tasks_update_tasklist` | W | `tasks` | Rename a task list (title is the only editable field). |
| `tasks_delete_tasklist` | D | `tasks` | Delete a task list and every task in it (irreversible) |
| `tasks_list_tasks` | R | `tasks` | List tasks in a task list (flat, ordered like the UI: top-level tasks by position, each followed by its subtasks; subtasks carry `parent`) |
| `tasks_get_task` | R | `tasks` | Get one task by id: title, notes, status (needsAction\|completed), due (YYYY-MM-DD), completed time, parent, position, links. |
| `tasks_create_task` | W | `tasks` | Create a task |
| `tasks_update_task` | W | `tasks` | Update a task's title, notes, due date and/or status (PATCH — omitted fields are untouched) |
| `tasks_complete_task` | W | `tasks` | Mark a task as completed (Google records the completion time) |
| `tasks_uncomplete_task` | W | `tasks` | Reopen a completed task (status back to needsAction, completion time cleared) |
| `tasks_move_task` | W | `tasks` | Move a task: re-nest it under `parent` (omit to make it top-level), place it after `previous` (omit to put it first), and/or move it to anot |
| `tasks_delete_task` | D | `tasks` | Delete a task permanently (irreversible; its subtasks are deleted too) |
| `tasks_clear_completed_tasks` | D | `tasks` | Clear all completed tasks from a list: they become hidden (still retrievable with show_hidden=true, and can be reopened), not deleted. |

</details>

<details><summary><b>Contacts</b> — 9 tools (<code>contacts_*</code>)</summary>

| Tool | Mode | Scope | What it does |
|---|---|---|---|
| `contacts_search_contacts` | R | `contacts` | Search the user's contacts by name, email, phone, nickname or organization (prefix match on words) |
| `contacts_list_contacts` | R | `contacts` | List all of the user's contacts (people/me/connections), paginated |
| `contacts_get_contact` | R | `contacts` | Get one contact by resource name ('people/c…') with all supported fields (names, emails, phones, organization, addresses, birthday, notes, u |
| `contacts_create_contact` | W | `contacts` | Create a contact |
| `contacts_update_contact` | W | `contacts` | Update a contact |
| `contacts_delete_contact` | D | `contacts` | Permanently delete a contact by resource name ('people/c…') |
| `contacts_list_groups` | R | `contacts` | List contact groups (labels): resourceName ('contactGroups/…'), name, groupType (USER_CONTACT_GROUP or SYSTEM_CONTACT_GROUP such as myContac |
| `contacts_modify_group_members` | W | `contacts` | Add and/or remove contacts ('people/c…') in a contact group ('contactGroups/…') |
| `contacts_batch_get_contacts` | R | `contacts` | Get up to 200 contacts by resource name ('people/c…') in one call |

</details>

<details><summary><b>Chat</b> — 10 tools (<code>chat_*</code>)</summary>

| Tool | Mode | Scope | What it does |
|---|---|---|---|
| `chat_list_spaces` | R | `chat.spaces.readonly` | List Chat spaces (rooms, group chats and direct messages) the signed-in user is a member of |
| `chat_get_space` | R | `chat.spaces.readonly` | Get one Chat space by resource name (spaces/AAAA): display name, type, threading/history state, member count, spaceUri |
| `chat_find_direct_message` | R | `chat.spaces.readonly` | Find the existing direct-message space between the signed-in user and another user, by email address or users/{id} |
| `chat_list_messages` | R | `chat.messages` | List messages in a space (spaces/AAAA), newest first by default |
| `chat_get_message` | R | `chat.messages` | Get one message by resource name (spaces/AAAA/messages/BBBB): text, sender, thread, attachments, quoted message, reactions |
| `chat_send_message` | D | `chat.messages` | Send a message to a space as the signed-in user |
| `chat_update_message` | W | `chat.messages` | Edit the text of a message you sent (spaces/AAAA/messages/BBBB) |
| `chat_delete_message` | D | `chat.messages` | Delete a message (spaces/AAAA/messages/BBBB) — irreversible |
| `chat_add_reaction` | W | `chat.messages` | Add an emoji reaction (unicode emoji such as 👍 or ✅) to a message as the signed-in user |
| `chat_upload_attachment` | W | `chat.messages` | Upload a file (base64 content) as a Chat attachment for a space |

</details>

<details><summary><b>Slides</b> — 11 tools (<code>slides_*</code>)</summary>

| Tool | Mode | Scope | What it does |
|---|---|---|---|
| `slides_get_presentation` | R | `presentations` | Presentation overview: title, locale, page size, revisionId, slide count, layouts (objectId + display name — needed for custom layouts) and  |
| `slides_read_presentation` | R | `presentations` | Cheapest way to read a deck: per slide {index, objectId, title (first TITLE/CENTERED_TITLE placeholder), text (all shape/table text joined w |
| `slides_get_slide` | R | `presentations` | One slide (page) in full detail: every element with objectId, type, placeholder, text (tables as cells[][], groups as children[]), transform |
| `slides_get_thumbnail` | R | `presentations` | PNG thumbnail of a slide: returns a contentUrl (valid ~30 minutes, no auth needed to fetch) plus width/height |
| `slides_create_presentation` | W | `presentations` | Create a new Google Slides presentation / slide deck (default theme, one blank title slide) |
| `slides_add_slide` | W | `presentations` | Append (or insert at insertion_index) a slide using a predefined layout and fill its title/body placeholders and speaker notes in one go |
| `slides_insert_text` | W | `presentations` | Insert text into a shape or table cell at a character index (0 = start; text inserted at the end must use the current length — read it with  |
| `slides_replace_text` | W | `presentations` | Replace every occurrence of a string across the deck (or only on the given slides) — the standard way to fill a template |
| `slides_delete_object` | D | `presentations` | Delete a page element (shape, image, table, line, group) or a whole slide by objectId |
| `slides_batch_update_presentation` | W | `presentations` | Run raw presentations.batchUpdate requests — the full Slides API surface: createSlide, insertText, deleteText, replaceAllText, createShape ( |
| `slides_export_presentation` | R | `drive` | Export a presentation through Drive as plain text (default — all slide text, cheap), PDF or .pptx |

</details>

<details><summary><b>Forms</b> — 9 tools (<code>forms_*</code>)</summary>

| Tool | Mode | Scope | What it does |
|---|---|---|---|
| `forms_get_form` | R | `forms.body` | Get a form's structure: title, description, responderUri (public link), linked responses sheet, publish state and every item (itemId, questi |
| `forms_list_responses` | R | `forms.responses.readonly` | List responses to a form, newest first |
| `forms_get_response` | R | `forms.responses.readonly` | Get one response by responseId (from forms_list_responses), with answers keyed by question title. |
| `forms_create_form` | W | `forms.body` | Create a Google Form with an optional description and questions (short_text, paragraph, multiple_choice, checkboxes, dropdown, linear_scale, |
| `forms_add_questions` | W | `forms.body` | Append questions to an existing form (same question shape as forms_create_form) |
| `forms_update_form` | W | `forms.body` | Update a form's title and/or description (the Drive file name is unchanged — rename it via Drive). |
| `forms_delete_item` | D | `forms.body` | Delete an item (question, section break, text, image, video) by its 0-based index (see forms_get_form item order) |
| `forms_update_publish_settings` | W | `forms.body` | Publish/unpublish a form and open/close it for responses |
| `forms_batch_update_form` | W | `forms.body` | Run raw forms.batchUpdate requests for anything the simpler tools don't cover: createItem (any Item incl |

</details>

<details><summary><b>Photos</b> — 13 tools (<code>photos_*</code>)</summary>

| Tool | Mode | Scope | What it does |
|---|---|---|---|
| `photos_list_albums` | R | `photoslibrary.readonly.appcreateddata` | List albums in the user's Google Photos library that were created by this app (excludeNonAppCreatedData=true) |
| `photos_get_album` | R | `photoslibrary.readonly.appcreateddata` | Get one album by id (must have been created by this app) |
| `photos_create_album` | W | `photoslibrary.appendonly` | Create a new (empty) album in the user's Google Photos library |
| `photos_search_media_items` | R | `photoslibrary.readonly.appcreateddata` | Search/list media items created by this app (mediaItems:search) |
| `photos_get_media_item` | R | `photoslibrary.readonly.appcreateddata` | Get one media item by id (must have been created by this app) |
| `photos_upload_media_item` | W | `photoslibrary.appendonly` | Upload a photo/video into the user's Google Photos library (optionally into an app-created album) |
| `photos_add_album_items` | W | `photoslibrary.appendonly` | Add existing media items (max 50 per call) to an album |
| `photos_update_media_item` | W | `photoslibrary.edit.appcreateddata` | Update the description (caption) of a media item created by this app (PATCH mediaItems/{id}?updateMask=description) |
| `photos_create_picker_session` | R | `photospicker.mediaitems.readonly` | Start a Google Photos Picker session — the ONLY way to reach photos the user did not upload through this app |
| `photos_get_picker_session` | R | `photospicker.mediaitems.readonly` | Get a Picker session's state |
| `photos_list_picked_media_items` | R | `photospicker.mediaitems.readonly` | List the media items the user selected in a Picker session (only after mediaItemsSet=true) |
| `photos_download_media_item` | R | `photospicker.mediaitems.readonly` | Download the bytes of a picked media item (authenticated GET of mediaFile.baseUrl + '=d') |
| `photos_delete_picker_session` | R | `photospicker.mediaitems.readonly` | Delete / close a Photos Picker session when done with it (cleanup; frees the selection; the user's library is untouched) |

</details>

<details><summary><b>YouTube</b> — 8 tools (<code>youtube_*</code>)</summary>

| Tool | Mode | Scope | What it does |
|---|---|---|---|
| `youtube_list_my_channels` | R | `youtube.readonly` | List the YouTube channels owned by the signed-in account (channels.list mine=true): id, title, customUrl, subscribers, views, video count an |
| `youtube_get_channel` | R | `youtube.readonly` | Get one channel by channel_id (UC…), for_handle (@handle, e.g |
| `youtube_list_playlists` | R | `youtube.readonly` | List playlists of a channel (channel_id) or of the signed-in account (mine=true, the default when channel_id is omitted) |
| `youtube_list_playlist_items` | R | `youtube.readonly` | List the videos in a playlist (playlistItems.list): videoId, title, position, publishedAt, channelTitle, url |
| `youtube_get_video_stats` | R | `youtube.readonly` | Get details + statistics for up to 50 videos in one call (videos.list): title, description, channel, publishedAt, duration (ISO 8601 + secon |
| `youtube_search_videos` | R | `youtube.readonly` | Search YouTube (search.list) for videos, channels or playlists |
| `youtube_list_subscriptions` | R | `youtube.readonly` | List channels the signed-in account subscribes to (subscriptions.list mine=true): channelId, title, description |
| `youtube_list_video_comments` | R | `youtube.readonly` | List top-level comment threads on a video (commentThreads.list): id, author, text, likes, publishedAt, replyCount |

</details>

<details><summary><b>Meet</b> — 11 tools (<code>meet_*</code>)</summary>

| Tool | Mode | Scope | What it does |
|---|---|---|---|
| `meet_create_space` | W | `meetings.space.created` | Create a new Google Meet space (a meeting link) |
| `meet_get_space` | R | `meetings.space.readonly` | Get a Meet space by name, meeting code or meet.google.com URL: link, code, config (accessType, entryPointAccess, moderation) and the active  |
| `meet_update_space` | W | `meetings.space.created` | Update a Meet space's config (only the fields you pass are changed): access_type, entry_point_access, moderation (ON = host must approve par |
| `meet_end_conference` | D | `meetings.space.created` | End the active conference (kick everyone out) in a Meet space you created |
| `meet_list_conference_records` | R | `meetings.space.readonly` | List past/ongoing conference records (each meeting occurrence), newest first |
| `meet_get_conference_record` | R | `meetings.space.readonly` | Get one conference record by resource name ('conferenceRecords/…'): space, startTime, endTime, expireTime. |
| `meet_list_participants` | R | `meetings.space.readonly` | List participants of a conference record: type (signedinUser \| anonymousUser \| phoneUser), displayName, user (people/… id for signed-in us |
| `meet_list_recordings` | R | `meetings.space.readonly` | List recordings of a conference record: state (STARTED \| ENDED \| FILE_GENERATED), start/end time, driveFileId (the MP4 in Drive) and expor |
| `meet_list_transcripts` | R | `meetings.space.readonly` | List transcripts of a conference record: state, start/end time, docsDocumentId (the Google Doc holding the transcript) and exportUri |
| `meet_list_transcript_entries` | R | `meetings.space.readonly` | Read the spoken entries of a transcript ('conferenceRecords/…/transcripts/…'), in order |
| `meet_list_smart_notes` | R | `meetings.space.readonly` | List Gemini 'take notes for me' smart notes of a conference record: state, docsDocumentId (the Google Doc with the notes) and exportUri |

</details>

<!-- TOOLS:END -->

Notes:
- `gmail_send_message` / `gmail_send_draft` / `chat_send_message` require `confirm: true` and are documented for the model as *only when the user explicitly asks to send*; everything else mail-related creates drafts.
- `sheets_batch_update_spreadsheet`, `docs_batch_update_document`, `slides_batch_update_presentation`, `forms_batch_update_form` take raw Google `requests` arrays — the full API surface (formatting, borders, colors, insert/delete rows, conditional formats, charts …).
- `google_api_request` calls any `https://*.googleapis.com` endpoint with your token for the long tail.
### What each count means

One number, one meaning — a tool count and a group count are never reported under the same name.

| Number | Where it is reported | What it counts |
| --- | --- | --- |
| `toolsCallable` | `google_list_tools`, `/health` (also as `tools`, the older name alerting reads) | Tools this deployment may CALL: the enabled groups and scopes, minus write tools when `MCP_READONLY=true`. |
| `toolsListed` | `google_list_tools`, `/health` | Tools `tools/list` ADVERTISES. The same number as `toolsCallable` unless `TOOL_SURFACE=compact` hides some — a hidden tool is still callable by name. |
| `groupCount` | `google_list_tools` | Tool groups this deployment registers at least one tool from, Meta included. The same 14 the line above counts. |
| per-group `toolsCallable` / `toolsListed` | `google_list_tools` `groups[]` | The same two numbers, for one group. They sum to the totals. |

A count seen in a client that does not match these is describing a different deployment — production and a QA or staging worker run different builds on purpose. `google_whoami` and `google_list_tools` both return `serverVersion`; quote it when comparing numbers. `tests/counts.test.ts` pins every one of these to the others across disabled groups, a compact surface and a read-only deployment.

- The table above is the **full** surface — what `tools/list` advertises by default. `TOOL_SURFACE=compact` advertises a 19-tool recipe set instead (16 product tools across Gmail, Drive, Docs, Calendar, Sheets and Tasks, plus the three `google_*` meta tools); every other tool stays registered and callable by name, and `/health` reports `surface`, `toolsListed` and `toolsCallable`. The default is unchanged in this release.
- Responses drop empty fields; lists come back as `{count, items, nextPageToken}`.

### Renamed in 1.5

Tools renamed to one `<group>_<verb>_<noun>` grammar. **No tool name stops working:** every old
name stays callable as a hidden alias — it is not advertised in `tools/list`, and its result
carries a `deprecated: {alias, use}` marker. A connector added before 1.5 keeps working on its
cached names. Re-add the connector (Settings → Connectors) to see the new ones. One alias is not a
pure rename and inherits two of its target's defaults — the note under the table says which.

<!-- RENAMES:START -->
46 tools were renamed in 1.5. Every old name stays callable as a hidden alias (it is not in `tools/list`, and the result carries a `deprecated` marker) until it is removed in **2.0**.

| Old name (alias) | New name | Removed in |
|---|---|---|
| `sheets_get_metadata` | `sheets_get_spreadsheet` | 2.0 |
| `sheets_get_cells` | `sheets_read_cells` | 2.0 |
| `sheets_batch_read` | `sheets_batch_read_ranges` | 2.0 |
| `sheets_batch_write` | `sheets_batch_write_ranges` | 2.0 |
| `sheets_batch_update` | `sheets_batch_update_spreadsheet` | 2.0 |
| `sheets_find_replace` | `sheets_replace_text` | 2.0 |
| `sheets_copy_sheet_to` | `sheets_copy_sheet` | 2.0 |
| `sheets_audit` | `sheets_audit_spreadsheet` | 2.0 |
| `drive_get_permissions` | `drive_list_permissions` | 2.0 |
| `drive_remove_permission` | `drive_delete_permission` | 2.0 |
| `drive_get_about` | `drive_get_quota` | 2.0 |
| `drive_list_folder` | `drive_search_files` | 2.0 |
| `docs_get_structure` | `docs_get_document` | 2.0 |
| `docs_batch_update` | `docs_batch_update_document` | 2.0 |
| `docs_export` | `docs_export_document` | 2.0 |
| `gmail_get_thread` | `gmail_read_thread` | 2.0 |
| `gmail_get_attachment` | `gmail_download_attachment` | 2.0 |
| `gmail_get_draft` | `gmail_read_draft` | 2.0 |
| `gmail_modify_labels` | `gmail_modify_message_labels` | 2.0 |
| `gmail_batch_modify` | `gmail_batch_modify_message_labels` | 2.0 |
| `calendar_quick_add` | `calendar_quick_add_event` | 2.0 |
| `calendar_respond_to_event` | `calendar_rsvp_event` | 2.0 |
| `calendar_free_busy` | `calendar_get_free_busy` | 2.0 |
| `calendar_list_instances` | `calendar_list_event_instances` | 2.0 |
| `tasks_clear_completed` | `tasks_clear_completed_tasks` | 2.0 |
| `contacts_search` | `contacts_search_contacts` | 2.0 |
| `contacts_list` | `contacts_list_contacts` | 2.0 |
| `contacts_get` | `contacts_get_contact` | 2.0 |
| `contacts_create` | `contacts_create_contact` | 2.0 |
| `contacts_update` | `contacts_update_contact` | 2.0 |
| `contacts_delete` | `contacts_delete_contact` | 2.0 |
| `contacts_batch_get` | `contacts_batch_get_contacts` | 2.0 |
| `chat_create_message` | `chat_send_message` | 2.0 |
| `slides_read_text` | `slides_read_presentation` | 2.0 |
| `slides_batch_update` | `slides_batch_update_presentation` | 2.0 |
| `slides_export` | `slides_export_presentation` | 2.0 |
| `forms_get` | `forms_get_form` | 2.0 |
| `forms_create` | `forms_create_form` | 2.0 |
| `forms_update_info` | `forms_update_form` | 2.0 |
| `forms_set_publish_settings` | `forms_update_publish_settings` | 2.0 |
| `forms_batch_update` | `forms_batch_update_form` | 2.0 |
| `photos_add_to_album` | `photos_add_album_items` | 2.0 |
| `photos_download_picked_media` | `photos_download_media_item` | 2.0 |
| `youtube_search` | `youtube_search_videos` | 2.0 |
| `meet_end_active_conference` | `meet_end_conference` | 2.0 |
| `meet_get_transcript_entries` | `meet_list_transcript_entries` | 2.0 |

Not a pure rename: `drive_list_folder`. It was a thin wrapper over `drive_search_files`, so the alias clears the free-text `query` and keeps the old `folder_id` default (`"root"` = My Drive root). Two defaults it cannot restore differ: `page_size` is 25 (was 50) and `order_by` is `modifiedTime desc` (was `folder,name`). Everything else passes straight through — see the CHANGELOG entry for 1.5 PR-4.

<!-- RENAMES:END -->

## How auth works

**claude.ai connector (`src/oauth.ts`)**

```
Claude ──(1) GET /authorize?client_id&code_challenge──▶ Worker consent page ("Claude wants to connect…", CSRF cookie)
       ◀─(2) POST /authorize → 302 accounts.google.com (scope=…, access_type=offline, prompt=consent, state=uuid)
Google ──(3) GET /callback?code&state ────────────────▶ Worker: exchange code → refresh_token + userinfo(email) → ALLOWED_EMAILS
       ◀─(4) completeAuthorization(props={email, refreshToken, grantedScopes}) → 302 claude.ai/…?code=
Claude ──(5) POST /token (PKCE verifier) ─────────────▶ MCP access token (1h) + refresh token
Claude ──(6) POST /mcp  Authorization: Bearer ────────▶ OAuthProvider decrypts props → McpAgent → GoogleClient
```

- The refresh token is stored **only** in the grant props, which `workers-oauth-provider` encrypts at rest (the key is wrapped by the tokens given to the client) — nothing in KV is usable on its own.
- Google access tokens are cached AES-GCM-encrypted under a key derived from the refresh token and refreshed ~60 s before expiry; a revoked/expired refresh token surfaces as a "remove and re-add the connector" error instead of a 500.

**bearer worker (`src/index.ts`)**

```
you    ──(1) GET /google/auth?key=<MCP_AUTH_TOKEN> ──▶ 302 accounts.google.com (state=uuid, 10 min)
Google ──(2) GET /callback?code&state ───────────────▶ exchange → userinfo → ALLOWED_EMAILS → TOKEN_KV["owner:grant"] = AES-GCM(refresh token)
client ──(3) POST /mcp  Authorization: Bearer <MCP_AUTH_TOKEN> ▶ McpAgent → loadOwnerGrant → GoogleClient
```

Each MCP session is a Durable Object; the encrypted KV token cache means many sessions share one Google access token instead of each minting their own.

## Configuration

| Name | Kind | Worker | Purpose |
|---|---|---|---|
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | secret | both | The GCP OAuth 2.0 *Web application* client |
| `MCP_AUTH_TOKEN` | secret | bearer | Shared secret MCP clients send; also unlocks `/google/auth` |
| `GOOGLE_REFRESH_TOKEN` | secret | bearer | Optional: refresh token minted elsewhere (skips `/google/auth`) |
| `ALLOWED_EMAILS` | var | both | Comma-separated emails / `@domains` allowed to sign in. **Fail closed: empty = nobody** (unless `ALLOW_ANY_GOOGLE_ACCOUNT`). |
| `ALLOW_ANY_GOOGLE_ACCOUNT` | var | both | `"true"` → an empty allow-list admits any Google account that passes your consent screen. Opt-in for public deployments only; `/health` warns. |
| `GOOGLE_HOSTED_DOMAIN` | var | both | Optional Workspace domain pre-selected on Google's account chooser (`hd`). Enforcement is still `ALLOWED_EMAILS`. |
| `ENABLED_TOOL_GROUPS` / `DISABLED_TOOL_GROUPS` | var | both | Least privilege: comma-separated product groups (`sheets, drive, docs, gmail, calendar, tasks, contacts, chat, slides, forms, photos, youtube, meet`) or **profile** shorthands (`core` = gmail+calendar+drive+docs+sheets, `gmail`, `calendar`, `drive_docs`, `personal` = core+tasks+contacts, `sheets_power_user` = sheets+drive, `company_admin` = core+chat+meet+contacts). A group name always wins over a profile of the same name, so every pre-1.5 value keeps its exact meaning (`gmail`/`calendar` therefore always resolve as the group). **New in 1.5:** if one of these variables already holds a profile name it was ignored before and now selects groups — re-check the consent screen. Only enabled groups' tools are registered **and only their Google scopes are requested**, so the consent screen shrinks. For example, spreadsheet work needs only `sheets` (`spreadsheets` scope), or `sheets_power_user` to add Drive (see [Scopes](#scopes)). Users must reconnect after a change. |
| `TOOL_SURFACE` | var | both | Which tools `tools/list` **advertises**: `full` (default — unset, blank or an unrecognised value all mean full, and an unrecognised one also raises a `/health` warning) or `compact` (a small recipe set). The value is matched exactly, like `MCP_READONLY`'s `"true"`. Hiding a tool never unregisters it: everything the groups enable stays callable by name, so a cached connector keeps working. Scopes are group-driven and never change with the surface. |
| `TOOL_SURFACE_ADD` | var | both | Comma/space-separated extra tool names to advertise on top of a `compact` surface (no effect on `full`). A name that cannot be advertised is ignored and listed in `/health.warnings` — separately for a name that is no tool at all (a typo) and one this deployment does not register (disabled group, missing scope, `MCP_READONLY`). The warnings are raised on a `full` surface too, so a typo shows up before you switch. |
| `TOOL_RATE_LIMIT_PER_MIN` | var | both | Tool calls per minute per MCP session (default `120`; `0` = unlimited). Over budget → a tool error telling the client when to retry. |
| `MCP_READONLY` | var | both | `"true"` → only read tools are registered (no writes, sends, deletes) |
| `AUTH_RATE_LIMIT` | `ratelimits` binding | oauth | Per-IP limit (30/min) on `/authorize`, `/callback`, `/register`, `/token` (configured in `wrangler.oauth.jsonc`) |
| `OAUTH_KV` | KV binding | oauth | OAuth clients/grants/tokens, login state, encrypted Google token cache |
| `TOKEN_KV` | KV binding | bearer | Encrypted owner grant, login state, encrypted Google token cache |
| `MCP_OBJECT` | Durable Object | both | `GoogleWorkspaceMCP` sessions (SQLite-backed, free plan) |

## Production checklist

Everything below is either enforced by the code or visible in `GET /health` (`warnings` is the field to alert on). Full runbook — deploy, rollback, rotation, revocation, incidents: **[docs/OPERATIONS.md](docs/OPERATIONS.md)**.

- [ ] `ALLOWED_EMAILS` set to the accounts / `@domains` that may connect (`/health.allowList = "set"`); `ALLOW_ANY_GOOGLE_ACCOUNT` left `false`.
- [ ] Consent screen *In production* — *Internal* for a Workspace org (no verification), or *External* + published (expect the unverified-app interstitial and the 100-user cap until Google verification; restricted scopes `gmail.modify` / `drive` also need a CASA assessment). Never leave it in *Testing*: refresh tokens die after 7 days.
- [ ] Least privilege: `ENABLED_TOOL_GROUPS` / `DISABLED_TOOL_GROUPS` (group keys or a profile) limited to what the audience needs; `MCP_READONLY=true` for read-only audiences. `TOOL_SURFACE` pinned explicitly on any deployment whose client drives off the advertised list.
- [ ] Secrets only via `wrangler secret put` / repo Actions secrets; `MCP_AUTH_TOKEN` ≥ 32 random chars (`openssl rand -hex 32`).
- [ ] `AUTH_RATE_LIMIT` binding present on the connector (`/health` warns if not); `TOOL_RATE_LIMIT_PER_MIN` sized for your users.
- [ ] Deploy through CI (`deploy.yml`) with `main` protected (PR + CI + CODEOWNERS review); rollback is `npx wrangler rollback`.
- [ ] Workers Logs on (`observability.enabled`, source maps uploaded); alert on `/health.warnings`, `tool_call` error rate, `auth_rate_limited` bursts, Google 429s.
- [ ] Privacy policy URL (`/privacy`) and homepage (`/`) registered on the consent screen's branding.
- [ ] Dependabot + secret scan (gitleaks) + `npm audit` running in CI (all in this repo).

## Development

```bash
cp .dev.vars.example .dev.vars   # fill in the Google client (add http://localhost:8787/callback + http://localhost:8788/callback as redirect URIs)
npm run dev                      # bearer worker on http://localhost:8787
npm run dev:oauth                # connector worker on http://localhost:8788
npm run typecheck && npm test    # tsc + vitest (no network; fetch is mocked)
npm run gen                      # refresh generated files after changing tools (README tables + docs/measurements/current.md)
npm run measure                  # what a client pays on connect: tools/list bytes per surface (see docs/measurements/README.md)
```

Layout and conventions for contributors/agents: [CLAUDE.md](CLAUDE.md). Security model: [SECURITY.md](SECURITY.md).

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| A tool's new parameter (e.g. `max_chars`) is missing from what Claude sees after an upgrade | claude.ai caches the connector's tool list from when it was added. Server-side defaults still apply (bodies are capped at 50k regardless); to see the new schema, disable/enable or remove/re-add the connector in Settings → Connectors. |
| Claude still calls a pre-1.5 tool name (or you scripted one) | The old names keep working as hidden aliases until 2.0 — the call succeeds and the result carries `deprecated: {alias, use}`. To see the new names, remove/re-add the connector in Settings → Connectors; the mapping is in [Renamed in 1.5](#renamed-in-15). |
| Consent page button disabled / `configured: false` on `/health` | Secrets not set on **that** worker: `npx wrangler secret put GOOGLE_CLIENT_ID [-c wrangler.oauth.jsonc]` and `…SECRET` |
| Google: `redirect_uri_mismatch` | The OAuth client must list the exact `https://<that worker>/callback` (both workers have their own) |
| Google: `invalid_scope` | An API's scope isn't valid for your client type or was removed (see Scopes) — the requested list is on the landing page |
| Google: *"Access blocked: app has not completed verification"* with **no** Advanced link | The consent screen is External + *Testing* with you not listed as a test user, or a restricted scope on a client from an org with strict policies. Publish to production (or make the app Internal). |
| claude.ai: "Unable to connect" / connector never reaches the consent page | `node scripts/smoke.mjs <origin>` — the 401 on `/mcp` must carry `resource_metadata`, both `.well-known` documents must be 200 and `/register` must return 201 |
| Tool error `403 … has not been used in project … or it is disabled` | Enable that API in the GCP project (`gcloud services enable …`), wait ~1 min |
| Tool error `403 … insufficient authentication scopes` | You unticked that permission at sign-in — remove + re-add the connector (or re-run `/google/auth`) and allow it |
| `Google rejected the refresh token (invalid_grant)` | Token revoked (myaccount.google.com/permissions), password/2FA change, or a *Testing*-mode app's 7-day expiry — reconnect; publish the app |
| Bearer worker: `503 Not connected to a Google account yet` | Open `/google/auth?key=<MCP_AUTH_TOKEN>` once (or set `GOOGLE_REFRESH_TOKEN`) |
| Chat tools 403 | Add the *Chat app* configuration under Google Chat API → Configuration |
| Everything worked, then Claude asks to reconnect after ~30 days | The provider's refresh-token TTL; reconnecting is one click |

## License
MIT
