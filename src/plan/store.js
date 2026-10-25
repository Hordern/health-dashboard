// The running plan's single write path. Every editor — Daniel via claude.ai,
// the nightly coach, other agents through the connector — changes the plan
// through these functions, and each change is logged in plan_changes with its
// author and reason. Reads live in server.js / mcp.js as plain queries.

import { pool, query } from "../db.js";

export const DAY_FIELDS = ["gym", "run_type", "planned_min", "planned_km", "session", "hr_guide", "shoe", "status", "notes"];
export const STATUSES = ["upcoming", "done", "flag", "missed"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const addDays = (isoDate, n) => new Date(Date.parse(isoDate) + n * 86_400_000).toISOString().slice(0, 10);
const weekday = (isoDate) => WEEKDAYS[new Date(isoDate + "T00:00:00Z").getUTCDay()];

function requireMeta({ author, reason } = {}) {
  if (!author?.trim()) throw new Error("author is required (who is making this change)");
  if (!reason?.trim()) throw new Error("reason is required (why this change is being made)");
}

// Runs fn(client) in one transaction, so a multi-step edit lands whole or not at all.
async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}

async function logChange(client, { author, reason }, action, target, before, after) {
  await client.query(
    `insert into plan_changes (author, action, target, before, after, reason) values ($1, $2, $3, $4, $5, $6)`,
    [author, action, target, before && JSON.stringify(before), after && JSON.stringify(after), reason],
  );
}

// Keeps a week's planned total in step with its days after an edit.
async function refreshWeekTotal(client, weekStart) {
  await client.query(
    `update plan_weeks set planned_total_km = (select sum(planned_km) from plan_days where week_start = $1) where start_date = $1`,
    [weekStart],
  );
}

async function applyDayPatch(client, date, patch, meta, action = "update_day") {
  const fields = Object.keys(patch).filter((f) => DAY_FIELDS.includes(f) && patch[f] !== undefined);
  if (!fields.length) throw new Error(`Nothing to change. Editable fields: ${DAY_FIELDS.join(", ")}`);
  if (patch.status && !STATUSES.includes(patch.status)) throw new Error(`status must be one of ${STATUSES.join(", ")}`);

  const [day] = (await client.query(`select * from plan_days where date = $1 for update`, [date])).rows;
  if (!day) throw new Error(`${date} isn't in the plan`);

  const before = Object.fromEntries(fields.map((f) => [f, day[f]]));
  const after = Object.fromEntries(fields.map((f) => [f, patch[f]]));
  await client.query(
    `update plan_days set ${fields.map((f, i) => `${f} = $${i + 2}`).join(", ")}, updated_at = now(), updated_by = $${fields.length + 2}
     where date = $1`,
    [date, ...fields.map((f) => patch[f]), meta.author],
  );
  await refreshWeekTotal(client, day.week_start);
  await logChange(client, meta, action, date, before, after);
  return { date, before, after };
}

// Change any fields of one day, e.g. { planned_km: 3.8 } or { status: "done", notes: "…" }.
export async function updatePlanDay(date, patch, meta) {
  requireMeta(meta);
  return transaction((client) => applyDayPatch(client, date, patch, meta));
}

// Move a run (type, distance, HR guide, shoe) from one day to another day that
// has no run, e.g. Thursday → Wednesday. Gym sessions stay where they are.
export async function moveRun(fromDate, toDate, meta) {
  requireMeta(meta);
  return transaction(async (client) => {
    const [from] = (await client.query(`select * from plan_days where date = $1`, [fromDate])).rows;
    const [to] = (await client.query(`select * from plan_days where date = $1`, [toDate])).rows;
    if (!from?.planned_km) throw new Error(`${fromDate} has no planned run to move`);
    if (!to) throw new Error(`${toDate} isn't in the plan`);
    if (to.planned_km) throw new Error(`${toDate} already has a run`);
    const run = { run_type: from.run_type, planned_km: from.planned_km, hr_guide: from.hr_guide, shoe: from.shoe };
    await applyDayPatch(client, toDate, { ...run, status: "upcoming" }, meta, "move_run");
    await applyDayPatch(client, fromDate, { run_type: null, planned_km: null, hr_guide: null, shoe: null }, meta, "move_run");
    return { moved: run, from: fromDate, to: toDate };
  });
}

