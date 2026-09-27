/**
 * The naming module itself (v1.5 PR-4): the verb vocabulary, the parser and the rename table
 * as pure functions. Whether the *registered* tools obey the grammar is `tests/hygiene.test.ts`.
 */
import { describe, it, expect } from "vitest";
import { EVERY_TOOL } from "../src/tools/index.js";
import {
  ALIAS_ARGS,
  ALIAS_REMOVAL_VERSION,
  aliasesFor,
  canonicalName,
  kindOf,
  MAX_NAME_LENGTH,
  NAME_EXEMPTIONS,
  parseToolName,
  RENAMES,
  VERB_KINDS,
  VERBS,
} from "../src/tools/naming.js";

// Flagged tools included: a tool behind a flag obeys the same grammar as every other one.
const names = EVERY_TOOL.map((t) => t.name);

describe("verb vocabulary", () => {
  it("VERBS is VERB_KINDS' keys, unique, and every verb is in use", () => {
    expect(VERBS).toEqual(Object.keys(VERB_KINDS));
    expect(new Set(VERBS).size).toBe(VERBS.length);
    const exempt = new Set<string>(NAME_EXEMPTIONS);
    const used = new Set(names.filter((n) => !exempt.has(n)).map((n) => parseToolName(n)!.verb));
    expect(VERBS.filter((v) => !used.has(v))).toEqual([]);
  });

  it("classifies the kinds the annotations are derived from", () => {
    expect(VERB_KINDS.list).toBe("read");
    expect(VERB_KINDS.batch_read).toBe("read");
    expect(VERB_KINDS.create).toBe("additive");
    expect(VERB_KINDS.quick_add).toBe("additive");
    expect(VERB_KINDS.copy).toBe("mutating");
    expect(VERB_KINDS.update).toBe("mutating_idempotent");
    expect(VERB_KINDS.batch_update).toBe("mutating_idempotent");
    // Writing one stated value over a range ends in the same state however often it runs.
    expect(VERB_KINDS.fill).toBe("mutating_idempotent");
    expect(kindOf("sheets_fill_range")).toBe("mutating_idempotent");
    expect(VERB_KINDS.send).toBe("destructive");
    expect(VERB_KINDS.end).toBe("destructive");
    expect(VERB_KINDS.delete).toBe("destructive_idempotent");
    expect(VERB_KINDS.clear).toBe("destructive_idempotent");
    expect(kindOf("gmail_send_message")).toBe("destructive");
    expect(kindOf("sheets_batch_read_ranges")).toBe("read");
    expect(kindOf("google_api_request")).toBeNull();
  });

  it("drops the verbs no name uses any more", () => {
    for (const gone of ["reply", "forward", "remove", "respond", "quick", "set", "batch", "whoami", "call"]) {
      expect(VERBS, `${gone} is no longer a verb`).not.toContain(gone);
    }
  });
});

describe("parseToolName", () => {
  it("splits service, verb and resource, matching compound verbs first", () => {
    expect(parseToolName("gmail_search_messages")).toEqual({ service: "gmail", verb: "search", resource: "messages" });
    expect(parseToolName("photos_list_picked_media_items")).toEqual({ service: "photos", verb: "list", resource: "picked_media_items" });
    expect(parseToolName("sheets_batch_read_ranges")).toEqual({ service: "sheets", verb: "batch_read", resource: "ranges" });
    expect(parseToolName("sheets_batch_update_spreadsheet")).toEqual({ service: "sheets", verb: "batch_update", resource: "spreadsheet" });
    expect(parseToolName("gmail_batch_modify_message_labels")).toEqual({ service: "gmail", verb: "batch_modify", resource: "message_labels" });
    expect(parseToolName("contacts_batch_get_contacts")).toEqual({ service: "contacts", verb: "batch_get", resource: "contacts" });
    expect(parseToolName("calendar_quick_add_event")).toEqual({ service: "calendar", verb: "quick_add", resource: "event" });
    expect(parseToolName("sheets_fill_range")).toEqual({ service: "sheets", verb: "fill", resource: "range" });
    // `read` and `add` are verbs in their own right: the compound match must not steal them.
    expect(parseToolName("slides_read_presentation")).toEqual({ service: "slides", verb: "read", resource: "presentation" });
    expect(parseToolName("photos_add_album_items")).toEqual({ service: "photos", verb: "add", resource: "album_items" });
  });

  it("returns null for a name with no service/verb split or an unknown verb", () => {
    expect(parseToolName("google_api_request")).toBeNull();
    expect(parseToolName("google_whoami")).toBeNull();
    expect(parseToolName("calendar_free_busy")).toBeNull();
    expect(parseToolName("gmail")).toBeNull();
    expect(parseToolName("")).toBeNull();
  });

  it("allows an empty resource only off the registered surface", () => {
    expect(parseToolName("forms_create")).toEqual({ service: "forms", verb: "create", resource: "" });
    expect(names).not.toContain("forms_create");
  });

  it("MAX_NAME_LENGTH leaves headroom over the longest registered name", () => {
    const longest = names.reduce((a, b) => (b.length > a.length ? b : a));
    expect(longest.length).toBeLessThanOrEqual(MAX_NAME_LENGTH);
  });
});

describe("renames", () => {
  it("holds 46 entries whose targets all exist", () => {
    const entries = Object.entries(RENAMES);
    expect(entries.length).toBe(46);
    const canonical = new Set(names);
    for (const [old, current] of entries) {
      expect(canonical.has(current), `${old} → ${current}`).toBe(true);
      expect(canonical.has(old), `${old} is retired`).toBe(false);
    }
  });

  it("aliasesFor and canonicalName round-trip", () => {
    for (const [old, current] of Object.entries(RENAMES)) {
      expect(canonicalName(old)).toBe(current);
      expect(aliasesFor(current)).toContain(old);
      expect(canonicalName(canonicalName(old))).toBe(current);
    }
    for (const name of names) {
      expect(canonicalName(name)).toBe(name);
      for (const old of aliasesFor(name)) expect(RENAMES[old]).toBe(name);
    }
    expect(aliasesFor("sheets_read_cells")).toEqual(["sheets_get_cells"]);
    expect(aliasesFor("drive_search_files")).toEqual(["drive_list_folder"]);
    expect(aliasesFor("not_a_tool")).toEqual([]);
    expect(canonicalName("not_a_tool")).toBe("not_a_tool");
  });

  it("ALIAS_ARGS covers only drive_list_folder, clears its free-text query and keeps its folder default", () => {
    expect(Object.keys(ALIAS_ARGS)).toEqual(["drive_list_folder"]);
    expect(ALIAS_ARGS.drive_list_folder({ folder_id: "root", page_size: 50 })).toEqual({ folder_id: "root", page_size: 50, query: undefined });
    expect(ALIAS_ARGS.drive_list_folder({ folder_id: "F1" })).toEqual({ folder_id: "F1", query: undefined });
    // The old tool declared folder_id: "root"; drive_search_files leaves it optional (= all of Drive).
    expect(ALIAS_ARGS.drive_list_folder({})).toEqual({ folder_id: "root", query: undefined });
    expect(ALIAS_ARGS.drive_list_folder({ folder_id: undefined })).toEqual({ folder_id: "root", query: undefined });
  });

  it("states the release that removes the aliases", () => {
    expect(ALIAS_REMOVAL_VERSION).toBe("2.0");
  });
});
