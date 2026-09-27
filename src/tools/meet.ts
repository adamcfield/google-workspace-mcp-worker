/**
 * Google Meet tools (REST API v2): spaces, conference records, participants,
 * recordings, transcripts, smart notes.
 * API: https://meet.googleapis.com/v2
 *
 * Scopes: `meetings.space.created` covers creating/updating/ending spaces you
 * created plus their conference records; `meetings.space.readonly` covers
 * reading spaces/records you have access to.
 */
import { z } from "zod";
import { API, type GoogleClient, GoogleApiError } from "../google/client.js";
import { tool, enc, listResult, PageSize, PageToken, audit, type AnyRec } from "./_shared.js";

const SCOPE_CREATED = "https://www.googleapis.com/auth/meetings.space.created";
const SCOPE_READONLY = "https://www.googleapis.com/auth/meetings.space.readonly";

const AccessType = z.enum(["OPEN", "TRUSTED", "RESTRICTED"]).describe("OPEN: anyone with the link joins; TRUSTED (default, works everywhere): org members + invitees join, others knock; RESTRICTED: only invitees join. Consumer (gmail.com) accounts can only use TRUSTED — OPEN/RESTRICTED return 403 'updateAccessType is not available to the user'");
const EntryPointAccess = z.enum(["ALL", "CREATOR_APP_ONLY"]).describe("ALL: any entry point; CREATOR_APP_ONLY: only the app that created the space");
const SpaceName = z.string().describe("Space name 'spaces/abc-defg-hij', meeting code 'abc-defg-hij', or a https://meet.google.com/abc-defg-hij URL");
const ConferenceRecord = z.string().describe("Conference record resource name, e.g. 'conferenceRecords/abc123' (from meet_list_conference_records)");

