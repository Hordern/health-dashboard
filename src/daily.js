// Scheduled job (Railway cron, see src/schedule.js): sync every source, then on
// the 7pm run also the rules engine's readiness check and the nightly coach.
// A failing step is recorded in sync_runs and skipped, never fatal.

import { pool, query, recordSync } from "./db.js";
import { syncData } from "./sync.js";
import { dailyReadiness } from "./coach/readiness.js";
import { runNightlyCoach } from "./coach/nightly-coach.js";
import { COACH_HOUR_LOCAL, localDate, localHour } from "./schedule.js";
import { activeBlock } from "./plan/store.js";
import { blockStatus } from "./plan/status.js";
import { reviewBlock } from "./coach/review.js";
import { checkLifting } from "./lifting/coach.js";

await syncData();

// Coach runs once a day: on the 7pm sync, or the 10pm one if 7pm failed.
const today = localDate();
const [{ done }] = await query(
  `select count(*) > 0 as done from sync_runs where source = 'coach' and ok and (started_at at time zone $2)::date = $1`,
  [today, process.env.TZ ?? "Australia/Melbourne"],
);
if (localHour() >= COACH_HOUR_LOCAL && !done) {
  await recordSync("rules", async () => {
    const r = await dailyReadiness(today);
    return `${r.flags.length} flags${r.flags.length ? ` (${r.flags.map((f) => f.flag).join(", ")})` : ""}; ${r.actions.join("; ") || "no actions"}`;
  });
  // End-of-block review (spec §5, §8): on the block's last day, or early if it
  // has stalled. Saved on the block; the coach explains it and the dashboard
  // offers "Plan next block" with the recommendation.
  await recordSync("review", async () => {
    const block = await activeBlock();
    if (!block || block.review) return "no review due";
    const status = await blockStatus(block, today);
    if (today < block.end && !status.new_plan_due) return `not due (block ends ${block.end})`;
    const review = await reviewBlock({ ...block, end: today < block.end ? today : block.end });
    await query(`update training_blocks set review = $2, review_at = now() where name = $1`, [block.name, JSON.stringify(review)]);
    return `${review.progress} / ${review.recovery} → ${review.decision}; recommends ${review.recommended_block.type}`;
  });
  await recordSync("lifting", () => checkLifting());
  await recordSync("coach", () => runNightlyCoach());
}

await pool.end();
