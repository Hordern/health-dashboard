# Health Dashboard

Daniel's personal health dashboard, hosted on Railway: one page showing
activities and runs, recovery (resting HR, HRV, sleep, training readiness),
weight and gym sessions, alongside the current running plan and a daily Claude
coaching note.

Data comes from Garmin, Withings scales, JEFIT and the plan in
`~/Claude/Running-Coach/CURRENT_PLAN.md`.

## How it fits together

```
Railway project
├── Postgres            all data (schema: db/schema.sql)
├── web   (npm start)   Express: dashboard + /api/dashboard + /withings/connect
└── daily (npm run daily, cron)
       garmin → withings → jefit → coaching note
```

Both services use the same Docker image. Garmin is fetched by a small Python
script (`src/sources/garmin_fetch.py`) because `python-garminconnect` is the
maintained client that gets past Garmin's 2026 anti-bot checks. Node owns all
database writes. Each source's last result shows at the top of the dashboard.

| Code | Job |
|---|---|
| `src/server.js` | Web app, password check, Withings OAuth callback |
| `src/daily.js` | Cron entry point |
| `src/sources/*.js` | One file per data source |
| `src/coach/daily-note.js` | The daily Claude call |
| `src/plan/import-markdown.js` | Imports CURRENT_PLAN.md, CLAUDE.md, ATHLETE_PROFILE.md |
| `public/` | Dashboard page (plain JS + Chart.js) |

## Deploy to Railway (first time)

1. `railway login`, then from this folder `railway init` (new project).
2. Add Postgres: `railway add --database postgres`.
3. Create the **web** service from this repo (`railway up`). In its variables set
   `DATABASE_URL=${{Postgres.DATABASE_URL}}`, `DASHBOARD_PASSWORD`, the Withings
   values and `ANTHROPIC_API_KEY`, `TZ=Australia/Melbourne` (see `.env.example`).
   Generate a public domain.
4. Create the **daily** service from the same repo with the same variables,
   start command `npm run daily`, and cron schedule `0 9 * * *` (UTC = 8pm
   Melbourne in AEDT; Railway cron is always UTC).
5. Install the Garmin client locally once: `npm run setup:python`.
   Then run the setup scripts against Railway's Postgres (its public URL
   comes from the TCP proxy on the Postgres service):
   ```
   railway run --service Postgres sh -c 'DATABASE_URL=$DATABASE_PUBLIC_URL npm run migrate'
   railway run --service Postgres sh -c 'DATABASE_URL=$DATABASE_PUBLIC_URL npm run import-plan'
   railway run --service Postgres sh -c 'DATABASE_URL=$DATABASE_PUBLIC_URL npm run garmin:login'
   ```
6. JEFIT: create a **read-only** token at jefit.com → Settings → Access tokens
   (needs Elite) and set `JEFIT_TOKEN` on the daily service.
7. Withings: create an app at developer.withings.com with callback
   `https://<domain>/withings/callback`, then visit `https://<domain>/withings/connect`
   (it only works while Withings is not yet connected).

## Coach rules engine

`docs/coach-rules.md` (Coach Rules Spec v1) defines how the plan evolves; the
code follows its division of work: the rules are deterministic code and Claude
only writes the notes.