/** 'spaces/abc-defg-hij' | 'abc-defg-hij' | 'https://meet.google.com/abc-defg-hij?x=y' → 'spaces/abc-defg-hij'. */
function normalizeSpaceName(input: string): string {
  let s = input.trim();
  if (!s) throw new Error("Space name is required (e.g. 'spaces/abc-defg-hij', 'abc-defg-hij' or a meet.google.com URL)");
  const url = s.match(/^https?:\/\/meet\.google\.com\/([^/?#\s]+)/i);
  if (url) s = url[1];
  if (s.startsWith("spaces/")) s = s.slice("spaces/".length);
  s = s.replace(/^\/+|\/+$/g, "");
  if (!s || s.includes("/")) throw new Error(`Invalid Meet space name: ${JSON.stringify(input)} — expected 'spaces/<code>', a meeting code like 'abc-defg-hij', or a meet.google.com URL`);
  return `spaces/${s}`;
}

/** Last path segment of 'spaces/xyz' for use in URLs. */
const spaceCode = (name: string) => enc(name.slice("spaces/".length));

/** Meeting codes look like abc-defg-hij; server space ids are opaque (e.g. jQCFfuBOdN5z). */
const isMeetingCode = (id: string) => /^[a-z]+-[a-z]+-[a-z]+$/i.test(id);

/**
 * spaces.patch / spaces:endActiveConference only accept the server-generated
 * space id; spaces.get accepts the meeting code alias too. Resolve an alias to
 * the canonical name when needed.
 */
async function resolveSpaceName(g: GoogleClient, input: string): Promise<string> {
  const name = normalizeSpaceName(input);
  if (!isMeetingCode(name.slice("spaces/".length))) return name;
  const space = await g.get<AnyRec>(`${API.meet}/spaces/${spaceCode(name)}`);
  if (typeof space.name !== "string") throw new Error(`Could not resolve meeting code ${name} to a space id`);
  return space.name;
}

function compactSpace(s: AnyRec): AnyRec {
  const c = s.config ?? {};
  return {
    name: s.name,
    meetingUri: s.meetingUri,
    meetingCode: s.meetingCode,
    config: { accessType: c.accessType, entryPointAccess: c.entryPointAccess, moderation: c.moderation, artifactConfig: c.artifactConfig },
    activeConference: s.activeConference?.conferenceRecord,
  };
}

function compactRecord(r: AnyRec): AnyRec {
  return { name: r.name, space: r.space, startTime: r.startTime, endTime: r.endTime, expireTime: r.expireTime };
}

/** Validate that a resource name has the expected prefix and no leading/trailing junk. */
function requirePrefix(value: string, prefix: string, label: string): string {
  const v = value.trim();
  if (!v.startsWith(prefix + "/") || v.length <= prefix.length + 1) throw new Error(`${label} must be a resource name starting with '${prefix}/' — got ${JSON.stringify(value)}`);
  return v;
}

/** Wrap a string in a quoted filter literal (escapes backslashes and double quotes). */
const quoted = (v: string) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

export const meetTools = [
  tool({
    name: "meet_create_space",
    description:
      "Create a new Google Meet space (a meeting link). Returns name ('spaces/…'), meetingUri (the link to share), meetingCode and config. access_type controls who can join without knocking. Note: the Meet API has no delete — a space cannot be removed afterwards (Google retires unused API-created spaces on its own), so create one only when the user needs a link.",
    scope: SCOPE_CREATED,
    write: true,
    destructive: false,
    input: {
      access_type: AccessType.default("TRUSTED"),
      entry_point_access: EntryPointAccess.default("ALL"),
    },
    handler: async (a, { g, email }) => {
      // Consumer accounts can only create TRUSTED spaces; fail before the call with the fix spelled out.
      if (a.access_type !== "TRUSTED" && /@(gmail|googlemail)\.com$/i.test(email ?? "")) {
        throw new Error(`access_type ${a.access_type} needs a Google Workspace account; ${email} is a consumer account — use access_type TRUSTED (the default).`);
      }
      let r: AnyRec;
      try {
        r = await g.post<AnyRec>(`${API.meet}/spaces`, { config: { accessType: a.access_type, entryPointAccess: a.entry_point_access } });
      } catch (err) {
        if (err instanceof GoogleApiError && err.status === 403 && /updateAccessType/i.test(`${err.message} ${err.body}`)) {
          throw new Error(`Google refused access_type ${a.access_type} for this account (${err.message}) — only Workspace accounts may set OPEN/RESTRICTED; retry with TRUSTED.`);
        }
        throw err;
      }
      audit("meet_create_space", { space: r.name, accessType: a.access_type });
      return compactSpace(r);
    },
  }),

  tool({
    name: "meet_get_space",
    description: "Get a Meet space by name, meeting code or meet.google.com URL: link, code, config (accessType, entryPointAccess, moderation) and the active conference record if a meeting is in progress.",
    scope: SCOPE_READONLY,
    input: { name: SpaceName },
    handler: async (a, { g }) => {
      const name = normalizeSpaceName(a.name);
      return compactSpace(await g.get<AnyRec>(`${API.meet}/spaces/${spaceCode(name)}`));
    },
  }),

  tool({
    name: "meet_update_space",
    description: "Update a Meet space's config (only the fields you pass are changed): access_type, entry_point_access, moderation (ON = host must approve participants / restricts chat & presenting). Only works on spaces you created.",
    scope: SCOPE_CREATED,
    write: true,
    idempotent: true,
    input: {
      name: SpaceName,
      access_type: AccessType.optional(),
      entry_point_access: EntryPointAccess.optional(),
      moderation: z.enum(["ON", "OFF"]).optional().describe("Host moderation"),
    },
    handler: async (a, { g }) => {
      const name = normalizeSpaceName(a.name);
      const config: AnyRec = {};
      const mask: string[] = [];
      if (a.access_type !== undefined) {
        config.accessType = a.access_type;
        mask.push("config.accessType");
      }
      if (a.entry_point_access !== undefined) {
        config.entryPointAccess = a.entry_point_access;
        mask.push("config.entryPointAccess");
      }
      if (a.moderation !== undefined) {
        config.moderation = a.moderation;
        mask.push("config.moderation");
      }
      if (!mask.length) throw new Error("Nothing to update — pass at least one of access_type, entry_point_access, moderation");
      const resolved = await resolveSpaceName(g, name);
      const r = await g.patch<AnyRec>(`${API.meet}/spaces/${spaceCode(resolved)}`, { config }, { updateMask: mask.join(",") });
      audit("meet_update_space", { space: name, fields: mask });
      return compactSpace(r);
    },
  }),

  tool({
    name: "meet_end_conference",
    description: "End the active conference (kick everyone out) in a Meet space you created. No-op error (404) if no conference is running.",
    scope: SCOPE_CREATED,
    write: true,
    destructive: true,
    input: { name: SpaceName },
    handler: async (a, { g }) => {
      const name = await resolveSpaceName(g, a.name);
      await g.post(`${API.meet}/spaces/${spaceCode(name)}:endActiveConference`, {});
      audit("meet_end_conference", { space: name });
      return { ended: true, space: name };
    },
  }),

  tool({
    name: "meet_list_conference_records",
    description:
      "List past/ongoing conference records (each meeting occurrence), newest first. Filter by space (name/code/URL) and/or a start-time window (RFC3339). Records expire ~30 days after the meeting ends (expireTime). Use the record name with meet_list_participants / recordings / transcripts.",
    scope: SCOPE_READONLY,
    input: {
      space: z.string().optional().describe("Only records of this space: 'spaces/…', meeting code, or meet.google.com URL"),
      start_after: z.string().optional().describe("RFC3339 timestamp, e.g. 2026-01-01T00:00:00Z — only conferences that started at/after this"),
      end_before: z.string().optional().describe("RFC3339 timestamp — only conferences that ended before this"),
      page_size: PageSize(25, 25),
      page_token: PageToken,
    },
    handler: async (a, { g }) => {
      const parts: string[] = [];
      if (a.space) {
        // The filter grammar distinguishes the opaque space id (space.name) from the human meeting code.
        const name = normalizeSpaceName(a.space);
        const id = name.slice("spaces/".length);
        parts.push(isMeetingCode(id) ? `space.meeting_code = ${quoted(id.toLowerCase())}` : `space.name = ${quoted(name)}`);
      }
      if (a.start_after) parts.push(`start_time>=${quoted(a.start_after)}`);
      if (a.end_before) parts.push(`end_time<${quoted(a.end_before)}`);
      const r = await g.get<AnyRec>(`${API.meet}/conferenceRecords`, {
        filter: parts.length ? parts.join(" AND ") : undefined,
        pageSize: a.page_size,
        pageToken: a.page_token,
      });
      return listResult((r.conferenceRecords ?? []).map(compactRecord), r.nextPageToken);
    },
  }),

  tool({
    name: "meet_get_conference_record",
    description: "Get one conference record by resource name ('conferenceRecords/…'): space, startTime, endTime, expireTime.",
    scope: SCOPE_READONLY,
    input: { name: ConferenceRecord },
    handler: async (a, { g }) => {
      const name = requirePrefix(a.name, "conferenceRecords", "name");
      return compactRecord(await g.get<AnyRec>(`${API.meet}/${name}`));
    },
  }),

  tool({
    name: "meet_list_participants",
    description:
      "List participants of a conference record: type (signedinUser | anonymousUser | phoneUser), displayName, user (people/… id for signed-in users), earliestStartTime, latestEndTime. Use meet_list_conference_records to find the record.",
    scope: SCOPE_READONLY,
    input: { conference_record: ConferenceRecord, page_size: PageSize(100, 250), page_token: PageToken },
    handler: async (a, { g }) => {
      const rec = requirePrefix(a.conference_record, "conferenceRecords", "conference_record");
      const r = await g.get<AnyRec>(`${API.meet}/${rec}/participants`, { pageSize: a.page_size, pageToken: a.page_token });
      const items = (r.participants ?? []).map((p: AnyRec) => ({
        name: p.name,
        type: p.signedinUser ? "signedinUser" : p.anonymousUser ? "anonymousUser" : p.phoneUser ? "phoneUser" : undefined,
        displayName: p.signedinUser?.displayName ?? p.anonymousUser?.displayName ?? p.phoneUser?.displayName,
        user: p.signedinUser?.user,
        earliestStartTime: p.earliestStartTime,
        latestEndTime: p.latestEndTime,
      }));
      return listResult(items, r.nextPageToken);
    },
  }),

  tool({
    name: "meet_list_recordings",
    description: "List recordings of a conference record: state (STARTED | ENDED | FILE_GENERATED), start/end time, driveFileId (the MP4 in Drive) and exportUri (link to open it).",
    scope: SCOPE_READONLY,
    input: { conference_record: ConferenceRecord },
    handler: async (a, { g }) => {
      const rec = requirePrefix(a.conference_record, "conferenceRecords", "conference_record");
      const r = await g.get<AnyRec>(`${API.meet}/${rec}/recordings`);
      const items = (r.recordings ?? []).map((x: AnyRec) => ({
        name: x.name,
        state: x.state,
        startTime: x.startTime,
        endTime: x.endTime,
        driveFileId: x.driveDestination?.file,
        exportUri: x.driveDestination?.exportUri,
      }));
      return listResult(items, r.nextPageToken);
    },
  }),

  tool({
    name: "meet_list_transcripts",
    description: "List transcripts of a conference record: state, start/end time, docsDocumentId (the Google Doc holding the transcript) and exportUri. Pass a transcript name to meet_list_transcript_entries for the text.",
    scope: SCOPE_READONLY,
    input: { conference_record: ConferenceRecord },
    handler: async (a, { g }) => {
      const rec = requirePrefix(a.conference_record, "conferenceRecords", "conference_record");
      const r = await g.get<AnyRec>(`${API.meet}/${rec}/transcripts`);
      const items = (r.transcripts ?? []).map((x: AnyRec) => ({
        name: x.name,
        state: x.state,
        startTime: x.startTime,
        endTime: x.endTime,
        docsDocumentId: x.docsDestination?.document,
        exportUri: x.docsDestination?.exportUri,
      }));
      return listResult(items, r.nextPageToken);
    },
  }),

  tool({
    name: "meet_list_transcript_entries",
    description:
      "Read the spoken entries of a transcript ('conferenceRecords/…/transcripts/…'), in order. as_text=true returns lines 'startTime  participant  text' (participant is a conferenceRecords/…/participants/… resource name — resolve names with meet_list_participants); as_text=false returns a compact list. Paginate with page_token for long meetings.",
    scope: SCOPE_READONLY,
    input: {
      transcript_name: z.string().describe("Transcript resource name from meet_list_transcripts, e.g. 'conferenceRecords/abc/transcripts/xyz'"),
      page_size: PageSize(100, 100),
      page_token: PageToken,
      as_text: z.boolean().default(true).describe("Return one line per entry instead of objects"),
    },
    handler: async (a, { g }) => {
      const t = requirePrefix(a.transcript_name, "conferenceRecords", "transcript_name");
      if (!/\/transcripts\/[^/]+$/.test(t)) throw new Error(`transcript_name must look like 'conferenceRecords/<id>/transcripts/<id>' — got ${JSON.stringify(a.transcript_name)}`);
      const r = await g.get<AnyRec>(`${API.meet}/${t}/entries`, { pageSize: a.page_size, pageToken: a.page_token });
      const entries: AnyRec[] = r.transcriptEntries ?? [];
      if (a.as_text) {
        const text = entries.map((e) => `${e.startTime ?? ""}  ${e.participant ?? ""}  ${e.text ?? ""}`).join("\n");
        return { count: entries.length, text, nextPageToken: r.nextPageToken };
      }
      return listResult(
        entries.map((e) => ({ name: e.name, participant: e.participant, text: e.text, languageCode: e.languageCode, startTime: e.startTime, endTime: e.endTime })),
        r.nextPageToken,
      );
    },
  }),

  tool({
    name: "meet_list_smart_notes",
    description: "List Gemini 'take notes for me' smart notes of a conference record: state, docsDocumentId (the Google Doc with the notes) and exportUri. Returns 404 on accounts/meetings without Gemini notes.",
    scope: SCOPE_READONLY,
    input: { conference_record: ConferenceRecord },
    handler: async (a, { g }) => {
      const rec = requirePrefix(a.conference_record, "conferenceRecords", "conference_record");
      const r = await g.get<AnyRec>(`${API.meet}/${rec}/smartNotes`);
      const items = (r.smartNotes ?? []).map((x: AnyRec) => ({
        name: x.name,
        state: x.state,
        docsDocumentId: x.docsDestination?.document,
        exportUri: x.docsDestination?.exportUri,
      }));
      return listResult(items, r.nextPageToken);
    },
  }),
];
