import crypto from "node:crypto";
import express from "express";
import { getSetting, query, setSetting } from "./db.js";
import { authorizeUrl, completeAuthorization, RECONNECT_FLAG, TOKEN_KEY as WITHINGS_TOKEN_KEY } from "./sources/withings.js";
import { SIGN_IN_FLAG } from "./sources/garmin.js";

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

// Problems that need Daniel to do something, shown as a banner at the top of the page.
const GARMIN_LOGIN_CMD =
  "cd ~/Projects/health-dashboard && railway run --service Postgres sh -c 'DATABASE_URL=$DATABASE_PUBLIC_URL npm run garmin:login'";

const onDate = (flag) => new Date(flag.since).toLocaleDateString("en-AU");

async function alerts() {
  const [garminTokens, signInRequired, withingsTokens, withingsReconnect] = await Promise.all([
    getSetting("garmin_tokens"), getSetting(SIGN_IN_FLAG), getSetting(WITHINGS_TOKEN_KEY), getSetting(RECONNECT_FLAG),
  ]);
  const list = [];

  // Withings: the developer-app variables come first, then the one-click OAuth connect.
  if (!process.env.WITHINGS_CLIENT_ID) {
    list.push({
      title: "Withings isn't set up",
      detail: "Create an app at developer.withings.com, then add WITHINGS_CLIENT_ID, WITHINGS_CLIENT_SECRET and WITHINGS_CALLBACK_URL to the web and daily services in Railway.",
    });
  } else if (withingsReconnect) {
    list.push({
      title: "Withings needs reconnecting",
      detail: `Withings stopped accepting the saved access on ${onDate(withingsReconnect)}, so no new weigh-ins are coming in.`,
      link: { href: "/withings/connect", text: "Reconnect Withings" },
    });
  } else if (!withingsTokens) {
    list.push({ title: "Withings isn't connected", detail: "Approve access once to start pulling weigh-ins.", link: { href: "/withings/connect", text: "Connect Withings" } });
  }

  if (!garminTokens) {
    list.push({ title: "Garmin isn't connected", detail: "Sign in once from your Mac:", command: GARMIN_LOGIN_CMD });
  } else if (signInRequired) {
    list.push({
      title: "Garmin needs a fresh sign-in",
      detail: `Garmin rejected the saved session on ${onDate(signInRequired)}, so no new Garmin data is coming in. Run this in Terminal:`,
      command: GARMIN_LOGIN_CMD,
    });
  }
  return list;
}

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
    res.json({ alerts: await alerts(), weeks, days, health, weights, runs, recent, gym, note: note[0] ?? null, syncs });
  } catch (err) {
    next(err);
  }
});

// Only usable until Withings is connected, so a visitor can't swap in their own
// account when the dashboard has no password. To reconnect, delete the
// withings_tokens row from settings first.
app.get("/withings/connect", async (_req, res, next) => {
  try {
    if (await getSetting(WITHINGS_TOKEN_KEY)) return res.status(409).send("Withings is already connected.");
    const state = crypto.randomUUID();
    await setSetting("withings_oauth_state", state);
    res.redirect(await authorizeUrl(state));
  } catch (err) {
    next(err);
  }
});

app.get("/withings/callback", async (req, res, next) => {
  try {
    // Withings' "Test URL reachability" button calls this with no code; answer 200 so the test passes.
    if (!req.query.code) return res.send("Withings callback is reachable.");
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
