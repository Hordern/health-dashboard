// Garmin Connect → activities + health_daily.
// One-time setup: `npm run garmin:login` from a laptop stores session tokens in
// settings. The daily sync reuses and refreshes them; no password is stored.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getSetting, query, setSetting } from "../db.js";

const TOKEN_KEY = "garmin_tokens";
const SCRIPT = fileURLToPath(new URL("./garmin_fetch.py", import.meta.url));

export function runGarminScript(mode, input, { interactive = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.PYTHON ?? "python3", [SCRIPT, mode], {
      stdio: [interactive ? "inherit" : "pipe", "pipe", "inherit"],
    });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`garmin_fetch.py ${mode} exited with ${code}`))));
    if (!interactive) child.stdin.end(JSON.stringify(input));
  });
}

const isoDaysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const num = (v) => (typeof v === "number" ? v : null);

// Garmin's raw field paths are undocumented. Check these against the first real
// sync (`npm run garmin:check`); the raw payload is stored, so a fix needs no re-fetch.
export function healthRow(day) {
  const sleep = day.sleep?.dailySleepDTO ?? {};
  // Training readiness is a list of readings through the day; the first is the latest.
  const readiness = Array.isArray(day.readiness) ? day.readiness[0] ?? {} : {};
  return {
    date: day.date,
    resting_hr: num(day.summary?.restingHeartRate),
    hrv_last_night: num(day.hrv?.hrvSummary?.lastNightAvg),
    hrv_status: day.hrv?.hrvSummary?.status ?? null,
    readiness_score: num(readiness.score),
    readiness_level: readiness.level ?? null,
    acute_load: num(readiness.acuteLoad),
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

export async function syncGarmin({ days = 3 } = {}) {
  const tokens = await getSetting(TOKEN_KEY);
  if (!tokens) throw new Error("Garmin not connected yet — run `npm run garmin:login` locally");

  const result = JSON.parse(await runGarminScript("fetch", { tokens, start: isoDaysAgo(days - 1), end: isoDaysAgo(0) }));
  await setSetting(TOKEN_KEY, result.tokens);

  for (const a of result.activities) await upsert("activities", "id", activityRow(a), a);
  for (const d of result.days) await upsert("health_daily", "date", healthRow(d), d);

  const failed = result.days.flatMap((d) => Object.entries(d).filter(([, v]) => v?.error).map(([k]) => `${d.date} ${k}`));
  return `${result.activities.length} activities, ${result.days.length} days` + (failed.length ? `; failed: ${failed.join(", ")}` : "");
}
