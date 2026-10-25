// Re-applies healthRow() to every stored Garmin day using its saved raw payload.
// Run after changing the field mapping in src/sources/garmin.js; no Garmin calls.
//   npm run garmin:remap

import { pool, query } from "../src/db.js";
import { healthRow } from "../src/sources/garmin.js";

const days = await query("select raw from health_daily");
for (const { raw } of days) {
  const row = healthRow(raw);
  const cols = Object.keys(row).filter((c) => c !== "date");
  await query(
    `update health_daily set ${cols.map((c, i) => `${c} = $${i + 2}`).join(", ")} where date = $1`,
    [row.date, ...cols.map((c) => row[c])],
  );
}
console.log(`Remapped ${days.length} days.`);
await pool.end();
