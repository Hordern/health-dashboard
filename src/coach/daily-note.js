// Writes the day's coaching note: one Claude call with the coach instructions
// (CLAUDE.md, imported by import-plan) and the last six weeks of data.

import Anthropic from "@anthropic-ai/sdk";
import { getSetting, query } from "../db.js";

const MODEL = process.env.CLAUDE_MODEL ?? "claude-opus-5-5";

async function recentData() {
  const since = "current_date - 42";
  return {
    planThisWeekAndNext: await query(`select * from plan_days where date between current_date - 7 and current_date + 7 order by date`),
    activities: await query(`select date, type, name, distance_km, duration_s, avg_hr, max_hr, elevation_gain_m, training_effect_label
                             from activities where date >= ${since} order by start_local`),
    health: await query(`select date, resting_hr, hrv_last_night, hrv_status, readiness_score, readiness_level, acute_load,
                                sleep_score, sleep_s, deep_s, rem_s from health_daily where date >= ${since} order by date`),
    weights: await query(`select measured_at, weight_kg, fat_ratio, muscle_kg from weights where measured_at >= ${since} order by measured_at`),
    gymSessions: await query(`select date, name, exercises from gym_sessions where date >= ${since} order by date`),
    previousNotes: await query(`select date, body from coaching_notes where date >= current_date - 7 order by date`),
  };
}

export async function writeDailyNote() {
  const [instructions, profile] = await Promise.all([getSetting("coach_instructions"), getSetting("athlete_profile")]);
  if (!instructions) throw new Error("Coach instructions missing — run `npm run import-plan` first");

  const today = new Date().toLocaleDateString("en-CA", { timeZone: process.env.TZ ?? "Australia/Melbourne" });
  const client = new Anthropic();
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    output_config: { effort: "medium" },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    // Stable instructions first so they're cached; today's data goes in the message.
    system: [
      { type: "text", text: instructions },
      { type: "text", text: `# Athlete profile\n\n${profile ?? "(not imported)"}`, cache_control: { type: "ephemeral" } },
    ],
    messages: [{
      role: "user",
      content:
        `Today is ${today}. Write today's coaching note for the dashboard: what happened since the last note, ` +
        `how recovery looks, and what the next planned session should be. Be direct and brief (under 250 words). ` +
        `Facts come only from the JSON below; say so when data is missing rather than guessing. ` +
        `Don't rewrite the plan; flag anything that needs a conversation with Daniel instead.\n\n` +
        "```json\n" + JSON.stringify(await recentData()) + "\n```",
    }],
  });

  if (response.stop_reason === "refusal") throw new Error(`Claude declined: ${response.stop_details?.category ?? "unknown"}`);
  const body = response.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
  if (!body) throw new Error(`Empty response (stop_reason ${response.stop_reason})`);

  await query(
    `insert into coaching_notes (date, model, body) values ($1, $2, $3)
     on conflict (date) do update set model = excluded.model, body = excluded.body, created_at = now()`,
    [today, response.model, body],
  );
  return `${body.length} chars, ${response.usage.input_tokens} in / ${response.usage.output_tokens} out`;
}
