/**
 * Google Calendar tools.
 * API: https://www.googleapis.com/calendar/v3
 *
 * Date/time inputs accept RFC3339 with an offset (2026-09-18T10:00:00+03:00)
 * or date-only YYYY-MM-DD (all-day). Events come back compacted via
 * compactEvent(); calendar_get_event returns the full description.
 */
import { z } from "zod";
import { API } from "../google/client.js";
import { tool, enc, listResult, PageSize, PageToken, audit, type AnyRec, formatInZone } from "./_shared.js";

const SCOPE = "https://www.googleapis.com/auth/calendar";
const CAL = API.calendar;
const DAY_MS = 86_400_000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const HAS_OFFSET = /(Z|[+-]\d{2}:?\d{2})$/i;

const CalendarId = z.string().default("primary").describe("Calendar id: 'primary' (the account's own calendar), an email address, or an id like xxx@group.calendar.google.com from calendar_list_calendars");
const EventId = z.string().describe("Event id (from calendar_list_events). For a single occurrence of a recurring event use the instance id, e.g. abc123_20260918T070000Z");
const SendUpdates = z.enum(["all", "externalOnly", "none"]).default("none").describe("Email guests about this change? all | externalOnly (only non-Google-Calendar guests) | none");
const TIME_DESC = "RFC3339 with offset (2026-09-18T10:00:00+03:00 / 2026-09-18T07:00:00Z) or date-only YYYY-MM-DD for an all-day event";
const Reminders = z.array(z.object({ method: z.enum(["email", "popup"]), minutes: z.number().int().min(0).max(40320) })).optional().describe("Custom reminders (replaces the calendar default), e.g. [{method:'popup',minutes:10}]");

/** RFC3339 or YYYY-MM-DD → EventDateTime ({dateTime,timeZone} or {date}). */
function toEventTime(value: string, timeZone?: string): AnyRec {
  const v = value.trim();
  if (DATE_ONLY.test(v)) return { date: v };
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) throw new Error(`Invalid date/time '${value}': use RFC3339 (2026-09-18T10:00:00+03:00) or YYYY-MM-DD for all-day`);
  if (!HAS_OFFSET.test(v) && !timeZone) throw new Error(`'${value}' has no UTC offset: add one (…+03:00 or Z) or pass time_zone (IANA name like Asia/Jerusalem)`);
  return { dateTime: v, timeZone };
}

/** List bounds (timeMin/timeMax) must be RFC3339 with offset; date-only is expanded in UTC. */
function toRfc3339(value: string, endOfDay = false): string {
  const v = value.trim();
  if (DATE_ONLY.test(v)) return `${v}T${endOfDay ? "23:59:59" : "00:00:00"}Z`;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) throw new Error(`Invalid date/time '${value}': use RFC3339 (2026-09-18T10:00:00+03:00) or YYYY-MM-DD`);
  return HAS_OFFSET.test(v) ? v : `${v}Z`;
}