// A new training block: its weeks and days are generated from `weeks` (one entry
// per week with run distances by weekday) and become the plan from `start`
// onward. Any existing plan days from that date are replaced; earlier days stay
// as history. The new block becomes the active one.
export async function createBlock(spec, meta) {
  requireMeta(meta);
  const { name, start, summary = null, rules = [], success = null, hr_guide = null, shoe = null, gym_by_weekday = {}, weeks } = spec;
  if (!name || !start || !weeks?.length) throw new Error("name, start and at least one week are required");
  // A block replaces the plan from its start date, so starting in the past would
  // erase days that already happened.
  const todayMelbourne = new Date().toLocaleDateString("en-CA", { timeZone: process.env.TZ ?? "Australia/Melbourne" });
  if (start < todayMelbourne) throw new Error(`start (${start}) can't be in the past; it would overwrite history`);

  return transaction(async (client) => {
    const end = addDays(start, weeks.length * 7 - 1);
    await client.query(`update training_blocks set active = false`);
    await client.query(
      `insert into training_blocks (name, start_date, end_date, summary, rules, success, active) values ($1, $2, $3, $4, $5, $6, true)`,
      [name, start, end, summary, JSON.stringify(rules), success],
    );

    // Hand days from `start` onward to the new block, then tidy up the weeks they came from.
    await client.query(`delete from plan_days where date >= $1`, [start]);
    await client.query(`delete from plan_weeks w where not exists (select 1 from plan_days d where d.week_start = w.start_date)`);
    await client.query(`update plan_weeks w set end_date = (select max(date) from plan_days d where d.week_start = w.start_date)`);

    for (const [i, w] of weeks.entries()) {
      const weekStart = addDays(start, i * 7);
      await client.query(
        `insert into plan_weeks (start_date, end_date, label, planned_total_km, summary, block) values ($1, $2, $3, null, $4, $5)`,
        [weekStart, addDays(weekStart, 6), w.label ?? `Week ${i + 1}`, w.objective ?? null, name],
      );
      for (let d = 0; d < 7; d++) {
        const date = addDays(weekStart, d);
        const km = w.runs?.[weekday(date)] ?? null;
        await client.query(
          `insert into plan_days (date, week_start, gym, run_type, planned_km, hr_guide, shoe, status, updated_at, updated_by)
           values ($1, $2, $3, $4, $5, $6, $7, 'upcoming', now(), $8)`,
          [date, weekStart, gym_by_weekday[weekday(date)] ?? null, km ? "Easy" : null, km, km ? hr_guide : null, km ? shoe : null, meta.author],
        );
      }
      await refreshWeekTotal(client, weekStart);
    }
    await logChange(client, meta, "create_block", name, null, spec);
    return { name, start, end, weeks: weeks.length };
  });
}

// Writes generated weeks (from src/coach/blocks.js: dated days in minutes) into
// a block from `fromDate` onward, replacing that block's days from that date.
async function writeGeneratedWeeks(client, name, fromDate, weeks, author) {
  await client.query(`delete from plan_days d using plan_weeks w where d.week_start = w.start_date and w.block = $1 and d.date >= $2`, [name, fromDate]);
  await client.query(`delete from plan_weeks w where w.block = $1 and not exists (select 1 from plan_days d where d.week_start = w.start_date)`, [name]);
  for (const w of weeks) {
    await client.query(
      `insert into plan_weeks (start_date, end_date, label, planned_total_km, summary, block, kind) values ($1, $2, $3, null, $4, $5, $6)
       on conflict (start_date) do update set end_date = excluded.end_date, label = excluded.label, summary = excluded.summary, block = excluded.block, kind = excluded.kind`,
      [w.start, addDays(w.start, 6), w.label, w.objective ?? null, name, w.kind ?? null],
    );
    for (const d of w.days.filter((day) => day.date >= fromDate)) {
      await client.query(
        `insert into plan_days (date, week_start, gym, run_type, planned_min, planned_km, session, hr_guide, shoe, notes, status, updated_at, updated_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'upcoming', now(), $11)`,
        [d.date, w.start, d.gym ?? null, d.run_type ?? null, d.planned_min ?? null, d.planned_km ?? null, d.session ?? null,
          d.hr_guide ?? null, d.shoe ?? null, d.notes ?? null, author],
      );
    }
    await refreshWeekTotal(client, w.start);
  }
}

