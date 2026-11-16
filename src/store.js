// Tiny JSON store. One file, atomic writes. Shape:
// {
//   lastRunDay: "YYYY-MM-DD",
//   lastFeedAt: ISO|null,                                       // last posts-feed sweep
//   guilds: {
//     [guildId]: {
//       defaultPostsPerWeek: number|null,
//       feedChannelId: string|null,                             // where new posts get forwarded
//       creators: {
//         [creatorId]: {
//           id, name, channelId, userId|null, postsPerWeek, maxGapDays|null,
//           handles: { tiktok, instagram, youtube, threads },   // parsed handles or null
//           paused: boolean,
//           feedOnly: boolean,                                  // forward posts, never nudge
//           seenPosts: { [platform]: string[] },                // post ids already forwarded/known
//           lastPostAt: { [platform]: ISO string },             // newest post we've seen per platform
//           lastCheckedAt: ISO|null, lastRemindedOn: "YYYY-MM-DD"|null, lastError: string|null,
//           addedAt: ISO
//         }
//       }
//     }
//   }
// }

import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

const FILE = path.resolve(process.env.DATA_FILE || "./data/creators.json");

let db = load();

function load() {
  try {
    const raw = fs.readFileSync(FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed.guilds) parsed.guilds = {};
    return parsed;
  } catch {
    return { lastRunDay: null, guilds: {} };
  }
}

export function save() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, FILE);
}

export function getState() {
  return db;
}

export function guild(guildId) {
  if (!db.guilds[guildId]) db.guilds[guildId] = { defaultPostsPerWeek: null, creators: {} };
  return db.guilds[guildId];
}

export function listCreators(guildId) {
  return Object.values(guild(guildId).creators).sort((a, b) => a.name.localeCompare(b.name));
}

/** All creators across all guilds, tagged with guildId. */
export function allCreators() {
  const out = [];
  for (const [guildId, g] of Object.entries(db.guilds)) {
    for (const c of Object.values(g.creators)) out.push({ guildId, creator: c });
  }
  return out;
}

export function normalizeName(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function findCreator(guildId, name) {
  const key = normalizeName(name);
  const list = listCreators(guildId);
  return (
    list.find((c) => normalizeName(c.name) === key) ||
    list.find((c) => normalizeName(c.name).includes(key)) ||
    null
  );
}

export function addCreator(guildId, data) {
  const g = guild(guildId);
  const id = randomBytes(6).toString("hex");
  const c = {
    id,
    name: data.name,
    channelId: data.channelId,
    userId: data.userId ?? null,
    postsPerWeek: data.postsPerWeek,
    maxGapDays: data.maxGapDays ?? null,
    handles: { tiktok: null, instagram: null, youtube: null, threads: null, ...data.handles },
    paused: false,
    feedOnly: data.feedOnly ?? false,
    lastPostAt: {},
    lastCheckedAt: null,
    lastRemindedOn: null,
    lastError: null,
    addedAt: new Date().toISOString(),
  };
  g.creators[id] = c;
  save();
  return c;
}

export function updateCreator(guildId, id, patch) {
  const g = guild(guildId);
  const c = g.creators[id];
  if (!c) return null;
  Object.assign(c, patch);
  save();
  return c;
}

export function removeCreator(guildId, id) {
  const g = guild(guildId);
  const existed = !!g.creators[id];
  delete g.creators[id];
  save();
  return existed;
}

export function setLastRunDay(day) {
  db.lastRunDay = day;
  save();
}

export function setLastFeedAt(iso) {
  db.lastFeedAt = iso;
  save();
}
