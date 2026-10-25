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
5. Locally, run the setup scripts against Railway's Postgres (its public URL
   comes from the TCP proxy on the Postgres service):
   ```
   railway run --service Postgres sh -c 'DATABASE_URL=$DATABASE_PUBLIC_URL npm run migrate'
   railway run --service Postgres sh -c 'DATABASE_URL=$DATABASE_PUBLIC_URL npm run import-plan'
   railway run --service Postgres sh -c 'DATABASE_URL=$DATABASE_PUBLIC_URL npm run garmin:login'
   ```
6. JEFIT: create a **read-only** token at jefit.com → Settings → Access tokens
   (needs Elite) and set `JEFIT_TOKEN` on the daily service.
7. Withings: create an app at developer.withings.com with callback
   `https://<domain>/withings/callback`, then visit `https://<domain>/withings/connect`.

## Day-to-day

- **Plan changes:** edit CURRENT_PLAN.md as now, then `npm run import-plan`.
- **Garmin session expired:** the garmin sync shows ✗ — run `npm run garmin:login` again.
- **Blank Garmin cards after the first sync:** run `npm run garmin:check`. Garmin's
  field names are undocumented, so the mapping in `src/sources/garmin.js`
  (`healthRow`) may need a fix. Raw payloads are stored, so no re-fetch is needed.