| Spec section | Code |
|---|---|
| 1 Config | `src/coach/config.js` (all thresholds, plus Daniel's run/gym days) |
| 4 Daily readiness (flags + actions) | `src/coach/readiness.js`, run at 7pm, saved in `readiness` |
| 5 End-of-block review, 8 recommendation | `src/coach/review.js`, run on the block's last day (or early if stalled), saved on the block |
| 6/8a Weekly progression, block shapes | `src/coach/blocks.js` (generator, in minutes; km is an estimate) |
| Pain/RPE manual input | `checkins` table, dashboard check-in card and the connector's `log_checkin` |

The next block is agreed in the planning chat: the coach explains the review
and calls `prepare_block`, the engine generates the block within the
guardrails, and Daniel locks it in. Deviations from the spec: with 3 runs a week
the long run is capped at 40% (30% is impossible with 3 runs); a deload week
drops runs rather than scheduling any under 20 min; decoupling and quality
scoring wait for long runs ≥ 60 min and quality sessions.

## Lifting

The lifting plan (settings `lifting_plan`, seeded by `scripts/seed-lifting-plan.js`)
is the weekly A/B template with a prescription per exercise (load, sets, rep
range, progression step) and the current lifting block (worked out from JEFIT
history: the lower-body reset on 28 Sep 2026). `src/lifting/analysis.js`
classifies each JEFIT session as a plan session, compares every exercise with
its prescription and the last time, and works out the next target (double
progression). At 7pm `src/lifting/coach.js` freezes each new session's
comparison and raises any prescription whose every set hit the top of the range
at the prescribed load; the nightly coach adds a comment per session.

## Schedule

The daily service runs at 6am, 9am, 3pm, 7pm and 10pm Melbourne
(`src/schedule.js`, cron `0 4,8,11,19,22 * * *` UTC). Every run syncs Garmin,
Withings and JEFIT; the 7pm run (or 10pm if 7pm failed) also runs the rules
engine, any end-of-block review and the nightly coach. The dashboard's Sync now
button (coach PIN) runs a data sync on demand.

## The plan: where it lives and who edits it

The database is the master copy of the running plan (`plan_weeks`, `plan_days`),
the training blocks (`training_blocks`) and the lifting plan. Every edit goes
through `src/plan/store.js` and is logged in `plan_changes` with its author and
reason; the dashboard shows the log under Coach → Running plan.

- **Rules engine** (`src/coach/readiness.js`, 7pm): applies the spec's daily
  recovery actions to upcoming runs, logged as `rules-engine`.
- **Nightly coach** (`src/coach/nightly-coach.js`, 7pm): writes the note and
  reviews each unreviewed past run day (status + comment). It explains the
  engine's decisions and never changes volumes.
- **Daniel / other agents**: through the connector's write URL (below) —
  update a day, move a run, comment on a run, create/update a block, set the
  lifting plan.
- **New blocks**: a block has a fixed number of weeks. A finished week with
  under half its planned runs done is "stalled"; two stalled weeks in a row, or
  the block's end date, flags "new plan due". The next block is agreed in the
  dashboard's planning chat (Coach → Plan next block, `COACH_PIN` required):
  the coach proposes, Daniel discusses, then locks it in.
- `npm run import-plan` was the one-time migration from CURRENT_PLAN.md and
  refuses to run once edits exist (`--force` to override).

## Ask Claude about the data (claude.ai connector)

The web service also runs a read-only MCP server at `/mcp/<MCP_KEY>`
(`src/mcp.js`). Tools cover daily health, activities, gym sessions and plan,
weights, the running plan, coaching notes, a block review for any date range,
the athlete profile/coaching rules, and a `sql_query` tool. SQL runs as the
`dashboard_reader` login (`db/readonly.sql`): SELECT on data tables only, no
access to `settings` (tokens), read-only transactions, one statement, 5 s cap.

A second URL, `/mcp/<MCP_WRITE_KEY>`, adds the plan editing tools (every edit
needs an author and a reason and is logged).

Setup: set `MCP_KEY`, `MCP_WRITE_KEY` and `READONLY_DB_PASSWORD` on the web service, run
`npm run migrate` (creates the role), then in claude.ai → Settings → Connectors
→ Add custom connector, use `https://<domain>/mcp/<MCP_KEY>`. The key is the
only access control, so keep the URL private.

## Day-to-day

- **Plan changes:** edit CURRENT_PLAN.md as now, then `npm run import-plan`.
- **Garmin session expired:** the garmin sync shows ✗ — run `npm run garmin:login` again.
- **Blank Garmin cards after the first sync:** run `npm run garmin:check`. Garmin's
  field names are undocumented, so the mapping in `src/sources/garmin.js`
  (`healthRow`) may need a fix. Raw payloads are stored, so no re-fetch is needed.
