// Regression tests for the post-1.4.2 QA round (N-04 … N-13 + build identification).
import { describe, it, expect } from "vitest";
import { ALL_TOOLS } from "../src/tools/index.js";
import { htmlToText } from "../src/tools/_shared.js";
import { compactFile } from "../src/tools/drive.js";
import { VERSION } from "../src/version.js";
import pkg from "../package.json" with { type: "json" };

const byName = (n: string) => ALL_TOOLS.find((t) => t.name === n)!;
const ctx = (g: any, email = "someone@example.com") => ({ g, email, requestedScopes: undefined }) as any;
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");

const msg = {
  id: "m1",
  threadId: "t1",
  snippet: "hello",
  internalDate: "1758200000000",
  raw: b64("From: a@b.c\r\nSubject: Hi\r\n\r\nplain body"),
  payload: {
    mimeType: "multipart/mixed",
    headers: [
      { name: "From", value: "a@b.c" },
      { name: "Subject", value: "Hi" },
      { name: "X-Original-Authentication-Results", value: "blob" },
      { name: "X-Gm-Message-State", value: "x" },
      { name: "Feedback-ID", value: "y" },
      { name: "List-Unsubscribe", value: "<mailto:u@b.c>" },
    ],
    parts: [
      { partId: "0", mimeType: "text/plain", headers: [{ name: "Content-Type", value: "text/plain" }, { name: "X-BeenThere", value: "z" }], body: { size: 4, data: b64("body") } },
      { partId: "1", mimeType: "application/pdf", filename: "a.pdf", body: { size: 10, attachmentId: "att1" } },
    ],
  },
};
const gmailClient = (extra: Record<string, any> = {}) => ({ get: async (url: string, q?: any) => (url.includes("/attachments/") ? (q?.fields === "size" ? { size: 9 } : { size: 9, data: b64("csv,data\n") }) : url.includes("/messages") ? msg : url.includes("/drafts") ? { id: "d1", message: msg } : {}), ...extra });

describe("N-04 provenance follows the content, not the format name", () => {
  it("gmail_read_message wraps raw and full", async () => {
    const t = byName("gmail_read_message");
    const raw: any = await t.handler({ message_id: "m1", format: "raw", max_chars: 50000, include_signature_headers: false }, ctx(gmailClient()));
    expect(Object.keys(raw)[0]).toBe("provenance");
    expect(raw.provenance).toMatchObject({ source: "gmail:message:m1", fields: ["snippet", "raw"], trust: "third-party" });
    expect(raw.raw).toContain("plain body");
    expect(raw.totalChars).toBe(raw.raw.length);
    expect(raw.returnedChars).toBe(raw.raw.length);
    const full: any = await t.handler({ message_id: "m1", format: "full", max_chars: 50000, include_signature_headers: false }, ctx(gmailClient()));
    expect(Object.keys(full)[0]).toBe("provenance");
    expect(full.provenance.fields).toContain("payload.headers");
    expect(full.provenance.fields).toContain("subject");
  });
  it("search, drafts, attachment text, sheets values and slides carry the envelope", async () => {
    const search: any = await byName("gmail_search_messages").handler({ query: "", max_results: 5, include_spam_trash: false }, ctx({ get: async (url: string) => (url.endsWith("/messages") ? { messages: [{ id: "m1" }] } : msg) }));
    expect(search.provenance.fields).toEqual(["items[].subject", "items[].snippet"]);
    expect(search.items).toHaveLength(1);
    const draft: any = await byName("gmail_read_draft").handler({ draft_id: "d1" }, ctx(gmailClient()));
    expect(draft.provenance.source).toBe("gmail:draft:d1");
    const att: any = await byName("gmail_download_attachment").handler({ message_id: "m1", attachment_id: "att1", as: "text", max_bytes: 1_000_000, max_chars: 4 }, ctx(gmailClient()));
    expect(att.provenance).toMatchObject({ source: "gmail:attachment:m1", fields: ["text"] });
    expect(att).toMatchObject({ totalChars: 9, returnedChars: 4, truncated: true, text: "csv," });
    const sheet: any = await byName("sheets_read_range").handler({ spreadsheet_id: "s1", range: "A1:B2", include_formulas: false, value_render_option: "FORMATTED_VALUE", date_time_render_option: "FORMATTED_STRING", major_dimension: "ROWS" }, ctx({ get: async () => ({ range: "Sheet1!A1:B2", values: [["a", "b"]] }) }));
    expect(Object.keys(sheet)[0]).toBe("provenance");
    expect(sheet.provenance).toMatchObject({ source: "sheets:spreadsheet:s1", fields: ["values"] });
    const batch: any = await byName("sheets_batch_read_ranges").handler({ spreadsheet_id: "s1", ranges: ["A1"], value_render_option: "FORMATTED_VALUE", date_time_render_option: "FORMATTED_STRING" }, ctx({ get: async () => ({ valueRanges: [{ range: "A1", values: [["x"]] }] }) }));
    expect(batch.provenance.fields).toEqual(["valueRanges[].values"]);
    const pres: any = await byName("slides_get_presentation").handler({ presentation_id: "p1", include_elements: true }, ctx({ get: async () => ({ presentationId: "p1", title: "Deck", slides: [] }) }));
    expect(Object.keys(pres)[0]).toBe("provenance");
    expect(pres.provenance.source).toBe("slides:presentation:p1");
  });
});

