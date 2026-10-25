// When things run. Railway's cron for the daily service must match CRON_UTC
// (it's set on the service, not read from here). Times are UTC, so Melbourne
// times shift an hour earlier when daylight saving ends in April.
//   6am, 9am, 3pm, 7pm, 10pm Melbourne (AEDT, UTC+11): data syncs
//   7pm: also the rules engine + nightly coach, so the note is ready to read
export const CRON_UTC = "0 4,8,11,19,22 * * *";
const SYNC_HOURS_UTC = [4, 8, 11, 19, 22];
export const COACH_HOUR_LOCAL = 19;
const TZ = process.env.TZ ?? "Australia/Melbourne";

export const localDate = (d = new Date()) => d.toLocaleDateString("en-CA", { timeZone: TZ });
export const localHour = (d = new Date()) => Number(d.toLocaleString("en-GB", { timeZone: TZ, hour: "2-digit", hour12: false }));

// The next scheduled sync after `now`, as an ISO timestamp.
export function nextSync(now = new Date()) {
  for (let day = 0; day < 2; day++) {
    for (const h of SYNC_HOURS_UTC) {
      const t = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + day, h));
      if (t > now) return t.toISOString();
    }
  }
  return null;
}
