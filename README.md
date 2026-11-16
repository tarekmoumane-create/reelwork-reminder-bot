# Creator Reminder Bot

A Discord bot that checks each creator's TikTok / Instagram / YouTube Shorts / Threads via ScrapeCreators every day at **8 PM ET** and drops a gentle nudge in *their* channel when they've fallen behind their posting schedule.

**The rule:** a creator on `N` posts/week gets `7 - N` rest days. Once they've gone `(7 - N) + 1` whole days without posting, they get a nudge at the 8 PM check.

| Posts / week | Nudge after… |
| --- | --- |
| 7x | 1 day (no post today by 8 PM) |
| 5x | 3 days without a post |
| 3x | 5 days without a post |
| 1x | 7 days without a post |

You can override this per creator with `max_gap_days`. One creator gets at most one nudge per day.

## 1. Create the Discord bot (once)

1. Go to <https://discord.com/developers/applications> → **New Application** → name it (e.g. "Posting Reminder").
2. **Bot** tab → **Reset Token** → copy the token. No privileged intents are needed.
3. **OAuth2 → URL Generator**: scopes `bot` + `applications.commands`; bot permissions **View Channels**, **Send Messages**, **Mention Everyone** (only needed so it can @mention creators). Copy the URL.
4. Open that URL to invite the bot to each client server. Make sure the bot can see the creators' channels (private channels need the bot's role added).

## 2. Configure

```bash
cd "reminder bot"
cp .env.example .env
```

Fill in `.env`:

```
DISCORD_TOKEN=...            # from step 1
SCRAPECREATORS_API_KEY=...   # same key as Reel Trax (Reel Trax → Settings, or scrapecreators.com)
REMINDER_HOUR=20             # 8 PM
TIMEZONE=America/New_York
```

## 3. Run

```bash
npm install
npm start
```

Keep it running with pm2 (`npx pm2 start src/index.js --name reminder-bot`) or host it on Railway / Render / a small VPS. It needs to be online at 8 PM ET; if it was down at 8 PM it runs the check as soon as it comes back up that day.

One-off checks from the terminal:

```bash
npm run dry-run   # fetch + report everyone, message nobody
npm run check     # fetch + actually send reminders
```

## 4. Add creators (in Discord, needs Manage Server)

```
/creator add name:Jess posts_per_week:5 tiktok:@jess.makes instagram:jessmakes user:@Jess
```

- **name** is matched against channel names, so `Jess` finds `#jess`, `#jess-content`, etc. Pass `channel:` to pick one explicitly.
- **user** is optional; if set, the nudge @mentions them, otherwise it uses their name.
- Handles accept `@handle`, bare handle, or a profile URL. Add at least one.
- `posts_per_week` can be omitted if you set a server default with `/config default_posts_per_week:5`.

Other commands:

| Command | What it does |
| --- | --- |
| `/creator list` | Everyone tracked in this server, with last-post info |
| `/creator edit name:Jess posts_per_week:7` | Change schedule, handles, channel, user, or `max_gap_days` (0 clears the override) |
| `/creator pause name:Jess` / `resume` | Skip reminders (vacation etc.) |
| `/creator remove name:Jess` | Stop tracking |
| `/status [name] [refresh]` | Last post per platform, days without, threshold. `refresh:true` re-fetches now |
| `/check [name] [dry_run] [force]` | Run the reminder check immediately. `dry_run` defaults to **true** and shows a preview of the message |
| `/config` | Server default posts/week, check time, count |

All command replies are only visible to you.

## What the nudge looks like

> Hey @Jess! Gentle nudge 👋 It's been **3 days** since your last post (last one was Sat, Sep 6 on TikTok). You're set for **5x a week**, so whenever you get a chance, let's get one up! You've got this 🙌
> Last 7 days: 2 posts · target 5
> If you already posted, ignore this. It can take a little while for us to see new posts.

Edit the copy in `src/messages.js`.

## Notes

- Data lives in `data/creators.json` (one file for all servers). Back it up if you move hosts.
- Every check costs ScrapeCreators credits: one call per linked platform per creator per day (YouTube may add up to 3 extra calls to date undated Shorts).
- If the API fails for a creator, the bot uses the last post date it already knows and logs the error. It never nudges someone it has zero data for.
- Slash commands are registered per server the moment the bot joins, so they show up instantly.
