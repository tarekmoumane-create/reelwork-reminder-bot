// The heart of the bot: decide whether each creator is behind and nudge them.
//
// Rule (from the brief):
//   7x/week  -> remind if no post today by the cutoff (1 day without a post)
//   5x/week  -> remind after 3 days without a post
// Generalised: allowed rest days = 7 - postsPerWeek, and we remind once the
// creator has gone (restDays + 1) whole days without posting. So:
//   7x -> 1 day, 6x -> 2, 5x -> 3, 4x -> 4, 3x -> 5, 2x -> 6, 1x -> 7.
// A creator can override this with `maxGapDays`.

import { fetchPostDates, PLATFORMS } from "./scrapecreators.js";
import { dayKey, daysSince, fmtDate } from "./time.js";
import { reminderMessage } from "./messages.js";
import { allCreators, updateCreator } from "./store.js";
import { publishNewPosts } from "./feed.js";

export function thresholdDays(creator) {
  if (creator.maxGapDays) return creator.maxGapDays;
  return Math.max(1, 7 - creator.postsPerWeek + 1);
}

/**
 * Refresh a creator's last-post dates from ScrapeCreators. Falls back to the
 * cached value per platform when the API fails so a flaky call never turns
 * into a false "you haven't posted" nudge.
 */
export async function refreshCreator(creator, apiKey, now = new Date()) {
  const lastPostAt = { ...(creator.lastPostAt || {}) };
  const errors = [];
  let postsLast7 = 0;
  let sawAnyResponse = false;
  const posts = {}; // platform -> [{id, url, date}], only platforms that answered

  for (const platform of PLATFORMS) {
    const handle = creator.handles?.[platform];
    if (!handle) continue;
    try {
      const { dates, posts: found } = await fetchPostDates(platform, handle, apiKey);
      sawAnyResponse = true;
      posts[platform] = found || [];
      if (dates.length) {
        const newest = dates[0];
        const cached = lastPostAt[platform] ? new Date(lastPostAt[platform]) : null;
        if (!cached || newest > cached) lastPostAt[platform] = newest.toISOString();
        const weekAgo = now.getTime() - 7 * 86_400_000;
        postsLast7 += dates.filter((d) => d.getTime() >= weekAgo).length;
      }
    } catch (err) {
      errors.push(`${platform}: ${err.message}`);
    }
  }

  return { lastPostAt, postsLast7, errors, sawAnyResponse, posts };
}

/** Compute status from stored/refreshed data. Pure. */
export function evaluate(creator, lastPostAt, now = new Date()) {
  let newest = null;
  let newestPlatform = null;
  for (const [platform, iso] of Object.entries(lastPostAt || {})) {
    const d = new Date(iso);
    if (!newest || d > newest) {
      newest = d;
      newestPlatform = platform;
    }
  }
  const daysWithout = newest ? daysSince(newest, now) : Infinity;
  const threshold = thresholdDays(creator);
  return {
    lastPost: newest,
    lastPlatform: newestPlatform,
    daysWithout,
    threshold,
    behind: daysWithout >= threshold,
  };
}

/**
 * Run the check for every creator (or a filtered subset).
 * @param {import('discord.js').Client} client
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {boolean} [opts.dryRun]        compute + report, don't message creators
 * @param {string}  [opts.guildId]       only this guild
 * @param {string}  [opts.creatorId]     only this creator
 * @param {boolean} [opts.force]         message even if already reminded today
 * @param {boolean} [opts.feedOnly]      only refresh + forward new posts, no nudges
 * @param {(line: string) => void} [opts.log]
 * @returns {Promise<Array<{guildId, creator, status, reminded, error}>>}
 */
