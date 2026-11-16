// Posts feed: forward every creator's new posts to one channel per server.
//
// Rides on the post lists the reminder check already fetches, so it costs no
// extra API calls. A post is "new" when its id isn't in creator.seenPosts yet.
// The first time we see a platform for a creator we only record what's there,
// so adding someone never floods the channel with their back catalogue.

import { guild as guildState, updateCreator } from "./store.js";

const MAX_AGE_MS = 3 * 86_400_000; // ignore anything older (re-pinned / resurfaced posts)
const SEEN_CAP = 200;

const LABEL = { tiktok: "TikTok", instagram: "Instagram", youtube: "YouTube", threads: "Threads" };

export function feedMessage(creator, platform, post) {
  const when = Math.floor(post.date.getTime() / 1000);
  return `**${creator.name}** posted on ${LABEL[platform] ?? platform} · <t:${when}:R>\n${post.url}`;
}

/**
 * @param {Record<string, Array<{id, url, date}>>} postsByPlatform  only platforms whose fetch succeeded
 * @returns {Promise<number>} how many posts were forwarded
 */
export async function publishNewPosts(client, guildId, creator, postsByPlatform, { now = new Date(), log = console.log } = {}) {
  const channelId = guildState(guildId).feedChannelId;
  const seen = { ...(creator.seenPosts || {}) };
  let channel = null;
  let sent = 0;

  for (const [platform, posts] of Object.entries(postsByPlatform || {})) {
    const firstLook = !seen[platform];
    const known = new Set(seen[platform] || []);
    const fresh = firstLook
      ? []
      : posts
          .filter((p) => !known.has(p.id) && now.getTime() - p.date.getTime() <= MAX_AGE_MS)
          .sort((a, b) => a.date - b.date);

    // Everything that isn't waiting to be forwarded counts as seen.
    for (const p of posts) if (!fresh.includes(p)) known.add(p.id);

    for (const post of fresh) {
      if (channelId) {
        try {
          channel ??= await client.channels.fetch(channelId);
          await channel.send({ content: feedMessage(creator, platform, post), allowedMentions: { parse: [] } });
          sent++;
        } catch (err) {
          // Leave it unseen so it goes out on the next sweep once access is fixed.
          log(`[${creator.name}] couldn't forward ${post.url}: ${err.message}`);
          continue;
        }
      }
      known.add(post.id);
    }
    seen[platform] = [...known].slice(-SEEN_CAP);
  }

  updateCreator(guildId, creator.id, { seenPosts: seen });
  return sent;
}
