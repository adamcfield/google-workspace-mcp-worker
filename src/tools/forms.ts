/**
 * Google Forms tools.
 * API: https://forms.googleapis.com/v1 (forms.body for structure, forms.responses.readonly for answers).
 *
 * Gotchas baked in here:
 *  - forms.create only accepts info.title / info.documentTitle — everything else (description,
 *    questions, settings) goes through forms.batchUpdate afterwards.
 *  - Forms created via the API are UNPUBLISHED by default (no responderUri that accepts answers)
 *    forms.create publishes by default; pass publish=false to create an unpublished draft.
 *  - Items are addressed by 0-based index in batchUpdate (createItem/deleteItem/moveItem).
 */
import { z } from "zod";
import { API } from "../google/client.js";
import { tool, enc, listResult, JsonObject, PageSize, PageToken, audit, type AnyRec, provenance } from "./_shared.js";

const BODY_SCOPE = "https://www.googleapis.com/auth/forms.body";
const RESPONSES_SCOPE = "https://www.googleapis.com/auth/forms.responses.readonly";

const FormId = z.string().describe("Form id (from the URL /forms/d/<id>/edit)");
const editUrl = (id: string) => `https://docs.google.com/forms/d/${id}/edit`;

const CHOICE_TYPE: Record<string, string> = { multiple_choice: "RADIO", checkboxes: "CHECKBOX", dropdown: "DROP_DOWN" };

const Question = z.object({
  title: z.string().describe("Question text"),
  type: z.enum(["short_text", "paragraph", "multiple_choice", "checkboxes", "dropdown", "linear_scale", "date", "time"]),
  required: z.boolean().default(false),
  options: z.array(z.string()).optional().describe("Choices for multiple_choice/checkboxes/dropdown (at least one)"),
  has_other: z.boolean().default(false).describe("Add an 'Other…' free-text option (multiple_choice/checkboxes only)"),
  scale: z
    .object({
      low: z.number().int().min(0).max(1).default(1),
      high: z.number().int().min(2).max(10).default(5),
      low_label: z.string().optional(),
      high_label: z.string().optional(),
    })
    .optional()
    .describe("linear_scale bounds/labels (Google allows low 0-1, high 2-10)"),
  description: z.string().optional().describe("Help text shown under the question"),
  include_year: z.boolean().default(true).describe("date: ask for the year"),
  include_time: z.boolean().default(false).describe("date: also ask for a time of day"),
});
type QuestionInput = z.infer<typeof Question>;
const Questions = z.array(Question).min(1).describe("Questions to create, in order");

/** Build a Forms API Item from the simplified question shape (throws on invalid combos). */
function questionToItem(q: QuestionInput): AnyRec {
  const question: AnyRec = { required: q.required };
  switch (q.type) {
    case "short_text":
      question.textQuestion = { paragraph: false };
      break;
    case "paragraph":
      question.textQuestion = { paragraph: true };
      break;
    case "multiple_choice":
    case "checkboxes":
    case "dropdown": {
      const options: AnyRec[] = (q.options ?? []).map((v) => ({ value: v }));
      if (q.has_other) {
        if (q.type === "dropdown") throw new Error(`Question "${q.title}": dropdown questions cannot have an 'Other' option`);
        options.push({ isOther: true });
      }
      if (!options.length) throw new Error(`Question "${q.title}" (${q.type}) needs at least one entry in options`);
      question.choiceQuestion = { type: CHOICE_TYPE[q.type], options, shuffle: false };
      break;
    }
    case "linear_scale": {
      const low = q.scale?.low ?? 1;
      const high = q.scale?.high ?? 5;
      if (high <= low) throw new Error(`Question "${q.title}": scale high (${high}) must be greater than low (${low})`);
      question.scaleQuestion = { low, high, lowLabel: q.scale?.low_label, highLabel: q.scale?.high_label };
      break;
    }
    case "date":
      question.dateQuestion = { includeYear: q.include_year, includeTime: q.include_time };
      break;
    case "time":
      question.timeQuestion = { duration: false };
      break;
  }
  return { title: q.title, description: q.description, questionItem: { question } };
}

