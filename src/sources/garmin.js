// Garmin Connect → activities + health_daily.
// One-time setup: `npm run garmin:login` from a laptop stores session tokens in
// settings. The daily sync reuses and refreshes them; no password is stored.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { clearSetting, getSetting, query, setSetting } from "../db.js";
import { localDate } from "../schedule.js";

const TOKEN_KEY = "garmin_tokens";
// Set when Garmin rejects the saved session; the dashboard shows a banner while it exists.
export const SIGN_IN_FLAG = "garmin_sign_in_required";
// Exit code garmin_fetch.py uses for a rejected session. Must match the Python side.
const SIGN_IN_REQUIRED = 3;
const SCRIPT = fileURLToPath(new URL("./garmin_fetch.py", import.meta.url));

// Railway's image sets PYTHON. On a laptop, use the project's .venv (created
// with `npm run setup:python`) so garminconnect is found without a global install.
const LOCAL_VENV = fileURLToPath(new URL("../../.venv/bin/python", import.meta.url));
const PYTHON = process.env.PYTHON ?? (existsSync(LOCAL_VENV) ? LOCAL_VENV : "python3");

export function runGarminScript(mode, input, { interactive = false, args = [] } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, [SCRIPT, mode, ...args], {
      stdio: [interactive ? "inherit" : "pipe", "pipe", "inherit"],
    });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolve(out);
      const err = new Error(`garmin_fetch.py ${mode} exited with ${code}`);
      err.exitCode = code;
      reject(err);
    });
    if (!interactive) child.stdin.end(JSON.stringify(input));
  });
}

// Days in local time: before 11am in Melbourne the UTC date is still yesterday,
// so a UTC date would skip this morning's sleep, readiness and body battery.
const isoDaysAgo = (n) => localDate(new Date(Date.now() - n * 86_400_000));
const num = (v) => (typeof v === "number" ? v : null);

// Garmin's raw field paths are undocumented; these were checked against the
// coaching notes for 19–25 Oct 2026. The raw payload is stored, so a mapping fix
// can be re-applied with `npm run garmin:remap` instead of re-fetching.
export function healthRow(day) {
  const sleep = day.sleep?.dailySleepDTO ?? {};
  // Training readiness is a list of readings through the day, newest first. The
  // headline score is the wake-up one (Garmin's morning report); later readings
  // drop after workouts. Acute load comes from the newest, so it includes today's training.
  const readings = Array.isArray(day.readiness) ? day.readiness : [];
  const wake = readings.find((r) => r.inputContext === "AFTER_WAKEUP_RESET") ?? readings.at(-1) ?? {};
  const latest = readings[0] ?? {};
  return {
    date: day.date,
    resting_hr: num(day.summary?.restingHeartRate),
    hrv_last_night: num(day.hrv?.hrvSummary?.lastNightAvg),
    hrv_status: day.hrv?.hrvSummary?.status ?? null,
    readiness_score: num(wake.score),
    readiness_level: wake.level ?? null,
    acute_load: num(latest.acuteLoad),
    body_battery: num(day.summary?.bodyBatteryMostRecentValue),
    body_battery_wake: num(day.summary?.bodyBatteryAtWakeTime),
    body_battery_high: num(day.summary?.bodyBatteryHighestValue),
    body_battery_low: num(day.summary?.bodyBatteryLowestValue),
    sleep_score: num(sleep.sleepScores?.overall?.value),
    sleep_s: num(sleep.sleepTimeSeconds),
    deep_s: num(sleep.deepSleepSeconds),
    light_s: num(sleep.lightSleepSeconds),
    rem_s: num(sleep.remSleepSeconds),
    awake_s: num(sleep.awakeSleepSeconds),
  };
}

export function activityRow(a) {
  return {
    id: a.activityId,
    date: a.startTimeLocal.slice(0, 10),
    start_local: a.startTimeLocal,
    type: a.activityType?.typeKey ?? "unknown",
    name: a.activityName ?? null,
    distance_km: a.distance ? Math.round(a.distance / 10) / 100 : null,
    duration_s: num(a.duration),
    avg_hr: num(a.averageHR) && Math.round(a.averageHR),
    max_hr: num(a.maxHR) && Math.round(a.maxHR),
    elevation_gain_m: num(a.elevationGain),
    training_effect_label: a.trainingEffectLabel ?? null,
  };
}

async function upsert(table, key, row, raw) {
  const cols = [...Object.keys(row), "raw"];
  const values = [...Object.values(row), raw];
  const updates = cols.filter((c) => c !== key).map((c) => `${c} = excluded.${c}`).join(", ");
  await query(
    `insert into ${table} (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")})
     on conflict (${key}) do update set ${updates}`,
    values,
  );
}

export async function syncGarmin({ days = 3, start = isoDaysAgo(days - 1), end = isoDaysAgo(0) } = {}) {
  const tokens = await getSetting(TOKEN_KEY);
  if (!tokens) throw new Error("Garmin not connected yet — run `npm run garmin:login` locally");

  let output;
  try {
    // Runs that already have their full details aren't fetched again.
    const have = await query(`select id from activities where details is not null and date between $1 and $2`, [start, end]);
    output = await runGarminScript("fetch", { tokens, start, end, have_details: have.map((r) => Number(r.id)) });
  } catch (err) {
    // Flag a dead session so the dashboard shows a sign-in banner (see server.js).
    if (err.exitCode === SIGN_IN_REQUIRED) {
      await setSetting(SIGN_IN_FLAG, { since: new Date().toISOString() });
      throw new Error("Garmin session expired — sign in again with `npm run garmin:login`");
    }
    throw err;
  }
  const result = JSON.parse(output);
  await setSetting(TOKEN_KEY, result.tokens);
  await clearSetting(SIGN_IN_FLAG); // the session works, so drop any old banner

  for (const a of result.activities) await upsert("activities", "id", activityRow(a), a);
  for (const d of result.days) await upsert("health_daily", "date", healthRow(d), d);
  for (const [id, details] of Object.entries(result.details ?? {})) {
    await query(`update activities set details = $2 where id = $1`, [id, details]);
  }

  const failed = result.days.flatMap((d) => Object.entries(d).filter(([, v]) => v?.error).map(([k]) => `${d.date} ${k}`));
  const detailed = Object.keys(result.details ?? {}).length;
  return `${result.activities.length} activities, ${result.days.length} days` + (detailed ? `, ${detailed} run details` : "") + (failed.length ? `; failed: ${failed.join(", ")}` : "");
}
