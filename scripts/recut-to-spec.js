// One-off (26 Oct 2026): re-cut the 6-week Reset block into the coach rules
// spec's 3-week structure (2 build + 1 deload), keeping 24 Oct as Day 1 and
// everything before today as history. Daniel chose this when adopting
// docs/coach-rules.md. Prints the new block; pass --apply to write it.
//   npm run recut -- [--apply]

import { pool, query } from "../src/db.js";
import { generateBlock } from "../src/coach/blocks.js";
import { regenerateBlock, updatePlanDay } from "../src/plan/store.js";

const BLOCK = "Reset block";
const today = new Date().toLocaleDateString("en-CA", { timeZone: process.env.TZ ?? "Australia/Melbourne" });

// Week 1's volume = this week's runs as already planned, in minutes: the run
// done on Saturday plus the planned Tue/Thu distances at easy pace.
const [sat] = await query(`select round(sum(duration_s) / 60) as min from activities where type = 'running' and date = '2026-10-24'`);
const block = await generateBlock({
  type: "FITNESS_BASE", start: "2026-10-24", labelPrefix: "B", runsPerWeek: 3,
  firstWeekMin: Number(sat.min) + 25 + 25, prevLongMin: Number(sat.min),
});

for (const w of block.weeks) {
  console.log(`${w.label} ${w.start} ${w.kind} ${w.total_min} min — ` +
    w.days.filter((d) => d.planned_min).map((d) => `${d.date.slice(5)} ${d.planned_min}′ ${d.session}`).join(", "));
}
console.log(`ends ${block.end}, easy pace ${block.pace_min_per_km} min/km`);

if (process.argv.includes("--apply")) {
  const meta = { author: "rules-engine", reason: "Adopted coach rules spec v1: re-cut the Reset block into a 3-week FITNESS_BASE block (2 build + 1 deload), Day 1 kept as 24 Oct" };
  await regenerateBlock(BLOCK, today, block.weeks, {
    end_date: block.end,
    block_type: "FITNESS_BASE",
    summary: "First FITNESS_BASE block under the coach rules spec: two build weeks then a deload week with the 30-minute benchmark. Day 1 was Saturday 24 Oct's 4.17 km run.",
    rules: [
      "All runs easy (avg HR under 148 bpm, excluding the finishing hill), planned by time; km shown is an estimate.",
      "Build weeks +5–7% volume (5% with one recovery flag active); the deload week is 75% of the last build week.",
      "Long run at most 40% of the week while running 3 times a week (30% from 4 runs), and at most +10 min on the previous long run.",
      "Strides once a week on an easy day away from heavy legs.",
      "Daily recovery check: RHR, HRV, sleep, missed runs and pain. Two or more flags hold next week's volume; pain swaps the next run for an easy bike.",
      "Missed runs aren't made up.",
    ],
    success: "At least 80% of planned runs completed (the MISSED flag trips above 20%), and a 30-minute benchmark in the deload week to compare the next block against.",
  }, meta);
  // Saturday's run is history; record its planned time so minute totals add up.
  await updatePlanDay("2026-10-24", { planned_min: Number(sat.min), session: "long" }, { author: "rules-engine", reason: "Re-cut: Day 1 recorded in minutes" });
  console.log("Applied.");
}
await pool.end();
