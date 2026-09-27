> **Historical document — not authoritative.**
>
> This is the original one-shot brief that started the project, kept because it explains why some
> early decisions look the way they do. It describes intentions, not the software: scopes, tool
> names, storage and setup have all moved on, and where this text and the code disagree, the code
> is right. Nothing here is a specification, a promise or a supported interface.
>
> For what the server actually does, read [README.md](../../README.md); for how it is run,
> [docs/OPERATIONS.md](../OPERATIONS.md); for how it is built,
> [CONTRIBUTING.md](../../CONTRIBUTING.md).

# Prompt for Claude: full Google Workspace MCP on Cloudflare

Build and deploy a remote MCP server that gives you full read/write access to my entire Google Workspace - Sheets first, but also Drive, Docs, Gmail, Calendar and Tasks - running as a Cloudflare Worker with real OAuth, then walk me through connecting Claude to it.

## Auth (important)

- Real OAuth 2.0 user-consent flow against my own Google account, NOT a service account. When I connect, I want the standard Google "choose your account / grant permissions" screen, the same way other apps connect to my Google account.
- Use Cloudflare's workers-oauth-provider library with Google as the upstream identity provider. Store refresh tokens encrypted (Worker KV or D1) and auto-refresh access tokens.
- Create a GCP OAuth 2.0 client (Web application) whose redirect URI is the Worker's /callback. Walk me through creating it or do it with gcloud if I have it.
- Enable these APIs in the GCP project: Google Sheets API, Google Drive API, Google Docs API, Gmail API, Google Calendar API, Google Tasks API.
- Request these scopes: spreadsheets, drive, documents, gmail.modify, calendar, tasks. List the exact scope URLs in the consent config so I can review them.


## Prior art (read this first)

I have built several MCP servers / Cloudflare Workers like this before. Before writing any code, search my GitHub repositories for previous MCP and Cloudflare Worker projects (look for "mcp", "worker", "McpAgent", "workers-oauth-provider" in names, READMEs and code) and study how they were built: project structure, auth handling, deploy setup, and tool definitions. Follow the same patterns where they fit, and tell me briefly which existing project you based your approach on.

## Stack and transport

- Cloudflare Workers + @modelcontextprotocol/sdk with McpAgent from the "agents" package, Streamable HTTP transport at /mcp, OAuth discovery endpoints so Claude's custom-connector flow completes the sign-in itself. TypeScript, wrangler for deploy, free tier.

## Tools to expose (compact JSON responses)

Sheets (highest priority - full fidelity):
1. list_spreadsheets(query)
2. get_spreadsheet_metadata(spreadsheet_id) - title, tabs, grid sizes
3. read_range(spreadsheet_id, range) - values AND formulas when asked
4. write_range(spreadsheet_id, range, values, value_input_option)
5. append_rows(spreadsheet_id, range, values)
6. batch_update(spreadsheet_id, requests) - formatting, insert/delete rows, borders, colors
7. add_sheet(spreadsheet_id, title)
8. create_spreadsheet(title)

Drive:
9. search_files(query), read_file(file_id) (Docs/Sheets/Slides/PDF export), upload_file(name, mime, content, folder_id), create_folder(name, parent_id), get_permissions(file_id), share_file(file_id, email, role)

Docs:
10. read_document(doc_id), append_text(doc_id, text), insert_text(doc_id, index, text), batch_update_document(doc_id, requests)

Gmail:
11. search_messages(query), read_message(id), create_draft(to, subject, body, thread_id?), send_message(...) only when I explicitly ask, list_labels, modify_labels(id, add, remove)

Calendar:
12. list_events(calendar_id, time_min, time_max), create_event(...), update_event(...), delete_event(...)

Tasks:
13. list_tasklists(), list_tasks(list_id), create_task(...), update_task(...), complete_task(...)


## Additional Google apps (all confirmed by the user - include every one)

Add these APIs to the GCP project and these tool groups to the server:

People (Contacts):
- search_contacts(query), list_contacts(), get_contact(resource_name), create_contact(...), update_contact(...), delete_contact(resource_name)
- Scope: contacts

Google Chat:
- list_spaces(), list_messages(space, page_size), get_message(name), create_message(space, text), update_message(name, text), delete_message(name)
- Scopes: chat.messages, chat.spaces.readonly (add chat.messages.readonly if needed)

Google Slides:
- get_presentation(presentation_id), create_presentation(title), batch_update_presentation(presentation_id, requests), read_slide_text(presentation_id)
- Scope: presentations

Google Forms:
- get_form(form_id), list_responses(form_id), create_form(title, questions)
- Scopes: forms.body, forms.responses.readonly

Google Photos:
- search_media_items(query, filters), list_albums(), get_album(album_id), upload_media_item(bytes, description, album_id?)
- Scopes: photoslibrary, photoslibrary.appendonly

YouTube:
- list_my_channels(), list_playlists(channel_id), list_videos(playlist_id), get_video_stats(video_id)
- Scope: youtube.readonly

Google Meet:
- create_space(), get_space(name), list_conference_records(space), list_participants(conference_record)
- Scopes: meet.space.created, meet.conference.media.readonly (adjust to what the current Meet API requires)

## Steps

1. Scaffold the Worker project and write all code, wrangler.toml, and the OAuth provider config.
2. Guide me through: GCP project creation, enabling the six APIs, creating the OAuth client and putting client_id/client_secret into Worker secrets.
3. Deploy, print the worker URL, and verify the OAuth discovery endpoints respond.
4. Give me exact steps to add it in Claude: Settings > Connectors > Add custom connector with the URL, then complete the Google consent screen with my own account.
5. Verify end-to-end after I connect: read a range from a test spreadsheet I share, write one cell and revert it, list my next 3 calendar events, and create+delete a draft Gmail message.

Work autonomously: stop only when you genuinely need me - GCP console actions only I can do, my Google sign-in, or a test file ID. Decide everything else yourself.

## Two operational notes (important)

- In the OAuth consent screen settings, publish the app to "In production" status. Google's default "Testing" status expires refresh tokens every 7 days, which would force me to re-authenticate weekly. Publishing is instant and needs no Google review for personal use.
- When I first connect, Google will show an "unverified app" warning because the OAuth client is new. That is expected for a self-owned app - I will click Advanced > continue.
