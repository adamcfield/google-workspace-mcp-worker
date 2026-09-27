/**
 * The catalog's group rows: name, tool-name prefix, and one line on what the group covers.
 *
 * A LEAF module with no imports, because two very different consumers need it and neither may
 * depend on the other: `_manifest.ts` derives a tool's group from the prefixes (routing, off the
 * wire), and `meta.ts` returns the rows from `google_list_tools` (on the wire). They were two
 * hand-kept copies until a QA round found the numbers around them had drifted even though the
 * text had not — so there is one list now, and the file it lives in imports nothing so it can
 * never pull the routing manifest into the wire path.
 *
 * `Meta` is not here: it is the group the meta tools themselves are in, and `META_GROUP_HINT`
 * below is its row. Everything that counts groups counts all 14.
 */
export const GROUP_HINTS: { group: string; prefix: string; hint: string }[] = [
  { group: "Sheets", prefix: "sheets_", hint: "Spreadsheets: list, read/write ranges, append, batchUpdate (formatting, tabs), find/replace, create" },
  { group: "Drive", prefix: "drive_", hint: "Files & folders: search, metadata, download/export, upload, move, copy, share, trash" },
  { group: "Docs", prefix: "docs_", hint: "Google Docs: read as text/structure, create, insert/replace text or a section, paragraph spacing, comments, batchUpdate" },
  { group: "Gmail", prefix: "gmail_", hint: "Mail: search threads/messages, read bodies, drafts, send, reply, labels, attachments" },
  { group: "Calendar", prefix: "calendar_", hint: "Calendars & events: list, search, create/update/delete events, free/busy, RSVP" },
  { group: "Tasks", prefix: "tasks_", hint: "Task lists and tasks: list, create, update, complete, delete" },
  { group: "Contacts", prefix: "contacts_", hint: "People API: search/list contacts, get, create, update, delete" },
  { group: "Chat", prefix: "chat_", hint: "Google Chat: list spaces, read messages, send/edit/delete messages as you" },
  { group: "Slides", prefix: "slides_", hint: "Presentations: read slides, create, batchUpdate (text, shapes, images)" },
  { group: "Forms", prefix: "forms_", hint: "Forms: get/create forms, edit questions, read responses" },
  { group: "Photos", prefix: "photos_", hint: "Photos Library (app-created content only) and Picker sessions for library photos" },
  { group: "YouTube", prefix: "youtube_", hint: "YouTube Data (read-only): channels, playlists, videos, search, stats" },
  { group: "Meet", prefix: "meet_", hint: "Meet REST: spaces, conference records, participants, recordings, transcripts" },
];

/** The Meta group's row — the three tools that describe the server rather than the account. */
export const META_GROUP_HINT = { group: "Meta", prefix: "google_", hint: "This server itself: identity and granted scopes, which tools exist, and a raw Google API escape hatch" };

/** Every group row, Meta first, in catalog order. */
export const ALL_GROUP_HINTS: readonly { group: string; prefix: string; hint: string }[] = [META_GROUP_HINT, ...GROUP_HINTS];
