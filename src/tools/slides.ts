/**
 * Google Slides tools: read a deck compactly, add/edit slides, raw batchUpdate, export.
 * API: https://slides.googleapis.com/v1 (+ Drive for moving/exporting).
 */
import { z } from "zod";
import { API } from "../google/client.js";
import { tool, enc, JsonObject, audit, bytesToBase64, provenance, type AnyRec } from "./_shared.js";
import { moveToFolder } from "./_drive.js";

const SCOPE = "https://www.googleapis.com/auth/presentations";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";
const MAX_EXPORT_BYTES = 3 * 1024 * 1024;

const LAYOUTS = ["BLANK", "TITLE", "TITLE_AND_BODY", "TITLE_ONLY", "SECTION_HEADER", "TITLE_AND_TWO_COLUMNS", "ONE_COLUMN_TEXT", "MAIN_POINT", "BIG_NUMBER", "CAPTION_ONLY"] as const;
type Layout = (typeof LAYOUTS)[number];

/** Placeholders each predefined layout exposes, in order (per-type index = position among same-type entries). */
const LAYOUT_PLACEHOLDERS: Record<Layout, string[]> = {
  BLANK: [],
  TITLE: ["CENTERED_TITLE", "SUBTITLE"],
  TITLE_AND_BODY: ["TITLE", "BODY"],
  TITLE_ONLY: ["TITLE"],
  SECTION_HEADER: ["TITLE"],
  TITLE_AND_TWO_COLUMNS: ["TITLE", "BODY", "BODY"],
  ONE_COLUMN_TEXT: ["TITLE", "BODY"],
  MAIN_POINT: ["TITLE"],
  BIG_NUMBER: ["TITLE", "BODY"],
  CAPTION_ONLY: ["BODY"],
};
const TITLE_TYPES = new Set(["TITLE", "CENTERED_TITLE"]);
const BODY_TYPES = new Set(["BODY", "SUBTITLE"]);

/** Field masks that keep page reads small (no text styles, no rendering hints). */
const NOTES_FIELDS = "notesPage(notesProperties.speakerNotesObjectId,pageElements(objectId,shape(placeholder.type,text.textElements.textRun.content)))";
const ELEMENT_FIELDS =
  "objectId,shape(shapeType,placeholder,text.textElements.textRun.content),table(rows,columns,tableRows.tableCells.text.textElements.textRun.content),image(contentUrl,sourceUrl),video(url,id,source),line.lineType,elementGroup,sheetsChart(spreadsheetId,chartId),wordArt.renderedText";
const SLIDE_FIELDS = (withElements: boolean) => `objectId,slideProperties(layoutObjectId,${NOTES_FIELDS})${withElements ? `,pageElements(${ELEMENT_FIELDS})` : ""}`;
const SLIDE_DETAIL_FIELDS = `objectId,slideProperties(layoutObjectId,${NOTES_FIELDS}),pageElements(title,description,transform,size,${ELEMENT_FIELDS})`;

