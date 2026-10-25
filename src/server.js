import crypto from "node:crypto";
import express from "express";
import { getSetting, query, setSetting } from "./db.js";
import { authorizeUrl, completeAuthorization } from "./sources/withings.js";

const app = express();

// Health data is behind a single shared password (any username) when DASHBOARD_PASSWORD is set.
app.use((req, res, next) => {
  const password = process.env.DASHBOARD_PASSWORD;
  if (!password) return next();
  const [, encoded = ""] = (req.headers.authorization ?? "").split(" ");
  const supplied = Buffer.from(encoded, "base64").toString().split(":").slice(1).join(":");
  if (supplied === password) return next();
  res.set("WWW-Authenticate", 'Basic realm="Health dashboard"').status(401).send("Password required");
});

app.get("/robots.txt", (_req, res) => res.type("text/plain").send("User-agent: *\nDisallow: /\n"));

app.get("/api/dashboard", async (_req, res, next) => {
  try {
    const [weeks, days, health, weights, runs, recent, gym, note, syncs] = await Promise.all([
      query(`select * from plan_weeks order by start_date`),
      query(`select p.*, (select sum(distance_km) from activities a where a.date = p.date and a.type = 'running') as actual_km
             from plan_days p order by date`),
      query(`select * from health_daily where date > current_date - 14 order by date`),
      query(`select measured_at, weight_kg, fat_ratio, muscle_kg from weights where measured_at > now() - interval '120 days' order by measured_at`),
      query(`select date, distance_km, avg_hr from activities where type = 'running' and date >= (select min(start_date) from plan_weeks) order by start_local`),
      query(`select date, start_local, type, name, distance_km, duration_s, avg_hr, max_hr, training_effect_label
             from activities where date > current_date - 10 order by start_local desc`),
      query(`select date, name, exercises from gym_sessions where date > current_date - 14 order by date desc`),
      query(`select date, model, body from coaching_notes order by date desc limit 1`),
      query(`select distinct on (source) source, started_at, ok, message from sync_runs order by source, started_at desc`),
    ]);
    res.json({ weeks, days, health, weights, runs, recent, gym, note: note[0] ?? null, syncs });
  } catch (err) {
    next(err);
  }
});

// Only usable until Withings is connected, so a visitor can't swap in their own
// account when the dashboard has no password. To reconnect, delete the
// withings_tokens row from settings first.
app.get("/withings/connect", async (_req, res, next) => {
  try {
    if (await getSetting("withings_tokens")) return res.status(409).send("Withings is already connected.");
    const state = crypto.randomUUID();
    await setSetting("withings_oauth_state", state);
    res.redirect(await authorizeUrl(state));
  } catch (err) {
    next(err);
  }
});

app.get("/withings/callback", async (req, res, next) => {
  try {
    if (req.query.state !== (await getSetting("withings_oauth_state"))) return res.status(400).send("State mismatch — start again at /withings/connect");
    await completeAuthorization(String(req.query.code));
    res.send('Withings connected. Weights will appear after the next daily sync. <a href="/">Back to dashboard</a>');
  } catch (err) {
    next(err);
  }
});

app.use(express.static(new URL("../public", import.meta.url).pathname));

const port = process.env.PORT ?? 3000;
app.listen(port, () => console.log(`Dashboard on http://localhost:${port}`));