// Rewrites a block from `fromDate` onward with generated weeks. Days before
// `fromDate` are kept as history, so a block can be re-cut part-way through.
// `blockPatch` can set the block's end_date, block_type, summary, rules, success.
export async function regenerateBlock(name, fromDate, weeks, blockPatch, meta) {
  requireMeta(meta);
  return transaction(async (client) => {
    const [block] = (await client.query(`select * from training_blocks where name = $1 for update`, [name])).rows;
    if (!block) throw new Error(`No block called "${name}"`);
    await writeGeneratedWeeks(client, name, fromDate, weeks, meta.author);
    const fields = ["end_date", "block_type", "summary", "rules", "success"].filter((f) => blockPatch?.[f] !== undefined);
    if (fields.length) {
      const value = (f) => (f === "rules" ? JSON.stringify(blockPatch[f]) : blockPatch[f]);
      await client.query(`update training_blocks set ${fields.map((f, i) => `${f} = $${i + 2}`).join(", ")} where name = $1`, [name, ...fields.map(value)]);
    }
    await logChange(client, meta, "regenerate_block", `${name} from ${fromDate}`,
      { end_date: block.end_date, block_type: block.block_type },
      { ...blockPatch, weeks: weeks.map((w) => `${w.label} ${w.start} ${w.total_min} min`) });
    return { name, from: fromDate, weeks: weeks.length };
  });
}

// Starts a new block from engine output (the planning chat's lock-in). It
// becomes the active block and owns every plan day from its start date; any
// later days of the previous block are dropped (earlier days stay as history).
export async function startBlock({ name, block_type, generated, summary = null, rules = [], success = null }, meta) {
  requireMeta(meta);
  const todayMelbourne = new Date().toLocaleDateString("en-CA", { timeZone: process.env.TZ ?? "Australia/Melbourne" });
  if (generated.start < todayMelbourne) throw new Error(`start (${generated.start}) can't be in the past; it would overwrite history`);
  return transaction(async (client) => {
    await client.query(`update training_blocks set active = false`);
    await client.query(
      `insert into training_blocks (name, start_date, end_date, summary, rules, success, active, block_type) values ($1, $2, $3, $4, $5, $6, true, $7)`,
      [name, generated.start, generated.end, summary, JSON.stringify(rules), success, block_type],
    );
    await client.query(`delete from plan_days where date >= $1`, [generated.start]);
    await client.query(`delete from plan_weeks w where not exists (select 1 from plan_days d where d.week_start = w.start_date)`);
    await client.query(`update plan_weeks w set end_date = (select max(date) from plan_days d where d.week_start = w.start_date)`);
    await client.query(`update training_blocks b set end_date = least(b.end_date, $1::date - 1) where name <> $2 and end_date >= $1`, [generated.start, name]);
    await writeGeneratedWeeks(client, name, generated.start, generated.weeks, meta.author);
    await logChange(client, meta, "start_block", name, null,
      { block_type, start: generated.start, end: generated.end, weeks: generated.weeks.map((w) => `${w.label} ${w.total_min} min`) });
    return { name, start: generated.start, end: generated.end };
  });
}

// Edit a block's description, rules, success measure or which block is active.
export async function updateBlock(name, patch, meta) {
  requireMeta(meta);
  const fields = ["summary", "rules", "success", "active"].filter((f) => patch[f] !== undefined);
  if (!fields.length) throw new Error("Nothing to change. Editable fields: summary, rules, success, active");
  return transaction(async (client) => {
    const [block] = (await client.query(`select * from training_blocks where name = $1 for update`, [name])).rows;
    if (!block) throw new Error(`No block called "${name}"`);
    if (patch.active) await client.query(`update training_blocks set active = false`);
    const value = (f) => (f === "rules" ? JSON.stringify(patch[f]) : patch[f]);
    await client.query(
      `update training_blocks set ${fields.map((f, i) => `${f} = $${i + 2}`).join(", ")} where name = $1`,
      [name, ...fields.map(value)],
    );
    const before = Object.fromEntries(fields.map((f) => [f, block[f]]));
    const after = Object.fromEntries(fields.map((f) => [f, patch[f]]));
    await logChange(client, meta, "update_block", name, before, after);
    return { name, before, after };
  });
}

// The lifting plan is free text (markdown) that Daniel or an agent maintains.
export async function setLiftingPlan(text, meta) {
  requireMeta(meta);
  return transaction(async (client) => {
    const [old] = (await client.query(`select value from settings where key = 'lifting_plan'`)).rows;
    const value = { text, updated_at: new Date().toISOString(), updated_by: meta.author };
    await client.query(
      `insert into settings (key, value, updated_at) values ('lifting_plan', $1, now())
       on conflict (key) do update set value = excluded.value, updated_at = now()`,
      [JSON.stringify(value)],
    );
    await logChange(client, meta, "set_lifting_plan", "lifting_plan", old ? { text: old.value.text } : null, { text });
    return value;
  });
}

export async function activeBlock() {
  const [block] = await query(
    `select name, block_type, start_date::text as start, end_date::text as "end", summary, rules, success, review, review_at from training_blocks where active`);
  return block ?? null;
}

export async function recentChanges(limit = 20) {
  return query(`select at, author, action, target, before, after, reason from plan_changes order by at desc limit $1`, [limit]);
}
