// The planning chat: Daniel presses "Plan next block", the coach proposes a block
// from his history, they discuss it, and Daniel locks it in. The coach proposes
// through a `propose_block` tool; nothing changes in the plan until lockIn().

import Anthropic from "@anthropic-ai/sdk";
import * as z from "zod";
import { getSetting, query } from "../db.js";
import { activeBlock, createBlock } from "../plan/store.js";
import { blockStatus } from "../plan/status.js";
import { blockSummary } from "../block.js";

const MODEL = process.env.CLAUDE_MODEL ?? "claude-opus-5-5";
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: process.env.TZ ?? "Australia/Melbourne" });

// What a proposal must contain; also what createBlock() takes.
const Proposal = z.object({
  name: z.string().min(1),
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  summary: z.string(),
  rules: z.array(z.string()),
  success: z.string(),
  hr_guide: z.string(),
  shoe: z.string(),
  gym_by_weekday: z.record(z.string(), z.string()),
  weeks: z.array(z.object({
    label: z.string(),
    // partialRecord: only run days appear (a plain record over an enum would demand all 7 days).
    runs: z.partialRecord(z.enum(WEEKDAYS), z.number().positive()).refine((r) => Object.keys(r).length > 0, "at least one run"),
    objective: z.string(),
  })).min(1).max(16),
});

const PROPOSE_TOOL = {
  name: "propose_block",
  description: "Show Daniel a proposed training block as a card he can lock in. Call it whenever you propose or revise the plan; the latest call replaces the previous proposal. Daniel locks it in himself with a button.",
  input_schema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Unique, descriptive, e.g. 'Base block 2'" },
      start: { type: "string", description: `YYYY-MM-DD, today or later (today is passed in the context)` },
      summary: { type: "string", description: "What the block is for, in two or three sentences" },
      rules: { type: "array", items: { type: "string" }, description: "The block's rules: effort, HR guide, progression, recovery gate, missed-run policy" },
      success: { type: "string", description: "How we'll judge the block at the end" },
      hr_guide: { type: "string", description: "Shown on every run, e.g. 'Aim <148 bpm'" },
      shoe: { type: "string" },
      gym_by_weekday: { type: "object", additionalProperties: { type: "string" }, description: "Gym session per weekday (Mon…Sun), unchanged unless Daniel agrees" },
      weeks: {
        type: "array",
        items: {
          type: "object",
          properties: {
            label: { type: "string" },
            runs: { type: "object", additionalProperties: { type: "number" }, description: "Distance in km by weekday, e.g. { \"Tue\": 3.5, \"Thu\": 3.5, \"Sat\": 4.2 }" },
            objective: { type: "string" },
          },
          required: ["label", "runs", "objective"],
        },
      },
    },
    required: ["name", "start", "summary", "rules", "success", "hr_guide", "shoe", "gym_by_weekday", "weeks"],
  },
};

// Everything the coach needs to suggest the next block, as of today.
async function planningContext() {
  const day = today();
  const blocks = await query(`select name, start_date::text as start, end_date::text as "end", summary, rules, success, active from training_blocks order by start_date`);
  const active = await activeBlock();
  return {
    today: day,
    active_block: active && { ...active, status: await blockStatus(active, day), so_far: await blockSummary(active.start, day < active.end ? day : active.end) },
    past_blocks: blocks,
    // Week-by-week adherence for the whole plan history.
    plan_weeks: await query(
      `select w.block, w.label, w.start_date::text as start, w.planned_total_km,
              count(*) filter (where d.planned_km > 0) as runs_planned,
              count(*) filter (where d.planned_km > 0 and exists (select 1 from activities a where a.date = d.date and a.type = 'running')) as runs_done
       from plan_weeks w join plan_days d on d.week_start = w.start_date group by w.start_date order by w.start_date`),
    runs: await query(`select date::text, distance_km, round(duration_s / 60) as minutes, avg_hr, max_hr, training_effect_label from activities where type = 'running' and date >= current_date - 120 order by date`),
    recovery_by_week: await query(
      `select date_trunc('week', date)::date::text as week, round(avg(resting_hr), 1) as resting_hr, round(avg(hrv_last_night), 1) as hrv,
              round(avg(readiness_score)) as readiness, round(avg(sleep_score)) as sleep_score
       from health_daily where date >= current_date - 120 group by 1 order by 1`),
    gym_sessions_by_week: await query(`select date_trunc('week', date)::date::text as week, count(*) as sessions from gym_sessions where date >= current_date - 120 group by 1 order by 1`),
    gym_plan: await getSetting("gym_plan"),
    lifting_plan: await getSetting("lifting_plan"),
    weight_by_week: await query(`select date_trunc('week', measured_at)::date::text as week, round(avg(weight_kg), 1) as kg from weights where measured_at >= current_date - 120 group by 1 order by 1`),
  };
}

