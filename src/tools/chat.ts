/**
 * Google Chat tools (user authentication — every call acts as the signed-in user).
 * API: https://chat.googleapis.com/v1 (+ /upload/v1 for attachments).
 *
 * GCP gotcha: besides enabling the Google Chat API, the OAuth client's GCP project
 * must have a "Chat app" configured (APIs & Services → Google Chat API → Configuration:
 * app name, avatar URL, description — it can stay unpublished/private). Without that
 * configuration EVERY Chat call returns 403 even though scopes and the API are fine.
 */
import { z } from "zod";
import { API } from "../google/client.js";
import { tool, listResult, PageSize, PageToken, audit, base64ToBytes, mapLimit, multipartRelated, provenance, Confirm, type AnyRec } from "./_shared.js";

const SCOPE_SPACES = "https://www.googleapis.com/auth/chat.spaces.readonly";
const SCOPE_MESSAGES = "https://www.googleapis.com/auth/chat.messages";
const CHAT_UPLOAD = "https://chat.googleapis.com/upload/v1";
const HINT_403 = " If it fails with 403 although the scope was granted, the GCP project lacks a Chat app configuration (Google Chat API → Configuration).";

const SpaceName = z.string().describe("Space resource name, e.g. spaces/AAAAxxxxxxx (from chat_list_spaces)");
const MessageName = z.string().describe("Message resource name, e.g. spaces/AAAAxxxxxxx/messages/BBBBxxxxxxx.BBBBxxxxxxx");

/** Validate a `spaces/{id}` resource name (returned as-is — already a path). */
function spaceName(s: string): string {
  const v = s.trim();
  if (!/^spaces\/[^/\s]+$/.test(v)) throw new Error(`Invalid space name "${s}" — expected the form spaces/AAAA (use chat_list_spaces or chat_find_direct_message to get it)`);
  return v;
}

/** Validate a `spaces/{id}/messages/{id}` resource name. */
function messageName(s: string): string {
  const v = s.trim();
  if (!/^spaces\/[^/\s]+\/messages\/[^/\s]+$/.test(v)) throw new Error(`Invalid message name "${s}" — expected the form spaces/AAAA/messages/BBBB (from chat_list_messages)`);
  return v;
}

/** Validate a `spaces/{id}/threads/{id}` resource name. */
function threadName(s: string): string {
  const v = s.trim();
  if (!/^spaces\/[^/\s]+\/threads\/[^/\s]+$/.test(v)) throw new Error(`Invalid thread name "${s}" — expected the form spaces/AAAA/threads/BBBB (message.thread from chat_list_messages)`);
  return v;
}

function compactSpace(s: AnyRec): AnyRec {
  return {
    name: s.name,
    displayName: s.displayName,
    spaceType: s.spaceType,
    type: s.type,
    singleUserBotDm: s.singleUserBotDm,
    threaded: s.threaded,
    spaceThreadingState: s.spaceThreadingState,
    spaceHistoryState: s.spaceHistoryState,
    externalUserAllowed: s.externalUserAllowed,
    createTime: s.createTime,
    lastActiveTime: s.lastActiveTime,
    membershipCount: s.membershipCount,
    spaceUri: s.spaceUri,
  };
}

function compactMessage(m: AnyRec): AnyRec {
  const sender = m.sender ?? {};
  return {
    name: m.name,
    text: m.text,
    formattedText: m.formattedText && m.formattedText !== m.text ? m.formattedText : undefined,
    sender: { name: sender.name, displayName: sender.displayName, type: sender.type, email: sender.email },
    createTime: m.createTime,
    lastUpdateTime: m.lastUpdateTime,
    thread: m.thread?.name,
    threadReply: m.threadReply,
    space: m.space?.name,
    attachment: (m.attachment ?? []).map((att: AnyRec) => ({ name: att.name, contentName: att.contentName, contentType: att.contentType, downloadUri: att.downloadUri })),
    quotedMessageMetadata: m.quotedMessageMetadata,
    emojiReactionSummaries: m.emojiReactionSummaries,
    deleted: m.deleted,
  };
}

