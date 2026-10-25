// Imports the running plan and coach instructions from the Running-Coach folder.
//
//   npm run import-plan -- [path/to/Running-Coach]
//
// Safe to re-run: the plan tables are rebuilt from CURRENT_PLAN.md each time.
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
const statusMark = /^(✅|⚠️|❌)\s*/;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (isoDate, n) => iso(new Date(Date.parse(isoDate) + n * 86_400_000));
const weekday = (isoDate) => WEEKDAYS[new Date(isoDate + "T00:00:00Z").getUTCDay()];

// "24–30 Oct" or "31 Oct – 6 Nov" → the first date, as YYYY-MM-DD.
function parseRangeStart(cell) {
  const m = clean(cell).match(/^(\d{1,2})(?:\s+(\w{3}))?\s*[–-].*?(\w{3})$/);
  if (!m) throw new Error(`Can't read date range "${cell}"`);
  return parseDate(`Xxx ${m[1]} ${m[2] ?? m[3]}`);
}

// The numbered weeks of the original comeback plan ("### Week 7 (…)" + a
// day table with an Actual column). Superseded weeks are skipped.
function parseNumberedWeeks(lines) {
  const weeks = [];
  let week = null;
  let columns = null;

  for (const line of lines) {
    const heading = line.match(/^### (Week \d+)/);
    if (heading) {
      week = /SUPERSEDED/i.test(line) ? null : { label: heading[1], block: "Comeback", plannedTotalKm: null, summary: null, days: [] };
      if (week) weeks.push(week);
      columns = null;
      continue;
    }
    if (/^## /.test(line)) week = null; // a new top-level section ends the week
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
        notes: orNull(clean(actual.replace(statusMark, ""))),
      });
    } else if (columns && !line.startsWith("|")) {
      columns = null;
    }
  }
  return weeks;
}

