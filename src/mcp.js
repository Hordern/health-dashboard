// Claude connector: an MCP server so claude.ai (or any MCP-capable agent) can
// query the dashboard's data and, on the write URL, edit the plan.
//   https://<domain>/mcp/<MCP_KEY>        read-only tools
//   https://<domain>/mcp/<MCP_WRITE_KEY>  read tools + plan editing tools
// Add either in claude.ai → Settings → Connectors → Add custom connector. The
// key in the path is the only access control, so treat each URL like a password.

import pg from "pg";
import * as z from "zod/v4";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { getSetting, query } from "./db.js";
import { blockReview, blockSummary } from "./block.js";
import { DAY_FIELDS, STATUSES, createBlock, moveRun, recentChanges, setLiftingPlan, updateBlock, updatePlanDay } from "./plan/store.js";

const MAX_ROWS = 500; // keeps a tool result small enough for Claude's context

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("YYYY-MM-DD");
const range = { from: date.describe("Start date, YYYY-MM-DD (inclusive)"), to: date.describe("End date, YYYY-MM-DD (inclusive)") };

const json = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const rows = async (sql, params) => json((await query(`${sql} limit ${MAX_ROWS}`, params)));

// Free-form SQL runs as a separate read-only login that has SELECT on the data
// tables only (no access to `settings`, which holds the Garmin/Withings tokens).
// See db/readonly.sql. Being its own login, it can't switch back to the owner role.
let readerPool;
function reader() {
  if (!process.env.READONLY_DB_PASSWORD) return null;
  if (!readerPool) {
    const url = new URL(process.env.DATABASE_URL);
    url.username = "dashboard_reader";
    url.password = process.env.READONLY_DB_PASSWORD;
    readerPool = new pg.Pool({
      connectionString: url.toString(),
      ssl: url.hostname.endsWith(".railway.internal") ? false : { rejectUnauthorized: false },
      max: 2,
      statement_timeout: 5000,
    });
  }
  return readerPool;
}

// Write tools report failures (bad date, missing reason…) back to Claude as a
// tool error it can read and fix, rather than as a protocol error.
const attempt = async (fn) => {
  try {
    return json(await fn());
  } catch (err) {
    return { content: [{ type: "text", text: `Not changed: ${err.message}` }], isError: true };
  }
};
const meta = {
  author: z.string().describe("Who is making the change, e.g. 'Daniel via claude.ai' or 'nightly-coach'"),
  reason: z.string().describe("Why — shown on the dashboard's change log"),
};

