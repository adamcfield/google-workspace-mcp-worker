/** Regression tests for the 2026-09-18 QA report findings (F-01…F-25). */
import { describe, it, expect } from "vitest";
import { ALL_TOOLS } from "../src/tools/index.js";
import { htmlToText, ok } from "../src/tools/_shared.js";
import { rfc5322Date } from "../src/tools/gmail.js";

const byName = (n: string) => ALL_TOOLS.find((t) => t.name === n)!;
const ctx = (g: any) => ({ g, readOnly: false, grantedScopes: [], email: "me@example.com" });

function fakeClient(route: (method: string, url: string, body: any, params: any) => any) {
  const calls: { method: string; url: string; body?: any; params?: any }[] = [];
  const make = (method: string) => async (url: string, a?: any, b?: any) => {
    const [body, params] = method === "get" ? [undefined, a] : [a, b];
    calls.push({ method, url, body, params });
    return route(method, url, body, params);
  };
  const g: any = { get: make("get"), post: make("post"), put: make("put"), patch: make("patch"), delete: make("delete") };
  g.request = async (method: string, url: string, opts: any) => {
    calls.push({ method: method.toLowerCase(), url, body: opts?.body, params: opts?.query });
    return route(method.toLowerCase(), url, opts?.body, opts?.query);
  };
  return { g, calls };
}

describe("F-13 google_api_request gate", () => {
  it("refuses mutations without confirm=true and allows GET", async () => {
    const { g, calls } = fakeClient(() => ({ ok: 1 }));
    const t = byName("google_api_request");
    await expect(t.handler({ method: "PATCH", url: "https://www.googleapis.com/drive/v3/files/x", body: { name: "y" }, response_type: "json", confirm: false }, ctx(g))).rejects.toThrow(/requires confirm=true/);
    expect(calls).toHaveLength(0);
    await t.handler({ method: "GET", url: "https://www.googleapis.com/drive/v3/about", response_type: "json", confirm: false }, ctx(g));
    await t.handler({ method: "POST", url: "https://www.googleapis.com/drive/v3/files", body: { name: "x" }, response_type: "json", confirm: true }, ctx(g));
    expect(calls.map((c) => c.method)).toEqual(["get", "post"]);
  });
  it("refuses endpoints whose dedicated tools carry the safeguards, even with confirm=true", async () => {
    const { g, calls } = fakeClient(() => ({ ok: 1 }));
    const t = byName("google_api_request");
    for (const [method, url, tool] of [
      ["POST", "https://gmail.googleapis.com/gmail/v1/users/me/messages/send", "gmail_send_message"],
      ["POST", "https://gmail.googleapis.com/gmail/v1/users/me/drafts/send", "gmail_send_draft"],
      ["DELETE", "https://gmail.googleapis.com/gmail/v1/users/me/messages/18c1", "gmail_trash_message"],
      ["DELETE", "https://www.googleapis.com/drive/v3/files/abc", "drive_delete_file"],
      ["DELETE", "https://www.googleapis.com/drive/v3/files/trash", "drive_delete_file"],
    ] as const) {
      await expect(t.handler({ method, url, body: method === "POST" ? { raw: "x" } : undefined, response_type: "json", confirm: true }, ctx(g)), url).rejects.toThrow(new RegExp(`not allowed through google_api_request.*${tool}`));
    }
    // A GET on the same paths is fine (reading a message / file).
    await t.handler({ method: "GET", url: "https://www.googleapis.com/drive/v3/files/abc", response_type: "json", confirm: false }, ctx(g));
    expect(calls).toHaveLength(1);
  });
});

describe("F-20 calendar_get_free_busy", () => {
  it("keeps a genuinely free calendar visible (busyCount 0) and separates unreadable/missing ones", async () => {
    const { g } = fakeClient(() => ({
      timeMin: "2026-09-18T00:00:00Z",
      timeMax: "2026-09-19T00:00:00Z",
      calendars: {
        primary: { busy: [{ start: "2026-09-18T09:00:00Z", end: "2026-09-18T10:00:00Z" }] },
        "free@example.com": { busy: [] },
        "other@example.com": { errors: [{ domain: "global", reason: "notFound" }] },
      },
    }));
    const r: any = await byName("calendar_get_free_busy").handler({ time_min: "2026-09-18T00:00:00Z", time_max: "2026-09-19T00:00:00Z", calendar_ids: ["primary", "free@example.com", "other@example.com", "third@example.com"] }, ctx(g));
    expect(r.ok).toBe(false);
    expect(r.calendars).toEqual([
      { id: "primary", busyCount: 1, busy: [{ start: "2026-09-18T09:00:00Z", end: "2026-09-18T10:00:00Z" }] },
      { id: "free@example.com", busyCount: 0, busy: [] },
    ]);
    // The free calendar must survive output compaction (this is the bug the QA run hit).
    expect(JSON.parse(ok(r).content[0].text).calendars.map((c: any) => c.id)).toEqual(["primary", "free@example.com"]);
    expect(r.unavailable).toEqual([
      { calendarId: "other@example.com", reason: "notFound (global)" },
      { calendarId: "third@example.com", reason: "not in Google's response (unknown id or not visible to you)" },
    ]);
    expect(r.warning).toMatch(/UNKNOWN, not free/);
  });
});

