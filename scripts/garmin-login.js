// One-time Garmin login, run from a laptop (Garmin may block logins from cloud IPs):
//   DATABASE_URL=<Railway public Postgres URL> npm run garmin:login
// Prompts for email, password and MFA, then stores only the session tokens.
//
// If Garmin rate-limits the login (429), reuse this Mac's existing session instead:
//   npm run garmin:login -- --import [path, default ~/.garminconnect]

import { pool, setSetting } from "../src/db.js";
import { runGarminScript } from "../src/sources/garmin.js";

const importIdx = process.argv.indexOf("--import");
const tokens = (importIdx === -1
  ? await runGarminScript("login", null, { interactive: true })
  : await runGarminScript("import", null, { interactive: true, args: process.argv.slice(importIdx + 1, importIdx + 2) })
).trim();
await setSetting("garmin_tokens", tokens);
console.log("Garmin tokens saved.");
await pool.end();
