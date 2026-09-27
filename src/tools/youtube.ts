/**
 * YouTube Data API tools (read-only: channels, playlists, videos, search, subscriptions, comments).
 * API: https://www.googleapis.com/youtube/v3
 */
import { z } from "zod";
import { API } from "../google/client.js";
import { tool, listResult, PageSize, PageToken, type AnyRec } from "./_shared.js";

const SCOPE = "https://www.googleapis.com/auth/youtube.readonly";

/** Truncate a string to `n` chars (undefined stays undefined). */
function cap(s: unknown, n: number): string | undefined {
  if (typeof s !== "string" || !s) return undefined;
  return s.length > n ? s.slice(0, n) + "…" : s;
}

/** YouTube statistics come back as strings ("12345") — coerce to numbers. */
function num(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** ISO 8601 duration (PT1H2M3S, P1DT2H) → seconds. */
function durationToSeconds(d: unknown): number | undefined {
  if (typeof d !== "string") return undefined;
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(d);
  if (!m) return undefined;
  const [, days, hours, mins, secs] = m;
  return Number(days ?? 0) * 86400 + Number(hours ?? 0) * 3600 + Number(mins ?? 0) * 60 + Number(secs ?? 0);
}

function compactChannel(c: AnyRec): AnyRec {
  const s = c.snippet ?? {};
  const st = c.statistics ?? {};
  return {
    id: c.id,
    title: s.title,
    customUrl: s.customUrl,
    description: cap(s.description, 300),
    publishedAt: s.publishedAt,
    country: s.country,
    subscribers: num(st.subscriberCount),
    views: num(st.viewCount),
    videos: num(st.videoCount),
    uploadsPlaylistId: c.contentDetails?.relatedPlaylists?.uploads,
    thumbnail: s.thumbnails?.default?.url,
  };
}

function compactPlaylist(p: AnyRec): AnyRec {
  const s = p.snippet ?? {};
  return {
    id: p.id,
    title: s.title,
    description: cap(s.description, 200),
    channelId: s.channelId,
    channelTitle: s.channelTitle,
    publishedAt: s.publishedAt,
    itemCount: num(p.contentDetails?.itemCount),
    privacy: p.status?.privacyStatus,
  };
}

function compactPlaylistItem(i: AnyRec): AnyRec {
  const s = i.snippet ?? {};
  const videoId = i.contentDetails?.videoId ?? s.resourceId?.videoId;
  return {
    videoId,
    title: s.title,
    position: s.position,
    publishedAt: i.contentDetails?.videoPublishedAt ?? s.publishedAt,
    channelTitle: s.videoOwnerChannelTitle,
    url: videoId ? `https://youtu.be/${videoId}` : undefined,
  };
}

function compactVideo(v: AnyRec): AnyRec {
  const s = v.snippet ?? {};
  const st = v.statistics ?? {};
  const cd = v.contentDetails ?? {};
  return {
    id: v.id,
    title: s.title,
    description: cap(s.description, 500),
    channelId: s.channelId,
    channelTitle: s.channelTitle,
    publishedAt: s.publishedAt,
    duration: cd.duration,
    durationSeconds: durationToSeconds(cd.duration),
    views: num(st.viewCount),
    likes: num(st.likeCount),
    comments: num(st.commentCount),
    tags: Array.isArray(s.tags) ? s.tags.slice(0, 15) : undefined,
    categoryId: s.categoryId,
    privacy: v.status?.privacyStatus,
    definition: cd.definition,
    caption: cd.caption,
    url: v.id ? `https://youtu.be/${v.id}` : undefined,
  };
}

export const youtubeTools = [
  tool({
    name: "youtube_list_my_channels",
    description:
      "List the YouTube channels owned by the signed-in account (channels.list mine=true): id, title, customUrl, subscribers, views, video count and the uploadsPlaylistId (pass it to youtube_list_playlist_items to enumerate every video on the channel). Brand-account channels only appear when the connector was authorized as that brand account.",
    scope: SCOPE,
    input: {},
    handler: async (_a, { g }) => {
      const r = await g.get<AnyRec>(`${API.youtube}/channels`, { part: "snippet,statistics,contentDetails", mine: true, maxResults: 50 });
      return listResult((r.items ?? []).map(compactChannel), r.nextPageToken);
    },
  }),

  tool({
    name: "youtube_get_channel",
    description:
      "Get one channel by channel_id (UC…), for_handle (@handle, e.g. '@mkbhd') or for_username (legacy username). Pass exactly one. Returns title, customUrl, description, subscribers, views, video count, uploadsPlaylistId.",
    scope: SCOPE,
    input: {
      channel_id: z.string().optional().describe("Channel id, starts with 'UC'"),
      for_handle: z.string().optional().describe("Channel handle with or without leading '@'"),
      for_username: z.string().optional().describe("Legacy YouTube username"),
    },
    handler: async (a, { g }) => {
      const given = [a.channel_id, a.for_handle, a.for_username].filter((x) => !!x);
      if (given.length !== 1) throw new Error("Pass exactly one of channel_id, for_handle or for_username");
      const query: AnyRec = { part: "snippet,statistics,contentDetails" };
      if (a.channel_id) query.id = a.channel_id;
      else if (a.for_handle) query.forHandle = a.for_handle.startsWith("@") ? a.for_handle : `@${a.for_handle}`;
      else query.forUsername = a.for_username;
      const r = await g.get<AnyRec>(`${API.youtube}/channels`, query);
      const c = r.items?.[0];
      if (!c) throw new Error(`Channel not found: ${a.channel_id ?? a.for_handle ?? a.for_username}`);
      return compactChannel(c);
    },
  }),

  tool({
    name: "youtube_list_playlists",
    description:
      "List playlists of a channel (channel_id) or of the signed-in account (mine=true, the default when channel_id is omitted). Returns id, title, itemCount, privacy. Note: a channel's automatic 'uploads' playlist is NOT listed here — get its id from youtube_list_my_channels / youtube_get_channel.",
    scope: SCOPE,
    input: {
      channel_id: z.string().optional().describe("Channel id (UC…) whose public playlists to list"),
      mine: z.boolean().default(false).describe("List the signed-in account's playlists (used automatically when channel_id is omitted)"),
      page_size: PageSize(25, 50),
      page_token: PageToken,
    },
    handler: async (a, { g }) => {
      if (a.channel_id && a.mine) throw new Error("Pass either channel_id or mine=true, not both");
      const query: AnyRec = { part: "snippet,contentDetails,status", maxResults: a.page_size, pageToken: a.page_token };
      if (a.channel_id) query.channelId = a.channel_id;
      else query.mine = true;
      const r = await g.get<AnyRec>(`${API.youtube}/playlists`, query);
      return listResult((r.items ?? []).map(compactPlaylist), r.nextPageToken, { totalResults: num(r.pageInfo?.totalResults) });
    },
  }),

  tool({
    name: "youtube_list_playlist_items",
    description:
      "List the videos in a playlist (playlistItems.list): videoId, title, position, publishedAt, channelTitle, url. Pass a channel's uploadsPlaylistId (from youtube_list_my_channels / youtube_get_channel, format UU…) to list ALL of that channel's videos, newest first. Paginate with page_token; totalResults gives the playlist size. Use youtube_get_video_stats on the videoIds for views/likes/duration.",
    scope: SCOPE,
    input: {
      playlist_id: z.string().describe("Playlist id (PL…, UU… for uploads, LL… liked videos)"),
      page_size: PageSize(50, 50),
      page_token: PageToken,
    },
    handler: async (a, { g }) => {
      const r = await g.get<AnyRec>(`${API.youtube}/playlistItems`, {
        part: "snippet,contentDetails",
        playlistId: a.playlist_id,
        maxResults: a.page_size,
        pageToken: a.page_token,
      });
      return listResult((r.items ?? []).map(compactPlaylistItem), r.nextPageToken, { totalResults: num(r.pageInfo?.totalResults) });
    },
  }),

  tool({
    name: "youtube_get_video_stats",
    description:
      "Get details + statistics for up to 50 videos in one call (videos.list): title, description, channel, publishedAt, duration (ISO 8601 + seconds), views, likes, comments, tags, categoryId, privacy, definition (hd/sd), caption, url. Video ids are the 11-char id from youtube.com/watch?v=<id> or youtu.be/<id>. Private videos of other channels are silently omitted.",
    scope: SCOPE,
    input: { video_ids: z.array(z.string()).min(1).max(50).describe("Up to 50 video ids") },
    handler: async (a, { g }) => {
      const ids = a.video_ids.map((v) => v.trim()).filter(Boolean);
      if (!ids.length) throw new Error("video_ids must contain at least one non-empty id");
      const r = await g.get<AnyRec>(`${API.youtube}/videos`, { part: "snippet,statistics,contentDetails,status", id: ids.join(","), maxResults: 50 });
      const items = (r.items ?? []).map(compactVideo);
      const found = new Set(items.map((v: AnyRec) => v.id));
      const missing = ids.filter((id) => !found.has(id));
      return { ...listResult(items), missing: missing.length ? missing : undefined };
    },
  }),

  tool({
    name: "youtube_search_videos",
    description:
      "Search YouTube (search.list) for videos, channels or playlists. EXPENSIVE: every call costs 100 quota units of the 10,000/day default quota — prefer youtube_list_playlist_items for a known channel's videos. Returns kind, id, title, channelTitle, publishedAt, description, url per result plus nextPageToken. Filter by channel_id, order (relevance|date|viewCount|rating) and published_after (RFC 3339, e.g. 2025-01-01T00:00:00Z).",
    scope: SCOPE,
    input: {
      query: z.string().describe("Search terms (supports | for OR and - to exclude, e.g. 'solar -ad')"),
      max_results: PageSize(10, 50),
      type: z.enum(["video", "channel", "playlist", "any"]).default("video").describe("Resource type to return ('any' mixes all three)"),
      page_token: PageToken,
      channel_id: z.string().optional().describe("Restrict results to this channel (UC…)"),
      order: z.enum(["relevance", "date", "viewCount", "rating"]).default("relevance"),
      published_after: z.string().optional().describe("RFC 3339 timestamp; only results published after this"),
    },
    handler: async (a, { g }) => {
      const query: AnyRec = {
        part: "snippet",
        q: a.query,
        maxResults: a.max_results,
        pageToken: a.page_token,
        channelId: a.channel_id,
        order: a.order,
        publishedAfter: a.published_after,
      };
      if (a.type !== "any") query.type = a.type;
      const r = await g.get<AnyRec>(`${API.youtube}/search`, query);
      const items = (r.items ?? []).map((it: AnyRec) => {
        const s = it.snippet ?? {};
        const idObj = it.id ?? {};
        const kind = idObj.videoId ? "video" : idObj.channelId ? "channel" : idObj.playlistId ? "playlist" : String(idObj.kind ?? "").replace("youtube#", "");
        const id = idObj.videoId ?? idObj.channelId ?? idObj.playlistId;
        const url = kind === "video" ? `https://youtu.be/${id}` : kind === "channel" ? `https://www.youtube.com/channel/${id}` : kind === "playlist" ? `https://www.youtube.com/playlist?list=${id}` : undefined;
        return { kind, id, title: s.title, channelTitle: s.channelTitle, publishedAt: s.publishedAt, description: cap(s.description, 200), url };
      });
      return listResult(items, r.nextPageToken, { totalResults: num(r.pageInfo?.totalResults) });
    },
  }),

  tool({
    name: "youtube_list_subscriptions",
    description: "List channels the signed-in account subscribes to (subscriptions.list mine=true): channelId, title, description. Paginate with page_token.",
    scope: SCOPE,
    input: { page_size: PageSize(50, 50), page_token: PageToken },
    handler: async (a, { g }) => {
      const r = await g.get<AnyRec>(`${API.youtube}/subscriptions`, { part: "snippet", mine: true, maxResults: a.page_size, pageToken: a.page_token });
      const items = (r.items ?? []).map((it: AnyRec) => {
        const s = it.snippet ?? {};
        return { channelId: s.resourceId?.channelId, title: s.title, description: cap(s.description, 150) };
      });
      return listResult(items, r.nextPageToken, { totalResults: num(r.pageInfo?.totalResults) });
    },
  }),

  tool({
    name: "youtube_list_video_comments",
    description:
      "List top-level comment threads on a video (commentThreads.list): id, author, text, likes, publishedAt, replyCount. Fails with 403 when comments are disabled on the video. Video id is the 11-char id from the watch URL.",
    scope: SCOPE,
    input: {
      video_id: z.string().describe("Video id (11 chars)"),
      max_results: PageSize(20, 100),
      page_token: PageToken,
      order: z.enum(["time", "relevance"]).default("time").describe("time = newest first; relevance = YouTube's top comments"),
    },
    handler: async (a, { g }) => {
      const r = await g.get<AnyRec>(`${API.youtube}/commentThreads`, {
        part: "snippet",
        videoId: a.video_id,
        maxResults: a.max_results,
        pageToken: a.page_token,
        order: a.order,
        textFormat: "plainText",
      });
      const items = (r.items ?? []).map((t: AnyRec) => {
        const top = t.snippet?.topLevelComment?.snippet ?? {};
        return {
          id: t.id,
          author: top.authorDisplayName,
          text: top.textOriginal ?? top.textDisplay,
          likes: num(top.likeCount),
          publishedAt: top.publishedAt,
          replyCount: num(t.snippet?.totalReplyCount),
        };
      });
      return listResult(items, r.nextPageToken);
    },
  }),
];