const presUrl = (id: string) => `${API.slides}/presentations/${enc(id)}`;
const randomId = (prefix: string) => `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;

/** Plain text of a TextContent holder (shape or table cell). */
function shapeText(holder: AnyRec | undefined): string {
  return ((holder?.text?.textElements ?? []) as AnyRec[]).map((t) => t.textRun?.content ?? "").join("");
}

function tableRows(table: AnyRec): string[][] {
  return ((table.tableRows ?? []) as AnyRec[]).map((r) => ((r.tableCells ?? []) as AnyRec[]).map((c) => shapeText(c).trim()));
}

/** Text of a page element: shape text, table rows ('a | b'), '[image] url', '[video]', group children joined. */
function elementText(el: AnyRec, withMedia = true): string {
  if (el.shape) return shapeText(el.shape);
  if (el.table)
    return tableRows(el.table)
      .map((r) => r.join(" | "))
      .join("\n");
  if (el.elementGroup)
    return ((el.elementGroup.children ?? []) as AnyRec[])
      .map((c) => elementText(c, withMedia).trim())
      .filter(Boolean)
      .join("\n");
  if (el.wordArt) return el.wordArt.renderedText ?? "";
  if (!withMedia) return "";
  if (el.image) return "[image]" + (el.image.contentUrl ? ` ${el.image.contentUrl}` : "");
  if (el.video) return "[video]" + (el.video.url ? ` ${el.video.url}` : "");
  if (el.sheetsChart) return "[chart]";
  return "";
}

function elementType(el: AnyRec): string {
  if (el.shape) return el.shape.shapeType ?? "shape";
  if (el.table) return "table";
  if (el.image) return "image";
  if (el.video) return "video";
  if (el.line) return "line";
  if (el.elementGroup) return "group";
  if (el.sheetsChart) return "chart";
  if (el.wordArt) return "wordArt";
  return "unknown";
}

function compactElement(el: AnyRec, detail: boolean): AnyRec {
  const out: AnyRec = { objectId: el.objectId, type: elementType(el), placeholder: el.shape?.placeholder?.type };
  if (el.table) {
    out.rows = el.table.rows;
    out.cols = el.table.columns;
    if (detail) out.cells = tableRows(el.table);
    else out.text = elementText(el) || undefined;
  } else if (el.elementGroup && detail) {
    out.children = ((el.elementGroup.children ?? []) as AnyRec[]).map((c) => compactElement(c, true));
  } else {
    out.text = elementText(el) || undefined;
  }
  if (detail) {
    if (el.title) out.title = el.title;
    if (el.description) out.description = el.description;
    const t = el.transform;
    if (t) out.transform = { translateX: t.translateX, translateY: t.translateY, scaleX: t.scaleX, scaleY: t.scaleY, shearX: t.shearX, shearY: t.shearY, unit: t.unit };
    const s = el.size;
    if (s) out.size = { width: s.width?.magnitude, height: s.height?.magnitude, unit: s.width?.unit ?? s.height?.unit };
  }
  return out;
}

/** Speaker notes text: the BODY placeholder shape on the slide's notes page. */
function notesText(slide: AnyRec): string | undefined {
  const els = (slide.slideProperties?.notesPage?.pageElements ?? []) as AnyRec[];
  const body = els.find((e) => e.shape?.placeholder?.type === "BODY");
  const t = body ? shapeText(body.shape).trim() : "";
  return t || undefined;
}

/** { index, objectId, layout, notes, elements[] } — elements omitted when includeElements=false. */
function compactSlide(slide: AnyRec, i: number | undefined, includeElements: boolean, detail = false): AnyRec {
  return {
    index: i === undefined ? undefined : i + 1,
    objectId: slide.objectId,
    layout: slide.slideProperties?.layoutObjectId,
    notes: notesText(slide),
    elements: includeElements ? ((slide.pageElements ?? []) as AnyRec[]).map((e) => compactElement(e, detail)) : undefined,
  };
}

export const slidesTools = [
  tool({
    name: "slides_get_presentation",
    description:
      "Presentation overview: title, locale, page size, revisionId, slide count, layouts (objectId + display name — needed for custom layouts) and every slide as {index, objectId, layout, notes, elements[{objectId, type, placeholder, text}]}. presentation_id is from the URL /presentation/d/<id>/. Set include_elements=false for a much cheaper slide list; use slides_read_presentation when you only need the words.",
    scope: SCOPE,
    input: {
      presentation_id: z.string().describe("Presentation id (from the URL /presentation/d/<id>/)"),
      include_elements: z.boolean().default(true).describe("Include each slide's page elements with their text"),
    },
    handler: async (a, { g }) => {
      const r = await g.get<AnyRec>(presUrl(a.presentation_id), {
        fields: `presentationId,title,locale,pageSize,revisionId,masters.objectId,layouts(objectId,layoutProperties(displayName,name)),slides(${SLIDE_FIELDS(a.include_elements)})`,
      });
      const slides = (r.slides ?? []) as AnyRec[];
      return {
        ...provenance(`slides:presentation:${a.presentation_id}`, ["title", "slides[].notes", "slides[].elements[].text"]),
        presentationId: r.presentationId,
        title: r.title,
        locale: r.locale,
        pageSize: r.pageSize ? { width: r.pageSize.width?.magnitude, height: r.pageSize.height?.magnitude, unit: r.pageSize.width?.unit ?? r.pageSize.height?.unit } : undefined,
        revisionId: r.revisionId,
        slideCount: slides.length,
        masters: (r.masters ?? []).length,
        layouts: ((r.layouts ?? []) as AnyRec[]).map((l) => ({ objectId: l.objectId, name: l.layoutProperties?.displayName ?? l.layoutProperties?.name })),
        slides: slides.map((s, i) => compactSlide(s, i, a.include_elements)),
      };
    },
  }),

  tool({
    name: "slides_read_presentation",
    description:
      "Cheapest way to read a deck: per slide {index, objectId, title (first TITLE/CENTERED_TITLE placeholder), text (all shape/table text joined with newlines, images/videos skipped), notes (speaker notes)}. No object ids for individual elements — use slides_get_presentation for those.",
    scope: SCOPE,
    input: { presentation_id: z.string() },
    handler: async (a, { g }) => {
      const r = await g.get<AnyRec>(presUrl(a.presentation_id), { fields: `presentationId,title,slides(${SLIDE_FIELDS(true)})` });
      const slides = (r.slides ?? []) as AnyRec[];
      return {
        ...provenance(`slides:presentation:${a.presentation_id}`, ["slides[].title", "slides[].text", "slides[].notes"]),
        presentationId: r.presentationId,
        title: r.title,
        slideCount: slides.length,
        slides: slides.map((s, i) => {
          const els = (s.pageElements ?? []) as AnyRec[];
          const titleEl = els.find((e) => TITLE_TYPES.has(e.shape?.placeholder?.type));
          return {
            index: i + 1,
            objectId: s.objectId,
            title: titleEl ? shapeText(titleEl.shape).trim() || undefined : undefined,
            text: els
              .map((e) => elementText(e, false).trim())
              .filter(Boolean)
              .join("\n"),
            notes: notesText(s),
          };
        }),
      };
    },
  }),

  tool({
    name: "slides_get_slide",
    description:
      "One slide (page) in full detail: every element with objectId, type, placeholder, text (tables as cells[][], groups as children[]), transform (translateX/Y, scaleX/Y in EMU — 914400 EMU = 1 inch) and size (width/height), plus layout id and speaker notes. page_object_id is a slide objectId from slides_get_presentation (layouts/masters/notes pages work too).",
    scope: SCOPE,
    input: { presentation_id: z.string(), page_object_id: z.string().describe("Slide objectId (e.g. 'p' or 'g1234abcd_0_1')") },
    handler: async (a, { g }) => {
      const page = await g.get<AnyRec>(`${presUrl(a.presentation_id)}/pages/${enc(a.page_object_id)}`, { fields: SLIDE_DETAIL_FIELDS });
      return { ...compactSlide(page, undefined, true, true), speakerNotesObjectId: page.slideProperties?.notesPage?.notesProperties?.speakerNotesObjectId };
    },
  }),

  tool({
    name: "slides_get_thumbnail",
    description: "PNG thumbnail of a slide: returns a contentUrl (valid ~30 minutes, no auth needed to fetch) plus width/height. Generating it counts as an expensive read against the Slides quota.",
    scope: SCOPE,
    input: {
      presentation_id: z.string(),
      page_object_id: z.string().describe("Slide objectId"),
      size: z.enum(["SMALL", "MEDIUM", "LARGE"]).default("MEDIUM").describe("SMALL ≈ 200px, MEDIUM ≈ 800px, LARGE ≈ 1600px wide"),
    },
    handler: async (a, { g }) => {
      const r = await g.get<AnyRec>(`${presUrl(a.presentation_id)}/pages/${enc(a.page_object_id)}/thumbnail`, {
        "thumbnailProperties.thumbnailSize": a.size,
        "thumbnailProperties.mimeType": "PNG",
      });
      return { contentUrl: r.contentUrl, width: r.width, height: r.height, expires: "~30 minutes" };
    },
  }),

  tool({
    name: "slides_create_presentation",
    description: "Create a new Google Slides presentation / slide deck (default theme, one blank title slide). Optionally move it into a Drive folder (needs the drive scope). Returns id, URL and the first slide's objectId.",
    scope: SCOPE,
    write: true,
    destructive: false,
    input: {
      title: z.string(),
      folder_id: z.string().optional().describe("Drive folder to create it in"),
    },
    handler: async (a, { g }) => {
      const r = await g.post<AnyRec>(`${API.slides}/presentations`, { title: a.title }, { fields: "presentationId,title,slides.objectId" });
      const id = r.presentationId as string;
      if (a.folder_id) {
        await moveToFolder(g, id, a.folder_id);
      }
      audit("slides_create_presentation", { presentation: id, title: a.title });
      return { presentationId: id, title: r.title, url: `https://docs.google.com/presentation/d/${id}/edit`, firstSlideId: r.slides?.[0]?.objectId };
    },
  }),

  tool({
    name: "slides_add_slide",
    description:
      "Append (or insert at insertion_index) a slide using a predefined layout and fill its title/body placeholders and speaker notes in one go. Body '\\n' separated lines become paragraphs (no automatic bullets — use slides_batch_update_presentation createParagraphBullets for bullets). Placeholders per layout: TITLE→CENTERED_TITLE+SUBTITLE, TITLE_AND_BODY/ONE_COLUMN_TEXT/BIG_NUMBER→TITLE+BODY, TITLE_AND_TWO_COLUMNS→TITLE+2×BODY, TITLE_ONLY/SECTION_HEADER/MAIN_POINT→TITLE, CAPTION_ONLY→BODY, BLANK→none. Predefined layouts exist in the default theme; custom themes may lack some (then use slides_batch_update_presentation createSlide with slideLayoutReference.layoutId from slides_get_presentation). Returns the new slide id and the title/body object ids for later edits.",
    scope: SCOPE,
    write: true,
    destructive: false,
    input: {
      presentation_id: z.string(),
      layout: z.enum(LAYOUTS).default("TITLE_AND_BODY"),
      title: z.string().optional().describe("Text for the TITLE/CENTERED_TITLE placeholder"),
      body: z.string().optional().describe("Text for the first BODY/SUBTITLE placeholder; '\\n' separates paragraphs"),
      insertion_index: z.number().int().min(0).optional().describe("0-based position (omit to append at the end)"),
      speaker_notes: z.string().optional(),
    },
    handler: async (a, { g }) => {
      const placeholders = LAYOUT_PLACEHOLDERS[a.layout];
      const titleType = placeholders.find((p) => TITLE_TYPES.has(p));
      const bodyType = placeholders.find((p) => BODY_TYPES.has(p));
      if (a.title && !titleType) throw new Error(`Layout ${a.layout} has no title placeholder — pick another layout or add a text box via slides_batch_update_presentation createShape`);
      if (a.body && !bodyType) throw new Error(`Layout ${a.layout} has no body placeholder — pick another layout or add a text box via slides_batch_update_presentation createShape`);
      const slideId = randomId("slide");
      const titleId = titleType ? `${slideId}_title` : undefined;
      const bodyId = bodyType ? `${slideId}_body` : undefined;
      const mappings: AnyRec[] = [];
      if (titleType) mappings.push({ layoutPlaceholder: { type: titleType, index: 0 }, objectId: titleId });
      if (bodyType) mappings.push({ layoutPlaceholder: { type: bodyType, index: 0 }, objectId: bodyId });
      const requests: AnyRec[] = [
        {
          createSlide: {
            objectId: slideId,
            insertionIndex: a.insertion_index,
            slideLayoutReference: { predefinedLayout: a.layout },
            placeholderIdMappings: mappings.length ? mappings : undefined,
          },
        },
      ];
      if (a.title) requests.push({ insertText: { objectId: titleId, text: a.title, insertionIndex: 0 } });
      if (a.body) requests.push({ insertText: { objectId: bodyId, text: a.body, insertionIndex: 0 } });
      await g.post<AnyRec>(`${presUrl(a.presentation_id)}:batchUpdate`, { requests });
      let notesId: string | undefined;
      if (a.speaker_notes) {
        const page = await g.get<AnyRec>(`${presUrl(a.presentation_id)}/pages/${enc(slideId)}`, { fields: "slideProperties.notesPage.notesProperties.speakerNotesObjectId" });
        notesId = page.slideProperties?.notesPage?.notesProperties?.speakerNotesObjectId;
        if (!notesId) throw new Error(`Slide ${slideId} was created but its notes page has no speaker-notes shape id; add notes via slides_batch_update_presentation`);
        await g.post(`${presUrl(a.presentation_id)}:batchUpdate`, { requests: [{ insertText: { objectId: notesId, text: a.speaker_notes, insertionIndex: 0 } }] });
      }
      audit("slides_add_slide", { presentation: a.presentation_id, slide: slideId, layout: a.layout });
      return { slideId, titleId, bodyId, speakerNotesObjectId: notesId };
    },
  }),

  tool({
    name: "slides_insert_text",
    description:
      "Insert text into a shape or table cell at a character index (0 = start; text inserted at the end must use the current length — read it with slides_get_slide). '\\n' starts a new paragraph. For a table cell pass cell_row/cell_column (0-based). Inserted text inherits the style at the insertion point.",
    scope: SCOPE,
    write: true,
    destructive: false,
    input: {
      presentation_id: z.string(),
      object_id: z.string().describe("Shape objectId (or table objectId with cell_row/cell_column)"),
      text: z.string(),
      insertion_index: z.number().int().min(0).default(0),
      cell_row: z.number().int().min(0).optional().describe("Table only: 0-based row"),
      cell_column: z.number().int().min(0).optional().describe("Table only: 0-based column"),
    },
    handler: async (a, { g }) => {
      if ((a.cell_row === undefined) !== (a.cell_column === undefined)) throw new Error("cell_row and cell_column must be given together");
      const req: AnyRec = { objectId: a.object_id, text: a.text, insertionIndex: a.insertion_index };
      if (a.cell_row !== undefined) req.cellLocation = { rowIndex: a.cell_row, columnIndex: a.cell_column };
      await g.post(`${presUrl(a.presentation_id)}:batchUpdate`, { requests: [{ insertText: req }] });
      audit("slides_insert_text", { presentation: a.presentation_id, object: a.object_id, chars: a.text.length });
      return { inserted: true, objectId: a.object_id, chars: a.text.length };
    },
  }),

  tool({
    name: "slides_replace_text",
    description: "Replace every occurrence of a string across the deck (or only on the given slides) — the standard way to fill a template. Matches inside shapes and table cells; text style at the match is kept.",
    scope: SCOPE,
    write: true,
    idempotent: true,
    input: {
      presentation_id: z.string(),
      find: z.string().describe("Literal text to find, e.g. '{{client}}'"),
      replace: z.string(),
      match_case: z.boolean().default(true),
      page_object_ids: z.array(z.string()).optional().describe("Limit to these slide objectIds (default: all slides)"),
    },
    handler: async (a, { g }) => {
      const r = await g.post<AnyRec>(`${presUrl(a.presentation_id)}:batchUpdate`, {
        requests: [{ replaceAllText: { containsText: { text: a.find, matchCase: a.match_case }, replaceText: a.replace, pageObjectIds: a.page_object_ids } }],
      });
      audit("slides_replace_text", { presentation: a.presentation_id, pages: a.page_object_ids?.length ?? "all" });
      return { occurrencesChanged: r.replies?.[0]?.replaceAllText?.occurrencesChanged ?? 0 };
    },
  }),

  tool({
    name: "slides_delete_object",
    description: "Delete a page element (shape, image, table, line, group) or a whole slide by objectId. Irreversible. Deleting the only slide in a deck fails.",
    scope: SCOPE,
    write: true,
    destructive: true,
    idempotent: true,
    input: { presentation_id: z.string(), object_id: z.string().describe("Element or slide objectId") },
    handler: async (a, { g }) => {
      await g.post(`${presUrl(a.presentation_id)}:batchUpdate`, { requests: [{ deleteObject: { objectId: a.object_id } }] });
      audit("slides_delete_object", { presentation: a.presentation_id, object: a.object_id });
      return { deleted: true, objectId: a.object_id };
    },
  }),

  tool({
    name: "slides_batch_update_presentation",
    description:
      "Run raw presentations.batchUpdate requests — the full Slides API surface: createSlide, insertText, deleteText, replaceAllText, createShape (TEXT_BOX etc. with elementProperties{pageObjectId, size, transform}), createImage (public/Drive url), createTable, insertTableRows/Columns, updateTextStyle, updateParagraphStyle, createParagraphBullets, updateShapeProperties, updatePageElementTransform, updatePageProperties (background), deleteObject, updateSlidesPosition, duplicateObject, replaceAllShapesWithImage, replaceAllShapesWithSheetsChart, groupObjects. Sizes/positions are in EMU (914400 = 1 inch; default 16:9 page is 9144000 × 5143500). Returns one reply per request (created objectIds etc.).",
    scope: SCOPE,
    write: true,
    idempotent: true,
    input: {
      presentation_id: z.string(),
      requests: z.array(JsonObject).min(1).describe("Array of Request objects, e.g. [{createShape:{objectId:'box1',shapeType:'TEXT_BOX',elementProperties:{pageObjectId:'p',size:{width:{magnitude:3000000,unit:'EMU'},height:{magnitude:1000000,unit:'EMU'}},transform:{scaleX:1,scaleY:1,translateX:500000,translateY:500000,unit:'EMU'}}}},{insertText:{objectId:'box1',text:'Hello'}}]"),
      required_revision_id: z.string().optional().describe("Fail if the presentation changed since this revisionId (from slides_get_presentation)"),
    },
    handler: async (a, { g }) => {
      const body: AnyRec = { requests: a.requests };
      if (a.required_revision_id) body.writeControl = { requiredRevisionId: a.required_revision_id };
      const r = await g.post<AnyRec>(`${presUrl(a.presentation_id)}:batchUpdate`, body);
      audit("slides_batch_update_presentation", { presentation: a.presentation_id, requests: a.requests.map((q) => Object.keys(q)[0]) });
      return { presentationId: r.presentationId ?? a.presentation_id, replies: r.replies ?? [], revisionId: r.writeControl?.requiredRevisionId };
    },
  }),

  tool({
    name: "slides_export_presentation",
    description:
      "Export a presentation through Drive as plain text (default — all slide text, cheap), PDF or .pptx. text/plain comes back as text; binary formats come back base64-encoded (max 3 MB — larger decks must be downloaded via Drive). Needs the drive scope.",
    scope: DRIVE_SCOPE,
    input: {
      presentation_id: z.string(),
      mime_type: z.enum(["application/pdf", "application/vnd.openxmlformats-officedocument.presentationml.presentation", "text/plain"]).default("text/plain"),
      as: z.enum(["base64", "text"]).optional().describe("Return encoding: default text for text/plain and base64 for binary formats; as=text is rejected for binary formats"),
    },
    handler: async (a, { g }) => {
      const isText = a.mime_type === "text/plain";
      const url = `${API.drive}/files/${enc(a.presentation_id)}/export`;
      if (isText && a.as !== "base64") {
        const text = await g.request<string>("GET", url, { query: { mimeType: a.mime_type }, responseType: "text" });
        return { presentationId: a.presentation_id, mimeType: a.mime_type, encoding: "text", chars: text.length, content: text };
      }
      if (!isText && a.as === "text") throw new Error(`${a.mime_type} is binary — use as=base64 (or mime_type text/plain)`);
      const buf = await g.request<ArrayBuffer>("GET", url, { query: { mimeType: a.mime_type }, responseType: "arrayBuffer" });
      if (buf.byteLength > MAX_EXPORT_BYTES) throw new Error(`Export is ${(buf.byteLength / 1048576).toFixed(1)} MB (limit 3 MB) — export as text/plain or download it via Drive`);
      return { presentationId: a.presentation_id, mimeType: a.mime_type, encoding: "base64", bytes: buf.byteLength, content: bytesToBase64(new Uint8Array(buf)) };
    },
  }),
];