// A training block section, e.g. "## RESET BLOCK — Day 1 = Sat 24 Oct 2026":
// a block-week table (one row per week, a column per run day) plus an optional
// day-by-day table that carries the gym template and, as days pass, the coach's
// status and comments. Returns null if the plan has no block section.
function parseBlock(lines) {
  const startIdx = lines.findIndex((l) => /^## .*BLOCK.*Day 1 =/i.test(l));
  if (startIdx === -1) return null;
  const endIdx = lines.findIndex((l, i) => i > startIdx && /^## /.test(l));
  const section = lines.slice(startIdx, endIdx === -1 ? undefined : endIdx);

  const title = section[0].replace(/^## /, "").split("—")[0].trim();
  const block = {
    name: title.charAt(0) + title.slice(1).toLowerCase(), // "RESET BLOCK" → "Reset block"
    summary: null, rules: [], success: null, weeks: [],
  };

  const byDate = new Map(); // day-by-day rows, keyed by date
  let table = null; // { kind: "weeks" | "days", columns }
  let inRules = false;
  for (const line of section) {
    if (/^\*\*What this is\.?\*\*/.test(line)) block.summary = clean(line.replace(/^\*\*What this is\.?\*\*/, ""));
    const success = line.match(/\*\*Success measure[^*]*\*\*\s*(.*)/);
    if (success) block.success = clean(success[1]);

    if (/^\*\*Rules for the block/.test(line)) { inRules = true; continue; }
    if (inRules) {
      if (line.startsWith("- ")) { block.rules.push(clean(line.slice(2))); continue; }
      if (line.trim()) inRules = false;
    }

    if (line.startsWith("| Block week")) { table = { kind: "weeks", columns: splitRow(line) }; continue; }
    if (line.startsWith("| Day #")) { table = { kind: "days", columns: splitRow(line) }; continue; }
    if (!table) continue;
    if (!line.startsWith("|")) { table = null; continue; }
    if (/^\|[-| ]+\|$/.test(line)) continue; // header separator

    const cells = Object.fromEntries(splitRow(line).map((c, i) => [table.columns[i], c]));
    if (table.kind === "weeks") {
      const runs = Object.entries(cells)
        .filter(([col]) => /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) run$/.test(col))
        .map(([col, val]) => [col.slice(0, 3), parseKm(val)]);
      block.weeks.push({
        label: clean(cells["Block week"]),
        start: parseRangeStart(cells["Dates (Sat–Fri)"] ?? Object.values(cells)[1]),
        runs: Object.fromEntries(runs),
        totalKm: parseKm(cells.Total ?? ""),
        objective: orNull(clean(cells.Objective ?? "")),
      });
    } else {
      byDate.set(parseDate(cells.Date), cells);
    }
  }

  // The gym template by weekday, taken from whichever day-by-day rows exist.
  const gymByWeekday = {};
  for (const [date, cells] of byDate) gymByWeekday[weekday(date)] ??= orNull(clean(cells["Gym (AM)"] ?? ""));
  const hrGuide = block.rules.join(" ").match(/HR guide <\s*(\d+)\s*bpm/)?.[1];

  const weeks = block.weeks.map((w) => ({
    label: w.label,
    block: block.name,
    plannedTotalKm: w.totalKm,
    summary: w.objective,
    days: Array.from({ length: 7 }, (_, i) => {
      const date = addDays(w.start, i);
      const km = w.runs[weekday(date)] ?? null;
      const row = byDate.get(date);
      const runCell = row?.Run ?? "";
      const status = parseStatus(runCell);
      return {
        date,
        gym: orNull(clean(row?.["Gym (AM)"] ?? "")) ?? gymByWeekday[weekday(date)] ?? null,
        runType: km ? "Easy" : null,
        plannedKm: km,
        hrGuide: km && hrGuide ? `Aim <${hrGuide} bpm` : null,
        shoe: km ? orNull(clean(row?.["Planned shoe"] ?? "")) ?? "Clifton Pro" : null,
        status,
        // Once a day has happened the coach writes its result into the Run cell.
        notes: status === "upcoming" ? null : orNull(clean(runCell.replace(statusMark, ""))),
      };
    }),
  }));

  const first = weeks[0]?.days[0].date;
  const last = weeks.at(-1)?.days.at(-1).date;
  return { info: { name: block.name, start: first, end: last, summary: block.summary, rules: block.rules, success: block.success }, weeks };
}

// All plan weeks in date order. Where a block overlaps an earlier week (the
// reset began on Sat 24 Oct, inside Week 14), the block owns those days.
export function parsePlan(markdown) {
  const lines = markdown.split("\n");
  const block = parseBlock(lines);
  const all = [...parseNumberedWeeks(lines), ...(block?.weeks ?? [])];

  const owner = new Map(); // date → week label; later weeks win
  for (const w of all) for (const d of w.days) owner.set(d.date, w.label);
  const weeks = all
    .map((w) => ({ ...w, days: w.days.filter((d) => owner.get(d.date) === w.label) }))
    .filter((w) => w.days.length > 0)
    .map((w) => ({ ...w, startDate: w.days[0].date, endDate: w.days.at(-1).date }));
  return { weeks, block: block?.info ?? null };
}

async function saveWeek(client, w) {
  await client.query(
    `insert into plan_weeks (start_date, end_date, label, planned_total_km, summary, block)
     values ($1, $2, $3, $4, $5, $6)`,
    [w.startDate, w.endDate, w.label, w.plannedTotalKm, w.summary, w.block],
  );
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
  const { weeks, block } = parsePlan(await read("CURRENT_PLAN.md"));

  // CURRENT_PLAN.md is the source of truth, so the plan tables are rebuilt from
  // it each time (this also drops weeks that were superseded or removed).
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("delete from plan_weeks"); // cascades to plan_days
    for (const w of weeks) await saveWeek(client, w);
    await client.query("commit");
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }

  await setSetting("running_block", block); // the current block's name, dates, rules and success measure
  // The daily analysis uses these as Claude's instructions and athlete context.
  await setSetting("coach_instructions", await read("CLAUDE.md"));
  await setSetting("athlete_profile", await read("ATHLETE_PROFILE.md"));

  for (const w of weeks) console.log(`${w.block} · ${w.label}: ${w.startDate} → ${w.endDate}, ${w.days.length} days, ${w.plannedTotalKm ?? "?"} km planned`);
  if (block) console.log(`Current block: ${block.name}, ${block.start} → ${block.end}, ${block.rules.length} rules`);
  await pool.end();
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
