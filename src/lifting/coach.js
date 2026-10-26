// Nightly lifting check (7pm, src/daily.js): for each recent JEFIT session not
// yet checked, freeze its comparison with the plan (gym_sessions.plan_check) and
// apply double progression — when every prescribed set reached the top of the
// rep range at the prescribed load, raise that exercise's load by its step.
// Changes go through the logged store as "rules-engine".

import { query } from "../db.js";
import { updateLiftingExercise } from "../plan/store.js";
import { analyseSession, getLiftingPlan } from "./analysis.js";

export async function checkLifting() {
  const plan = await getLiftingPlan();
  if (!plan?.sessions) return "no lifting plan";
  const history = await query(`select id, date::text, name, exercises from gym_sessions where date >= current_date - 70 order by date desc`);
  const unchecked = history.filter((s) => s.date >= new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10));
  const notes = [];
  for (const s of unchecked) {
    const [{ checked }] = await query(`select plan_check is not null as checked from gym_sessions where id = $1`, [s.id]);
    if (checked) continue;
    const result = analyseSession(s, plan, history);
    await query(`update gym_sessions set plan_check = $2 where id = $1`, [s.id, JSON.stringify(result)]);
    notes.push(`${s.date} ${result.plan_session ?? "unmatched"}`);
    for (const e of result.exercises.filter((x) => x.status === "progress_ready" && x.next.load_kg && x.next.load_kg > (x.prescribed.load_kg ?? 0))) {
      await updateLiftingExercise(result.plan_session, e.exercise, { load_kg: e.next.load_kg }, {
        author: "rules-engine",
        reason: `Double progression: every set at the top of ${e.prescribed.reps} at ${e.prescribed.load_kg} kg on ${s.date} (${e.done})`,
      });
      notes.push(`${e.exercise} → ${e.next.load_kg} kg`);
    }
  }
  return notes.length ? notes.join("; ") : "nothing new";
}
