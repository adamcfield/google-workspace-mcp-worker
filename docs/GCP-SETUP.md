# Google Cloud setup (one-time)

Everything below happens in **your** Google Cloud project with **your** Google account. The Worker never uses a service account — it acts as whichever Google user signs in on the consent screen.

You need three things from GCP: (1) the APIs enabled, (2) an OAuth consent screen, (3) an OAuth 2.0 client (Web application) whose redirect URI is the Worker's `/callback`.

> Deploy the Workers first (`./scripts/setup.sh --no-secrets`) so you know their URLs:
> `https://google-workspace-mcp-oauth.<your-subdomain>.workers.dev` (claude.ai connector) and
> `https://google-workspace-mcp.<your-subdomain>.workers.dev` (bearer worker, optional).

## 1. Create / pick a project

Console: <https://console.cloud.google.com/projectcreate> → name it e.g. `workspace-mcp`.

With `gcloud` (optional):

```bash
gcloud auth login
gcloud projects create workspace-mcp-$(date +%s | tail -c 6) --name="workspace-mcp" --set-as-default
# or: gcloud config set project <existing-project-id>
```

No billing account is required for any of these APIs at personal-use volumes.

## 2. Enable the APIs

Console: **APIs & Services → Library**, search and click *Enable* for each:

| API | Service name | Used by |
|---|---|---|
| Google Sheets API | `sheets.googleapis.com` | `sheets_*` |
| Google Drive API | `drive.googleapis.com` | `drive_*`, exports, listing Sheets/Docs |
| Google Docs API | `docs.googleapis.com` | `docs_*` |
| Gmail API | `gmail.googleapis.com` | `gmail_*` |
| Google Calendar API | `calendar-json.googleapis.com` | `calendar_*` |
| Google Tasks API | `tasks.googleapis.com` | `tasks_*` |
| People API | `people.googleapis.com` | `contacts_*` |
| Google Chat API | `chat.googleapis.com` | `chat_*` (needs the extra Chat app config below) |
| Google Slides API | `slides.googleapis.com` | `slides_*` |
| Google Forms API | `forms.googleapis.com` | `forms_*` |
| Photos Library API | `photoslibrary.googleapis.com` | `photos_*` (uploads, app-created albums) |
| Google Photos Picker API | `photospicker.googleapis.com` | `photos_*_picker_*` (pick any library photo) |
| YouTube Data API v3 | `youtube.googleapis.com` | `youtube_*` |
| Google Meet REST API | `meet.googleapis.com` | `meet_*` |

One command for all of them:

```bash
gcloud services enable \
  sheets.googleapis.com drive.googleapis.com docs.googleapis.com gmail.googleapis.com \
  calendar-json.googleapis.com tasks.googleapis.com people.googleapis.com chat.googleapis.com \
  slides.googleapis.com forms.googleapis.com photoslibrary.googleapis.com photospicker.googleapis.com \
  youtube.googleapis.com meet.googleapis.com
```

### Google Chat extra step

The Chat API refuses every call (403) until the project has a *Chat app* configuration, even for user-authenticated calls:
**APIs & Services → Google Chat API → Configuration** → App name `Workspace MCP`, Avatar URL (any https PNG, e.g. `https://developers.google.com/chat/images/quickstart-app-avatar.png`), Description `MCP connector`, Functionality: untick everything (no bot), Visibility: leave unpublished → **Save**.

## 3. OAuth consent screen

Console: **APIs & Services → OAuth consent screen** (now "Google Auth Platform → Branding / Audience").

- **App name**: `Google Workspace MCP` · **User support email**: yours · **Developer contact**: yours.
- **Branding** (required for External): *Application home page* = `https://google-workspace-mcp-oauth.<sub>.workers.dev` · *Privacy policy link* = `https://google-workspace-mcp-oauth.<sub>.workers.dev/privacy` (both served by the worker; *Terms of service* may stay empty) · *Authorized domain*: `workers.dev`.
- **Audience / User type**:
  - Your account is a **Google Workspace** account (e.g. `@your-company.com`) and the project lives in that organisation → choose **Internal**. Internal apps need no verification, show no "unverified app" warning, and refresh tokens never expire on the 7-day testing timer. This is the best option.
  - Otherwise choose **External**, then on the *Audience* page click **Publish app** → status **In production**. Do **not** stay in *Testing*: testing-mode refresh tokens die after 7 days and you'd re-authenticate weekly. Publishing is instant and requires no Google review for your own use; you'll just see the *"Google hasn't verified this app"* interstitial when connecting — click **Advanced → Go to Google Workspace MCP (unsafe)**. That's expected for a self-owned client.
