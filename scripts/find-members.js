// Search guild members by name. Usage: node scripts/find-members.js <guildId> name1 name2 ...
import "dotenv/config";
import { Client, GatewayIntentBits } from "discord.js";
const [guildId, ...names] = process.argv.slice(2);
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.once("clientReady", async () => {
  const guild = await client.guilds.fetch(guildId);
  for (const q of names) {
    const res = await guild.members.search({ query: q, limit: 5 }).catch((e) => e.message);
    if (typeof res === "string") { console.log(`${q} -> ERROR ${res}`); continue; }
    console.log(`${q} -> ${[...res.values()].map((m) => `${m.user.username} (${m.displayName}) ${m.id}`).join(" | ") || "no match"}`);
  }
  client.destroy();
});
client.login(process.env.DISCORD_TOKEN);
