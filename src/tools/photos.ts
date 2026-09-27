/**
 * Google Photos tools: Library API (app-created albums/media, uploads) and the
 * Photos Picker API (user-selected media from anywhere in the library).
 * APIs: https://photoslibrary.googleapis.com/v1 and https://photospicker.googleapis.com/v1
 * (+ Drive for the drive-source upload).
 *
 * IMPORTANT (since 2025-03-31): the Photos Library API only returns media items
 * and albums CREATED BY THIS APP — the scopes are photoslibrary.readonly.appcreateddata /
 * appendonly / edit.appcreateddata. photos_list_albums / photos_search_media_items
 * will NOT show photos the user took with their phone. To access any photo in the
 * user's library use the Picker flow:
 *   photos_create_picker_session → the user opens pickerUri in a browser and selects
 *   → photos_get_picker_session (poll until mediaItemsSet) → photos_list_picked_media_items
 *   → (optional) photos_download_media_item.
 * baseUrls (both APIs) expire after ~60 minutes; append =w2048-h2048 for a sized
 * image, =d for the original bytes, =dv for a video download.
 */
import { z } from "zod";
import { API } from "../google/client.js";
import { tool, enc, listResult, PageSize, PageToken, audit, base64ToBytes, bytesToBase64, MAX_OUTPUT_CHARS, type AnyRec } from "./_shared.js";

const SCOPE_READ = "https://www.googleapis.com/auth/photoslibrary.readonly.appcreateddata";
const SCOPE_APPEND = "https://www.googleapis.com/auth/photoslibrary.appendonly";
const SCOPE_EDIT = "https://www.googleapis.com/auth/photoslibrary.edit.appcreateddata";
const SCOPE_PICKER = "https://www.googleapis.com/auth/photospicker.mediaitems.readonly";

const APP_DATA_NOTE = "Only media/albums CREATED BY THIS APP are visible (Library API restriction since 2025-03-31); for any other library photo use photos_create_picker_session.";
const BASE_URL_NOTE = "baseUrl expires after ~60 min; append =w2048-h2048 (or any =w{W}-h{H}) for an image, =d for original bytes, =dv to download a video.";
const PICKER_BASE_URL_NOTE = "mediaFile.baseUrl needs an 'Authorization: Bearer <access token>' header and a =w{W}-h{H} or =d suffix (expires ~60 min) — or call photos_download_media_item with it.";
const PICKER_INSTRUCTION = "Open pickerUri in a browser, select photos, click Done, then call photos_get_picker_session (poll until mediaItemsSet=true) and photos_list_picked_media_items.";

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
  mp4: "video/mp4",
  mov: "video/quicktime",
  m4v: "video/x-m4v",
  webm: "video/webm",
  avi: "video/x-msvideo",
  mkv: "video/x-matroska",
};

