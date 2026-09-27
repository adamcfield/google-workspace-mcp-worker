/**
 * The deterministic mutation gate and the selector built on it.
 *
 * These tests pin the safety properties the tool-selection work rests on. They are written against
 * the REAL catalog rather than a fixture, because the properties are claims about what this server
 * can be talked into doing, and a hand-made three-tool manifest cannot support such a claim.
 */

import { describe, expect, it } from "vitest";
import { ALL_TOOLS } from "../src/tools/_groups.js";
import { buildManifest } from "../src/tools/_manifest.js";
import { GATE_PARAMS, gateTools, rankWrites, readMutationIntent } from "../src/routing/gate.js";
import { selectTools, SELECT_PARAMS } from "../src/routing/select.js";
import cases from "./../bench/jev/cases.json" with { type: "json" };

const manifest = buildManifest(ALL_TOOLS, new Set(ALL_TOOLS.map((t) => t.name)));
const entry = (name: string) => manifest.find((e) => e.name === name);
const writes = (names: readonly string[]) => names.filter((n) => entry(n)?.write);

describe("mutation intent", () => {
  it("reads nothing out of a request that only asks to look at something", () => {
    for (const request of ["find the emails from the supplier", "what is on my calendar tomorrow", "מה יש לי ביומן מחר", "how much Drive storage do I have left"]) {
      expect(readMutationIntent(request).mutating, request).toBe(false);
    }
  });

  it("sees the verb in the second clause of a Hebrew request, where the conjunction is joined to it", () => {
    // `ותשתף` and `ותקבע` are "and share" and "and schedule". The shared tokenizer reduces the
    // first only partially and the second not at all, which is why the gate normalizes again.
    expect(readMutationIntent("תמצא את הקובץ ותשתף אותו עם הצוות").verbs).toContain("share");
    expect(readMutationIntent("תבדוק אם אני פנוי ביום רביעי ותקבע פגישה").verbs).toContain("create");
  });

  it("treats a pasted range, link or address as naming a target", () => {
    expect(readMutationIntent("clear the values in Sheet1!A2:D100").targeted).toBe(true);
    expect(readMutationIntent("remove it").targeted).toBe(false);
  });

  it("does not read YouTube out of a comment: Docs has comments too", () => {
    // Once "comment" became a lexicon word the tokenizer folded YouTube's service word "comments"
    // into it, and "delete the comment" read as naming YouTube.
    for (const request of ["delete the comment", "delete all the comments", "reply to the comment and resolve it", "resolve the review comments"]) {
      expect(readMutationIntent(request).services, request).not.toContain("youtube");
    }
    expect(readMutationIntent("delete the comments on my latest video").services).toContain("youtube");
    expect(readMutationIntent("delete the comment").resources).toContain("comment");
  });
});