/** Compact a Forms Item into {itemId, title, type, questionId, required, options, scale, ...}. */
function compactItem(it: AnyRec): AnyRec {
  const out: AnyRec = { itemId: it.itemId, title: it.title, description: it.description };
  const q = it.questionItem?.question;
  if (q) {
    out.questionId = q.questionId;
    out.required = q.required;
    if (q.choiceQuestion) {
      out.type = q.choiceQuestion.type ?? "CHOICE";
      out.options = (q.choiceQuestion.options ?? []).map((o: AnyRec) => (o.isOther ? "(other)" : o.value));
    } else if (q.textQuestion) out.type = q.textQuestion.paragraph ? "PARAGRAPH" : "SHORT_TEXT";
    else if (q.scaleQuestion) {
      out.type = "SCALE";
      const s = q.scaleQuestion;
      out.scale = { low: s.low, high: s.high, lowLabel: s.lowLabel, highLabel: s.highLabel };
    } else if (q.dateQuestion) {
      out.type = "DATE";
      out.includeYear = q.dateQuestion.includeYear;
      out.includeTime = q.dateQuestion.includeTime;
    } else if (q.timeQuestion) out.type = q.timeQuestion.duration ? "DURATION" : "TIME";
    else if (q.fileUploadQuestion) out.type = "FILE_UPLOAD";
    else if (q.rowQuestion) out.type = "GRID_ROW";
    else if (q.ratingQuestion) out.type = "RATING";
    if (q.grading?.pointValue !== undefined) out.points = q.grading.pointValue;
  } else if (it.questionGroupItem) {
    const grp = it.questionGroupItem;
    out.type = grp.grid?.columns?.type === "CHECKBOX" ? "CHECKBOX_GRID" : "GRID";
    out.columns = (grp.grid?.columns?.options ?? []).map((o: AnyRec) => o.value);
    out.rows = (grp.questions ?? []).map((rq: AnyRec) => ({ questionId: rq.questionId, title: rq.rowQuestion?.title, required: rq.required }));
  } else if (it.pageBreakItem) out.type = "PAGE_BREAK";
  else if (it.textItem) out.type = "TEXT";
  else if (it.imageItem) {
    out.type = "IMAGE";
    out.imageUri = it.imageItem.image?.contentUri ?? it.imageItem.image?.sourceUri;
  } else if (it.videoItem) {
    out.type = "VIDEO";
    out.videoUri = it.videoItem.video?.youtubeUri;
  }
  return out;
}

/** Compact a Form resource. */
function compactForm(f: AnyRec): AnyRec {
  return {
    formId: f.formId,
    title: f.info?.title,
    documentTitle: f.info?.documentTitle,
    description: f.info?.description,
    responderUri: f.responderUri,
    editUrl: f.formId ? editUrl(f.formId) : undefined,
    linkedSheetId: f.linkedSheetId,
    revisionId: f.revisionId,
    isQuiz: f.settings?.quizSettings?.isQuiz,
    publishSettings: f.publishSettings,
    items: (f.items ?? []).map(compactItem),
  };
}

/** questionId → human title (grid rows become "Group title — Row title"). */
function questionTitles(f: AnyRec): Map<string, string> {
  const m = new Map<string, string>();
  for (const it of (f.items ?? []) as AnyRec[]) {
    const q = it.questionItem?.question;
    if (q?.questionId) m.set(q.questionId, it.title || q.questionId);
    for (const rq of (it.questionGroupItem?.questions ?? []) as AnyRec[]) {
      if (rq.questionId) m.set(rq.questionId, [it.title, rq.rowQuestion?.title].filter(Boolean).join(" — ") || rq.questionId);
    }
  }
  return m;
}