export const chatTools = [
  tool({
    name: "chat_list_spaces",
    description:
      "List Chat spaces (rooms, group chats and direct messages) the signed-in user is a member of. Returns name (spaces/AAAA), displayName, spaceType, threading/history state, membershipCount, spaceUri. Filter with spaceType, e.g. spaceType = \"SPACE\" or spaceType = \"DIRECT_MESSAGE\". DMs have no displayName — set resolve_dm_members=true to attach the other participants (one extra call per DM, first 20 DMs)." +
      HINT_403,
    scope: SCOPE_SPACES,
    input: {
      page_size: PageSize(100, 1000),
      page_token: PageToken,
      filter: z.string().optional().describe('Space filter, e.g. spaceType = "SPACE" or spaceType = "DIRECT_MESSAGE" (combine with OR)'),
      resolve_dm_members: z.boolean().default(false).describe("For DIRECT_MESSAGE spaces without a displayName, fetch the members so the counterparty is visible (extra call per DM, capped at 20)"),
    },
    handler: async (a, { g }) => {
      const r = await g.get<AnyRec>(`${API.chat}/spaces`, { pageSize: a.page_size, pageToken: a.page_token, filter: a.filter });
      const spaces = (r.spaces ?? []).map(compactSpace) as AnyRec[];
      if (a.resolve_dm_members) {
        const dms = spaces.filter((s) => s.spaceType === "DIRECT_MESSAGE" && !s.displayName).slice(0, 20);
        await mapLimit(dms, 4, async (s) => {
          const m = await g.get<AnyRec>(`${API.chat}/${s.name}/members`, { pageSize: 10 }).catch(() => ({}) as AnyRec);
          s.members = ((m.memberships ?? []) as AnyRec[]).map((x) => ({ user: x.member?.name, displayName: x.member?.displayName, type: x.member?.type })).filter((x) => x.user);
        });
      }
      return listResult(spaces, r.nextPageToken);
    },
  }),

  tool({
    name: "chat_get_space",
    description: "Get one Chat space by resource name (spaces/AAAA): display name, type, threading/history state, member count, spaceUri." + HINT_403,
    scope: SCOPE_SPACES,
    input: { name: SpaceName },
    handler: async (a, { g }) => compactSpace(await g.get<AnyRec>(`${API.chat}/${spaceName(a.name)}`)),
  }),

  tool({
    name: "chat_find_direct_message",
    description:
      "Find the existing direct-message space between the signed-in user and another user, by email address or users/{id}. Returns the space (use its name with chat_list_messages / chat_send_message). 404 means no DM exists yet." +
      HINT_403,
    scope: SCOPE_SPACES,
    input: { user: z.string().describe("Other user's email address (e.g. jane@example.com) or resource name users/123456789") },
    handler: async (a, { g }) => {
      const u = a.user.trim();
      if (!u) throw new Error("user is required (email address or users/{id})");
      const name = u.startsWith("users/") ? u : `users/${u}`;
      return compactSpace(await g.get<AnyRec>(`${API.chat}/spaces:findDirectMessage`, { name }));
    },
  }),

  tool({
    name: "chat_list_messages",
    description:
      "List messages in a space (spaces/AAAA), newest first by default. Each item has name (spaces/AAAA/messages/BBBB), text, sender, createTime, thread (spaces/AAAA/threads/CCCC), attachments, reactions. " +
      'Filter examples: createTime > "2026-01-01T00:00:00Z", thread.name = spaces/AAAA/threads/BBBB (combine with AND).' +
      HINT_403,
    scope: SCOPE_MESSAGES,
    input: {
      space: SpaceName,
      page_size: PageSize(25, 1000),
      page_token: PageToken,
      filter: z.string().optional().describe('Message filter on createTime and/or thread.name, e.g. createTime > "2026-01-01T00:00:00Z" AND thread.name = spaces/AAAA/threads/BBBB'),
      order_by: z.enum(["createTime desc", "createTime asc"]).default("createTime desc"),
      show_deleted: z.boolean().default(false).describe("Include deleted messages (text is gone; deleted/deletionMetadata remain)"),
    },
    handler: async (a, { g }) => {
      const [field, dir] = a.order_by.split(" ");
      const r = await g.get<AnyRec>(`${API.chat}/${spaceName(a.space)}/messages`, {
        pageSize: a.page_size,
        pageToken: a.page_token,
        filter: a.filter,
        orderBy: `${field} ${dir.toUpperCase()}`,
        showDeleted: a.show_deleted,
      });
      return { ...provenance(`chat:space:${a.space}`, ["items[].text", "items[].formattedText"]), ...listResult((r.messages ?? []).map(compactMessage), r.nextPageToken) };
    },
  }),

  tool({
    name: "chat_get_message",
    description: "Get one message by resource name (spaces/AAAA/messages/BBBB): text, sender, thread, attachments, quoted message, reactions." + HINT_403,
    scope: SCOPE_MESSAGES,
    input: { name: MessageName },
    handler: async (a, { g }) => ({ ...provenance(`chat:message:${a.name}`, ["text", "formattedText"]), ...compactMessage(await g.get<AnyRec>(`${API.chat}/${messageName(a.name)}`)) }),
  }),

  tool({
    name: "chat_send_message",
    description:
      "Send a message to a space as the signed-in user. ONLY when the user explicitly asks to post; confirm must be true. text supports Chat formatting: *bold*, _italic_, ~strike~, `code`, ```code block```, <users/all> (@all), <users/123|Name> (@mention), <https://link|text>. " +
      "To reply in an existing thread pass thread_name (spaces/AAAA/threads/BBBB); to start or continue a thread under your own key pass thread_key (any string). " +
      "Attach a file uploaded with chat_upload_attachment via attachment_data_ref." +
      HINT_403,
    scope: SCOPE_MESSAGES,
    write: true,
    destructive: true,
    input: {
      space: SpaceName,
      text: z.string().min(1).describe("Message text (max 4096 chars)"),
      thread_name: z.string().optional().describe("Reply in this thread: spaces/AAAA/threads/BBBB (message.thread from chat_list_messages)"),
      thread_key: z.string().optional().describe("Client-chosen thread key: first use starts a thread, later uses reply to it"),
      message_reply_option: z
        .enum(["REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD", "REPLY_MESSAGE_OR_FAIL"])
        .optional()
        .describe("When thread_name/thread_key is given (default REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD): fall back to a new thread if the thread does not exist, or fail"),
      attachment_data_ref: z
        .object({ resourceName: z.string(), attachmentUploadToken: z.string() })
        .optional()
        .describe("attachmentDataRef returned by chat_upload_attachment"),
      confirm: Confirm,
    },
    handler: async (a, { g }) => {
      const space = spaceName(a.space);
      if (a.thread_name && a.thread_key) throw new Error("Pass either thread_name or thread_key, not both");
      const body: AnyRec = { text: a.text };
      if (a.thread_name) body.thread = { name: threadName(a.thread_name) };
      else if (a.thread_key) body.thread = { threadKey: a.thread_key };
      if (a.attachment_data_ref) body.attachment = [{ attachmentDataRef: a.attachment_data_ref }];
      const query: AnyRec = {};
      if (body.thread) query.messageReplyOption = a.message_reply_option ?? "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD";
      const r = await g.post<AnyRec>(`${API.chat}/${space}/messages`, body, query);
      audit("chat_send_message", { space, message: r.name, thread: r.thread?.name, chars: a.text.length, attachment: !!a.attachment_data_ref });
      return compactMessage(r);
    },
  }),

  tool({
    name: "chat_update_message",
    description: "Edit the text of a message you sent (spaces/AAAA/messages/BBBB). Only the author can edit; the same formatting as chat_send_message applies." + HINT_403,
    scope: SCOPE_MESSAGES,
    write: true,
    idempotent: true,
    input: { name: MessageName, text: z.string().min(1).describe("New message text") },
    handler: async (a, { g }) => {
      const name = messageName(a.name);
      const r = await g.patch<AnyRec>(`${API.chat}/${name}`, { text: a.text }, { updateMask: "text" });
      audit("chat_update_message", { message: name, chars: a.text.length });
      return compactMessage(r);
    },
  }),

  tool({
    name: "chat_delete_message",
    description: "Delete a message (spaces/AAAA/messages/BBBB) — irreversible. Users can delete their own messages (space managers can delete others'). force=true also deletes the thread replies when the message started a thread." + HINT_403,
    scope: SCOPE_MESSAGES,
    write: true,
    destructive: true,
    idempotent: true,
    input: { name: MessageName, force: z.boolean().default(false).describe("Also delete replies in the thread this message started") },
    handler: async (a, { g }) => {
      const name = messageName(a.name);
      await g.delete(`${API.chat}/${name}`, { force: a.force });
      audit("chat_delete_message", { message: name, force: a.force });
      return { deleted: true, name };
    },
  }),

  tool({
    name: "chat_add_reaction",
    description: "Add an emoji reaction (unicode emoji such as 👍 or ✅) to a message as the signed-in user." + HINT_403,
    scope: SCOPE_MESSAGES,
    write: true,
    destructive: false,
    input: { message_name: MessageName, emoji: z.string().min(1).describe("Unicode emoji, e.g. 👍 (not :thumbsup: shortcodes)") },
    handler: async (a, { g }) => {
      const message = messageName(a.message_name);
      const emoji = a.emoji.trim();
      if (!emoji) throw new Error("emoji is required (a unicode emoji such as 👍)");
      const r = await g.post<AnyRec>(`${API.chat}/${message}/reactions`, { emoji: { unicode: emoji } });
      audit("chat_add_reaction", { message, emoji });
      return { name: r.name, emoji: r.emoji?.unicode ?? emoji, user: r.user?.name };
    },
  }),

  tool({
    name: "chat_upload_attachment",
    description:
      "Upload a file (base64 content) as a Chat attachment for a space. Returns attachmentDataRef {resourceName, attachmentUploadToken} — pass it as attachment_data_ref to chat_send_message in the SAME space to post it (the upload alone posts nothing). Max 200 MB." +
      HINT_403,
    scope: SCOPE_MESSAGES,
    write: true,
    destructive: false,
    input: {
      space: SpaceName,
      file_name: z.string().min(1).describe("File name incl. extension, e.g. report.pdf"),
      content_base64: z.string().min(1).describe("File bytes, base64-encoded"),
      mime_type: z.string().default("application/octet-stream").describe("Content type of the bytes, e.g. application/pdf, image/png"),
    },
    handler: async (a, { g }) => {
      const space = spaceName(a.space);
      let payload: Uint8Array;
      try {
        payload = base64ToBytes(a.content_base64);
      } catch {
        throw new Error("content_base64 is not valid base64");
      }
      if (!payload.length) throw new Error("content_base64 decoded to zero bytes");
      const { body, contentType } = multipartRelated({ filename: a.file_name }, a.mime_type, payload);
      const r = await g.post<AnyRec>(`${CHAT_UPLOAD}/${space}/attachments:upload`, body, { uploadType: "multipart" }, { headers: { "content-type": contentType }, noRetry: true, timeoutMs: 120_000 });
      audit("chat_upload_attachment", { space, name: a.file_name, bytes: payload.length });
      const ref = r.attachmentDataRef ?? r;
      return { attachmentDataRef: { resourceName: ref.resourceName, attachmentUploadToken: ref.attachmentUploadToken } };
    },
  }),
];