export async function runCheck(client, opts) {
  const { apiKey, dryRun = false, guildId, creatorId, force = false, feedOnly = false, log = console.log } = opts;
  const now = new Date();
  const today = dayKey(now);
  const results = [];

  let targets = allCreators();
  if (guildId) targets = targets.filter((t) => t.guildId === guildId);
  if (creatorId) targets = targets.filter((t) => t.creator.id === creatorId);

  for (const { guildId: gid, creator } of targets) {
    const result = { guildId: gid, creator, status: null, reminded: false, error: null, skipped: null };
    results.push(result);

    if (creator.paused) {
      result.skipped = "paused";
      continue;
    }
    if (!Object.values(creator.handles || {}).some(Boolean)) {
      result.skipped = "no handles";
      continue;
    }

    const refreshed = await refreshCreator(creator, apiKey, now);
    updateCreator(gid, creator.id, {
      lastPostAt: refreshed.lastPostAt,
      lastCheckedAt: now.toISOString(),
      lastError: refreshed.errors.length ? refreshed.errors.join(" | ") : null,
    });

    const status = evaluate(creator, refreshed.lastPostAt, now);
    status.postsLast7 = refreshed.postsLast7;
    result.status = status;

    if (refreshed.errors.length) {
      log(`[${creator.name}] API errors: ${refreshed.errors.join(" | ")}`);
    }

    if (!dryRun) result.posted = await publishNewPosts(client, gid, creator, refreshed.posts, { now, log });
    if (feedOnly || creator.feedOnly) continue;

    if (!status.behind) continue;

    // Never seen a post AND every API call failed -> don't guess.
    if (!status.lastPost && !refreshed.sawAnyResponse) {
      result.skipped = "no data (API failed, nothing cached)";
      continue;
    }

    if (!force && creator.lastRemindedOn === today) {
      result.skipped = "already reminded today";
      continue;
    }

    const text = reminderMessage({
      mention: creator.userId ? `<@${creator.userId}>` : creator.name,
      name: creator.name,
      postsPerWeek: creator.postsPerWeek,
      daysWithout: status.daysWithout,
      lastPostDate: status.lastPost ? fmtDate(status.lastPost) : null,
      lastPlatform: status.lastPlatform,
      postsLast7: refreshed.postsLast7,
      maxGapDays: status.threshold,
    });
    result.text = text;

    if (dryRun) {
      result.skipped = "dry run";
      continue;
    }

    try {
      const channel = await client.channels.fetch(creator.channelId);
      if (!channel || !channel.isTextBased()) throw new Error("channel not found or not text");
      await channel.send({ content: text, allowedMentions: { users: creator.userId ? [creator.userId] : [] } });
      updateCreator(gid, creator.id, { lastRemindedOn: today });
      result.reminded = true;
      log(`[${creator.name}] reminded in #${channel.name ?? creator.channelId}`);
    } catch (err) {
      result.error = err.message;
      log(`[${creator.name}] failed to send: ${err.message}`);
    }
  }

  return results;
}

/** One-line human summary of a check result, for /check and /status output. */
export function describe(result) {
  const { creator, status, reminded, error, skipped } = result;
  if (creator.feedOnly) {
    const last = status?.lastPost ? `last post ${fmtDate(status.lastPost)} (${status.lastPlatform})` : "no posts found";
    return `**${creator.name}** (posts feed only) — ${last}`;
  }
  const head = `**${creator.name}** (${creator.postsPerWeek}x/wk)`;
  if (skipped === "paused") return `${head} — ⏸️ paused`;
  if (skipped === "no handles") return `${head} — ⚠️ no handles linked`;
  if (!status) return `${head} — ?`;
  const last = status.lastPost
    ? `last post ${fmtDate(status.lastPost)}${status.lastPlatform ? ` (${status.lastPlatform})` : ""}`
    : "no posts found";
  const days = Number.isFinite(status.daysWithout) ? `${status.daysWithout}d` : "∞";
  let tail;
  if (error) tail = `❌ send failed: ${error}`;
  else if (reminded) tail = "📨 reminded";
  else if (!status.behind) tail = "✅ on track";
  else if (skipped === "dry run") tail = "🔔 would remind";
  else if (skipped) tail = `🔕 behind, ${skipped}`;
  else tail = "🔔 behind";
  return `${head} — ${last} · ${days} without / limit ${status.threshold}d · ${tail}`;
}