/** Compact a FormResponse: answers keyed by question title. */
function compactResponse(r: AnyRec, titles: Map<string, string>, includeRaw: boolean): AnyRec {
  const answers: AnyRec = {};
  for (const [qid, ans] of Object.entries((r.answers ?? {}) as Record<string, AnyRec>)) {
    let key = titles.get(qid) ?? qid;
    if (key in answers) key = `${key} (${qid})`;
    let value: unknown;
    if (ans.textAnswers?.answers) {
      const vals = (ans.textAnswers.answers as AnyRec[]).map((x) => x.value);
      value = vals.length === 1 ? vals[0] : vals;
    } else if (ans.fileUploadAnswers?.answers) {
      value = (ans.fileUploadAnswers.answers as AnyRec[]).map((x) => ({ fileId: x.fileId, fileName: x.fileName, mimeType: x.mimeType }));
    }
    if (ans.grade && (ans.grade.score !== undefined || ans.grade.correct !== undefined)) {
      value = { value, score: ans.grade.score, correct: ans.grade.correct };
    }
    answers[key] = value;
  }
  return {
    responseId: r.responseId,
    createTime: r.createTime,
    lastSubmittedTime: r.lastSubmittedTime,
    respondentEmail: r.respondentEmail,
    totalScore: r.totalScore,
    answers,
    raw: includeRaw ? r : undefined,
  };
}