describe("the gate", () => {
  it("offers no writing tool at all when nothing was asked to change", () => {
    for (const request of ["find the emails from the supplier about invoice 4471", "show me the text of the onboarding document", "list my Chat spaces"]) {
      expect(gateTools(request, manifest).tools, request).toEqual([]);
    }
  });

  it("does not read rewording Claude's own text, or redoing a lookup, as a change to a document", () => {
    // "rewrite" / "reword" / "redo" alone are the commonest words for reformatting an answer or
    // repeating a search. As bare cues they offered trash and batch-update tools for these.
    for (const request of [
      "rewrite this summary of my inbox in bullet points",
      "reword your answer so it is shorter",
      "redo the search for emails from the supplier",
      "can you redo that calendar lookup for next week",
      "תנסח מחדש את התשובה בנקודות",
    ]) {
      expect(readMutationIntent(request).verbs, request).toEqual([]);
      expect(gateTools(request, manifest).tools, request).toEqual([]);
    }
  });

  it("does not read \"more space\" in a Chat, Meet or Drive question as a formatting change", () => {
    // "space" is the Chat and Meet noun and a Drive storage word, and "more" is a function word, so
    // bare "more space" / "add space" cues matched these reads in any word order.
    for (const request of [
      "show me more messages from the team space in chat",
      "are there more chat spaces I belong to",
      "which files take up more space in my drive",
      "which meet space has more participants",
      "is there less space left in my drive than last month",
      "for each of the chat spaces below, list the members",
    ]) {
      expect(readMutationIntent(request).verbs, request).toEqual([]);
      expect(gateTools(request, manifest).tools, request).toEqual([]);
    }
  });

  it("keeps questions about comments, spacing and alignment reads: the formatting and comment cues need the change itself", () => {
    // The comment, alignment and spacing cues are word sets matched in any order, so each is tied
    // to the words that make it a request: "comment on" needs what to say ("that", "saying"),
    // alignment needs the text it aligns, a space cue needs a change of amount, and the Hebrew
    // cues are imperatives tied to a noun — a bare "להגדיל" / "ליישר" is how a budget or how-to
    // question is asked. Before the cues were tied, the bare Hebrew verbs offered Sheets writes for
    // the budget questions and "space above the table" offered the style tool for a question.
    for (const request of [
      "show me the comments on the design doc",
      "who commented on the proposal doc",
      "what are the comments on the budget section",
      "is there a comment on the intro section",
      "which comments on the doc are marked resolved",
      "list the unresolved comments in the report document",
      "are there any comments that say the numbers are wrong in the doc",
      "how much space above the table is there in the report doc",
      "what alignment does the title in the doc use",
      "what line spacing does the report document use",
      "what is the cost center in the report doc",
      "double-check the messages in the team space",
      "מה ההערות במסמך",
      "בכמה להגדיל את התקציב בגיליון",
      "כמה להקטין את ההוצאות לפי הגיליון",
      "איך ליישר טקסט במסמך",
    ]) {
      expect(readMutationIntent(request).verbs, request).toEqual([]);
      expect(gateTools(request, manifest).tools, request).toEqual([]);
    }
  });

  it("offers no Docs writing tool for a calendar or Chat request that never mentions a document", () => {
    // Benchmark cases J26 and J65. "whether" in two comment tools' route text and "space above" /
    // "space below" in the spacing tool's keywords pulled Docs tools into these, evicting a tool
    // the request could actually use (meet_create_space, tasks_uncomplete_task).
    for (const request of ["check whether I am free on Friday morning and if so book a 30 minute call", "post a message in the Engineering space saying the deploy is done"]) {
      const tools = gateTools(request, manifest).tools;
      expect(tools.filter((n) => n.startsWith("docs_")), request).toEqual([]);
    }
    expect(gateTools("check whether I am free on Friday morning and if so book a 30 minute call", manifest).tools).toContain("calendar_create_event");
    expect(gateTools("post a message in the Engineering space saying the deploy is done", manifest).tools).toContain("chat_send_message");
  });

  it("refuses to guess an irreversible tool when the request names no target", () => {
    for (const request of ["remove it", "clean this up", "תעדכן את זה"]) {
      const result = gateTools(request, manifest);
      const destructive = result.tools.filter((name) => entry(name)?.destructive);
      expect(destructive, request).toEqual([]);
    }
    // Naming a thing no irreversible tool acts on is not naming a target. Comments, sections,
    // spacing and alignment are Docs nouns, and no delete, clear or end tool takes one: each of
    // these was refused before those words entered the lexicon, and must still be. With one
    // request-wide "named something" flag they were offered drive_delete_file,
    // calendar_delete_event, sheets_delete_sheet, contacts_delete_contact, chat_delete_message,
    // sheets_clear_range and meet_end_conference. ("delete all the comments" is stricter than
    // before: "comments" was a YouTube service word, and that alone let unrelated deletes through.)
    for (const request of [
      "delete the comment",
      "delete all the comments",
      "permanently delete the comment",
      "erase the comment",
      "end the comment",
      "remove the section",
      "delete this section",
      "clear the section",
      "remove the spacing",
      "delete the alignment",
      "wipe the alignment",
      "תמחק את ההערה",
      "תסיר את ההערה",
      "תמחק את כל ההערות",
      "תמחק לצמיתות את ההערה",
      "תסיר את הסעיף",
      "תמחק את הסעיף הזה",
      "תנקה את הסעיף",
      "תסיר את הריווח",
      "תמחק את היישור",
      "תנקה את היישור",
    ]) {
      const result = gateTools(request, manifest);
      expect(result.tools.filter((name) => entry(name)?.destructive), request).toEqual([]);
      expect(result.needsTarget, request).toBe(true);
    }
  });

  it("keeps release/1.6's answer for a change that names nothing, with the Sheets evidence cues in the same gate", () => {
    // Measured on release/1.6 (with the fill and row/column evidence already in its gate): each of
    // these got no writing tool and a request to say which object was meant. The per-tool rule and
    // the own-evidence admission are merged into one gate here; neither may bring a write back.
    for (const request of ["delete it", "remove it", "clear everything", "delete everything", "erase all of it", "תמחק את זה", "תנקה הכל", "תמחק הכל"]) {
      const result = gateTools(request, manifest);
      expect(result.tools, request).toEqual([]);
      expect(result.needsTarget, request).toBe(true);
    }
  });

  it("a refused section replace keeps its ranked place: nothing irreversible moves up into the cap", () => {
    // Review finding: OWN_VERB_ONLY_TOOLS once took docs_replace_section out of the ranking pool when
    // its verbs were not said, so the tools below it moved up one place and drive_delete_file (sixth)
    // entered the cap of five on "delete the formatting from the doc" — the tool that deletes the
    // whole document, offered to strip formatting. release/1.6 (78e4230) offers no Drive delete here.
    for (const request of ["delete the formatting from the doc", "delete the formatting from the proposal doc", "delete the formatting from my doc", "get rid of the formatting from the doc"]) {
      const result = gateTools(request, manifest);
      expect(result.tools, request).not.toContain("drive_delete_file");
      expect(result.tools, request).not.toContain("docs_replace_section");
    }
  });

  it("never offers the section replace to a vague discard: it erases the section, so only its own verb admits it", () => {
    // docs_replace_section empties a section (text "" clears it, tables go whole). Flagged as a
    // recoverable write, the trash family ("discard", "throw away", תזרוק) admitted it on requests
    // release/1.6 refused with needsTarget; the same request refused docs_delete_range, which does the
    // same deletion. Measured on release/1.6 (ed8d1ca): no tools, needsTarget, for each of these.
    for (const request of ["discard the section", "throw away the section", "תזרוק את הסעיף", "discard the heading", "discard the budget section", "throw away that part", "זרוק את הסעיף הזה"]) {
      const result = gateTools(request, manifest);
      expect(result.tools, request).not.toContain("docs_replace_section");
      expect(result.tools.filter((name) => entry(name)?.destructive), request).toEqual([]);
      expect(result.needsTarget, request).toBe(true);
    }
    // Its own verb, or a verb that asks for new content in place of the old (OWN_VERB_ONLY_TOOLS),
    // still reaches it on a section the request names.
    for (const request of [
      "rewrite the Risks section in the proposal doc",
      "replace the Background section of the design doc with this text",
      "תכתוב מחדש את הסעיף תקציב במסמך",
      "update the Budget section in the proposal doc",
      "change the summary section to say we are on track",
      "edit the section under the Risks heading",
      "overwrite the intro section of the document",
      "תעדכן את הסעיף רקע במסמך",
    ]) {
      expect(gateTools(request, manifest).tools, request).toContain("docs_replace_section");
    }
    // The rest of the recoverable family does not: formatting, moving or completing a section is not
    // a request to erase its body.
    for (const request of ["format the Budget section in the proposal doc", "move the section under the Risks heading", "complete the summary section in the doc", "trash the Budget section in the proposal doc"]) {
      expect(gateTools(request, manifest).tools, request).not.toContain("docs_replace_section");
    }
  });

  it("judges the target per tool: naming one thing is no licence to delete another", () => {
    // Each request names its object, and only the tools that act on THAT object's service or
    // resource may be offered. A request-wide flag also offered every other delete that ranked.
    const irreversible = (request: string) => gateTools(request, manifest).tools.filter((name) => entry(name)?.destructive);
    expect(irreversible("delete the event on Friday at 3pm")).toEqual(["calendar_delete_event"]);
    expect(irreversible("delete the draft to bob@example.com")).toEqual(["gmail_delete_draft"]);
    expect(irreversible("clear the values in Sheet1!A2:D100")).toEqual(["sheets_clear_range"]);
    for (const name of irreversible("delete the comment on the proposal doc")) expect(["docs", "drive"], name).toContain(entry(name)?.service);
    // A word of a resource is not the resource: "completed" alone names no tasks.
    expect(gateTools("clear completed", manifest).needsTarget).toBe(true);
    // An address or a time next to a named thing only qualifies that thing.
    expect(gateTools("delete the comment from yesterday", manifest).needsTarget).toBe(true);
    expect(gateTools("delete the comment from bob@example.com", manifest).needsTarget).toBe(true);
  });

  it("still offers the irreversible tool a request actually names", () => {
    for (const [request, tool] of [
      ["delete the draft to bob@example.com", "gmail_delete_draft"],
      ["תמחק את הטיוטה", "gmail_delete_draft"],
      ["delete the onboarding document", "drive_delete_file"],
      ["delete the budget spreadsheet", "drive_delete_file"],
      ["delete the Summary tab", "sheets_delete_sheet"],
      ["remove bob@example.com from the budget spreadsheet", "drive_delete_permission"],
      ["cancel my 3pm", "calendar_delete_event"],
      ["מחק את האירוע ביום שלישי", "calendar_delete_event"],
      ["end the meeting for everyone", "meet_end_conference"],
      ["תסיים את הפגישה", "meet_end_conference"],
      ["clear my completed tasks", "tasks_clear_completed_tasks"],
      ["delete the paragraph about pricing in the doc", "docs_delete_range"],
      ["reply to the comment and resolve it", "docs_create_reply"],
    ] as const) {
      const result = gateTools(request, manifest);
      expect(result.tools, request).toContain(tool);
      expect(result.needsTarget, request).toBe(false);
    }
  });

  it("still offers an irreversible tool with no target when the tool itself asks the user first", () => {
    // "send it" names no message and no recipient, but every tool it can mean carries a `confirm`
    // argument, so the user gets a second checkpoint before anything leaves. Refusing here would
    // buy no safety and would break the most common phrasing there is.
    const result = gateTools("send it", manifest);
    expect(result.tools.length).toBeGreaterThan(0);
    for (const name of result.tools) {
      const e = entry(name)!;
      expect(!e.destructive || e.required.includes("confirm") || e.optional.includes("confirm"), name).toBe(true);
    }
  });

  it("never promotes an irreversible tool into a slot a refused one vacated, confirm or not", () => {
    // Before this rule was per tool, a targeted request kept the first five of the ranking and
    // nothing below them. Refusing the unaimed deletes in those five must not let a send tool that
    // ranked eighth move up: `confirm` is a second checkpoint, not a reason to offer a tool the
    // ranking had already left out. release/1.6 offered none of these for these requests.
    for (const [request, notOffered] of [
      ["delete the event and send the summary", ["chat_send_message", "gmail_send_message"]],
      ["delete the tab and send a reply", ["chat_send_message", "gmail_send_message"]],
      ["delete the contact then send it to bob@example.com", ["gmail_send_message", "chat_send_message", "gmail_send_draft"]],
      ["delete the file and post in the Engineering space", ["gmail_send_draft", "gmail_send_message"]],
      ["תמחק את האירוע ותשלח את הסיכום", ["chat_send_message", "gmail_send_message", "gmail_send_draft"]],
      ["תמחק את איש הקשר ותשלח את זה ל-bob@example.com", ["chat_send_message", "gmail_send_message", "gmail_send_draft"]],
    ] as const) {
      const tools = gateTools(request, manifest).tools;
      for (const name of notOffered) expect(tools, request).not.toContain(name);
    }
    // The tools that did rank within the five are still offered.
    expect(gateTools("delete the event and send the summary", manifest).tools).toEqual(expect.arrayContaining(["calendar_delete_event", "gmail_send_draft"]));
    expect(gateTools("delete the file and post in the Engineering space", manifest).tools).toEqual(expect.arrayContaining(["drive_delete_file", "chat_send_message"]));
  });

  it("only ever removes from its own ranking: every irreversible tool offered was said, and ranked within the cap", () => {
    // The structural form of the two tests above, held against the ranking rule 2 was actually
    // given (`rankWrites`), over compounds of a delete and a send, formatting requests and every
    // benchmark case. Whatever else changes in the ranker, rule 2 cannot offer an irreversible tool
    // that the request-wide rule of release/1.6 would not have offered over the same ranking.
    const requests = [
      ...["delete", "remove", "cancel"].flatMap((verb) =>
        ["the event", "the tab", "the contact", "the file", "the draft", "the comment", "the section", "the task"].flatMap((noun) =>
          ["send the summary", "send it to bob@example.com", "post in the Engineering space", "email the team"].map((tail) => `${verb} ${noun} and ${tail}`),
        ),
      ),
      "reduce spacing in the email",
      "right align the email signature",
      "rename the email",
      "send it",
      ...cases.cases.map((c) => c.request),
    ];
    for (const request of requests) {
      const { intent, ordered, evidenced, ranked, rankedVerbs } = rankWrites(request, manifest);
      const tools = gateTools(request, manifest).tools;
      expect(tools, request).toEqual(ordered.filter((name) => tools.includes(name)));
      for (const name of tools.filter((n) => entry(n)?.destructive)) {
        const e = entry(name)!;
        const confirm = e.required.includes("confirm") || e.optional.includes("confirm");
        expect(intent.verbs.some((v) => e.verb === v || e.verb.endsWith(`_${v}`)), `${request}: ${name} verb`).toBe(true);
        if (!intent.targeted) expect(confirm, `${request}: ${name} untargeted`).toBe(true);
        // A tool admitted on the request's own evidence (a fill, a row/column cue) is not ranked and
        // takes none of the five places; every other one was said and ranked within the cap.
        if (evidenced.includes(name)) continue;
        expect(rankedVerbs.some((v) => e.verb === v || e.verb.endsWith(`_${v}`)), `${request}: ${name} ranked verb`).toBe(true);
        if (intent.targeted) expect(ranked.indexOf(name), `${request}: ${name} rank`).toBeLessThan(GATE_PARAMS.maxTools);
      }
    }
    // ~170 requests, each ranked twice (rankWrites, then gateTools): about 3 s alone and more next to
    // the heavy Sheets suites, past vitest's 5 s default on a 4-core runner.
  }, 30_000);

  it("offers an irreversible tool only for its own verb, never through a recoverable verb's family", () => {
    // `trash` is a recoverable verb, but `gmail_trash_message` is flagged irreversible and takes no
    // `confirm`. A recoverable verb admits its whole family ("rename" reaches untrash, "add" reaches
    // append), and through that the formatting and rewording cues ("reduce spacing", "right align",
    // "rewrite the section") offered it to any request that said "email" — questions included.
    // release/1.6 offered no writing tool at all for any of these but the last.
    for (const request of [
      "reduce spacing in the email",
      "center align the text in the email",
      "right align the email signature",
      "rewrite the section of the email",
      "reword the document and the email",
      "תנסח מחדש את המסמך מהמייל",
      "does the email have double spacing",
      "why does the email text align right",
      "is there a way to right align text in the email",
      "how do I rewrite a doc from an email",
      "the numbers in the budget don't align right with the email",
      "rename the email",
      "תקטין ריווח במייל",
      "תיישר לימין את החתימה במייל",
    ]) {
      expect(gateTools(request, manifest).tools.filter((name) => entry(name)?.destructive), request).toEqual([]);
    }
    // Said outright, trashing still reaches the tool.
    expect(gateTools("move that phishing email to the trash", manifest).tools).toContain("gmail_trash_message");
  });

  it("does not let one irreversible verb reach another's tools", () => {
    // A request to delete must never surface `clear`, and vice versa: for irreversible verbs the
    // cost of widening by one word is a wrong action, not a wasted schema.
    const deleting = gateTools("delete the event on Friday at 3pm", manifest).tools;
    expect(deleting.some((n) => entry(n)?.verb === "clear")).toBe(false);
    expect(deleting).toContain("calendar_delete_event");
    expect(deleting).not.toContain("calendar_create_event");
  });

  it("keeps at most one irreversible tool per service, choosing the most specific resource named", () => {
    const tools = gateTools("delete the task list named Old Drafts", manifest).tools;
    expect(tools).toContain("tasks_delete_tasklist");
    expect(tools).not.toContain("tasks_delete_task");
  });

  it("is total: no input shape throws", () => {
    for (const request of ["", "   ", "\u0000", "?".repeat(2000), "https://example.com/a?b=c"]) {
      expect(() => gateTools(request, manifest)).not.toThrow();
    }
  });
});

