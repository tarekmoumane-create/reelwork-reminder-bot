// Dump every message from a channel to stdout as JSON lines.
// Usage: node scripts/dump-channel.js <guildId> <channel-name-or-id>
import "dotenv/config";
import { Client, GatewayIntentBits, ChannelType } from "discord.js";

const [guildId, channelArg] = process.argv.slice(2);
if (!guildId || !channelArg) {
  console.error("usage: node scripts/dump-channel.js <guildId> <channel-name-or-id>");
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

client.once("clientReady", async () => {
  try {
    const guild = await client.guilds.fetch(guildId);
    const channels = await guild.channels.fetch();
    const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
    const channel =
      channels.get(channelArg) ||
      [...channels.values()].find((c) => c && c.type === ChannelType.GuildText && norm(c.name) === norm(channelArg));
    if (!channel) {
      console.error("channel not found. text channels:", [...channels.values()].filter((c) => c?.type === ChannelType.GuildText).map((c) => c.name).join(", "));
      process.exit(2);
    }
    console.error(`reading #${channel.name} (${channel.id})`);
    let before;
    const all = [];
    for (;;) {
      const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
      if (!batch.size) break;
      for (const m of batch.values()) all.push(m);
      before = batch.last().id;
      if (batch.size < 100) break;
    }
    all.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    for (const m of all) {
      console.log(
        JSON.stringify({
          id: m.id,
          at: m.createdAt.toISOString(),
          authorId: m.author.id,
          author: m.author.username,
          displayName: m.member?.displayName ?? m.author.globalName ?? m.author.username,
          content: m.content,
          embeds: m.embeds.map((e) => e.url).filter(Boolean),
        })
      );
    }
    console.error(`${all.length} messages`);
  } catch (err) {
    console.error("error:", err.message);
  } finally {
    client.destroy();
  }
});

client.login(process.env.DISCORD_TOKEN);