export const formsTools = [
  tool({
    name: "forms_get_form",
    description:
      "Get a form's structure: title, description, responderUri (public link), linked responses sheet, publish state and every item (itemId, questionId, type RADIO/CHECKBOX/DROP_DOWN/SHORT_TEXT/PARAGRAPH/SCALE/DATE/TIME/FILE_UPLOAD/GRID/PAGE_BREAK/TEXT/IMAGE/VIDEO, required, options, scale). Item order = 0-based index used by forms_delete_item / moveItem.",
    scope: BODY_SCOPE,
    input: { form_id: FormId, raw: z.boolean().default(false).describe("Return the raw Form resource instead of the compact shape") },
    handler: async (a, { g }) => {
      const f = await g.get<AnyRec>(`${API.forms}/forms/${enc(a.form_id)}`);
      return a.raw ? f : compactForm(f);
    },
  }),

  tool({
    name: "forms_list_responses",
    description:
      "List responses to a form, newest first. Answers are keyed by question title (values are strings, arrays for multi-select, or {fileId,fileName} for uploads). Filter supports only 'timestamp >= <RFC3339>' or 'timestamp > <RFC3339>' (e.g. timestamp >= 2026-01-01T00:00:00Z).",
    scope: RESPONSES_SCOPE,
    input: {
      form_id: FormId,
      page_size: PageSize(100, 5000),
      page_token: PageToken,
      filter: z.string().optional().describe("e.g. 'timestamp >= 2026-01-01T00:00:00Z' (only timestamp comparisons are supported)"),
      include_raw: z.boolean().default(false).describe("Also include each raw FormResponse"),
    },
    handler: async (a, { g }) => {
      if (a.filter && !/^\s*timestamp\s*>=?\s*\S+\s*$/.test(a.filter)) throw new Error("filter must look like 'timestamp >= 2026-01-01T00:00:00Z' (the Forms API only supports timestamp > / >= filters)");
      const [form, r] = await Promise.all([
        g.get<AnyRec>(`${API.forms}/forms/${enc(a.form_id)}`),
        g.get<AnyRec>(`${API.forms}/forms/${enc(a.form_id)}/responses`, { pageSize: a.page_size, pageToken: a.page_token, filter: a.filter }),
      ]);
      const titles = questionTitles(form);
      const items = ((r.responses ?? []) as AnyRec[]).map((x) => compactResponse(x, titles, a.include_raw));
      return { ...provenance(`forms:responses:${a.form_id}`, ["items[].answers"]), ...listResult(items, r.nextPageToken, { formId: a.form_id, title: form.info?.title }) };
    },
  }),

  tool({
    name: "forms_get_response",
    description: "Get one response by responseId (from forms_list_responses), with answers keyed by question title.",
    scope: RESPONSES_SCOPE,
    input: { form_id: FormId, response_id: z.string(), include_raw: z.boolean().default(false) },
    handler: async (a, { g }) => {
      const [form, r] = await Promise.all([
        g.get<AnyRec>(`${API.forms}/forms/${enc(a.form_id)}`),
        g.get<AnyRec>(`${API.forms}/forms/${enc(a.form_id)}/responses/${enc(a.response_id)}`),
      ]);
      return { ...provenance(`forms:response:${a.form_id}`, ["answers"]), ...compactResponse(r, questionTitles(form), a.include_raw) };
    },
  }),

  tool({
    name: "forms_create_form",
    description:
      "Create a Google Form with an optional description and questions (short_text, paragraph, multiple_choice, checkboxes, dropdown, linear_scale, date, time), then publish it so it accepts responses (publish=true). Returns formId, responderUri (share this link), editUrl and the created items. The form lands in the Drive root of the signed-in account.",
    scope: BODY_SCOPE,
    write: true,
    destructive: false,
    input: {
      title: z.string().describe("Form title shown to respondents"),
      document_title: z.string().optional().describe("File name in Drive (defaults to title)"),
      description: z.string().optional().describe("Text shown under the title"),
      questions: z.array(Question).optional().describe("Questions to create, in order"),
      publish: z.boolean().default(true).describe("true (default): the form is published and accepts responses immediately; false: created unpublished (forms.create unpublished=true) — publish later with forms_update_publish_settings"),
    },
    handler: async (a, { g }) => {
      // forms.create publishes by default; `unpublished=true` creates a draft that does not accept responses.
      const created = await g.post<AnyRec>(`${API.forms}/forms`, { info: { title: a.title, documentTitle: a.document_title ?? a.title } }, { unpublished: !a.publish });
      const id = created.formId as string;
      const requests: AnyRec[] = [];
      if (a.description) requests.push({ updateFormInfo: { info: { description: a.description }, updateMask: "description" } });
      (a.questions ?? []).forEach((q, i) => requests.push({ createItem: { item: questionToItem(q), location: { index: i } } }));
      let form: AnyRec = created;
      if (requests.length) {
        const r = await g.post<AnyRec>(`${API.forms}/forms/${enc(id)}:batchUpdate`, { requests, includeFormInResponse: true });
        form = r.form ?? form;
      }
      const publishSettings: AnyRec | undefined = form.publishSettings ?? created.publishSettings;
      audit("forms_create_form", { form: id, title: a.title, questions: a.questions?.length ?? 0, publish: a.publish });
      return {
        formId: id,
        title: form.info?.title,
        documentTitle: form.info?.documentTitle ?? created.info?.documentTitle,
        responderUri: form.responderUri ?? created.responderUri,
        editUrl: editUrl(id),
        publishSettings,
        published: a.publish,
        items: ((form.items ?? []) as AnyRec[]).map(compactItem),
      };
    },
  }),

  tool({
    name: "forms_add_questions",
    description: "Append questions to an existing form (same question shape as forms_create_form). By default they go after the last item; pass at_index to insert at a 0-based position instead. Returns the new itemIds/questionIds.",
    scope: BODY_SCOPE,
    write: true,
    destructive: false,
    input: { form_id: FormId, questions: Questions, at_index: z.number().int().min(0).optional().describe("0-based insert position (default: end of form)") },
    handler: async (a, { g }) => {
      let base: number;
      if (a.at_index === undefined) {
        const f = await g.get<AnyRec>(`${API.forms}/forms/${enc(a.form_id)}`);
        base = (f.items ?? []).length;
      } else base = a.at_index;
      const requests = a.questions.map((q, i) => ({ createItem: { item: questionToItem(q), location: { index: base + i } } }));
      const r = await g.post<AnyRec>(`${API.forms}/forms/${enc(a.form_id)}:batchUpdate`, { requests });
      audit("forms_add_questions", { form: a.form_id, count: a.questions.length, atIndex: base });
      return {
        formId: a.form_id,
        added: ((r.replies ?? []) as AnyRec[]).map((rep, i) => ({ index: base + i, title: a.questions[i]?.title, itemId: rep.createItem?.itemId, questionIds: rep.createItem?.questionId })),
      };
    },
  }),

  tool({
    name: "forms_update_form",
    description: "Update a form's title and/or description (the Drive file name is unchanged — rename it via Drive).",
    scope: BODY_SCOPE,
    write: true,
    idempotent: true,
    input: { form_id: FormId, title: z.string().optional(), description: z.string().optional() },
    handler: async (a, { g }) => {
      const info: AnyRec = {};
      const mask: string[] = [];
      if (a.title !== undefined) {
        info.title = a.title;
        mask.push("title");
      }
      if (a.description !== undefined) {
        info.description = a.description;
        mask.push("description");
      }
      if (!mask.length) throw new Error("Provide title and/or description to update");
      const r = await g.post<AnyRec>(`${API.forms}/forms/${enc(a.form_id)}:batchUpdate`, {
        requests: [{ updateFormInfo: { info, updateMask: mask.join(",") } }],
        includeFormInResponse: true,
      });
      audit("forms_update_form", { form: a.form_id, fields: mask });
      return { formId: a.form_id, title: r.form?.info?.title ?? a.title, description: r.form?.info?.description ?? a.description };
    },
  }),

  tool({
    name: "forms_delete_item",
    description: "Delete an item (question, section break, text, image, video) by its 0-based index (see forms_get_form item order). Irreversible — existing answers to that question stay in responses but the question is gone.",
    scope: BODY_SCOPE,
    write: true,
    destructive: true,
    idempotent: true,
    input: { form_id: FormId, item_index: z.number().int().min(0).describe("0-based item index from forms_get_form") },
    handler: async (a, { g }) => {
      await g.post(`${API.forms}/forms/${enc(a.form_id)}:batchUpdate`, { requests: [{ deleteItem: { location: { index: a.item_index } } }] });
      audit("forms_delete_item", { form: a.form_id, index: a.item_index });
      return { deleted: true, formId: a.form_id, itemIndex: a.item_index };
    },
  }),

  tool({
    name: "forms_update_publish_settings",
    description:
      "Publish/unpublish a form and open/close it for responses. Unpublishing also stops accepting responses; accepting responses requires the form to be published. Legacy forms (created before publish states existed) reject this with 400.",
    scope: BODY_SCOPE,
    write: true,
    idempotent: true,
    input: {
      form_id: FormId,
      is_published: z.boolean().default(true).describe("false = unpublished (responders see 'not accepting')"),
      is_accepting_responses: z.boolean().default(true),
    },
    handler: async (a, { g }) => {
      // Google forces isAcceptingResponses=false on unpublished forms; coerce instead of rejecting the plain "unpublish" call.
      const accepting = a.is_published && a.is_accepting_responses;
      const r = await g.post<AnyRec>(`${API.forms}/forms/${enc(a.form_id)}:setPublishSettings`, {
        publishSettings: { publishState: { isPublished: a.is_published, isAcceptingResponses: accepting } },
        updateMask: "publishState",
      });
      audit("forms_update_publish_settings", { form: a.form_id, isPublished: a.is_published, isAcceptingResponses: accepting });
      return { formId: r.formId ?? a.form_id, publishSettings: r.publishSettings };
    },
  }),

  tool({
    name: "forms_batch_update_form",
    description:
      "Run raw forms.batchUpdate requests for anything the simpler tools don't cover: createItem (any Item incl. fileUpload/grid/rating, image/video/text items), deleteItem, moveItem {originalLocation,newLocation}, updateItem {item, location, updateMask}, updateFormInfo, updateSettings (quiz mode: {settings:{quizSettings:{isQuiz:true}},updateMask:'quizSettings.isQuiz'}). Locations are 0-based indexes. Returns replies (new itemIds/questionIds).",
    scope: BODY_SCOPE,
    write: true,
    idempotent: true,
    input: {
      form_id: FormId,
      requests: z.array(JsonObject).min(1).describe("Array of Request objects, e.g. [{moveItem:{originalLocation:{index:2},newLocation:{index:0}}}]"),
      include_form_in_response: z.boolean().default(false).describe("Return the updated (compact) form as well"),
    },
    handler: async (a, { g }) => {
      const r = await g.post<AnyRec>(`${API.forms}/forms/${enc(a.form_id)}:batchUpdate`, { requests: a.requests, includeFormInResponse: a.include_form_in_response });
      audit("forms_batch_update_form", { form: a.form_id, requests: a.requests.map((q) => Object.keys(q)[0]) });
      return { replies: r.replies ?? [], writeControl: r.writeControl, form: a.include_form_in_response && r.form ? compactForm(r.form) : undefined };
    },
  }),
];
