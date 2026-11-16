// Slash commands. Admin-only (Manage Server) by default.
//
//   /creator add     name, posts_per_week, [channel], [user], tiktok/instagram/youtube/threads, [max_gap_days]
//   /creator edit    name, any of the above
//   /creator remove  name
//   /creator list
//   /creator pause   name        /creator resume name
//   /status          [name]      last post per platform, days without, threshold
//   /check           [name] [dry_run] [force]   run the reminder check right now
//   /config          [default_posts_per_week]

import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  MessageFlags,
} from "discord.js";
import { HANDLE_PARSERS, PLATFORMS } from "./scrapecreators.js";
import {
  addCreator,
  findCreator,
  guild as guildState,
  listCreators,
  normalizeName,
  removeCreator,
  save,
  updateCreator,
} from "./store.js";
import { runCheck, describe, thresholdDays, evaluate, refreshCreator } from "./reminders.js";
import { fmtDate, fmtReminderTime } from "./time.js";

const handleOptions = (sub) =>
  sub
    .addStringOption((o) => o.setName("tiktok").setDescription("TikTok @handle or profile URL"))
    .addStringOption((o) => o.setName("instagram").setDescription("Instagram @handle or profile URL"))
    .addStringOption((o) => o.setName("youtube").setDescription("YouTube @handle or channel URL (Shorts)"))
    .addStringOption((o) => o.setName("threads").setDescription("Threads @handle or profile URL"));