describe("N-05 gmail truncation fields match the other readers", () => {
  it("reports totalChars/returnedChars on text and html bodies", async () => {
    const long = { ...msg, payload: { mimeType: "text/html", headers: [], body: { size: 1, data: b64(`<p>${"x".repeat(2000)}</p>`) } } };
    const r: any = await byName("gmail_read_message").handler({ message_id: "m1", format: "html", max_chars: 500, include_signature_headers: false }, ctx({ get: async () => long }));
    expect(r.bodyChars).toBeUndefined();
    expect(r).toMatchObject({ totalChars: 2000, returnedChars: 500, bodyHtmlTotalChars: 2007, bodyHtmlReturnedChars: 500, truncated: true });
    expect(r.body).toHaveLength(500);
    const short: any = await byName("gmail_read_message").handler({ message_id: "m1", format: "text", max_chars: 5000, include_signature_headers: false }, ctx({ get: async () => long }));
    expect(short).toMatchObject({ totalChars: 2000, returnedChars: 2000 });
    expect(short.truncated).toBeUndefined();
  });
});

describe("N-06 htmlToText", () => {
  it("decodes named entities", () => {
    expect(htmlToText("a&zwnj;b &hellip; c&mdash;d &rsquo;e&rsquo; &copy; &euro;5 &nbsp;f &bogus; &amp;lt;")).toBe("ab … c—d ’e’ © €5 f &bogus; &lt;");
  });
  it("keeps a boundary after an image-only link and drops tracking URLs", () => {
    const track = "https://u1.ct.sendgrid.net/ls/click?upn=" + "A".repeat(500);
    expect(htmlToText(`<a href="${track}"><img src="x.png"></a>For Fall Winter 2026`)).toBe("[link] For Fall Winter 2026");
    expect(htmlToText(`<a href="${track}"><img alt="Shop now" src="x.png"></a>Next`)).toBe("Shop nowNext".replace("Shop nowNext", "Shop nowNext")); // alt without a URL: the text itself
    expect(htmlToText(`<a href="https://x.y/z"><img alt="Shop now" src="x.png"></a> Next`)).toBe("Shop now (https://x.y/z) Next");
    expect(htmlToText(`<a href="https://x.y/z"><img src="x.png"></a>Next`)).toBe("https://x.y/z Next");
    expect(htmlToText(`<p>Read <a href="${track}">the story</a> today</p>`)).toBe("Read the story today");
  });
  it("still renders ordinary anchors and entities inside them once", () => {
    expect(htmlToText('<a href="https://x.y/?a=1&amp;b=2">Tom &amp; Jerry</a>')).toBe("Tom & Jerry (https://x.y/?a=1&b=2)");
  });
});

describe("N-12 format=full keeps headers by allow-list", () => {
  it("drops X-*/Feedback-ID noise, keeps List-Unsubscribe and Content-Type, counts what it dropped", async () => {
    const r: any = await byName("gmail_read_message").handler({ message_id: "m1", format: "full", max_chars: 50000, include_signature_headers: false }, ctx(gmailClient()));
    expect(r.payload.headers.map((h: any) => h.name)).toEqual(["From", "Subject", "List-Unsubscribe"]);
    expect(r.payload.parts[0].headers.map((h: any) => h.name)).toEqual(["Content-Type"]);
    expect(r.headersOmitted).toBe(4);
    const all: any = await byName("gmail_read_message").handler({ message_id: "m1", format: "full", max_chars: 50000, include_signature_headers: true }, ctx(gmailClient()));
    expect(all.payload.headers).toHaveLength(6);
    expect(all.headersOmitted).toBeUndefined();
  });
});

describe("N-08 / build identification", () => {
  it("google_whoami omits picture and reports serverVersion; google_list_tools too", async () => {
    const g: any = { tokenInfo: async () => ({ email: "a@b.c", scopes: ["openid", "https://www.googleapis.com/auth/userinfo.email"], expiresIn: 100 }), get: async () => ({ picture: "https://lh3/x", name: undefined }) };
    const who: any = await byName("google_whoami").handler({}, ctx(g));
    expect(who.picture).toBeUndefined();
    expect(who.serverVersion).toBe(VERSION);
    // google_list_tools now reports THIS session's counts, so it needs the session catalog.
    const tools: any = await byName("google_list_tools").handler({}, { ...ctx({}), catalog: { manifest: ALL_TOOLS, listed: ALL_TOOLS, aliases: [] } });
    expect(tools.serverVersion).toBe(VERSION);
    expect(pkg.version).toBe(VERSION);
  });
});

describe("N-13 Drive size on native Google files", () => {
  it("omits the placeholder size for application/vnd.google-apps.* and keeps real sizes", () => {
    expect(compactFile({ id: "1", mimeType: "application/vnd.google-apps.spreadsheet", size: "1024" })).toEqual({ id: "1", mimeType: "application/vnd.google-apps.spreadsheet" });
    expect(compactFile({ id: "2", mimeType: "application/pdf", size: "1024" })).toEqual({ id: "2", mimeType: "application/pdf", size: "1024" });
  });
  it("applies to drive_get_file and search results", async () => {
    const files = [{ id: "1", mimeType: "application/vnd.google-apps.form", size: "1024" }, { id: "2", mimeType: "image/png", size: "77" }];
    const get: any = await byName("drive_get_file").handler({ file_id: "1" }, ctx({ get: async () => files[0] }));
    expect(get.size).toBeUndefined();
    const list: any = await byName("drive_search_files").handler({ include_trashed: false, page_size: 10, order_by: "" }, ctx({ get: async () => ({ files }) }));
    expect(list.items.map((f: any) => f.size)).toEqual([undefined, "77"]);
  });
});
