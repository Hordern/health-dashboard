// Daily job, run by Railway's cron service: pull every source, then write the
// coaching note. A failing source is recorded and skipped, never fatal.

import { pool, recordSync } from "./db.js";
import { syncGarmin } from "./sources/garmin.js";
import { syncWithings } from "./sources/withings.js";
import { syncJefit } from "./sources/jefit.js";
import { runNightlyCoach } from "./coach/nightly-coach.js";

await recordSync("garmin", () => syncGarmin());
await recordSync("withings", () => syncWithings());
await recordSync("jefit", () => syncJefit());
await recordSync("coach", () => runNightlyCoach());

await pool.end();
