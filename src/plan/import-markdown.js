// Imports the running plan and coach instructions from the Running-Coach folder.
//
//   npm run import-plan -- [path/to/Running-Coach]
//
// Safe to re-run: each week in CURRENT_PLAN.md replaces its rows in the database.
// Run it locally (the markdown lives on the laptop) with DATABASE_URL pointing
// at Railway's public Postgres URL.

import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pool, setSetting } from "../db.js";

const coachDir = process.argv[2] ?? path.join(os.homedir(), "Claude/Running-Coach");
const PLAN_YEAR = 2026;
const MONTHS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };

const clean = (s) => s.replace(/\*\*/g, "").replace(/~~.*?~~/g, "").trim();
const orNull = (s) => (!s || s === "—" || s === "-" ? null : s);

function parseDate(dayCell) {
  const m = dayCell.match(/^\w{3} (\d{1,2}) (\w{3})/);
  if (!m) throw new Error(`Can't read date from day cell "${dayCell}"`);
  const month = MONTHS[m[2]];
  const year = month < 7 ? PLAN_YEAR + 1 : PLAN_YEAR; // plan started Jul 2026
  return `${year}-${String(month).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
}

function parseKm(cell) {
  const m = clean(cell).match(/(\d+(?:\.\d+)?)\s*km/);
  return m ? Number(m[1]) : null;
}

function parseStatus(actual) {
  if (actual.startsWith("✅")) return "done";
  if (actual.startsWith("⚠️")) return "flag";
  if (actual.startsWith("❌")) return "missed";
  return "upcoming";
}

const splitRow = (line) => line.split("|").slice(1, -1).map((c) => c.trim());

export function parsePlan(markdown) {
  const weeks = [];
  let week = null;
  let columns = null;

  for (const line of markdown.split("\n")) {
    const heading = line.match(/^### (Week \d+)/);
    if (heading) {
      week = { label: heading[1], plannedTotalKm: null, summary: null, days: [] };
      weeks.push(week);
      columns = null;
      continue;
    }
    if (!week) continue;

    if (week.plannedTotalKm == null && /^\**Total/.test(line)) {
      week.summary = clean(line);
      const m = week.summary.match(/(\d+(?:\.\d+)?)\s*km/);
      week.plannedTotalKm = m ? Number(m[1]) : null;
    } else if (line.startsWith("| Day ")) {
      columns = splitRow(line);
    } else if (columns && /^\| (Mon|Tue|Wed|Thu|Fri|Sat|Sun) /.test(line)) {
      const cells = Object.fromEntries(splitRow(line).map((c, i) => [columns[i], c]));
      const actual = cells.Actual ?? "";
      week.days.push({
        date: parseDate(cells.Day),
        gym: orNull(clean(cells["Gym (AM)"] ?? "")),
        runType: orNull(clean(cells.Run ?? "")),
        plannedKm: parseKm(cells.Distance ?? ""),
        hrGuide: orNull(clean(cells["HR guide (excl. hill)"] ?? "")),
        shoe: orNull(clean(cells.Shoe ?? "")),
        status: parseStatus(actual),
        notes: orNull(clean(actual.replace(/^(✅|⚠️|❌)\s*/, ""))),
      });
    } else if (columns && !line.startsWith("|")) {
      columns = null;
    }
  }

  return weeks
    .filter((w) => w.days.length > 0)
    .map((w) => ({ ...w, startDate: w.days[0].date, endDate: w.days.at(-1).date }));
}

async function saveWeek(client, w) {
  await client.query(
    `insert into plan_weeks (start_date, end_date, label, planned_total_km, summary)
     values ($1, $2, $3, $4, $5)
     on conflict (start_date) do update set end_date = excluded.end_date, label = excluded.label,
       planned_total_km = excluded.planned_total_km, summary = excluded.summary`,
    [w.startDate, w.endDate, w.label, w.plannedTotalKm, w.summary],
  );
  await client.query("delete from plan_days where week_start = $1", [w.startDate]);
  for (const d of w.days) {
    await client.query(
      `insert into plan_days (date, week_start, gym, run_type, planned_km, hr_guide, shoe, status, notes)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [d.date, w.startDate, d.gym, d.runType, d.plannedKm, d.hrGuide, d.shoe, d.status, d.notes],
    );
  }
}

async function main() {
  const read = (name) => readFile(path.join(coachDir, name), "utf8");
  const weeks = parsePlan(await read("CURRENT_PLAN.md"));

  const client = await pool.connect();
  try {
    await client.query("begin");
    for (const w of weeks) await saveWeek(client, w);
    await client.query("commit");
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }

  // The daily analysis uses these as Claude's instructions and athlete context.
  await setSetting("coach_instructions", await read("CLAUDE.md"));
  await setSetting("athlete_profile", await read("ATHLETE_PROFILE.md"));

  for (const w of weeks) console.log(`${w.label}: ${w.startDate} → ${w.endDate}, ${w.days.length} days, ${w.plannedTotalKm ?? "?"} km planned`);
  await pool.end();
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
