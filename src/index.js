import "dotenv/config";
import { Client, GatewayIntentBits, REST, Routes, Events, MessageFlags } from "discord.js";
import { commandDefinitions, handleAutocomplete, handleCommand } from "./commands.js";
import { runCheck, describe } from "./reminders.js";
import { getState, setLastRunDay, setLastFeedAt } from "./store.js";
import { dayKey, zonedParts, REMINDER_HOUR, TZ, fmtReminderTime } from "./time.js";

const TOKEN = process.env.DISCORD_TOKEN;
const API_KEY = process.env.SCRAPECREATORS_API_KEY || "";
const args = new Set(process.argv.slice(2));

if (!TOKEN) {
  console.error("DISCORD_TOKEN is missing. Copy .env.example to .env and fill it in.");
  process.exit(1);
}
if (!API_KEY) console.warn("SCRAPECREATORS_API_KEY is empty — checks will fail until it's set.");

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ---------- slash command registration (per guild = instant) ----------

async function registerCommands(guildId) {
  const rest = new REST().setToken(TOKEN);
  await rest.put(Routes.applicationGuildCommands(client.user.id, guildId), { body: commandDefinitions });
}

async function registerEverywhere() {
  for (const g of client.guilds.cache.values()) {
    try {
      await registerCommands(g.id);
      console.log(`Commands registered in ${g.name} (${g.id})`);
    } catch (err) {
      console.error(`Failed to register commands in ${g.name}: ${err.message}`);
    }
  }
}

// ---------- scheduler ----------
// Every minute: if it's at/after REMINDER_HOUR in TZ and we haven't run today,
// run. This also catches up if the bot was offline at the exact hour.

let running = false;

async function scheduledTick() {
  if (running) return;
  const now = new Date();
  const { hour } = zonedParts(now);
  const today = dayKey(now);
  if (hour < REMINDER_HOUR) return;
  if (getState().lastRunDay === today) return;

  running = true;
  console.log(`[${now.toISOString()}] Daily check starting (${today} ${TZ})`);
  try {
    const results = await runCheck(client, { apiKey: API_KEY });
    for (const r of results) console.log("  " + describe(r).replace(/\*\*/g, ""));
    setLastRunDay(today);
    setLastFeedAt(new Date().toISOString());
    console.log(`Daily check done: ${results.filter((r) => r.reminded).length} reminded, ${results.length} checked`);
  } catch (err) {
    console.error("Daily check crashed:", err);
  } finally {
    running = false;
  }
}

// Posts feed: every FEED_INTERVAL_HOURS, look for new posts and forward them to
// each server's posts channel (/config posts_channel). No nudges on these sweeps.

const FEED_INTERVAL_HOURS = Number(process.env.FEED_INTERVAL_HOURS) > 0 ? Number(process.env.FEED_INTERVAL_HOURS) : 4;

async function feedTick() {
  if (running) return;
  const last = getState().lastFeedAt ? new Date(getState().lastFeedAt).getTime() : 0;
  if (Date.now() - last < FEED_INTERVAL_HOURS * 3_600_000) return;

  running = true;
  try {
    const results = await runCheck(client, { apiKey: API_KEY, feedOnly: true });
    setLastFeedAt(new Date().toISOString());
    const posted = results.reduce((n, r) => n + (r.posted || 0), 0);
    console.log(`[${new Date().toISOString()}] Feed sweep done: ${posted} new post(s) forwarded, ${results.length} checked`);
  } catch (err) {
    console.error("Feed sweep crashed:", err);
  } finally {
    running = false;
  }
}

// ---------- events ----------

client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag}. Daily check at ${fmtReminderTime()}.`);
  await registerEverywhere();

  if (args.has("--check-now")) {
    const dryRun = args.has("--dry-run");
    console.log(`Running check now (dryRun=${dryRun})…`);
    const results = await runCheck(client, { apiKey: API_KEY, dryRun });
    for (const r of results) {
      console.log("  " + describe(r).replace(/\*\*/g, ""));
      if (r.text && dryRun) console.log("    preview: " + r.text.replace(/\n/g, "\n             "));
    }
    client.destroy();
    process.exit(0);
  }

  setInterval(async () => {
    await scheduledTick();
    await feedTick();
  }, 60_000);
  await scheduledTick();
  await feedTick();
});

client.on(Events.GuildCreate, async (g) => {
  console.log(`Joined ${g.name} (${g.id})`);
  try {
    await registerCommands(g.id);
  } catch (err) {
    console.error(`Failed to register commands in ${g.name}: ${err.message}`);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isAutocomplete()) return await handleAutocomplete(interaction);
    if (interaction.isChatInputCommand()) return await handleCommand(interaction, { apiKey: API_KEY });
  } catch (err) {
    console.error("Interaction error:", err);
    const msg = { content: `Something went wrong: ${err.message}`, flags: MessageFlags.Ephemeral };
    if (interaction.isRepliable()) {
      if (interaction.deferred || interaction.replied) await interaction.editReply(msg).catch(() => {});
      else await interaction.reply(msg).catch(() => {});
    }
  }
});

process.on("unhandledRejection", (err) => console.error("Unhandled rejection:", err));

client.login(TOKEN);
