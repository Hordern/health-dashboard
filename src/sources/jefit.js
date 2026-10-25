// JEFIT → gym_sessions, via JEFIT's Open Training API (beta, needs Elite).
// Setup: create a READ-ONLY token at jefit.com → Settings → Access tokens and
// set it as JEFIT_TOKEN. Reference: jefit.com/my-jefit/settings/api-tokens/guide

import { query, setSetting } from "../db.js";

const API = "https://www.jefit.com/api/v2";
const LBS_TO_KG = 0.45359237;
const TZ = process.env.TZ ?? "Australia/Melbourne";

async function get(path) {
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${process.env.JEFIT_TOKEN}`, Accept: "application/json" },
  });
  const body = await res.json().catch(() => ({}));
  // JEFIT returns several different refusals as 403; the error field says which.
  if (!res.ok) throw new Error(`JEFIT ${path} → ${res.status} ${body.error ?? ""} ${body.message ?? ""}`.trim());
  return body.data;
}

const ymd = (date) => date.toLocaleDateString("en-CA", { timeZone: TZ });

// Session logs name exercises by global id ("d_…" library, "u_…" custom). One
// call returns every name; the guide says to look ids up, never construct them.
async function exerciseNames() {
  const exercises = await get("/exercises?select=id,name&limit=2000");
  return new Map(exercises.map((e) => [e.id, e.name]));
}

const toKg = (lbs) => Math.round(lbs * LBS_TO_KG * 10) / 10;

// The current routine is the gym plan. Saved as one settings row (it's a single
// document the page shows as-is), with exercise names resolved and weights in kg.
// A day exercise's own exercise_id is a local number, so names come from
// exercise.id, the global id the name map is keyed by.
function gymPlan(routine, names) {
  return {
    name: routine.name,
    days: (routine.days ?? []).map((d) => ({
      name: d.name,
      exercises: (d.day_exercises ?? []).map((de) => ({
        name: names.get(de.exercise?.id) ?? de.exercise?.id ?? "Unknown exercise",
        sets: (de.sets ?? []).map((st) => ({ type: st.type, weight_kg: st.weight_lbs ? toKg(st.weight_lbs) : null, reps: st.reps })),
      })),
    })),
  };
}

// Log sets only include the fields that apply to the exercise's record type.
function toSet(s) {
  return {
    type: s.type,
    ...(s.weight != null && { weight_kg: toKg(s.weight) }),
    ...(s.reps != null && { reps: s.reps }),
    ...(s.duration != null && { duration_s: s.duration }),
    ...(s.distance != null && { distance: s.distance }),
  };
}

export async function syncJefit({ days = 14 } = {}) {
  if (!process.env.JEFIT_TOKEN) throw new Error("JEFIT_TOKEN not set — create a read-only token in JEFIT settings");

  const end = new Date();
  const start = new Date(end - days * 86_400_000);
  // startDate/endDate are epoch seconds. Any other format (YYYY-MM-DD, ms) is
  // silently ignored and returns an empty list rather than an error.
  const epoch = (d) => Math.floor(d.getTime() / 1000);
  const [names, routine, sessions] = await Promise.all([
    exerciseNames(),
    get("/user/current-routine"),
    get(`/user/sessions?startDate=${epoch(start)}&endDate=${epoch(end)}`),
  ]);
  await setSetting("gym_plan", gymPlan(routine, names));

  // Sessions only carry the day's local number, so day names come from the
  // current routine. Days from older routines show without a name.
  const dayNameById = new Map((routine?.days ?? []).map((d) => [d.numeric_local_id, d.name]));

  for (const s of sessions) {
    const exercises = (s.logs ?? []).map((log) => ({
      name: names.get(log.exercise_id) ?? log.exercise_id,
      record_type: log.record_type,
      sets: (log.log_sets ?? []).map(toSet),
    }));
    await query(
      `insert into gym_sessions (id, date, name, exercises, raw) values ($1, $2, $3, $4, $5)
       on conflict (id) do update set date = excluded.date, name = excluded.name,
         exercises = excluded.exercises, raw = excluded.raw`,
      [String(s.local_id), ymd(new Date(s.date * 1000)), dayNameById.get(s.numeric_day_id) ?? null, JSON.stringify(exercises), s],
    );
  }
  return `${sessions.length} sessions from the last ${days} days; plan "${routine.name}"`;
}
