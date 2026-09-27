/**
 * v1.5 PR-5 §C/§F.4 — group/profile expansion in ENABLED_TOOL_GROUPS / DISABLED_TOOL_GROUPS.
 *
 * The invariant that keeps every existing deployment byte-identical: a name is a GROUP first and
 * only then a profile, and `enabledScopes` stays group-driven — a profile changes WHICH groups are
 * on, never how a group maps to Google scopes.
 */
import { describe, it, expect } from "vitest";
import { PROFILES, ALL_GROUP_KEYS, expandProfiles, enabledGroups, enabledScopes, SCOPES } from "../src/google/scopes.js";

const PROFILE_KEYS = Object.keys(PROFILES);

const on = (env: Record<string, string>) => [...enabledGroups(env).groups].filter((g) => g !== "identity").sort();

describe("profiles: the table itself", () => {
  it("only references real groups or other profiles, and never shadows a group key", () => {
    for (const [name, members] of Object.entries(PROFILES)) {
      for (const m of members) expect(ALL_GROUP_KEYS.includes(m) || Object.hasOwn(PROFILES, m), `${name} -> ${m}`).toBe(true);
    }
    expect((PROFILES as Record<string, readonly string[]>).sheets).toBeUndefined(); // shadowed by the sheets GROUP — deliberately absent
    expect(PROFILE_KEYS).toEqual(["core", "gmail", "calendar", "drive_docs", "personal", "sheets_power_user", "company_admin"]);
  });
  it("every profile expands to at least one real group (a zero-group profile would fail OPEN)", () => {
    // enabledGroups falls back to ALL_GROUP_KEYS only when the operator named nothing; a profile
    // that resolved to nothing must never be able to trigger that fallback (see the test below).
    for (const p of PROFILE_KEYS) expect(expandProfiles([p]).groups.filter((g) => ALL_GROUP_KEYS.includes(g)).length, p).toBeGreaterThan(0);
  });
  it("admin / apps_script are not profiles — they stay an honest unknown-name warning", () => {
    expect(enabledGroups({ ENABLED_TOOL_GROUPS: "admin, apps_script" }).unknownGroups).toEqual(["admin", "apps_script"]);
  });
});

describe("expandProfiles", () => {
  it("expands recursively, preserves order and de-duplicates", () => {
    expect(expandProfiles(["core"])).toEqual({ groups: ["gmail", "calendar", "drive", "docs", "sheets"], profiles: ["core"] });
    expect(expandProfiles(["personal"])).toEqual({ groups: ["gmail", "calendar", "drive", "docs", "sheets", "tasks", "contacts"], profiles: ["personal", "core"] });
    expect(expandProfiles(["company_admin"]).groups).toEqual(["gmail", "calendar", "drive", "docs", "sheets", "chat", "meet", "contacts"]);
    // tasks first, then personal: first mention wins, no duplicate
    expect(expandProfiles(["tasks", "personal"]).groups).toEqual(["tasks", "gmail", "calendar", "drive", "docs", "sheets", "contacts"]);
    expect(expandProfiles(["core", "personal", "core"]).profiles).toEqual(["core", "personal"]);
  });
  it("resolves a name as a GROUP before a profile (pre-1.5 values keep their meaning)", () => {
    expect(expandProfiles(["gmail"])).toEqual({ groups: ["gmail"], profiles: [] });
    expect(expandProfiles(["calendar"])).toEqual({ groups: ["calendar"], profiles: [] });
    expect(expandProfiles(["sheets"])).toEqual({ groups: ["sheets"], profiles: [] });
  });
  it("passes unknown names through untouched and is not confused by Object.prototype keys", () => {
    expect(expandProfiles(["nope"])).toEqual({ groups: ["nope"], profiles: [] });
    expect(expandProfiles(["constructor", "tostring"])).toEqual({ groups: ["constructor", "tostring"], profiles: [] });
  });
  it("is cycle-safe (with an injected table — the shipped one is never mutated)", () => {
    const cyclic = { a: ["b"], b: ["a", "sheets"] };
    expect(expandProfiles(["a"], cyclic)).toEqual({ groups: ["sheets"], profiles: ["a", "b"] });
    expect(expandProfiles(["a", "b"], cyclic)).toEqual({ groups: ["sheets"], profiles: ["a", "b"] });
    expect(PROFILE_KEYS).toEqual(Object.keys(PROFILES)); // the production table is untouched
  });
  it("handles the empty list", () => {
    expect(expandProfiles([])).toEqual({ groups: [], profiles: [] });
  });
});