- **Scopes**: you can leave the "Data access" list empty — Google shows whatever the Worker requests at sign-in. If you prefer to list them, add exactly these (also shown on the Worker's landing page):

```
openid
https://www.googleapis.com/auth/userinfo.email
https://www.googleapis.com/auth/spreadsheets
https://www.googleapis.com/auth/drive
https://www.googleapis.com/auth/documents
https://www.googleapis.com/auth/gmail.modify
https://www.googleapis.com/auth/calendar
https://www.googleapis.com/auth/tasks
https://www.googleapis.com/auth/contacts
https://www.googleapis.com/auth/chat.spaces.readonly
https://www.googleapis.com/auth/chat.messages
https://www.googleapis.com/auth/presentations
https://www.googleapis.com/auth/forms.body
https://www.googleapis.com/auth/forms.responses.readonly
https://www.googleapis.com/auth/photoslibrary.appendonly
https://www.googleapis.com/auth/photoslibrary.readonly.appcreateddata
https://www.googleapis.com/auth/photoslibrary.edit.appcreateddata
https://www.googleapis.com/auth/photospicker.mediaitems.readonly
https://www.googleapis.com/auth/youtube.readonly
https://www.googleapis.com/auth/meetings.space.created
https://www.googleapis.com/auth/meetings.space.readonly
```

Scope notes:
- `drive` and `gmail.modify` are Google **restricted** scopes; the rest are *sensitive*. For an Internal app or a self-owned External app this only affects the warning screen, not functionality.
- `photoslibrary` / `photoslibrary.readonly` / `photoslibrary.sharing` were **removed by Google on 2025-03-31** — requesting them fails the whole consent flow. The Library API now only sees media this app uploaded; any other library photo is reached via the Picker API scope above.
- Meet's REST API v2 scopes are `meetings.space.created` / `meetings.space.readonly` (there is no `meet.conference.media.readonly`).

### Verification, the 100-user cap and CASA (External apps)

An **External** app that requests *restricted* scopes (`gmail.modify`, `drive`) shows Google's *unverified app* interstitial and is capped at **100 users** until it passes [OAuth verification](https://support.google.com/cloud/answer/13463073). For restricted scopes that includes an annual **CASA** (Cloud Application Security Assessment) by an authorised assessor — plan weeks, not days. Ways around it:

- **Internal** user type (Google Workspace organisation): no verification, no cap, only your org's accounts can consent — the right choice for a company deployment.
- **Trim scopes** with `ENABLED_TOOL_GROUPS` / `DISABLED_TOOL_GROUPS` (README → Configuration): a deployment without Gmail and Drive requests no restricted scope, which drops the CASA requirement (sensitive scopes still need the lighter verification for a public app).

Whatever you pick, keep the publishing status **In production**: *Testing* refresh tokens expire after 7 days and every user has to reconnect.

## 4. OAuth 2.0 client

Console: **APIs & Services → Credentials → Create credentials → OAuth client ID**

- Application type: **Web application**
- Name: `workspace-mcp-worker`
- Authorized JavaScript origins: *(leave empty)*
- **Authorized redirect URIs** (one per deployed worker, exact, https, no trailing slash — `setup.sh` prints them):
  - `https://google-workspace-mcp-oauth.<your-subdomain>.workers.dev/callback` (claude.ai connector)
  - `https://google-workspace-mcp.<your-subdomain>.workers.dev/callback` (bearer worker)
  - add `http://localhost:8787/callback` and `http://localhost:8788/callback` if you use `wrangler dev`
- Create → copy the **Client ID** (`…apps.googleusercontent.com`) and **Client secret** (`GOCSPX-…`).

`gcloud` cannot create this kind of client (the `iam oauth-clients` commands are for Workforce Identity, not the consent-screen client), so this step is console-only.

## 5. Put the credentials in the Worker

Each worker holds its own copy of the secrets:

```bash
# claude.ai connector worker
npx wrangler secret put GOOGLE_CLIENT_ID     -c wrangler.oauth.jsonc
npx wrangler secret put GOOGLE_CLIENT_SECRET -c wrangler.oauth.jsonc
# bearer worker (if deployed)
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put MCP_AUTH_TOKEN
```

No redeploy needed. Optionally lock the servers to your account(s):

```jsonc
// wrangler.oauth.jsonc and wrangler.jsonc → "vars"
"ALLOWED_EMAILS": "you@example.com, @yourdomain.com"
```

(then redeploy). Verify with `node scripts/smoke.mjs https://google-workspace-mcp-oauth.<sub>.workers.dev` — `configured=true` on the `/health` line. For the bearer worker, connect your account once: open `https://google-workspace-mcp.<sub>.workers.dev/google/auth?key=<MCP_AUTH_TOKEN>`.

## Revoking / rotating

- Revoke the grant for your Google account: <https://myaccount.google.com/permissions> → *Google Workspace MCP* → Remove. The Worker's cached tokens then fail with a clear "reconnect" message.
- Rotate the client secret: Credentials → the client → *Reset secret* → `npx wrangler secret put GOOGLE_CLIENT_SECRET`. Existing refresh tokens keep working with the new secret.
- Remove the connector in Claude → Settings → Connectors; the OAuth grant record in KV expires with its refresh-token TTL.
