// The nightly coach: one Claude call with the coaching rules (CLAUDE.md, from
// import-plan), the active block and six weeks of data. It returns, as checked
// structured output:
//   - the day's note for the dashboard,
//   - a review (status + comment) for each run day that has passed unreviewed,
//   - any distance changes to upcoming runs, each with a reason.
// Reviews and changes go through src/plan/store.js like every other edit, so
// they appear in the plan's change log as "nightly-coach".

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import * as z from "zod";
import { getSetting, query } from "../db.js";
import { activeBlock, recentChanges, updatePlanDay } from "../plan/store.js";
import { blockStatus } from "../plan/status.js";

const MODEL = process.env.CLAUDE_MODEL ?? "claude-opus-5-5";
const AUTHOR = "nightly-coach";

const Output = z.object({
  note: z.string().describe("Today's coaching note for the dashboard, markdown, under 250 words"),
  run_reviews: z.array(z.object({
    date: z.string().describe("YYYY-MM-DD of a past plan day listed in reviewable_days"),
    status: z.enum(["done", "flag", "missed"]).describe("done = as planned; flag = happened but needs attention (over distance, HR well over guide…); missed = didn't happen"),
    comment: z.string().describe("The coach's comment on that day, one to three sentences, facts from the data"),
  })),
  plan_changes: z.array(z.object({
    date: z.string().describe("YYYY-MM-DD of an upcoming planned run"),
    planned_km: z.number().describe("New distance; 0 removes the run"),
    reason: z.string(),
  })).describe("Only when the block rules or recovery data call for it. Usually empty."),
});

const today = () => new Date().toLocaleDateString("en-CA", { timeZone: process.env.TZ ?? "Australia/Melbourne" });

async function context(day) {
  const since = "current_date - 42";
  return {
    active_block: await activeBlock(),
    // on_track / at_risk / stalled / ended, with runs done per block week.
    block_status: await blockStatus(await activeBlock(), day),
    plan_this_week_and_next: await query(`select date::text, gym, run_type, planned_km, hr_guide, shoe, status, notes from plan_days where date between current_date - 7 and current_date + 14 order by date`),
    // Past run days nobody has reviewed yet. Days someone already commented on are left alone.
    reviewable_days: await query(`select date::text, run_type, planned_km from plan_days where date < $1 and date >= current_date - 7 and planned_km > 0 and status = 'upcoming' order by date`, [day]),
    recent_plan_changes: await recentChanges(10),
    activities: await query(`select start_local::text, type, name, distance_km, duration_s, avg_hr, max_hr, elevation_gain_m, training_effect_label
                             from activities where date >= ${since} order by start_local`),
    health: await query(`select date::text, resting_hr, hrv_last_night, hrv_status, readiness_score, readiness_level, acute_load,
                                sleep_score, sleep_s, deep_s, rem_s from health_daily where date >= ${since} order by date`),
    weights: await query(`select measured_at::text, weight_kg from weights where measured_at >= ${since} order by measured_at`),
    gym_sessions: await query(`select date::text, name, exercises from gym_sessions where date >= current_date - 14 order by date`),
    previous_notes: await query(`select date::text, body from coaching_notes where date >= current_date - 7 order by date`),
  };
}

export async function runNightlyCoach() {
  const [instructions, profile] = await Promise.all([getSetting("coach_instructions"), getSetting("athlete_profile")]);
  if (!instructions) throw new Error("Coach instructions missing — run `npm run import-plan` first");

  const day = today();
  const data = await context(day);
  const response = await new Anthropic().messages.parse({
    model: MODEL,
    max_tokens: 16000,
    output_config: { effort: "medium", format: zodOutputFormat(Output) },
    // Stable instructions first so they're cached; today's data goes in the message.
    system: [
      { type: "text", text: instructions },
      { type: "text", text: `# Athlete profile\n\n${profile ?? "(not imported)"}`, cache_control: { type: "ephemeral" } },
      { type: "text", text: "The running plan now lives in the dashboard database, not CURRENT_PLAN.md. You review runs and adjust upcoming distances through your structured output; Daniel and other agents can also edit the plan, and recent_plan_changes shows what they changed and why. Respect the active block's rules. If block_status says a new plan is due (stalled or ended), say so in the note and tell Daniel to press 'Plan next block' on the dashboard; don't redesign the block yourself." },
    ],
    messages: [{
      role: "user",
      content:
        `Today is ${day}. 1) Review each day in reviewable_days against the Garmin activities and recovery data. ` +
        `2) Write today's note: what happened since the last note, how recovery looks, and the next planned session. ` +
        `3) Only if the block rules or recovery data call for it, change upcoming run distances (with a reason). ` +
        `Facts come only from the JSON below; say so when data is missing rather than guessing. ` +
        `Anything that needs Daniel's decision goes in the note as a question, not as a plan change.\n\n` +
        "```json\n" + JSON.stringify(data) + "\n```",
    }],
  });

  if (response.stop_reason === "refusal") throw new Error(`Claude declined: ${response.stop_details?.category ?? "unknown"}`);
  const out = response.parsed_output;
  if (!out) throw new Error(`No structured output (stop_reason ${response.stop_reason})`);

  await query(
    `insert into coaching_notes (date, model, body) values ($1, $2, $3)
     on conflict (date) do update set model = excluded.model, body = excluded.body, created_at = now()`,
    [day, response.model, out.note.trim()],
  );

  // Apply only what the coach is allowed to touch; anything else is reported, not applied.
  const reviewable = new Set(data.reviewable_days.map((d) => d.date));
  const skipped = [];
  let reviewed = 0, changed = 0;
  for (const r of out.run_reviews) {
    if (!reviewable.has(r.date)) { skipped.push(`review ${r.date}`); continue; }
    await updatePlanDay(r.date, { status: r.status, notes: r.comment }, { author: AUTHOR, reason: "Run review" });
    reviewed++;
  }
  for (const c of out.plan_changes) {
    if (c.date <= day) { skipped.push(`change ${c.date} (not upcoming)`); continue; }
    const patch = c.planned_km > 0 ? { planned_km: c.planned_km } : { planned_km: null, run_type: null, hr_guide: null, shoe: null };
    try {
      await updatePlanDay(c.date, patch, { author: AUTHOR, reason: c.reason });
      changed++;
    } catch (err) {
      skipped.push(`change ${c.date}: ${err.message}`);
    }
  }

  return `note ${out.note.length} chars, ${reviewed} run reviews, ${changed} plan changes` +
    (skipped.length ? `, skipped: ${skipped.join("; ")}` : "") +
    `; ${response.usage.input_tokens} in / ${response.usage.output_tokens} out`;
}