describe("enabledGroups with profiles", () => {
  it("a profile in ENABLED narrows to its groups and is reported in profiles", () => {
    const r = enabledGroups({ ENABLED_TOOL_GROUPS: "drive_docs" });
    expect([...r.groups].sort()).toEqual(["docs", "drive", "identity"]);
    expect(r.profiles).toEqual(["drive_docs"]);
    expect(r.unknownGroups).toEqual([]);
    expect(on({ ENABLED_TOOL_GROUPS: "sheets_power_user" })).toEqual(["drive", "sheets"]);
    expect(on({ ENABLED_TOOL_GROUPS: "personal" })).toEqual(["calendar", "contacts", "docs", "drive", "gmail", "sheets", "tasks"]);
  });
  it("a profile in DISABLED subtracts all of its groups", () => {
    expect(on({ DISABLED_TOOL_GROUPS: "drive_docs" })).toEqual(ALL_GROUP_KEYS.filter((g) => g !== "drive" && g !== "docs").sort());
    const r = enabledGroups({ ENABLED_TOOL_GROUPS: "personal", DISABLED_TOOL_GROUPS: "drive_docs" });
    expect([...r.groups].filter((g) => g !== "identity").sort()).toEqual(["calendar", "contacts", "gmail", "sheets", "tasks"]);
    expect(r.profiles).toEqual(["personal", "core", "drive_docs"]);
  });
  it("mixes profiles and plain groups, and a name that is neither stays unknown", () => {
    const r = enabledGroups({ ENABLED_TOOL_GROUPS: "core, youtube, nope" });
    expect([...r.groups].filter((g) => g !== "identity").sort()).toEqual(["calendar", "docs", "drive", "gmail", "sheets", "youtube"]);
    expect(r.unknownGroups).toEqual(["nope"]);
    expect(r.profiles).toEqual(["core"]);
  });
  it("a repeated unknown name is reported once per variable (PR-4 repeated it; /health text changes)", () => {
    expect(enabledGroups({ ENABLED_TOOL_GROUPS: "nope, nope, sheets" }).unknownGroups).toEqual(["nope"]);
    // Across the two variables it is still listed twice — they are expanded separately.
    expect(enabledGroups({ ENABLED_TOOL_GROUPS: "nope, nope", DISABLED_TOOL_GROUPS: "nope" }).unknownGroups).toEqual(["nope", "nope"]);
  });
  it("an ENABLED list that names only unknowns stays FAIL-CLOSED, it never means 'everything'", () => {
    // The operator DID name something, so the ALL_GROUP_KEYS fallback must not apply.
    expect(on({ ENABLED_TOOL_GROUPS: "nope" })).toEqual([]);
    expect(on({ ENABLED_TOOL_GROUPS: "nope, alsonope" })).toEqual([]);
    expect(enabledScopes({ ENABLED_TOOL_GROUPS: "nope" })).toEqual(["openid", "https://www.googleapis.com/auth/userinfo.email"]);
    // Same for a (hypothetical) profile that expands to no group at all: identity only, not all 21 scopes.
    const empty = { empty: [] as string[], alsoEmpty: ["empty"] };
    for (const p of Object.keys(empty)) expect(expandProfiles([p], empty).groups, p).toEqual([]);
  });
  it("defaults are untouched: no ENABLED/DISABLED means every group and no profile", () => {
    const all = enabledGroups({});
    expect(all.groups.size).toBe(ALL_GROUP_KEYS.length + 1);
    expect(all.unknownGroups).toEqual([]);
    expect(all.profiles).toEqual([]);
  });
});

describe("enabledScopes stays group-driven and unchanged", () => {
  /** Hardcoded goldens, captured from release/1.5 (888d359) — NOT re-derived from enabledGroups. */
  const g = (...names: string[]) => names.map((n) => (n === "openid" ? n : `https://www.googleapis.com/auth/${n}`));
  const ID = ["openid", "userinfo.email"];
  const GOLDEN: [Record<string, string>, string[]][] = [
    [{}, g(...ID, "spreadsheets", "drive", "documents", "gmail.modify", "calendar", "tasks", "contacts", "chat.spaces.readonly", "chat.messages", "presentations", "forms.body", "forms.responses.readonly", "photoslibrary.appendonly", "photoslibrary.readonly.appcreateddata", "photoslibrary.edit.appcreateddata", "photospicker.mediaitems.readonly", "youtube.readonly", "meetings.space.created", "meetings.space.readonly")],
    [{ ENABLED_TOOL_GROUPS: "sheets" }, g(...ID, "spreadsheets")],
    [{ ENABLED_TOOL_GROUPS: "sheets,drive", DISABLED_TOOL_GROUPS: "drive" }, g(...ID, "spreadsheets")],
    [{ DISABLED_TOOL_GROUPS: "gmail, photos" }, g(...ID, "spreadsheets", "drive", "documents", "calendar", "tasks", "contacts", "chat.spaces.readonly", "chat.messages", "presentations", "forms.body", "forms.responses.readonly", "youtube.readonly", "meetings.space.created", "meetings.space.readonly")],
    [{ ENABLED_TOOL_GROUPS: "gmail" }, g(...ID, "gmail.modify")],
    [{ ENABLED_TOOL_GROUPS: "calendar" }, g(...ID, "calendar")],
  ];

  it("every pre-1.5 config resolves to exactly the scope list it did before this PR", () => {
    for (const [env, scopes] of GOLDEN) expect(enabledScopes(env), JSON.stringify(env)).toEqual(scopes);
    expect(enabledScopes({})).toHaveLength(SCOPES.length);
  });

  it("a profile only picks groups: drive_docs == 'drive, docs' spelled out", () => {
    expect(enabledScopes({ ENABLED_TOOL_GROUPS: "drive_docs" })).toEqual(enabledScopes({ ENABLED_TOOL_GROUPS: "drive, docs" }));
    expect(enabledScopes({ ENABLED_TOOL_GROUPS: "personal" })).toEqual(enabledScopes({ ENABLED_TOOL_GROUPS: "gmail calendar drive docs sheets tasks contacts" }));
    expect(enabledScopes({ ENABLED_TOOL_GROUPS: "company_admin" })).toEqual(enabledScopes({ ENABLED_TOOL_GROUPS: "gmail calendar drive docs sheets chat meet contacts" }));
  });
});