/** Start/end pair from tool args (all_day forces date-only; an all-day end is exclusive so equal dates get +1 day). */
function timeRange(start: string, end: string, timeZone: string | undefined, allDay: boolean | undefined): { start: AnyRec; end: AnyRec } {
  const s = allDay ? { date: start.trim().slice(0, 10) } : toEventTime(start, timeZone);
  const e = allDay ? { date: end.trim().slice(0, 10) } : toEventTime(end, timeZone);
  if (!!s.date !== !!e.date) throw new Error("start and end must both be date-only (all-day) or both date-times");
  if (s.date && e.date && e.date <= s.date) {
    e.date = new Date(Date.parse(`${s.date}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
  }
  return { start: s, end: e };
}

/** Compact an Event resource (description capped at 500 chars). */
/** Google adds `ctz=<zone>` to htmlLink only when the request carried a timeZone; add it ourselves when the zone is known so the link opens in the right zone. */
function withCtz(link: unknown, tz: unknown): string | undefined {
  if (typeof link !== "string" || !link) return undefined;
  // Only an IANA-looking zone is ever appended: the list serializer once passed Array#map's index here (ctz=1, ctz=2).
  if (typeof tz !== "string" || !/^[A-Za-z][A-Za-z0-9_+\-]*(\/[A-Za-z0-9_+\-]+)*$/.test(tz) || /[?&]ctz=/.test(link)) return link;
  return `${link}${link.includes("?") ? "&" : "?"}ctz=${encodeURIComponent(tz).replace(/%2F/gi, "/")}`;
}

/** Never pass this straight to Array#map — the index would land in `tz`. */
function compactEvent(e: AnyRec, tz?: string): AnyRec {
  const desc = typeof e.description === "string" ? e.description : undefined;
  const entry = (e.conferenceData?.entryPoints ?? []) as AnyRec[];
  return {
    id: e.id,
    status: e.status,
    summary: e.summary,
    description: desc && desc.length > 500 ? `${desc.slice(0, 500)}…` : desc,
    location: e.location,
    start: e.start?.dateTime ?? e.start?.date,
    end: e.end?.dateTime ?? e.end?.date,
    allDay: !!e.start?.date,
    timeZone: e.start?.timeZone,
    attendees: (e.attendees ?? []).map((x: AnyRec) => ({ email: x.email, responseStatus: x.responseStatus, organizer: x.organizer, self: x.self, optional: x.optional })),
    organizer: e.organizer?.email,
    creator: e.creator?.email,
    hangoutLink: e.hangoutLink,
    meetLink: (entry.find((p) => p.entryPointType === "video") ?? entry[0])?.uri,
    htmlLink: withCtz(e.htmlLink, tz ?? e.start?.timeZone),
    recurringEventId: e.recurringEventId,
    recurrence: e.recurrence,
    reminders: e.reminders,
    updated: e.updated,
    visibility: e.visibility,
    transparency: e.transparency,
    colorId: e.colorId,
    eventType: e.eventType,
  };
}

/** Optional event fields shared by create and update (undefined = not provided). */
const EventFields = {
  time_zone: z.string().optional().describe("IANA time zone for start/end (e.g. Asia/Jerusalem). Required when start/end carry no offset"),
  description: z.string().optional(),
  location: z.string().optional(),
  attendees: z.array(z.string()).optional().describe("Guest email addresses"),
  recurrence: z.array(z.string()).optional().describe("RRULE/EXRULE/RDATE/EXDATE lines, e.g. ['RRULE:FREQ=WEEKLY;COUNT=10']"),
  reminders: Reminders,
  add_meet_link: z.boolean().default(false).describe("Attach a Google Meet conference"),
  send_updates: SendUpdates,
  color_id: z.string().optional().describe("Event color id (see calendar_get_colors)"),
  visibility: z.enum(["default", "public", "private", "confidential"]).optional(),
  transparency: z.enum(["opaque", "transparent"]).optional().describe("opaque = busy, transparent = free"),
  guests_can_modify: z.boolean().optional(),
};

export const calendarTools = [
  tool({
    name: "calendar_list_calendars",
    description: "List all calendars the user has (calendar list: own, subscribed, shared, secondary) — the way to get calendar ids. Returns id, summary (name), primary, accessRole (owner/writer/reader/freeBusyReader), timeZone, backgroundColor, selected, hidden.",
    scope: SCOPE,
    input: {},
    handler: async (_a, { g }) => {
      const items: AnyRec[] = [];
      let pageToken: string | undefined;
      do {
        const r = await g.get<AnyRec>(`${CAL}/users/me/calendarList`, { maxResults: 250, pageToken, showHidden: true });
        items.push(...(r.items ?? []));
        pageToken = r.nextPageToken;
      } while (pageToken);
      return listResult(
        items.map((c) => ({ id: c.id, summary: c.summaryOverride ?? c.summary, primary: c.primary, accessRole: c.accessRole, timeZone: c.timeZone, backgroundColor: c.backgroundColor, selected: c.selected, hidden: c.hidden })),
      );
    },
  }),

  tool({
    name: "calendar_list_events",
    description:
      "List/search events in a calendar (events.list). Defaults: time_min = now, no time_max (upcoming events, soonest first), recurring events expanded into single instances ordered by start time. To get the next N upcoming events just set max_results=N. order_by=startTime requires single_events=true. Date-only bounds are interpreted in UTC.",
    scope: SCOPE,
    input: {
      calendar_id: CalendarId,
      time_min: z.string().optional().describe(`Lower bound (exclusive) on the event END time. ${TIME_DESC}. Default: now`),
      time_max: z.string().optional().describe(`Upper bound (exclusive) on the event START time. ${TIME_DESC}. Default: none`),
      query: z.string().optional().describe("Free-text search across summary, description, location, attendees"),
      max_results: PageSize(25, 250),
      page_token: PageToken,
      single_events: z.boolean().default(true).describe("Expand recurring events into instances (required for order_by=startTime)"),
      order_by: z.enum(["startTime", "updated"]).default("startTime"),
      show_deleted: z.boolean().default(false).describe("Include cancelled events"),
      time_zone: z.string().optional().describe("Time zone used in the response (IANA name)"),
      updated_min: z.string().optional().describe("Only events modified after this RFC3339 time (deleted events included since then)"),
    },
    handler: async (a, { g }) => {
      if (a.order_by === "startTime" && !a.single_events) throw new Error("order_by=startTime requires single_events=true (use order_by=updated to list recurring events unexpanded)");
      const now = new Date();
      const timeMin = a.time_min ? toRfc3339(a.time_min) : now.toISOString();
      const timeMax = a.time_max ? toRfc3339(a.time_max, true) : undefined;
      if (timeMax && Date.parse(timeMax) <= Date.parse(timeMin)) throw new Error(`time_max (${timeMax}) must be after time_min (${timeMin})`);
      const r = await g.get<AnyRec>(`${CAL}/calendars/${enc(a.calendar_id)}/events`, {
        timeMin,
        timeMax,
        q: a.query,
        maxResults: a.max_results,
        pageToken: a.page_token,
        singleEvents: a.single_events,
        orderBy: a.order_by,
        showDeleted: a.show_deleted,
        timeZone: a.time_zone,
        updatedMin: a.updated_min ? toRfc3339(a.updated_min) : undefined,
      });
      // r.timeZone is the zone Google rendered the list in (the requested one, else the calendar's).
      return listResult((r.items ?? []).map((e: AnyRec) => compactEvent(e, r.timeZone)), r.nextPageToken, { timeZone: r.timeZone, nextSyncToken: r.nextSyncToken, timeMin, timeMax });
    },
  }),

  tool({
    name: "calendar_get_event",
    description: "Get one event by id with its full description, attendees and response statuses, Meet link, recurrence and reminders.",
    scope: SCOPE,
    input: { calendar_id: CalendarId, event_id: EventId },
    handler: async (a, { g }) => {
      const e = await g.get<AnyRec>(`${CAL}/calendars/${enc(a.calendar_id)}/events/${enc(a.event_id)}`);
      return { ...compactEvent(e), description: e.description };
    },
  }),

  tool({
    name: "calendar_create_event",
    description:
      "Create an event. start/end: RFC3339 with offset (2026-09-18T10:00:00+03:00) or YYYY-MM-DD for all-day (all-day end is exclusive: a one-day event has end = the next day; equal dates are auto-bumped). Set add_meet_link=true for a Google Meet link. Guests are only emailed when send_updates is 'all' or 'externalOnly'.",
    scope: SCOPE,
    write: true,
    destructive: false,
    input: {
      calendar_id: CalendarId,
      summary: z.string().describe("Event title"),
      start: z.string().describe(TIME_DESC),
      end: z.string().describe(TIME_DESC),
      all_day: z.boolean().optional().describe("Force an all-day event (inferred automatically from date-only start/end)"),
      ...EventFields,
    },
    handler: async (a, { g }) => {
      const body: AnyRec = {
        summary: a.summary,
        description: a.description,
        location: a.location,
        ...timeRange(a.start, a.end, a.time_zone, a.all_day),
        attendees: a.attendees?.map((email) => ({ email })),
        recurrence: a.recurrence,
        colorId: a.color_id,
        visibility: a.visibility,
        transparency: a.transparency,
        guestsCanModify: a.guests_can_modify,
      };
      if (a.reminders) body.reminders = { useDefault: false, overrides: a.reminders };
      if (a.add_meet_link) body.conferenceData = { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } } };
      const e = await g.post<AnyRec>(`${CAL}/calendars/${enc(a.calendar_id)}/events`, body, {
        sendUpdates: a.send_updates,
        conferenceDataVersion: a.add_meet_link ? 1 : undefined,
      });
      audit("calendar_create_event", { calendar: a.calendar_id, event: e.id, attendees: a.attendees?.length ?? 0, sendUpdates: a.send_updates, meet: a.add_meet_link });
      return compactEvent(e);
    },
  }),

  tool({
    name: "calendar_update_event",
    description:
      "Update an event (PATCH: only the fields you pass change). attendees replaces the whole guest list when given. Changing start or end: pass both when switching between all-day and timed. To edit one occurrence of a recurring event use its instance id; the parent id changes the whole series.",
    scope: SCOPE,
    write: true,
    idempotent: true,
    input: {
      calendar_id: CalendarId,
      event_id: EventId,
      summary: z.string().optional().describe("New title"),
      start: z.string().optional().describe(TIME_DESC),
      end: z.string().optional().describe(TIME_DESC),
      all_day: z.boolean().optional().describe("Force all-day when start/end are given"),
      ...EventFields,
    },
    handler: async (a, { g }) => {
      const body: AnyRec = {
        summary: a.summary,
        description: a.description,
        location: a.location,
        recurrence: a.recurrence,
        colorId: a.color_id,
        visibility: a.visibility,
        transparency: a.transparency,
        guestsCanModify: a.guests_can_modify,
      };
      // PATCH merges sub-fields, so switching all-day ↔ timed must null the other representation.
      const patchTime = (t: AnyRec): AnyRec => (t.date ? { date: t.date, dateTime: null, timeZone: null } : { dateTime: t.dateTime, timeZone: t.timeZone ?? null, date: null });
      if (a.start && a.end) {
        const r = timeRange(a.start, a.end, a.time_zone, a.all_day);
        body.start = patchTime(r.start);
        body.end = patchTime(r.end);
      } else if (a.start) body.start = patchTime(a.all_day ? { date: a.start.slice(0, 10) } : toEventTime(a.start, a.time_zone));
      else if (a.end) body.end = patchTime(a.all_day ? { date: a.end.slice(0, 10) } : toEventTime(a.end, a.time_zone));
      if (a.attendees) body.attendees = a.attendees.map((email) => ({ email }));
      if (a.reminders) body.reminders = { useDefault: false, overrides: a.reminders };
      if (a.add_meet_link) body.conferenceData = { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } } };
      for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
      if (!Object.keys(body).length) throw new Error("Nothing to update: pass at least one field (summary, start/end, description, location, attendees, …)");
      const e = await g.patch<AnyRec>(`${CAL}/calendars/${enc(a.calendar_id)}/events/${enc(a.event_id)}`, body, {
        sendUpdates: a.send_updates,
        conferenceDataVersion: a.add_meet_link ? 1 : undefined,
      });
      audit("calendar_update_event", { calendar: a.calendar_id, event: a.event_id, fields: Object.keys(body), sendUpdates: a.send_updates });
      return compactEvent(e);
    },
  }),

  tool({
    name: "calendar_delete_event",
    description: "Delete an event (irreversible). Deleting a recurring event's parent id removes the whole series; an instance id removes only that occurrence.",
    scope: SCOPE,
    write: true,
    destructive: true,
    idempotent: true,
    input: { calendar_id: CalendarId, event_id: EventId, send_updates: SendUpdates },
    handler: async (a, { g }) => {
      await g.delete(`${CAL}/calendars/${enc(a.calendar_id)}/events/${enc(a.event_id)}`, { sendUpdates: a.send_updates });
      audit("calendar_delete_event", { calendar: a.calendar_id, event: a.event_id, sendUpdates: a.send_updates });
      return { deleted: true, calendarId: a.calendar_id, eventId: a.event_id };
    },
  }),

  tool({
    name: "calendar_quick_add_event",
    description: "Create an event from natural-language text (events.quickAdd), e.g. 'Lunch with Dana tomorrow 13:00' or 'Dentist Sep 20 9am-10am'. Google parses the date/time in the calendar's time zone and may also eat punctuation from the title (a leading '[' is dropped) — check the returned summary/start/end; use calendar_create_event when the exact title matters.",
    scope: SCOPE,
    write: true,
    destructive: false,
    input: { calendar_id: CalendarId, text: z.string().min(1).describe("Text describing the event"), send_updates: SendUpdates },
    handler: async (a, { g }) => {
      // quickAdd takes no timeZone, so its htmlLink has no ctz and start/end carry the calendar's offset only; fetch the zone for the link.
      const [created, cal] = await Promise.all([
        g.post<AnyRec>(`${CAL}/calendars/${enc(a.calendar_id)}/events/quickAdd`, undefined, { text: a.text, sendUpdates: a.send_updates }),
        g.get<AnyRec>(`${CAL}/calendars/${enc(a.calendar_id)}`, { fields: "timeZone" }).catch(() => ({}) as AnyRec),
      ]);
      let e = created;
      audit("calendar_quick_add_event", { calendar: a.calendar_id, event: e.id });
      const warnings: string[] = [];
      // Google's parser eats a leading "[tag]" ("[MCP-TEST] lunch…" → "MCP-TEST] lunch"). Put it back.
      const tag = /^\s*(\[[^\]]+\])/.exec(a.text)?.[1];
      const summary = typeof e.summary === "string" ? e.summary : "";
      if (tag && !summary.includes(tag)) {
        const rest = summary.startsWith(tag.slice(1)) ? summary.slice(tag.length - 1) : summary;
        const fixed = `${tag} ${rest.trim()}`.trim();
        // Guests were already notified by quickAdd (per send_updates); the title repair must not send a second mail.
        e = await g.patch<AnyRec>(`${CAL}/calendars/${enc(a.calendar_id)}/events/${enc(String(e.id))}`, { summary: fixed }, { sendUpdates: "none" });
        warnings.push(`Google's parser dropped the leading ${tag} from the title; restored it ("${fixed}")`);
      }
      if (!summary && !tag) warnings.push("Google produced an empty title — set one with calendar_update_event, or use calendar_create_event for an exact title");
      return { ...compactEvent(e, typeof cal.timeZone === "string" ? cal.timeZone : undefined), timeZone: cal.timeZone, warning: warnings.length ? warnings.join("; ") : undefined };
    },
  }),

  tool({
    name: "calendar_move_event",
    description: "Move an event to another calendar (events.move). Only the organizer's default-type events can be moved; the event keeps its id.",
    scope: SCOPE,
    write: true,
    idempotent: true,
    input: {
      calendar_id: CalendarId.describe("Source calendar id"),
      event_id: EventId,
      destination_calendar_id: z.string().describe("Target calendar id"),
      send_updates: SendUpdates,
    },
    handler: async (a, { g }) => {
      const moved = await g.post<AnyRec>(`${CAL}/calendars/${enc(a.calendar_id)}/events/${enc(a.event_id)}/move`, undefined, { destination: a.destination_calendar_id, sendUpdates: a.send_updates });
      audit("calendar_move_event", { from: a.calendar_id, to: a.destination_calendar_id, event: a.event_id });
      // events.move echoes the source-side stub (status "cancelled"); read the event from its new calendar instead.
      const e = await g.get<AnyRec>(`${CAL}/calendars/${enc(a.destination_calendar_id)}/events/${enc(moved.id ?? a.event_id)}`).catch(() => moved);
      return { ...compactEvent(e), movedTo: a.destination_calendar_id };
    },
  }),

  tool({
    name: "calendar_rsvp_event",
    description: "RSVP to an invitation as the signed-in user: sets your attendee responseStatus (accepted / declined / tentative / needsAction) and optional comment. Fails if you are not on the guest list (e.g. events you organize without inviting yourself).",
    scope: SCOPE,
    write: true,
    idempotent: true,
    input: {
      calendar_id: CalendarId,
      event_id: EventId,
      response: z.enum(["accepted", "declined", "tentative", "needsAction"]),
      comment: z.string().optional().describe("Note for the organizer"),
      send_updates: SendUpdates,
    },
    handler: async (a, { g, email }) => {
      const url = `${CAL}/calendars/${enc(a.calendar_id)}/events/${enc(a.event_id)}`;
      const e = await g.get<AnyRec>(url);
      const attendees = ((e.attendees ?? []) as AnyRec[]).map((x) => ({ ...x }));
      const me = email?.toLowerCase();
      const mine = attendees.find((x) => x.self === true) ?? (me ? attendees.find((x) => typeof x.email === "string" && x.email.toLowerCase() === me) : undefined);
      if (!mine) throw new Error(`The signed-in account${email ? ` (${email})` : ""} is not an attendee of event ${a.event_id}; only invited guests can respond`);
      mine.responseStatus = a.response;
      if (a.comment !== undefined) mine.comment = a.comment;
      const updated = await g.patch<AnyRec>(url, { attendees }, { sendUpdates: a.send_updates });
      audit("calendar_rsvp_event", { calendar: a.calendar_id, event: a.event_id, response: a.response });
      return { ...compactEvent(updated), yourResponse: a.response };
    },
  }),

  tool({
    name: "calendar_get_free_busy",
    description: "Free/busy intervals for one or more calendars in a time window (freeBusy.query). Use it to find open slots before scheduling. Calendar ids can be other people's email addresses if their free/busy is visible to you. Every requested calendar appears exactly once: in `calendars` with busyCount (0 = genuinely free in the window) or in `unavailable` with Google's reason (ok=false) — an unavailable calendar is UNKNOWN, not free.",
    scope: SCOPE,
    input: {
      time_min: z.string().describe(`Window start. ${TIME_DESC}`),
      time_max: z.string().describe(`Window end. ${TIME_DESC}`),
      calendar_ids: z.array(z.string()).min(1).max(50).default(["primary"]).describe("Calendar ids / email addresses to check"),
      time_zone: z.string().optional().describe("Time zone for the response (IANA name)"),
    },
    handler: async (a, { g }) => {
      const timeMin = toRfc3339(a.time_min);
      const timeMax = toRfc3339(a.time_max, true);
      if (Date.parse(timeMax) <= Date.parse(timeMin)) throw new Error(`time_max (${timeMax}) must be after time_min (${timeMin})`);
      const r = await g.post<AnyRec>(`${CAL}/freeBusy`, { timeMin, timeMax, timeZone: a.time_zone, items: a.calendar_ids.map((id) => ({ id })) }, undefined, { idempotent: true });
      // Output compaction drops empty arrays/objects, so a free calendar ({busy: []}) used to vanish
      // from the response and read as "not there". Emit a list with a numeric busyCount instead.
      const calendars: { id: string; busyCount: number; busy: { start: string; end: string }[] }[] = [];
      const unavailable: { calendarId: string; reason: string }[] = [];
      const got = (r.calendars ?? {}) as Record<string, AnyRec>;
      for (const id of a.calendar_ids) {
        const c = got[id];
        const errs = (c?.errors ?? []) as AnyRec[];
        if (!c) unavailable.push({ calendarId: id, reason: "not in Google's response (unknown id or not visible to you)" });
        else if (errs.length) unavailable.push({ calendarId: id, reason: errs.map((e) => `${e.reason ?? "error"}${e.domain ? ` (${e.domain})` : ""}`).join("; ") });
        else {
          const busy = ((c.busy ?? []) as AnyRec[]).map((b) => ({ start: String(b.start), end: String(b.end) }));
          calendars.push({ id, busyCount: busy.length, busy });
        }
      }
      // Google occasionally keys the response by canonical id rather than the requested alias.
      for (const [id, c] of Object.entries(got)) {
        if (a.calendar_ids.includes(id) || (c.errors ?? []).length) continue;
        const busy = ((c.busy ?? []) as AnyRec[]).map((b) => ({ start: String(b.start), end: String(b.end) }));
        calendars.push({ id, busyCount: busy.length, busy });
      }
      const ok = unavailable.length === 0;
      return {
        ok,
        warning: ok ? undefined : `${unavailable.length} calendar(s) could not be read — their busy times are UNKNOWN, not free: ${unavailable.map((u) => `${u.calendarId} (${u.reason})`).join(", ")}`,
        timeZone: a.time_zone,
        timeMin: formatInZone(r.timeMin ?? timeMin, a.time_zone),
        timeMax: formatInZone(r.timeMax ?? timeMax, a.time_zone),
        calendars,
        unavailable,
      };
    },
  }),

  tool({
    name: "calendar_list_event_instances",
    description: "List the individual occurrences of a recurring event (events.instances). Each instance has its own id (usable in update/delete/respond) and recurringEventId = the parent.",
    scope: SCOPE,
    input: {
      calendar_id: CalendarId,
      event_id: EventId.describe("Id of the recurring (parent) event"),
      time_min: z.string().optional().describe(`Lower bound on instance end time. ${TIME_DESC}`),
      time_max: z.string().optional().describe(`Upper bound on instance start time. ${TIME_DESC}`),
      max_results: PageSize(50, 250),
      page_token: PageToken,
    },
    handler: async (a, { g }) => {
      const r = await g.get<AnyRec>(`${CAL}/calendars/${enc(a.calendar_id)}/events/${enc(a.event_id)}/instances`, {
        timeMin: a.time_min ? toRfc3339(a.time_min) : undefined,
        timeMax: a.time_max ? toRfc3339(a.time_max, true) : undefined,
        maxResults: a.max_results,
        pageToken: a.page_token,
      });
      return listResult((r.items ?? []).map((e: AnyRec) => compactEvent(e, r.timeZone)), r.nextPageToken, { timeZone: r.timeZone });
    },
  }),

  tool({
    name: "calendar_get_colors",
    description: "Color palette for events and calendars (colors.get): maps color id → background hex, so color_id values for calendar_create_event/calendar_update_event are known.",
    scope: SCOPE,
    input: {},
    handler: async (_a, { g }) => {
      const r = await g.get<AnyRec>(`${CAL}/colors`);
      const flat = (m: AnyRec | undefined) => Object.fromEntries(Object.entries((m ?? {}) as Record<string, AnyRec>).map(([id, c]) => [id, c.background]));
      return { event: flat(r.event), calendar: flat(r.calendar) };
    },
  }),
];
