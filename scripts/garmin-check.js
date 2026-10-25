// Shows which promoted health/activity columns came back empty after a sync, so a
// wrong Garmin field path is caught instead of silently showing blanks.
//   npm run garmin:check

import { pool, query } from "../src/db.js";

const [health] = await query(`
  select count(*) as days,
         count(resting_hr) as resting_hr, count(hrv_last_night) as hrv_last_night,
         count(readiness_score) as readiness_score, count(acute_load) as acute_load,
         count(sleep_score) as sleep_score, count(sleep_s) as sleep_s
  from health_daily where date > current_date - 7`);
const [acts] = await query(`
  select count(*) as activities, count(distance_km) as distance_km, count(avg_hr) as avg_hr
  from activities where date > current_date - 30 and type = 'running'`);

console.table(health);
console.table(acts);
await pool.end();
