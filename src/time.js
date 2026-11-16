// Timezone helpers. All "day" math happens in the configured zone (default
// America/New_York) so the 8 PM cutoff and "days since last post" line up
// with the creators' calendar, not the server's.

export const TZ = process.env.TIMEZONE || "America/New_York";
export const REMINDER_HOUR = clampHour(process.env.REMINDER_HOUR, 20);

function clampHour(v, dflt) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : dflt;
}

const partsFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

/** { year, month, day, hour, minute } for `date` in TZ */
export function zonedParts(date = new Date()) {
  const out = {};
  for (const p of partsFmt.formatToParts(date)) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return out;
}

/** "YYYY-MM-DD" for `date` in TZ */
export function dayKey(date = new Date()) {
  const { year, month, day } = zonedParts(date);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Whole calendar days from dayKey a to dayKey b (b - a). */
export function daysBetween(a, b) {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

/** Calendar days (in TZ) since `date`, relative to `now`. Today = 0. */
export function daysSince(date, now = new Date()) {
  return daysBetween(dayKey(date), dayKey(now));
}

/** Human date like "Mon, Sep 7" in TZ */
export function fmtDate(date) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(date);
}

/** e.g. "8 PM ET" */
export function fmtReminderTime() {
  const h = REMINDER_HOUR;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const ampm = h < 12 ? "AM" : "PM";
  const abbr = new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "short" })
    .formatToParts(new Date())
    .find((p) => p.type === "timeZoneName")?.value;
  return `${h12} ${ampm} ${abbr ?? TZ}`;
}