async function systemPrompt() {
  const [rules, profile] = await Promise.all([getSetting("coach_instructions"), getSetting("athlete_profile")]);
  return [
    { type: "text", text: rules ?? "" },
    { type: "text", text: `# Athlete profile\n\n${profile ?? ""}`, cache_control: { type: "ephemeral" } },
    { type: "text", text:
      "You are planning Daniel's next training block with him in a chat on his dashboard. Open by explaining briefly how the " +
      "current block went (from the data), then propose a block with propose_block. Keep messages short and conversational. " +
      "Revise with propose_block whenever you change the plan. Daniel locks it in himself; don't claim it is saved. " +
      "A block has a fixed number of weeks; it will be flagged for a new plan if it stalls for two weeks (fewer than half " +
      "the planned runs done) or when it ends, so set targets he can actually complete. Leave the gym schedule as it is unless he asks." },
  ];
}

const textOf = (content) => (typeof content === "string" ? content : content.filter((b) => b.type === "text").map((b) => b.text).join("\n"));

// Runs Claude until it finishes its turn, executing propose_block calls.
async function runTurn(chat) {
  const client = new Anthropic();
  const system = await systemPrompt();
  for (let i = 0; i < 4; i++) {
    const response = await client.messages.create({
      model: MODEL, max_tokens: 16000, output_config: { effort: "medium" },
      system, tools: [PROPOSE_TOOL], messages: chat.messages,
    });
    if (response.stop_reason === "refusal") throw new Error("The coach declined to answer that.");
    // Appended exactly as returned, so thinking blocks replay unchanged next turn.
    chat.messages.push({ role: "assistant", content: response.content });
    const calls = response.content.filter((b) => b.type === "tool_use");
    if (!calls.length) return;

    const results = calls.map((call) => {
      const parsed = Proposal.safeParse(call.input);
      if (!parsed.success) return { type: "tool_result", tool_use_id: call.id, is_error: true, content: `Invalid proposal: ${parsed.error.message}` };
      if (parsed.data.start < today()) return { type: "tool_result", tool_use_id: call.id, is_error: true, content: `start must be ${today()} or later` };
      chat.proposal = parsed.data;
      return { type: "tool_result", tool_use_id: call.id, content: "Shown to Daniel as a card. He can lock it in or ask for changes." };
    });
    chat.messages.push({ role: "user", content: results });
  }
}

async function save(chat) {
  await query(`update coach_chats set messages = $2, proposal = $3 where id = $1`,
    [chat.id, JSON.stringify(chat.messages), chat.proposal && JSON.stringify(chat.proposal)]);
}

// The page shows plain text turns only; tool calls and results stay hidden.
export function forDisplay(chat) {
  const turns = chat.messages.slice(1) // the first message is the hidden kickoff with the data
    .map((m) => ({ role: m.role, text: textOf(m.content).trim() }))
    .filter((m) => m.text);
  return { id: chat.id, status: chat.status, proposal: chat.proposal, block_name: chat.block_name, turns };
}

export async function latestOpenChat() {
  const [chat] = await query(`select * from coach_chats where status = 'open' order by id desc limit 1`);
  return chat ? forDisplay(chat) : null;
}

export async function startChat() {
  await query(`update coach_chats set status = 'closed' where status = 'open'`);
  const [{ id }] = await query(`insert into coach_chats default values returning id`);
  const chat = {
    id, status: "open", proposal: null,
    messages: [{
      role: "user",
      content: "Daniel pressed 'Plan next block' on his dashboard. Here is his data:\n\n```json\n" + JSON.stringify(await planningContext()) + "\n```",
    }],
  };
  await runTurn(chat);
  await save(chat);
  return forDisplay(chat);
}

export async function sendMessage(id, text) {
  const [chat] = await query(`select * from coach_chats where id = $1 and status = 'open'`, [id]);
  if (!chat) throw new Error("That chat isn't open any more. Start a new one.");
  chat.messages.push({ role: "user", content: text });
  await runTurn(chat);
  await save(chat);
  return forDisplay(chat);
}

export async function lockIn(id) {
  const [chat] = await query(`select * from coach_chats where id = $1 and status = 'open'`, [id]);
  if (!chat?.proposal) throw new Error("There's no proposal to lock in yet.");
  await createBlock(chat.proposal, { author: "Daniel (planning chat)", reason: `Agreed in planning chat #${id}: ${chat.proposal.summary}` });
  await query(`update coach_chats set status = 'locked', block_name = $2 where id = $1`, [id, chat.proposal.name]);
  return { locked: chat.proposal.name };
}
