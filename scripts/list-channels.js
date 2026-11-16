// List text channels (with category) for a guild. Usage: node scripts/list-channels.js <guildId>
import "dotenv/config";
import { Client, GatewayIntentBits, ChannelType } from "discord.js";
const guildId = process.argv[2];
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.once("clientReady", async () => {
  const guild = await client.guilds.fetch(guildId);
  const channels = await guild.channels.fetch();
  const out = [...channels.values()]
    .filter((c) => c && c.type === ChannelType.GuildText)
    .map((c) => ({ id: c.id, name: c.name, category: c.parent?.name ?? null, pos: c.rawPosition }))
    .sort((a, b) => (a.category ?? "").localeCompare(b.category ?? "") || a.pos - b.pos);
  for (const c of out) console.log(`${(c.category ?? "-").padEnd(16)} #${c.name}  ${c.id}`);
  client.destroy();
});
client.login(process.env.DISCORD_TOKEN);
