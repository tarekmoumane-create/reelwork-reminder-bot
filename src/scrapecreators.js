// ScrapeCreators API client — ported from Reel Trax's lib/scrapecreators.ts.
// Only what this bot needs: "when did this creator last post?" per platform.

const BASE = "https://api.scrapecreators.com";

export class ScrapeCreatorsError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "ScrapeCreatorsError";
    this.status = status;
  }
}

// ---------- handle parsing (accepts @handle, bare handle, or profile URL) ----------

export function parseTikTokHandle(input) {
  if (!input) return null;
  const s = input.trim();
  const m = s.match(/tiktok\.com\/@([A-Za-z0-9._]+)/i);
  if (m) return m[1];
  if (s.startsWith("@")) return s.slice(1);
  if (/^[A-Za-z0-9._]+$/.test(s)) return s;
  return null;
}

export function parseInstagramHandle(input) {
  if (!input) return null;
  const s = input.trim();
  const m = s.match(/instagram\.com\/([A-Za-z0-9._]+)/i);
  if (m) return m[1];
  if (s.startsWith("@")) return s.slice(1);
  if (/^[A-Za-z0-9._]+$/.test(s)) return s;
  return null;
}

export function parseYouTubeHandle(input) {
  if (!input) return null;
  const s = input.trim();
  const m = s.match(/youtube\.com\/@([A-Za-z0-9._-]+)/i);
  if (m) return m[1];
  if (s.startsWith("@")) return s.slice(1);
  if (/^[A-Za-z0-9._-]+$/.test(s)) return s;
  return null;
}

export function parseThreadsHandle(input) {
  if (!input) return null;
  const s = input.trim();
  const m = s.match(/threads\.(net|com)\/@?([A-Za-z0-9._]+)/i);
  if (m) return m[2];
  if (s.startsWith("@")) return s.slice(1);
  if (/^[A-Za-z0-9._]+$/.test(s)) return s;
  return null;
}

export const PLATFORMS = ["tiktok", "instagram", "youtube", "threads"];

export const HANDLE_PARSERS = {
  tiktok: parseTikTokHandle,
  instagram: parseInstagramHandle,
  youtube: parseYouTubeHandle,
  threads: parseThreadsHandle,
};

// ---------- helpers ----------

/** first defined value among candidate dotted paths */
function pick(obj, paths) {
  for (const path of paths) {
    let cur = obj;
    let ok = true;
    for (const part of path.split(".")) {
      if (cur == null) {
        ok = false;
        break;
      }
      cur = cur[part];
    }
    if (ok && cur != null) return cur;
  }
  return undefined;
}

function toDate(v) {
  if (v == null) return null;
  if (typeof v === "number") {
    const ms = v < 1e12 ? v * 1000 : v; // seconds vs milliseconds
    const d = new Date(ms);
    return isNaN(d.getTime()) ? null : d;
  }
  if (typeof v === "string") {
    if (/^\d+$/.test(v)) return toDate(Number(v));
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

async function scGet(path, params, apiKey) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${BASE}${path}?${qs}`, {
    headers: { "x-api-key": apiKey },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ScrapeCreatorsError(
      `ScrapeCreators ${path} -> ${res.status} ${body.slice(0, 200)}`,
      res.status
    );
  }
  return res.json();
}

// ---------- per-platform "recent post dates" ----------
// Each returns { dates: Date[] (newest first), posts: [{id, url, date}], rawCount }.
// `posts` feeds the #posts channel (see feed.js) off the same API call.

async function tiktokDates(handle, apiKey) {
  const data = await scGet(
    "/v3/tiktok/profile/videos",
    { handle, sort_by: "latest", trim: "true" },
    apiKey
  );
  const list = data?.aweme_list ?? data?.data?.aweme_list ?? [];
  const dates = [];
  const posts = [];
  for (const it of list) {
    const d = toDate(pick(it, ["create_time", "createTime"]));
    if (!d) continue;
    dates.push(d);
    const id = String(pick(it, ["aweme_id", "id"]) ?? "");
    if (id) posts.push({ id, url: it.url || `https://www.tiktok.com/@${handle}/video/${id}`, date: d });
  }
  return { dates, posts, rawCount: list.length };
}

