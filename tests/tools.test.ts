import { describe, it, expect } from "vitest";
import { z } from "zod";
import { ALL_TOOLS, TOOL_GROUPS, registerTools } from "../src/tools/index.js";
import { aliasDefs } from "../src/tools/_shared.js";
import { RENAMES } from "../src/tools/naming.js";

describe("tool catalog", () => {
  it("has unique, prefixed, documented tools with scopes", () => {
    const names = ALL_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const g of TOOL_GROUPS) {
      expect(g.tools.length, g.group).toBeGreaterThan(0);
      for (const t of g.tools) {
        expect(t.name, `${g.group}: ${t.name}`).toMatch(new RegExp(`^${g.prefix}[a-z0-9_]+$`));
        expect(t.description.length, t.name).toBeGreaterThan(20);
        expect(typeof t.handler).toBe("function");
        if (g.group !== "Meta") expect(t.scope, `${t.name} missing scope`).toMatch(/^https:\/\/www\.googleapis\.com\/auth\//);
      }
    }
    expect(ALL_TOOLS.length).toBeGreaterThanOrEqual(100);
  });

  it("covers every tool the spec asked for", () => {
    const names = new Set(ALL_TOOLS.map((t) => t.name));
    const required = [
      "sheets_list_spreadsheets", "sheets_get_spreadsheet", "sheets_read_range", "sheets_write_range", "sheets_append_rows", "sheets_batch_update_spreadsheet", "sheets_add_sheet", "sheets_create_spreadsheet",
      "drive_search_files", "drive_read_file", "drive_upload_file", "drive_create_folder", "drive_list_permissions", "drive_share_file",
      "docs_read_document", "docs_append_text", "docs_insert_text", "docs_batch_update_document",
      "gmail_search_messages", "gmail_read_message", "gmail_create_draft", "gmail_send_message", "gmail_list_labels", "gmail_modify_message_labels",
      "calendar_list_events", "calendar_create_event", "calendar_update_event", "calendar_delete_event",
      "tasks_list_tasklists", "tasks_list_tasks", "tasks_create_task", "tasks_update_task", "tasks_complete_task",
      "contacts_search_contacts", "contacts_list_contacts", "contacts_get_contact", "contacts_create_contact", "contacts_update_contact", "contacts_delete_contact",
      "chat_list_spaces", "chat_list_messages", "chat_get_message", "chat_send_message", "chat_update_message", "chat_delete_message",
      "slides_get_presentation", "slides_create_presentation", "slides_batch_update_presentation", "slides_read_presentation",
      "forms_get_form", "forms_list_responses", "forms_create_form",
      "photos_search_media_items", "photos_list_albums", "photos_get_album", "photos_upload_media_item",
      "youtube_list_my_channels", "youtube_list_playlists", "youtube_list_playlist_items", "youtube_get_video_stats",
      "meet_create_space", "meet_get_space", "meet_list_conference_records", "meet_list_participants",
      "google_whoami",
    ];
    const missing = required.filter((n) => !names.has(n));
    expect(missing).toEqual([]);
  });

  it("every input schema converts to JSON Schema (what the MCP SDK sends to clients)", () => {
    for (const t of ALL_TOOLS) {
      const schema = z.object(t.input);
      // Same conversion the SDK performs for tools/list (zod's default unrepresentable: "throw").
      expect(() => z.toJSONSchema(schema, { target: "draft-7", io: "input" }), t.name).not.toThrow();
    }
  });

  it("send tools require confirm=true and are marked destructive; deletes are destructive", () => {
    for (const t of ALL_TOOLS) {
      if (/^gmail_send_/.test(t.name)) {
        expect(t.destructive, t.name).toBe(true);
        expect(t.input.confirm, `${t.name} must take confirm`).toBeDefined();
        expect(() => z.object(t.input).parse({ confirm: false, to: "a@b.c", subject: "s", body: "b", draft_id: "d" }), t.name).toThrow();
      }
      // Picker sessions are scratch state, not user data — their delete is neither a write nor destructive.
      if ((/_delete_/.test(t.name) || /_delete$/.test(t.name)) && !/picker_session/.test(t.name)) {
        expect(t.write, t.name).toBe(true);
        expect(t.destructive, t.name).toBe(true);
      }
    }
  });

  it("registers the canonical tools then the hidden aliases; read-only mode drops every write tool and its alias", () => {
    const make = () => {
      const names: string[] = [];
      return { server: { registerTool: (n: string) => void names.push(n) } as any, names };
    };
    const aliases = aliasDefs(ALL_TOOLS);
    expect(aliases.map((t) => t.name).sort()).toEqual(Object.keys(RENAMES).sort());
    const full = make();
    registerTools(full.server, { g: {} as any, readOnly: false, grantedScopes: [] });
    expect(full.names).toEqual([...ALL_TOOLS.map((t) => t.name), ...aliases.map((t) => t.name)]); // canonical first, aliases after
    const ro = make();
    registerTools(ro.server, { g: {} as any, readOnly: true, grantedScopes: [] });
    expect(ro.names.length).toBe([...ALL_TOOLS, ...aliases].filter((t) => !t.write).length);
    const byName = new Map([...ALL_TOOLS, ...aliases].map((t) => [t.name, t]));
    expect(ro.names.filter((n) => byName.get(n)!.write)).toEqual([]);
    expect(ro.names).not.toContain("gmail_send_message");
    expect(ro.names).not.toContain("chat_create_message"); // a write alias is dropped with its target
    expect(ro.names).not.toContain("sheets_write_range");
    expect(ro.names).toContain("sheets_read_range");
    expect(ro.names).toContain("sheets_get_metadata"); // a read alias stays callable
  });
});