/** Guess a mime type from a file name's extension (default application/octet-stream). */
function guessMime(fileName: string): string {
  const ext = fileName.toLowerCase().split(".").pop() ?? "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

/** "YYYY-MM-DD" → Photos API Date {year, month, day}. */
function toApiDate(s: string, what: string): { year: number; month: number; day: number } {
  const m = DATE_RE.exec(s);
  if (!m) throw new Error(`${what} must be YYYY-MM-DD (got '${s}')`);
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

/** Compact a Library API MediaItem. */
function compactMediaItem(m: AnyRec | undefined): AnyRec | undefined {
  if (!m) return undefined;
  const md = m.mediaMetadata ?? {};
  const p = md.photo;
  const v = md.video;
  return {
    id: m.id,
    filename: m.filename,
    mimeType: m.mimeType,
    description: m.description,
    productUrl: m.productUrl,
    baseUrl: m.baseUrl,
    baseUrlNote: m.baseUrl ? BASE_URL_NOTE : undefined,
    created: md.creationTime,
    width: md.width !== undefined ? Number(md.width) : undefined,
    height: md.height !== undefined ? Number(md.height) : undefined,
    photo: p ? { cameraMake: p.cameraMake, cameraModel: p.cameraModel, focalLength: p.focalLength, apertureFNumber: p.apertureFNumber, isoEquivalent: p.isoEquivalent } : undefined,
    video: v ? { fps: v.fps, status: v.status } : undefined,
    contributorInfo: m.contributorInfo ? { displayName: m.contributorInfo.displayName, profilePictureBaseUrl: m.contributorInfo.profilePictureBaseUrl } : undefined,
  };
}

/** Compact a Library API Album. */
function compactAlbum(al: AnyRec | undefined): AnyRec | undefined {
  if (!al) return undefined;
  return {
    id: al.id,
    title: al.title,
    productUrl: al.productUrl,
    mediaItemsCount: al.mediaItemsCount !== undefined ? Number(al.mediaItemsCount) : undefined,
    coverPhotoBaseUrl: al.coverPhotoBaseUrl,
    coverPhotoMediaItemId: al.coverPhotoMediaItemId,
    isWriteable: al.isWriteable,
  };
}

/** Compact a Picker API PickedMediaItem. */
function compactPickedItem(m: AnyRec): AnyRec {
  const f = m.mediaFile ?? {};
  const meta = f.mediaFileMetadata;
  return {
    id: m.id,
    createTime: m.createTime,
    type: m.type,
    mediaFile: {
      baseUrl: f.baseUrl,
      mimeType: f.mimeType,
      filename: f.filename,
      mediaFileMetadata: meta
        ? {
            width: meta.width,
            height: meta.height,
            cameraMake: meta.cameraMake,
            cameraModel: meta.cameraModel,
            photoMetadata: meta.photoMetadata,
            videoMetadata: meta.videoMetadata,
          }
        : undefined,
    },
  };
}

/** Compact a Picker API Session. */
function compactSession(s: AnyRec): AnyRec {
  return {
    id: s.id,
    pickerUri: s.pickerUri,
    pollingConfig: s.pollingConfig,
    expireTime: s.expireTime,
    mediaItemsSet: !!s.mediaItemsSet,
  };
}

export const photosTools = [
  // ---- Library API (app-created data only) ------------------------------------
  tool({
    name: "photos_list_albums",
    description: `List albums in the user's Google Photos library that were created by this app (excludeNonAppCreatedData=true). ${APP_DATA_NOTE} Returns id, title, productUrl, mediaItemsCount, coverPhotoBaseUrl, isWriteable.`,
    scope: SCOPE_READ,
    input: {
      page_size: PageSize(50, 50),
      page_token: PageToken,
    },
    handler: async (a, { g }) => {
      const r = await g.get<AnyRec>(`${API.photos}/albums`, { pageSize: a.page_size, pageToken: a.page_token, excludeNonAppCreatedData: true });
      return listResult((r.albums ?? []).map((al: AnyRec) => compactAlbum(al)), r.nextPageToken, { note: APP_DATA_NOTE });
    },
  }),

  tool({
    name: "photos_get_album",
    description: `Get one album by id (must have been created by this app). ${APP_DATA_NOTE}`,
    scope: SCOPE_READ,
    input: { album_id: z.string().describe("Album id (from photos_list_albums / photos_create_album)") },
    handler: async (a, { g }) => compactAlbum(await g.get<AnyRec>(`${API.photos}/albums/${enc(a.album_id)}`)),
  }),

  tool({
    name: "photos_create_album",
    description: "Create a new (empty) album in the user's Google Photos library. Returns the album id/productUrl; add media with photos_upload_media_item(album_id) or photos_add_album_items.",
    scope: SCOPE_APPEND,
    write: true,
    destructive: false,
    input: { title: z.string().min(1).max(500).describe("Album title") },
    handler: async (a, { g }) => {
      const r = await g.post<AnyRec>(`${API.photos}/albums`, { album: { title: a.title } });
      audit("photos_create_album", { album: r.id, title: a.title });
      return compactAlbum(r);
    },
  }),

  tool({
    name: "photos_search_media_items",
    description:
      `Search/list media items created by this app (mediaItems:search). ${APP_DATA_NOTE} Either pass album_id (lists that album's items, no filters allowed) OR filters (date ranges / dates / content categories / media type / archived / favorites) — the API rejects album_id combined with filters. With neither, lists all app-created media newest first. ${BASE_URL_NOTE}`,
    scope: SCOPE_READ,
    input: {
      album_id: z.string().optional().describe("List items of this album (cannot be combined with filters)"),
      page_size: PageSize(25, 100),
      page_token: PageToken,
      filters: z
        .object({
          date_ranges: z.array(z.object({ start: z.string().describe("YYYY-MM-DD"), end: z.string().describe("YYYY-MM-DD (inclusive)") })).optional().describe("Up to 5 ranges (combined with `dates`)"),
          dates: z.array(z.string()).optional().describe("Exact dates YYYY-MM-DD (up to 5)"),
          content_categories: z.array(z.string()).optional().describe("Include categories: LANDSCAPES, RECEIPTS, CITYSCAPES, LANDMARKS, SELFIES, PEOPLE, PETS, WEDDINGS, BIRTHDAYS, DOCUMENTS, TRAVEL, ANIMALS, FOOD, SPORT, NIGHT, PERFORMANCES, WHITEBOARDS, SCREENSHOTS, UTILITY, ARTS, CRAFTS, FASHION, HOUSES, GARDENS, FLOWERS, HOLIDAYS (max 10)"),
          media_type: z.enum(["ALL_MEDIA", "PHOTO", "VIDEO"]).optional(),
          include_archived: z.boolean().optional().describe("Also return archived media (default false)"),
          favorites_only: z.boolean().optional().describe("Only items marked as favorite"),
        })
        .optional(),
    },
    handler: async (a, { g }) => {
      const f = a.filters;
      // Build the filter object first; only a non-empty one conflicts with album_id.
      const filters: AnyRec = {};
      if (f) {
        if (f.date_ranges?.length || f.dates?.length) {
          filters.dateFilter = {
            ranges: f.date_ranges?.map((r) => ({ startDate: toApiDate(r.start, "date_ranges[].start"), endDate: toApiDate(r.end, "date_ranges[].end") })),
            dates: f.dates?.map((d) => toApiDate(d, "dates[]")),
          };
        }
        if (f.content_categories?.length) filters.contentFilter = { includedContentCategories: f.content_categories.map((c) => c.toUpperCase()) };
        if (f.media_type) filters.mediaTypeFilter = { mediaTypes: [f.media_type] };
        if (f.include_archived === true) filters.includeArchivedMedia = true;
        if (f.favorites_only === true) filters.featureFilter = { includedFeatures: ["FAVORITES"] };
      }
      const hasFilters = Object.keys(filters).length > 0;
      if (a.album_id && hasFilters) throw new Error("album_id cannot be combined with filters (Photos API rule) — drop one of them");
      const body: AnyRec = { pageSize: a.page_size, pageToken: a.page_token };
      if (a.album_id) body.albumId = a.album_id;
      if (hasFilters) body.filters = filters;
      // The API can return empty pages with a nextPageToken (filtered searches); follow a few so callers never loop on count=0.
      let r = await g.post<AnyRec>(`${API.photos}/mediaItems:search`, body, undefined, { idempotent: true });
      for (let hops = 0; hops < 5 && !(r.mediaItems ?? []).length && r.nextPageToken; hops++) {
        r = await g.post<AnyRec>(`${API.photos}/mediaItems:search`, { ...body, pageToken: r.nextPageToken }, undefined, { idempotent: true });
      }
      const items = (r.mediaItems ?? []).map((m: AnyRec) => compactMediaItem(m));
      return listResult(items, r.nextPageToken, !items.length && r.nextPageToken ? { note: "Empty page but more pages exist (filtered searches skip through the library) — continue with page_token; stop when nextPageToken is absent." } : {});
    },
  }),

  tool({
    name: "photos_get_media_item",
    description: `Get one media item by id (must have been created by this app). ${APP_DATA_NOTE} ${BASE_URL_NOTE}`,
    scope: SCOPE_READ,
    input: { media_item_id: z.string().describe("Media item id") },
    handler: async (a, { g }) => compactMediaItem(await g.get<AnyRec>(`${API.photos}/mediaItems/${enc(a.media_item_id)}`)),
  }),

  tool({
    name: "photos_upload_media_item",
    description:
      "Upload a photo/video into the user's Google Photos library (optionally into an app-created album). Provide EXACTLY ONE source: content_base64 (raw bytes), drive_file_id (copies a Drive file — needs the drive scope) or url (public http(s) URL). Max 100 MB. Two-step: bytes → upload token → mediaItems:batchCreate. Mime type is taken from Drive metadata / the URL response, else guessed from the file_name extension. Returns the create status and the new media item. Note: content_base64 of a large file is token-expensive — prefer drive_file_id or url.",
    scope: SCOPE_APPEND,
    write: true,
    destructive: false,
    input: {
      file_name: z.string().min(1).describe("File name shown in Photos, e.g. 'sunset.jpg' (extension drives the mime-type guess)"),
      description: z.string().max(1000).optional().describe("Caption shown under the item in Photos"),
      album_id: z.string().optional().describe("Add the new item to this app-created album"),
      content_base64: z.string().optional().describe("Raw file bytes, base64 (standard alphabet)"),
      drive_file_id: z.string().optional().describe("Copy the bytes of this Drive file"),
      url: z.string().optional().describe("Public http(s) URL to fetch the bytes from"),
    },
    handler: async (a, { g }) => {
      const sources = [a.content_base64, a.drive_file_id, a.url].filter((s) => s !== undefined && s !== "");
      if (sources.length !== 1) throw new Error("Provide exactly one of content_base64, drive_file_id or url");

      // 1) obtain bytes + mime
      let bytes: Uint8Array;
      let mime: string | undefined;
      let source: string;
      if (a.content_base64) {
        source = "base64";
        bytes = base64ToBytes(a.content_base64);
      } else if (a.drive_file_id) {
        source = "drive";
        const meta = await g.get<AnyRec>(`${API.drive}/files/${enc(a.drive_file_id)}`, { fields: "id,name,mimeType,size", supportsAllDrives: true });
        if (typeof meta.mimeType === "string" && meta.mimeType.startsWith("application/vnd.google-apps.")) throw new Error(`Drive file ${a.drive_file_id} is a Google Docs-type file (${meta.mimeType}) with no binary content — export it first`);
        if (meta.size !== undefined && Number(meta.size) > MAX_UPLOAD_BYTES) throw new Error(`Drive file is ${meta.size} bytes — over the 100 MB limit`);
        if (typeof meta.mimeType === "string" && meta.mimeType !== "application/octet-stream") mime = meta.mimeType;
        const buf = await g.get<ArrayBuffer>(`${API.drive}/files/${enc(a.drive_file_id)}`, { alt: "media", supportsAllDrives: true }, { responseType: "arrayBuffer" });
        bytes = new Uint8Array(buf);
      } else {
        source = "url";
        const u = a.url!;
        if (!/^https?:\/\//i.test(u)) throw new Error("url must start with http:// or https://");
        const f = fetch.bind(globalThis);
        const res = await f(u, { redirect: "follow" });
        if (!res.ok) throw new Error(`Fetching url failed: HTTP ${res.status}`);
        const len = Number(res.headers.get("content-length"));
        if (Number.isFinite(len) && len > MAX_UPLOAD_BYTES) throw new Error(`url content is ${len} bytes — over the 100 MB limit`);
        const ct = (res.headers.get("content-type") ?? "").split(";")[0].trim();
        if (ct && ct !== "application/octet-stream" && !ct.startsWith("text/")) mime = ct;
        bytes = new Uint8Array(await res.arrayBuffer());
      }
      if (bytes.length === 0) throw new Error("The source contains no bytes");
      if (bytes.length > MAX_UPLOAD_BYTES) throw new Error(`Content is ${bytes.length} bytes — over the 100 MB limit`);
      mime ??= guessMime(a.file_name);

      // 2) upload bytes → upload token
      const uploadToken = await g.request<string>("POST", `${API.photos}/uploads`, {
        body: bytes,
        headers: {
          "content-type": "application/octet-stream",
          "X-Goog-Upload-Content-Type": mime,
          "X-Goog-Upload-Protocol": "raw",
          "X-Goog-Upload-File-Name": a.file_name,
        },
        responseType: "text",
        noRetry: true,
        timeoutMs: 120_000,
      });
      if (!uploadToken || typeof uploadToken !== "string") throw new Error("Photos upload did not return an upload token");

      // 3) create the media item
      const r = await g.post<AnyRec>(`${API.photos}/mediaItems:batchCreate`, {
        albumId: a.album_id,
        newMediaItems: [{ description: a.description, simpleMediaItem: { fileName: a.file_name, uploadToken: uploadToken.trim() } }],
      });
      const result: AnyRec = r.newMediaItemResults?.[0] ?? {};
      const status = result.status ?? {};
      const failed = status.code !== undefined && status.code !== 0;
      audit("photos_upload_media_item", { source, bytes: bytes.length, mime, album: a.album_id, ok: !failed, mediaItem: result.mediaItem?.id });
      if (failed) throw new Error(`Photos rejected the upload: ${status.message ?? JSON.stringify(status)}`);
      return { status: status.message ?? "Success", bytes: bytes.length, mimeType: mime, mediaItem: compactMediaItem(result.mediaItem) };
    },
  }),

  tool({
    name: "photos_add_album_items",
    description: "Add existing media items (max 50 per call) to an album. Both the album and the media items must have been created by this app (upload via photos_upload_media_item).",
    scope: SCOPE_APPEND,
    write: true,
    destructive: false,
    input: {
      album_id: z.string(),
      media_item_ids: z.array(z.string()).min(1).max(50).describe("Media item ids (max 50)"),
    },
    handler: async (a, { g }) => {
      await g.post(`${API.photos}/albums/${enc(a.album_id)}:batchAddMediaItems`, { mediaItemIds: a.media_item_ids });
      audit("photos_add_album_items", { album: a.album_id, count: a.media_item_ids.length });
      return { added: a.media_item_ids.length, albumId: a.album_id };
    },
  }),

  tool({
    name: "photos_update_media_item",
    description: "Update the description (caption) of a media item created by this app (PATCH mediaItems/{id}?updateMask=description). Pass '' to clear it.",
    scope: SCOPE_EDIT,
    write: true,
    idempotent: true,
    input: {
      media_item_id: z.string(),
      description: z.string().max(1000).describe("New caption ('' clears)"),
    },
    handler: async (a, { g }) => {
      const r = await g.patch<AnyRec>(`${API.photos}/mediaItems/${enc(a.media_item_id)}`, { description: a.description }, { updateMask: "description" });
      audit("photos_update_media_item", { mediaItem: a.media_item_id });
      return compactMediaItem(r);
    },
  }),

  // ---- Picker API (any library photo, chosen by the user) ---------------------
  tool({
    name: "photos_create_picker_session",
    description:
      "Start a Google Photos Picker session — the ONLY way to reach photos the user did not upload through this app. Returns pickerUri: the user must open it in a browser, select photos/videos and click Done; then poll photos_get_picker_session until mediaItemsSet=true and call photos_list_picked_media_items. Sessions expire (see expireTime, ~1 day) and nothing in the library is modified.",
    scope: SCOPE_PICKER,
    // Creates scratch state on Google's side (not user data): not read-only, not idempotent, not a library write.
    annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false },
    input: {},
    handler: async (_a, { g }) => {
      const r = await g.post<AnyRec>(`${API.picker}/sessions`, {});
      return { ...compactSession(r), instruction: PICKER_INSTRUCTION };
    },
  }),

  tool({
    name: "photos_get_picker_session",
    description: "Get a Picker session's state. Poll it (respect pollingConfig.pollInterval) until mediaItemsSet=true, meaning the user finished selecting; then call photos_list_picked_media_items. pollingConfig.timeoutIn means the user stopped responding.",
    scope: SCOPE_PICKER,
    input: { session_id: z.string().describe("Session id from photos_create_picker_session") },
    handler: async (a, { g }) => compactSession(await g.get<AnyRec>(`${API.picker}/sessions/${enc(a.session_id)}`)),
  }),

  tool({
    name: "photos_list_picked_media_items",
    description: `List the media items the user selected in a Picker session (only after mediaItemsSet=true). Each item: id, createTime, type (PHOTO/VIDEO), mediaFile {baseUrl, mimeType, filename, mediaFileMetadata {width, height, camera, photoMetadata/videoMetadata}}. ${PICKER_BASE_URL_NOTE}`,
    scope: SCOPE_PICKER,
    input: {
      session_id: z.string(),
      page_size: PageSize(25, 100),
      page_token: PageToken,
    },
    handler: async (a, { g }) => {
      const r = await g.get<AnyRec>(`${API.picker}/mediaItems`, { sessionId: a.session_id, pageSize: a.page_size, pageToken: a.page_token });
      return listResult((r.mediaItems ?? []).map((m: AnyRec) => compactPickedItem(m)), r.nextPageToken, { note: PICKER_BASE_URL_NOTE });
    },
  }),

  tool({
    name: "photos_download_media_item",
    description:
      "Download the bytes of a picked media item (authenticated GET of mediaFile.baseUrl + '=d'). Works for Picker baseUrls (and app-created Library baseUrls) while they are fresh (~60 min). Returns base64 + byte count + mimeType. Inline output is capped at ~250 KB (base64 must fit the tool-response limit): pass a baseUrl that already ends with a size suffix such as =w800-h800 for a downscaled image; originals larger than that cannot be returned inline.",
    scope: SCOPE_PICKER,
    input: {
      media_base_url: z.string().describe("mediaFile.baseUrl (or a Library baseUrl); '=d' is appended unless it already ends with a =… suffix"),
      max_bytes: z.number().int().min(1).max(250_000).default(250_000).describe("Reject downloads larger than this (hard max 250 KB — larger base64 would be truncated by the response limit)"),
      as: z.enum(["base64"]).default("base64").describe("Output encoding"),
    },
    handler: async (a, { g }) => {
      const base = a.media_base_url.trim();
      // The user's access token goes on this request: only Google Photos' own media hosts, never a
      // wildcard over googleusercontent.com (which also fronts user-controlled services), and no redirects.
      let host = "";
      try {
        host = new URL(base).hostname.toLowerCase();
      } catch {
        /* handled below */
      }
      if (!base.startsWith("https://") || !/^(lh\d*\.googleusercontent\.com|photospicker\.googleapis\.com|photoslibrary\.googleapis\.com)$/.test(host)) {
        throw new Error("media_base_url must be a Photos baseUrl (https://lh3.googleusercontent.com/… or photospicker.googleapis.com) from photos_list_picked_media_items");
      }
      const url = /=[A-Za-z0-9-]+$/.test(base) ? base : `${base}=d`;
      const res = await g.request<Response>("GET", url, { responseType: "response", headers: { accept: "*/*" }, redirect: "manual" });
      if (res.status >= 300 && res.status < 400) throw new Error(`Photos answered with a redirect (${res.status}) — the baseUrl has probably expired (~60 min); list the picked items again for a fresh one`);
      const len = Number(res.headers.get("content-length"));
      if (Number.isFinite(len) && len > a.max_bytes) throw new Error(`Media is ${len} bytes — over max_bytes (${a.max_bytes}); use a =w…-h… sized baseUrl or raise max_bytes`);
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.length > a.max_bytes) throw new Error(`Media is ${buf.length} bytes — over max_bytes (${a.max_bytes}); use a =w…-h… sized baseUrl or raise max_bytes`);
      const mimeType = (res.headers.get("content-type") ?? "application/octet-stream").split(";")[0].trim();
      if (Math.ceil(buf.length / 3) * 4 > MAX_OUTPUT_CHARS - 2000) throw new Error(`Media is ${buf.length} bytes — its base64 would exceed the response limit; request a smaller =w…-h… rendition`);
      return { encoding: a.as, bytes: buf.length, mimeType, base64: bytesToBase64(buf) };
    },
  }),

  tool({
    name: "photos_delete_picker_session",
    description: "Delete / close a Photos Picker session when done with it (cleanup; frees the selection; the user's library is untouched). Picked baseUrls stop working once the session is gone.",
    scope: SCOPE_PICKER,
    annotations: { readOnlyHint: false, destructiveHint: false },
    input: { session_id: z.string() },
    handler: async (a, { g }) => {
      await g.delete(`${API.picker}/sessions/${enc(a.session_id)}`);
      return { deleted: true, sessionId: a.session_id };
    },
  }),
];