describe("F-25 calendar_move_event", () => {
  it("returns the event as it exists on the destination calendar", async () => {
    const { g, calls } = fakeClient((m) => (m === "post" ? { id: "ev1", status: "cancelled" } : { id: "ev1", status: "confirmed", summary: "Moved", start: { dateTime: "2026-09-18T10:00:00+03:00" }, end: { dateTime: "2026-09-18T11:00:00+03:00" } }));
    const r: any = await byName("calendar_move_event").handler({ calendar_id: "primary", event_id: "ev1", destination_calendar_id: "dest@group.calendar.google.com", send_updates: "none" }, ctx(g));
    expect(calls[1].url).toMatch(/calendars\/dest%40group\.calendar\.google\.com\/events\/ev1$/);
    expect(r.status).toBe("confirmed");
    expect(r.movedTo).toBe("dest@group.calendar.google.com");
  });
});

describe("F-21 forms_create_form", () => {
  it("defaults the Drive file name to the form title", async () => {
    const { g, calls } = fakeClient(() => ({ formId: "f1", info: { title: "[MCP-TEST] form" }, responderUri: "https://x" }));
    await byName("forms_create_form").handler({ title: "[MCP-TEST] form", publish: true }, ctx(g));
    expect(calls[0].body).toEqual({ info: { title: "[MCP-TEST] form", documentTitle: "[MCP-TEST] form" } });
  });
});

describe("F-02/F-03 gmail_read_message", () => {
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");
  const msg = {
    id: "m1",
    threadId: "t1",
    labelIds: ["INBOX"],
    payload: {
      mimeType: "multipart/mixed",
      headers: [
        { name: "From", value: "a@b.c" },
        { name: "Subject", value: "hi" },
        { name: "ARC-Seal", value: "i=1; a=rsa-sha256; ..." },
        { name: "DKIM-Signature", value: "v=1; ..." },
        { name: "Received", value: "from x by y" },
      ],
      parts: [
        { partId: "0", mimeType: "text/plain", headers: [{ name: "Content-Type", value: "text/plain" }], body: { size: 20, data: b64("x".repeat(3000)) } },
        { partId: "1", mimeType: "application/pdf", filename: "a.pdf", body: { size: 475000, attachmentId: "att1" } },
      ],
    },
  };
  it("caps the body at max_chars and flags truncation", async () => {
    const { g } = fakeClient(() => msg);
    const r: any = await byName("gmail_read_message").handler({ message_id: "m1", format: "text", max_chars: 1000, include_signature_headers: false }, ctx(g));
    expect(r.body).toHaveLength(1000);
    expect(r.totalChars).toBe(3000);
    expect(r.returnedChars).toBe(1000);
    expect(r.truncated).toBe(true);
    expect(r.attachments).toEqual([{ partId: "1", filename: "a.pdf", mimeType: "application/pdf", size: 475000, attachmentId: "att1" }]);
  });
  it("format=full is structure only and drops ARC/DKIM/Received headers", async () => {
    const { g } = fakeClient(() => msg);
    const r: any = await byName("gmail_read_message").handler({ message_id: "m1", format: "full", max_chars: 50000, include_signature_headers: false }, ctx(g));
    expect(r.body).toBeUndefined();
    expect(r.payload.headers.map((h: any) => h.name)).toEqual(["From", "Subject"]);
    expect(r.payload.parts[0].body).toEqual({ size: 20 });
    // attachmentIds live once, in attachments[] (N-02) — not repeated in the MIME tree.
    expect(r.payload.parts[1].body).toEqual({ size: 475000 });
    expect(r.attachments[0].attachmentId).toBe("att1");
    const keep: any = await byName("gmail_read_message").handler({ message_id: "m1", format: "full", max_chars: 50000, include_signature_headers: true }, ctx(g));
    expect(keep.payload.headers).toHaveLength(5);
  });
  it("gmail_download_attachment refuses big inline payloads and can save to Drive", async () => {
    const data = b64("%PDF-1.4 " + "y".repeat(2000));
    const { g, calls } = fakeClient((m, url) => (url.includes("/attachments/") ? { size: 2009, data } : url.includes("upload") ? { id: "drv1", name: "a.pdf", webViewLink: "https://drive/x" } : msg));
    const t = byName("gmail_download_attachment");
    await expect(t.handler({ message_id: "m1", attachment_id: "att1", as: "base64", max_bytes: 100, max_chars: 100000 }, ctx(g))).rejects.toThrow(/as=drive/);
    const r: any = await t.handler({ message_id: "m1", attachment_id: "att1", as: "drive", max_bytes: 100, max_chars: 100000 }, ctx(g));
    expect(r.savedToDrive).toBe(true);
    expect(r.file.id).toBe("drv1");
    const up = calls.find((c) => c.url.includes("upload"))!;
    expect(up.params.uploadType).toBe("multipart");
    expect(Buffer.from(up.body).toString("utf8")).toMatch(/"name":"a.pdf"[\s\S]*Content-Type: application\/pdf/);
  });
});

