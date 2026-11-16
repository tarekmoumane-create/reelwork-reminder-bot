// Reminder copy. Edit freely — keep it gentle. `ctx` has:
//   mention        "<@userId>" or the creator's name
//   name           creator display name
//   postsPerWeek   their target
//   daysWithout    whole days since their last post (Infinity if never seen)
//   lastPostDate   "Mon, Sep 7" or null
//   lastPlatform   "tiktok" | "instagram" | "youtube" | "threads" | null
//   postsLast7     posts we saw in the trailing 7 days
//   maxGapDays     the threshold that fired

const PLATFORM_LABEL = {
  tiktok: "TikTok",
  instagram: "Instagram",
  youtube: "YouTube",
  threads: "Threads",
};

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function reminderMessage(ctx) {
  const { mention, postsPerWeek, daysWithout, lastPostDate, lastPlatform, postsLast7 } = ctx;
  const plat = lastPlatform ? PLATFORM_LABEL[lastPlatform] : null;

  const openers = ["Hey", "Hi", "Heyy"];
  const closers = [
    "No stress, just keeping the momentum going 💪",
    "You've got this 🙌",
    "Appreciate you 🙏",
    "Consistency is everything, let's keep it rolling ✨",
  ];

  let body;
  if (postsPerWeek >= 7) {
    // Daily poster who hasn't posted today.
    body = `Gentle nudge 👋 We haven't spotted a post from you today yet. You're on a daily schedule, so if you've got one ready, now's a great time to get it up!`;
  } else if (!Number.isFinite(daysWithout)) {
    body = `Gentle nudge 👋 We couldn't find any recent posts on your linked accounts. You're set for **${postsPerWeek}x a week**, so whenever you get a chance, let's get one up!`;
  } else {
    const since = lastPostDate ? ` (last one was ${lastPostDate}${plat ? ` on ${plat}` : ""})` : "";
    body = `Gentle nudge 👋 It's been **${daysWithout} days** since your last post${since}. You're set for **${postsPerWeek}x a week**, so whenever you get a chance, let's get one up!`;
  }

  const tally =
    Number.isFinite(postsLast7) && postsPerWeek < 7
      ? `\n-# Last 7 days: ${postsLast7} post${postsLast7 === 1 ? "" : "s"} · target ${postsPerWeek}`
      : "";

  const footnote = `\n-# If you already posted, ignore this. It can take a little while for us to see new posts.`;

  return `${pickRandom(openers)} ${mention}! ${body} ${pickRandom(closers)}${tally}${footnote}`;
}
