// Bulk-add creators from a JSON file. The running bot holds its own copy of the
// store in memory, so stop it first (or run `launchctl kickstart -k` after).
//
// Usage: node scripts/add-creators.js <guildId> <file.json>
// File: [{ "name", "channelId", "userId"?, "postsPerWeek", "handles": {tiktok?, instagram?, youtube?, threads?} }, ...]
import fs from "node:fs";
import { addCreator, findCreator, updateCreator, listCreators } from "../src/store.js";
import { HANDLE_PARSERS } from "../src/scrapecreators.js";

const [guildId, file] = process.argv.slice(2);
if (!guildId || !file) {
  console.error("usage: node scripts/add-creators.js <guildId> <file.json>");
  process.exit(1);
}
const rows = JSON.parse(fs.readFileSync(file, "utf8"));
for (const r of rows) {
  const handles = {};
  for (const [p, v] of Object.entries(r.handles || {})) {
    if (!v) continue;
    const parsed = HANDLE_PARSERS[p]?.(v);
    if (!parsed) throw new Error(`${r.name}: bad ${p} handle "${v}"`);
    handles[p] = parsed;
  }
  const existing = findCreator(guildId, r.name);
  if (existing && existing.name.toLowerCase() === r.name.toLowerCase()) {
    updateCreator(guildId, existing.id, {
      channelId: r.channelId,
      userId: r.userId ?? existing.userId,
      postsPerWeek: r.postsPerWeek,
      maxGapDays: r.maxGapDays ?? existing.maxGapDays,
      handles: { ...existing.handles, ...handles },
    });
    console.log(`updated ${r.name}`);
  } else {
    const c = addCreator(guildId, {
      name: r.name,
      channelId: r.channelId,
      userId: r.userId ?? null,
      postsPerWeek: r.postsPerWeek,
      maxGapDays: r.maxGapDays ?? null,
      handles,
    });
    if (r.paused) updateCreator(guildId, c.id, { paused: true });
    console.log(`added ${r.name}${r.paused ? " (paused)" : ""}`);
  }
}
console.log(`\n${listCreators(guildId).length} creators now tracked in guild ${guildId}`);