describe("F-04 htmlToText", () => {
  it("keeps anchor text with the URL, handles lists and quoted '>' in attributes", () => {
    expect(htmlToText('<p>See <a href="https://x.y/z?a=1&amp;b=2">our site</a> now</p><div style="a>b"><a href="https://same.com/">https://same.com</a></div>')).toBe("See our site (https://x.y/z?a=1&b=2) now\nhttps://same.com/");
    expect(htmlToText("<ul><li>one</li><li>two</li></ul>")).toBe("- one\n- two");
    expect(htmlToText('<a href="mailto:a@b.c">a@b.c</a> &#x1F600;')).toBe("a@b.c 😀");
  });
});

describe("F-01 sheets_create_spreadsheet locale", () => {
  it("maps he_IL to the legacy iw_IL code Google accepts", async () => {
    const { g, calls } = fakeClient(() => ({ spreadsheetId: "s1", sheets: [] }));
    await byName("sheets_create_spreadsheet").handler({ title: "t", locale: "he_IL" }, ctx(g));
    expect(calls[0].body.properties.locale).toBe("iw_IL");
    await byName("sheets_create_spreadsheet").handler({ title: "t", locale: "en_US" }, ctx(g));
    expect(calls[1].body.properties.locale).toBe("en_US");
  });
  it("sheets_get_spreadsheet omits merges unless asked", async () => {
    const { g, calls } = fakeClient(() => ({}));
    await byName("sheets_get_spreadsheet").handler({ spreadsheet_id: "s1", include_merges: false }, ctx(g));
    expect(calls[0].params.fields).not.toMatch(/merges/);
    await byName("sheets_get_spreadsheet").handler({ spreadsheet_id: "s1", include_merges: true }, ctx(g));
    expect(calls[1].params.fields).toMatch(/merges/);
  });
});

describe("F-24 photos_search_media_items", () => {
  it("follows empty pages, and when they persist keeps the token with a note instead of hiding results", async () => {
    let n = 0;
    const { g, calls } = fakeClient(() => (++n < 3 ? { mediaItems: [], nextPageToken: `p${n}` } : { mediaItems: [{ id: "x", mimeType: "image/jpeg" }] }));
    const r: any = await byName("photos_search_media_items").handler({ page_size: 25 }, ctx(g));
    expect(calls).toHaveLength(3);
    expect(calls[2].body.pageToken).toBe("p2");
    expect(r.count).toBe(1);
    expect(r.nextPageToken).toBeUndefined();
    let m = 0;
    const always = fakeClient(() => ({ mediaItems: [], nextPageToken: `q${++m}` }));
    const r2: any = await byName("photos_search_media_items").handler({ page_size: 25 }, ctx(always.g));
    expect(always.calls).toHaveLength(6);
    expect(r2.count).toBe(0);
    expect(r2.nextPageToken).toBe("q6");
    expect(r2.note).toMatch(/more pages exist/);
  });
});

describe("F-17 sheets_read_range include_formulas", () => {
  it("mirrors `values` for non-formula cells so the parallel arrays share types", async () => {
    const { g } = fakeClient((m, url, body, params) => (params.valueRenderOption === "FORMULA" ? { range: "S!A1:B2", values: [[3, "=A1*2"], [1250.5, "x"]] } : { range: "S!A1:B2", values: [["3", "6"], ["1,250.50", "x"]] }));
    const r: any = await byName("sheets_read_range").handler({ spreadsheet_id: "s", range: "S!A1:B2", include_formulas: true, value_render_option: "FORMATTED_VALUE", date_time_render_option: "FORMATTED_STRING", major_dimension: "ROWS" }, ctx(g));
    expect(r.values).toEqual([["3", "6"], ["1,250.50", "x"]]);
    expect(r.formulas).toEqual([["3", "=A1*2"], ["1,250.50", "x"]]);
  });
});

describe("F-09 draft Date header", () => {
  it("stamps an RFC 5322 UTC date so Gmail does not invent a US-Pacific offset", () => {
    expect(rfc5322Date(new Date("2026-09-18T06:04:36Z"))).toBe("Fri, 18 Sep 2026 06:04:36 +0000");
  });
});

describe("F-05 google_whoami", () => {
  it("reports allScopesGranted explicitly", async () => {
    const g: any = { tokenInfo: async () => ({ email: "me@example.com", scopes: ["https://www.googleapis.com/auth/userinfo.email"], expiresIn: 100 }), get: async () => ({}) };
    const r: any = await byName("google_whoami").handler({}, ctx(g));
    expect(r.allScopesGranted).toBe(false);
    expect(r.missingScopes).toContain("spreadsheets");
  });
});