describe("selection", () => {
  it("never exposes a writing tool for a request that asked for no change", async () => {
    // The strong form of the property, over every read-only case in the benchmark at once.
    const readOnly = cases.cases.filter((c) => !c.required.some((slot) => slot.some((name) => entry(name)?.write)));
    expect(readOnly.length).toBeGreaterThan(20);
    for (const c of readOnly) {
      const picked = await selectTools(c.request, manifest);
      const unexpected = writes(picked.tools).filter((name) => !picked.gate.tools.includes(name));
      expect(unexpected, `${c.id}: ${c.request}`).toEqual([]);
    }
  });

  it("exposes no irreversible write for a delete that names nothing an irreversible tool acts on", async () => {
    // The selection's writes come only from the gate, so this is the gate's refusal seen end to end.
    for (const request of ["delete the comment", "remove the section", "wipe the alignment", "תמחק את כל ההערות", "תסיר את הסעיף"]) {
      const picked = await selectTools(request, manifest);
      expect(picked.tools.filter((name) => entry(name)?.destructive), request).toEqual([]);
      expect(picked.gate.needsTarget, request).toBe(true);
    }
  });

  it("exposes no irreversible write for a formatting or rewording request, or a question, that mentions an email", async () => {
    for (const request of ["reduce spacing in the email", "does the email have double spacing", "why does the email text align right", "rewrite the section of the email", "תנסח מחדש את המסמך מהמייל"]) {
      const picked = await selectTools(request, manifest);
      expect(picked.tools.filter((name) => entry(name)?.destructive), request).toEqual([]);
    }
    const compound = await selectTools("delete the event and send the summary", manifest);
    expect(compound.tools).not.toContain("chat_send_message");
  });

  it("keeps the gate's tools when the model says no to every one of them", async () => {
    const request = "delete the event on Friday at 3pm";
    const pinned = gateTools(request, manifest).tools;
    expect(pinned.length).toBeGreaterThan(0);
    const picked = await selectTools(request, manifest, { ask: async () => false });
    for (const name of pinned) expect(picked.tools).toContain(name);
  });

  it("keeps the gate's tools when the model throws, and says so", async () => {
    const request = "send the draft I wrote to the finance team";
    const pinned = gateTools(request, manifest).tools;
    const picked = await selectTools(request, manifest, {
      ask: async () => {
        throw new Error("upstream unavailable");
      },
    });
    expect(picked.fallback).toBe(true);
    for (const name of pinned) expect(picked.tools).toContain(name);
  });

  it("keeps the gate's tools when the cap would otherwise evict them", async () => {
    const request = "revoke someone's access to the budget spreadsheet";
    const pinned = gateTools(request, manifest).tools;
    expect(pinned.length).toBeGreaterThan(0);
    const picked = await selectTools(request, manifest, { maxTools: 1 });
    for (const name of pinned) expect(picked.tools).toContain(name);
  });

  it("respects the cap for everything the gate did not pin", async () => {
    const picked = await selectTools("find the emails from the supplier about invoice 4471", manifest, { maxTools: 5 });
    expect(picked.gate.tools).toEqual([]);
    expect(picked.tools.length).toBeLessThanOrEqual(5);
  });

  it("returns candidates best first, not by name", async () => {
    // A cap that cuts an alphabetically sorted list keeps whatever starts with "c". This is the
    // regression that cost `gmail_search_messages` its place on a request about finding an email.
    const picked = await selectTools("find the emails from the supplier about invoice 4471", manifest, { maxTools: SELECT_PARAMS.maxTools });
    expect(picked.tools[0]).toBe("gmail_search_messages");
    expect(picked.tools).not.toEqual([...picked.tools].sort());
  });

  it("asks one question per prefiltered candidate and no more", async () => {
    const asked: string[] = [];
    const picked = await selectTools("what is on my calendar tomorrow", manifest, {
      ask: async (_request, tool) => {
        asked.push(tool.name);
        return tool.name === "calendar_list_events";
      },
    });
    expect(asked).toEqual(picked.prefiltered);
    expect(new Set(asked).size).toBe(asked.length);
    expect(picked.asked).toBe(asked.length);
  });

  it("falls back rather than returning nothing when the model rejects every candidate", async () => {
    const picked = await selectTools("what is on my calendar tomorrow", manifest, { ask: async () => false });
    expect(picked.tools.length).toBeGreaterThan(0);
  });
});