async function instagramDates(handle, apiKey) {
  const data = await scGet("/v2/instagram/user/posts", { handle }, apiKey);
  const list = pick(data, ["items", "data.items", "data", "posts", "media"]) ?? [];
  const dates = [];
  const posts = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const it = raw?.media ?? raw?.node ?? raw;
    const d = toDate(
      pick(it, ["taken_at", "taken_at_timestamp", "device_timestamp", "timestamp"])
    );
    if (!d) continue;
    dates.push(d);
    const code = pick(it, ["code", "shortcode"]);
    const id = String(pick(it, ["pk", "id"]) ?? code ?? "");
    const url = code
      ? `https://www.instagram.com/${it.product_type === "clips" ? "reel" : "p"}/${code}/`
      : it.url;
    if (id && url) posts.push({ id, url, date: d });
  }
  return { dates, posts, rawCount: Array.isArray(list) ? list.length : 0 };
}

// Shorts the list endpoint didn't date get one details call each, capped so a
// big backlog can't burn credits. We only need the newest few for a reminder.
const YT_DATE_LOOKUP_CAP = 3;

async function youtubeDates(handle, apiKey) {
  const data = await scGet("/v1/youtube/channel/shorts", { handle, sort: "newest" }, apiKey);
  const list = pick(data, ["shorts", "data.shorts", "videos", "items"]) ?? [];
  const dates = [];
  const posts = [];
  let lookups = 0;
  for (const it of Array.isArray(list) ? list : []) {
    const id = String(pick(it, ["id", "videoId", "video_id"]) ?? "");
    if (!id) continue;
    let d = toDate(pick(it, ["publishDate", "publishedTime", "publish_date", "publishedAt"]));
    if (!d && lookups < YT_DATE_LOOKUP_CAP) {
      lookups++;
      const url = pick(it, ["url"]) || `https://www.youtube.com/shorts/${id}`;
      try {
        const v = await scGet("/v1/youtube/video", { url }, apiKey);
        d = toDate(pick(v, ["publishDate", "publish_date", "uploadDate"]));
      } catch {
        d = null;
      }
    }
    if (d) {
      dates.push(d);
      posts.push({ id, url: `https://www.youtube.com/shorts/${id}`, date: d });
    }
  }
  return { dates, posts, rawCount: Array.isArray(list) ? list.length : 0 };
}

async function threadsDates(handle, apiKey) {
  const data = await scGet("/v1/threads/user/posts", { handle }, apiKey);
  const list = pick(data, ["posts", "data.posts", "items", "data", "threads"]) ?? [];
  const dates = [];
  const posts = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const it = raw?.post ?? raw?.node ?? raw;
    const d = toDate(pick(it, ["taken_at", "taken_at_timestamp", "timestamp"]));
    if (!d) continue;
    dates.push(d);
    const code = pick(it, ["code", "shortcode"]);
    const id = String(pick(it, ["pk", "id"]) ?? code ?? "");
    if (id && code) posts.push({ id, url: `https://www.threads.net/@${handle}/post/${code}`, date: d });
  }
  return { dates, posts, rawCount: Array.isArray(list) ? list.length : 0 };
}

const FETCHERS = {
  tiktok: tiktokDates,
  instagram: instagramDates,
  youtube: youtubeDates,
  threads: threadsDates,
};

/**
 * Fetch recent post dates for one platform handle.
 * @returns {Promise<{dates: Date[], posts: Array<{id, url, date}>, rawCount: number}>} dates sorted newest first
 */
export async function fetchPostDates(platform, handle, apiKey) {
  const fn = FETCHERS[platform];
  if (!fn) throw new ScrapeCreatorsError(`Unknown platform: ${platform}`);
  const r = await fn(handle, apiKey);
  r.dates.sort((a, b) => b.getTime() - a.getTime());
  return r;
}