export const commandDefinitions = [
  new SlashCommandBuilder()
    .setName("creator")
    .setDescription("Manage creators tracked in this server")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) =>
      handleOptions(
        sub
          .setName("add")
          .setDescription("Start tracking a creator")
          .addStringOption((o) =>
            o.setName("name").setDescription("Creator's name (used to find their channel)").setRequired(true)
          )
          .addIntegerOption((o) =>
            o
              .setName("posts_per_week")
              .setDescription("How many posts per week they're expected to make (uses server default if omitted)")
              .setMinValue(1)
              .setMaxValue(21)
          )
          .addChannelOption((o) =>
            o
              .setName("channel")
              .setDescription("Their channel (defaults to the channel matching their name)")
              .addChannelTypes(ChannelType.GuildText)
          )
          .addUserOption((o) => o.setName("user").setDescription("Their Discord account, to @mention them"))
      ).addIntegerOption((o) =>
        o
          .setName("max_gap_days")
          .setDescription("Override: remind after this many days without a post")
          .setMinValue(1)
          .setMaxValue(30)
      )
    )
    .addSubcommand((sub) =>
      handleOptions(
        sub
          .setName("edit")
          .setDescription("Update a creator's schedule, handles, channel or user")
          .addStringOption((o) => o.setName("name").setDescription("Creator to edit").setRequired(true).setAutocomplete(true))
          .addIntegerOption((o) =>
            o.setName("posts_per_week").setDescription("New posts per week").setMinValue(1).setMaxValue(21)
          )
          .addChannelOption((o) =>
            o.setName("channel").setDescription("New channel").addChannelTypes(ChannelType.GuildText)
          )
          .addUserOption((o) => o.setName("user").setDescription("Their Discord account"))
      )
        .addIntegerOption((o) =>
          o.setName("max_gap_days").setDescription("Override days-without-post threshold (0 to clear)").setMinValue(0).setMaxValue(30)
        )
        .addStringOption((o) => o.setName("rename").setDescription("New display name"))
    )
    .addSubcommand((sub) =>
      sub
        .setName("remove")
        .setDescription("Stop tracking a creator")
        .addStringOption((o) => o.setName("name").setDescription("Creator to remove").setRequired(true).setAutocomplete(true))
    )
    .addSubcommand((sub) => sub.setName("list").setDescription("List tracked creators in this server"))
    .addSubcommand((sub) =>
      sub
        .setName("pause")
        .setDescription("Pause reminders for a creator (vacation, etc.)")
        .addStringOption((o) => o.setName("name").setDescription("Creator").setRequired(true).setAutocomplete(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName("resume")
        .setDescription("Resume reminders for a creator")
        .addStringOption((o) => o.setName("name").setDescription("Creator").setRequired(true).setAutocomplete(true))
    ),

  new SlashCommandBuilder()
    .setName("status")
    .setDescription("Show posting status for creators in this server")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((o) => o.setName("name").setDescription("One creator (default: all)").setAutocomplete(true))
    .addBooleanOption((o) => o.setName("refresh").setDescription("Re-fetch from ScrapeCreators now (uses API credits)")),

  new SlashCommandBuilder()
    .setName("check")
    .setDescription("Run the reminder check now for this server")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((o) => o.setName("name").setDescription("One creator (default: all)").setAutocomplete(true))
    .addBooleanOption((o) => o.setName("dry_run").setDescription("Report only, don't message anyone (default: true)"))
    .addBooleanOption((o) => o.setName("force").setDescription("Send even if already reminded today")),

  new SlashCommandBuilder()
    .setName("config")
    .setDescription("Server-wide settings")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addIntegerOption((o) =>
      o
        .setName("default_posts_per_week")
        .setDescription("Used when /creator add omits posts_per_week")
        .setMinValue(1)
        .setMaxValue(21)
    )
    .addChannelOption((o) =>
      o
        .setName("posts_channel")
        .setDescription("Channel where every creator's new posts get dropped")
        .addChannelTypes(ChannelType.GuildText)
    ),
].map((c) => c.toJSON());

// ---------- helpers ----------

const EPHEMERAL = { flags: MessageFlags.Ephemeral };

function parseHandles(interaction) {
  const handles = {};
  const bad = [];
  for (const p of PLATFORMS) {
    const raw = interaction.options.getString(p);
    if (raw == null) continue;
    if (raw.trim() === "" || raw.trim() === "-") {
      handles[p] = null; // explicit clear
      continue;
    }
    const parsed = HANDLE_PARSERS[p](raw);
    if (parsed) handles[p] = parsed;
    else bad.push(`${p}: "${raw}"`);
  }
  return { handles, bad };
}

/** Find a text channel whose name matches the creator's name. */
export function findChannelForName(guild, name) {
  const key = normalizeName(name);
  if (!key) return null;
  const channels = [...guild.channels.cache.values()].filter((c) => c.type === ChannelType.GuildText);
  return (
    channels.find((c) => normalizeName(c.name) === key) ||
    channels.find((c) => normalizeName(c.name).includes(key)) ||
    channels.find((c) => key.includes(normalizeName(c.name)) && normalizeName(c.name).length >= 4) ||
    null
  );
}

function handlesLine(c) {
  const parts = PLATFORMS.filter((p) => c.handles?.[p]).map((p) => `${p}: @${c.handles[p]}`);
  return parts.length ? parts.join(" · ") : "_no handles_";
}

function creatorCard(c) {
  if (c.feedOnly) {
    const st = evaluate(c, c.lastPostAt);
    return [
      `**${c.name}** — posts feed only (no nudges)`,
      handlesLine(c),
      st.lastPost ? `Last post: ${fmtDate(st.lastPost)} (${st.lastPlatform})` : "Last post: _none found yet_",
    ].join("\n");
  }
  const lines = [
    `**${c.name}**${c.paused ? " ⏸️ (paused)" : ""} — ${c.postsPerWeek}x/week · nudge after ${thresholdDays(c)} day${thresholdDays(c) === 1 ? "" : "s"} without a post`,
    `Channel: <#${c.channelId}>${c.userId ? ` · User: <@${c.userId}>` : " · User: _not linked (will use name)_"}`,
    handlesLine(c),
  ];
  const st = evaluate(c, c.lastPostAt);
  if (st.lastPost) {
    lines.push(
      `Last post: ${fmtDate(st.lastPost)} (${st.lastPlatform}) · ${st.daysWithout}d without · ${st.behind ? "🔔 behind" : "✅ on track"}`
    );
  } else if (c.lastCheckedAt) {
    lines.push("Last post: _none found_");
  } else {
    lines.push("Last post: _not checked yet_");
  }
  if (c.lastRemindedOn) lines.push(`Last reminded: ${c.lastRemindedOn}`);
  if (c.lastError) lines.push(`⚠️ Last API error: ${c.lastError.slice(0, 200)}`);
  return lines.join("\n");
}

// ---------- handlers ----------

export async function handleAutocomplete(interaction) {
  const focused = interaction.options.getFocused().toLowerCase();
  const names = listCreators(interaction.guildId)
    .map((c) => c.name)
    .filter((n) => n.toLowerCase().includes(focused))
    .slice(0, 25);
  await interaction.respond(names.map((n) => ({ name: n, value: n })));
}

export async function handleCommand(interaction, ctx) {
  const { apiKey } = ctx;
  if (!interaction.inGuild()) {
    return interaction.reply({ content: "Use this inside a server.", ...EPHEMERAL });
  }
  const guildId = interaction.guildId;
  const name = interaction.commandName;

  if (name === "creator") return handleCreator(interaction, guildId);
  if (name === "config") return handleConfig(interaction, guildId);
  if (name === "status") return handleStatus(interaction, guildId, apiKey);
  if (name === "check") return handleCheck(interaction, guildId, apiKey);
  return interaction.reply({ content: "Unknown command.", ...EPHEMERAL });
}

async function handleCreator(interaction, guildId) {
  const sub = interaction.options.getSubcommand();

  if (sub === "list") {
    const list = listCreators(guildId);
    if (!list.length) {
      return interaction.reply({ content: "No creators tracked here yet. Use `/creator add`.", ...EPHEMERAL });
    }
    const body = list.map(creatorCard).join("\n\n");
    return interaction.reply({ content: body.slice(0, 1990), ...EPHEMERAL });
  }

  if (sub === "add") {
    const displayName = interaction.options.getString("name", true).trim();
    if (findCreator(guildId, displayName)?.name.toLowerCase() === displayName.toLowerCase()) {
      return interaction.reply({ content: `**${displayName}** is already tracked. Use \`/creator edit\`.`, ...EPHEMERAL });
    }
    const g = guildState(guildId);
    const postsPerWeek = interaction.options.getInteger("posts_per_week") ?? g.defaultPostsPerWeek;
    if (!postsPerWeek) {
      return interaction.reply({
        content: "Please pass `posts_per_week`, or set a server default with `/config default_posts_per_week`.",
        ...EPHEMERAL,
      });
    }
    const { handles, bad } = parseHandles(interaction);
    if (bad.length) {
      return interaction.reply({ content: `Couldn't parse: ${bad.join(", ")}`, ...EPHEMERAL });
    }
    if (!Object.values(handles).some(Boolean)) {
      return interaction.reply({
        content: "Add at least one handle (tiktok / instagram / youtube / threads) so I can see their posts.",
        ...EPHEMERAL,
      });
    }
    let channel = interaction.options.getChannel("channel");
    if (!channel) {
      await interaction.guild.channels.fetch().catch(() => {});
      channel = findChannelForName(interaction.guild, displayName);
    }
    if (!channel) {
      return interaction.reply({
        content: `I couldn't find a channel matching **${displayName}**. Pass one with the \`channel\` option.`,
        ...EPHEMERAL,
      });
    }
    const user = interaction.options.getUser("user");
    const maxGapDays = interaction.options.getInteger("max_gap_days");
    const c = addCreator(guildId, {
      name: displayName,
      channelId: channel.id,
      userId: user?.id ?? null,
      postsPerWeek,
      maxGapDays: maxGapDays || null,
      handles,
    });
    return interaction.reply({
      content: `Added! I'll check every day at ${fmtReminderTime()}.\n\n${creatorCard(c)}\n\n-# Tip: run \`/check name:${c.name} dry_run:true\` to test.`,
      ...EPHEMERAL,
    });
  }

  // Everything below needs an existing creator.
  const target = findCreator(guildId, interaction.options.getString("name", true));
  if (!target) {
    return interaction.reply({ content: "No creator by that name here. Try `/creator list`.", ...EPHEMERAL });
  }

  if (sub === "remove") {
    removeCreator(guildId, target.id);
    return interaction.reply({ content: `Removed **${target.name}**.`, ...EPHEMERAL });
  }
  if (sub === "pause") {
    updateCreator(guildId, target.id, { paused: true });
    return interaction.reply({ content: `Paused reminders for **${target.name}**.`, ...EPHEMERAL });
  }
  if (sub === "resume") {
    updateCreator(guildId, target.id, { paused: false });
    return interaction.reply({ content: `Resumed reminders for **${target.name}**.`, ...EPHEMERAL });
  }
  if (sub === "edit") {
    const patch = {};
    const ppw = interaction.options.getInteger("posts_per_week");
    if (ppw) patch.postsPerWeek = ppw;
    const ch = interaction.options.getChannel("channel");
    if (ch) patch.channelId = ch.id;
    const user = interaction.options.getUser("user");
    if (user) patch.userId = user.id;
    const gap = interaction.options.getInteger("max_gap_days");
    if (gap != null) patch.maxGapDays = gap === 0 ? null : gap;
    const rename = interaction.options.getString("rename");
    if (rename) patch.name = rename.trim();
    const { handles, bad } = parseHandles(interaction);
    if (bad.length) return interaction.reply({ content: `Couldn't parse: ${bad.join(", ")}`, ...EPHEMERAL });
    if (Object.keys(handles).length) patch.handles = { ...target.handles, ...handles };
    if (!Object.keys(patch).length) {
      return interaction.reply({ content: "Nothing to change. Pass at least one option.", ...EPHEMERAL });
    }
    const c = updateCreator(guildId, target.id, patch);
    return interaction.reply({ content: `Updated.\n\n${creatorCard(c)}`, ...EPHEMERAL });
  }
}

async function handleConfig(interaction, guildId) {
  const g = guildState(guildId);
  const dflt = interaction.options.getInteger("default_posts_per_week");
  if (dflt) {
    g.defaultPostsPerWeek = dflt;
    save();
  }
  const postsChannel = interaction.options.getChannel("posts_channel");
  if (postsChannel) {
    g.feedChannelId = postsChannel.id;
    save();
  }
  return interaction.reply({
    content: `Server default posts/week: **${g.defaultPostsPerWeek ?? "not set"}**\nPosts channel: ${g.feedChannelId ? `<#${g.feedChannelId}>` : "**not set**"}\nDaily check time: **${fmtReminderTime()}**\nTracked creators: **${listCreators(guildId).length}**`,
    ...EPHEMERAL,
  });
}

async function handleStatus(interaction, guildId, apiKey) {
  const nameOpt = interaction.options.getString("name");
  const refresh = interaction.options.getBoolean("refresh") ?? false;
  let list = listCreators(guildId);
  if (nameOpt) {
    const c = findCreator(guildId, nameOpt);
    if (!c) return interaction.reply({ content: "No creator by that name here.", ...EPHEMERAL });
    list = [c];
  }
  if (!list.length) return interaction.reply({ content: "No creators tracked here yet.", ...EPHEMERAL });

  await interaction.deferReply(EPHEMERAL);
  if (refresh) {
    if (!apiKey) return interaction.editReply("SCRAPECREATORS_API_KEY is not set on the bot.");
    for (const c of list) {
      const r = await refreshCreator(c, apiKey);
      updateCreator(guildId, c.id, {
        lastPostAt: r.lastPostAt,
        lastCheckedAt: new Date().toISOString(),
        lastError: r.errors.length ? r.errors.join(" | ") : null,
      });
    }
    list = nameOpt ? [findCreator(guildId, nameOpt)] : listCreators(guildId);
  }
  return interaction.editReply(list.map(creatorCard).join("\n\n").slice(0, 1990));
}

async function handleCheck(interaction, guildId, apiKey) {
  if (!apiKey) return interaction.reply({ content: "SCRAPECREATORS_API_KEY is not set on the bot.", ...EPHEMERAL });
  const nameOpt = interaction.options.getString("name");
  const dryRun = interaction.options.getBoolean("dry_run") ?? true;
  const force = interaction.options.getBoolean("force") ?? false;
  let creatorId;
  if (nameOpt) {
    const c = findCreator(guildId, nameOpt);
    if (!c) return interaction.reply({ content: "No creator by that name here.", ...EPHEMERAL });
    creatorId = c.id;
  }
  await interaction.deferReply(EPHEMERAL);
  const results = await runCheck(interaction.client, { apiKey, dryRun, guildId, creatorId, force });
  if (!results.length) return interaction.editReply("No creators to check.");
  const lines = results.map(describe);
  const previews = results
    .filter((r) => r.text && dryRun)
    .map((r) => `\n> **Preview for ${r.creator.name}:**\n${r.text.split("\n").map((l) => `> ${l}`).join("\n")}`);
  const head = dryRun ? "🧪 **Dry run** (nobody was messaged)\n" : "📨 **Check complete**\n";
  return interaction.editReply((head + lines.join("\n") + previews.join("\n")).slice(0, 1990));
}