function buildServer({ canWrite }) {
  const server = new McpServer({ name: "daniel-health-dashboard", version: "1.1.0" });

  server.registerTool("athlete_context", {
    description: "Daniel's athlete profile and his running coach's rules (progression rules, HR guides, how to review runs). Read this first so answers use the same coaching standards as the dashboard's daily note.",
  }, async () => json({ athlete_profile: await getSetting("athlete_profile"), coaching_rules: await getSetting("coach_instructions") }));

  server.registerTool("block_review", {
    description: "How the training block is going: planned runs done, km vs plan, runs under the 148 bpm easy HR guide, gym sessions/week, average readiness/HRV/resting HR/sleep score, and weight change. With no dates: last 4 weeks, the 4 weeks before, and since the plan started. With from/to: that window only.",
    inputSchema: { from: date.optional(), to: date.optional() },
  }, async ({ from, to }) => json(from && to ? await blockSummary(from, to) : await blockReview()));

  server.registerTool("daily_health", {
    description: "Garmin recovery data per day: resting HR, overnight HRV and status, training readiness (wake-up score) and level, acute training load, sleep score and sleep stage durations in seconds.",
    inputSchema: range,
  }, async ({ from, to }) => rows(
    `select date::text, resting_hr, hrv_last_night, hrv_status, readiness_score, readiness_level, acute_load,
            sleep_score, sleep_s, deep_s, light_s, rem_s, awake_s
     from health_daily where date between $1 and $2 order by date`, [from, to]));

  server.registerTool("activities", {
    description: "Garmin activities (runs, strength sessions, walks…): start time, type, distance km, duration seconds, avg/max HR, elevation gain, Garmin training-effect label. Optionally filter by type, e.g. 'running' or 'strength_training'.",
    inputSchema: { ...range, type: z.string().optional() },
  }, async ({ from, to, type }) => rows(
    `select start_local::text, type, name, distance_km, duration_s, avg_hr, max_hr, elevation_gain_m, training_effect_label
     from activities where date between $1 and $2 and ($3::text is null or type = $3) order by start_local`, [from, to, type ?? null]));

  server.registerTool("gym_sessions", {
    description: "Gym workouts logged in JEFIT: date, routine day name, and each exercise with its sets (weight_kg, reps, set type).",
    inputSchema: range,
  }, async ({ from, to }) => rows(`select date::text, name, exercises from gym_sessions where date between $1 and $2 order by date`, [from, to]));

  server.registerTool("gym_plan", {
    description: "Daniel's current JEFIT routine: each day's exercises with target sets (weight_kg and reps).",
  }, async () => json(await getSetting("gym_plan")));

  server.registerTool("weights", {
    description: "Withings scale weigh-ins: time, weight kg, fat ratio %, muscle kg.",
    inputSchema: range,
  }, async ({ from, to }) => rows(
    `select measured_at::text, weight_kg, fat_ratio, muscle_kg from weights where measured_at::date between $1 and $2 order by measured_at`, [from, to]));

  server.registerTool("running_plan", {
    description: "The running plan from CURRENT_PLAN.md, day by day: planned run type and km, HR guide, shoe, gym session that day, status (done/flag/missed/upcoming), the coach's notes for the day, and actual km from Garmin runs.",
    inputSchema: range,
  }, async ({ from, to }) => rows(
    `select p.date::text, w.label as week, p.gym, p.run_type, p.planned_km, p.hr_guide, p.shoe, p.status, p.notes,
            (select sum(distance_km) from activities a where a.date = p.date and a.type = 'running') as actual_km
     from plan_days p join plan_weeks w on w.start_date = p.week_start
     where p.date between $1 and $2 order by p.date`, [from, to]));

  server.registerTool("training_blocks", {
    description: "Training blocks (e.g. the Reset block): dates, summary, rules, success measure, and which one is active.",
  }, async () => rows(`select name, start_date::text, end_date::text, summary, rules, success, active from training_blocks order by start_date`));

  server.registerTool("plan_changes", {
    description: "The log of edits to the plan: when, who, what changed (before/after) and why. Newest first.",
    inputSchema: { limit: z.number().int().min(1).max(200).default(30) },
  }, async ({ limit }) => json(await recentChanges(limit)));

  server.registerTool("lifting_plan", {
    description: "Daniel's lifting plan (free text he maintains), separate from the JEFIT routine in gym_plan.",
  }, async () => json(await getSetting("lifting_plan")));

  server.registerTool("coaching_notes", {
    description: "The daily coaching notes Claude wrote for the dashboard.",
    inputSchema: range,
  }, async ({ from, to }) => rows(`select date::text, body from coaching_notes where date between $1 and $2 order by date`, [from, to]));

  server.registerTool("sql_query", {
    description: `Run one read-only SQL SELECT (PostgreSQL) for questions the other tools don't cover. Tables: activities(date, start_local, type, name, distance_km, duration_s, avg_hr, max_hr, elevation_gain_m, training_effect_label, raw jsonb), health_daily(date, resting_hr, hrv_last_night, hrv_status, readiness_score, readiness_level, acute_load, sleep_score, sleep_s, deep_s, light_s, rem_s, awake_s, raw jsonb), weights(measured_at, weight_kg, fat_ratio, muscle_kg), gym_sessions(date, name, exercises jsonb [{name, record_type, sets:[{type, weight_kg, reps}]}]), plan_weeks(start_date, end_date, label, planned_total_km, summary), plan_days(date, week_start, gym, run_type, planned_km, hr_guide, shoe, status, notes), coaching_notes(date, body), training_blocks(name, start_date, end_date, summary, rules, success, active), plan_changes(at, author, action, target, before, after, reason). Results are capped at ${MAX_ROWS} rows and 5 seconds.`,
    inputSchema: { sql: z.string().describe("A single SELECT statement") },
  }, async ({ sql }) => {
    const pool = reader();
    if (!pool) return { content: [{ type: "text", text: "SQL access isn't set up (READONLY_DB_PASSWORD missing)." }], isError: true };
    const client = await pool.connect();
    try {
      await client.query("begin read only");
      // A named (prepared) statement can only hold one statement, so a query
      // can't smuggle in a second command after a semicolon.
      const result = await client.query({ name: `q${Date.now()}`, text: sql });
      return json({ rows: result.rows.slice(0, MAX_ROWS), truncated: result.rows.length > MAX_ROWS });
    } catch (err) {
      return { content: [{ type: "text", text: `SQL error: ${err.message}` }], isError: true };
    } finally {
      await client.query("rollback").catch(() => {});
      client.release();
    }
  });

  if (canWrite) registerWriteTools(server);
  return server;
}

