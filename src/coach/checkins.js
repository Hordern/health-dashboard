// Daniel's daily check-in: pain during running and next morning (0–10) and
// session RPE (1–10). Garmin doesn't record these; the PAIN flag (spec §4)
// depends on them. Saved from the dashboard or by an agent via the connector.

import { query } from "../db.js";

const FIELDS = ["pain_during", "pain_next_morning", "rpe", "note"];

export async function saveCheckin(date, values, author) {
  const fields = FIELDS.filter((f) => values[f] !== undefined && values[f] !== "");
  if (!fields.length) throw new Error(`Nothing to save. Fields: ${FIELDS.join(", ")}`);
  for (const f of ["pain_during", "pain_next_morning"]) {
    if (values[f] != null && !(Number.isInteger(values[f]) && values[f] >= 0 && values[f] <= 10)) throw new Error(`${f} must be 0–10`);
  }
  if (values.rpe != null && !(Number.isInteger(values.rpe) && values.rpe >= 1 && values.rpe <= 10)) throw new Error("rpe must be 1–10");
  await query(
    `insert into checkins (date, ${fields.join(", ")}, updated_by) values ($1, ${fields.map((_, i) => `$${i + 2}`).join(", ")}, $${fields.length + 2})
     on conflict (date) do update set ${fields.map((f) => `${f} = excluded.${f}`).join(", ")}, updated_at = now(), updated_by = excluded.updated_by`,
    [date, ...fields.map((f) => values[f]), author],
  );
  return (await query(`select date::text, pain_during, pain_next_morning, rpe, note from checkins where date = $1`, [date]))[0];
}

export const recentCheckins = (days = 14) =>
  query(`select date::text, pain_during, pain_next_morning, rpe, note from checkins where date >= current_date - $1::int order by date desc`, [days]);