// Plan editing. Every call is logged in plan_changes with author and reason
// (see src/plan/store.js), so read the plan first and say why you're changing it.
function registerWriteTools(server) {
  const dayChanges = z.object({
    gym: z.string().nullable().optional(),
    run_type: z.string().nullable().optional().describe("e.g. 'Easy', 'Long', or null for no run"),
    planned_km: z.number().nullable().optional(),
    hr_guide: z.string().nullable().optional().describe("e.g. 'Aim <148 bpm'"),
    shoe: z.string().nullable().optional(),
    status: z.enum(STATUSES).optional(),
    notes: z.string().nullable().optional().describe("The coach's comment for the day"),
  });

  server.registerTool("update_plan_day", {
    description: `Change one day of the running plan. Only the fields given change (${DAY_FIELDS.join(", ")}). Use null to clear a field, e.g. planned_km: null and run_type: null to remove a run.`,
    inputSchema: { date, changes: dayChanges, ...meta },
  }, async ({ date: d, changes, author, reason }) => attempt(() => updatePlanDay(d, changes, { author, reason })));

  server.registerTool("comment_on_run", {
    description: "Record how a planned day went: set its status (done / flag / missed) and the coach's comment. Use after reviewing the day's Garmin data.",
    inputSchema: { date, status: z.enum(["done", "flag", "missed"]), comment: z.string(), author: meta.author },
  }, async ({ date: d, status, comment, author }) =>
    attempt(() => updatePlanDay(d, { status, notes: comment }, { author, reason: "Run review" })));

  server.registerTool("move_run", {
    description: "Move a planned run (type, distance, HR guide, shoe) to another day that has no run, e.g. Thursday → Wednesday. Gym sessions don't move.",
    inputSchema: { from: date, to: date, ...meta },
  }, async ({ from, to, author, reason }) => attempt(() => moveRun(from, to, { author, reason })));

  server.registerTool("create_block", {
    description: "Start a new training block. Its weeks replace the plan from `start` onward (earlier days stay as history) and it becomes the active block. Each week gives run distances by weekday, e.g. { label: 'R1', runs: { Tue: 3.5, Thu: 3.5, Sat: 4.2 }, objective: '…' }.",
    inputSchema: {
      name: z.string(), start: date,
      summary: z.string().optional(), rules: z.array(z.string()).optional(), success: z.string().optional(),
      hr_guide: z.string().optional(), shoe: z.string().optional(),
      gym_by_weekday: z.record(z.string(), z.string()).optional().describe("Gym session per weekday, e.g. { Mon: 'Heavy Legs' }"),
      weeks: z.array(z.object({ label: z.string(), runs: z.record(z.string(), z.number()), objective: z.string().optional() })).min(1),
      ...meta,
    },
  }, async ({ author, reason, ...spec }) => attempt(() => createBlock(spec, { author, reason })));

  server.registerTool("update_block", {
    description: "Edit a training block's summary, rules, success measure, or make it the active block.",
    inputSchema: {
      name: z.string(),
      changes: z.object({ summary: z.string().optional(), rules: z.array(z.string()).optional(), success: z.string().optional(), active: z.boolean().optional() }),
      ...meta,
    },
  }, async ({ name, changes, author, reason }) => attempt(() => updateBlock(name, changes, { author, reason })));

  server.registerTool("set_lifting_plan", {
    description: "Replace Daniel's lifting plan text (markdown). Read lifting_plan first and send the whole updated text.",
    inputSchema: { text: z.string(), ...meta },
  }, async ({ text, author, reason }) => attempt(() => setLiftingPlan(text, { author, reason })));
}

// Stateless Streamable HTTP: a fresh server + transport per request (the SDK's
// recommended setup when there's no session state to keep).
export function mountMcp(app, express) {
  // Each URL is only mounted when its key is set.
  if (process.env.MCP_KEY) mountEndpoint(app, express, process.env.MCP_KEY, { canWrite: false });
  if (process.env.MCP_WRITE_KEY) mountEndpoint(app, express, process.env.MCP_WRITE_KEY, { canWrite: true });
}

function mountEndpoint(app, express, key, options) {
  app.post(`/mcp/${key}`, express.json({ limit: "1mb" }), async (req, res) => {
    const server = buildServer(options);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { transport.close(); server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("MCP request failed", err);
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  });
  // Stateless mode has no server-initiated stream or sessions to delete.
  const notAllowed = (_req, res) => res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
  app.get(`/mcp/${key}`, notAllowed);
  app.delete(`/mcp/${key}`, notAllowed);
}
