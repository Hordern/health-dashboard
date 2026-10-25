// One-time Garmin login, run from a laptop (Garmin may block logins from cloud IPs):
//   DATABASE_URL=<Railway public Postgres URL> npm run garmin:login
// Prompts for email, password and MFA, then stores only the session tokens.

import { pool, setSetting } from "../src/db.js";
import { runGarminScript } from "../src/sources/garmin.js";

const tokens = (await runGarminScript("login", null, { interactive: true })).trim();
await setSetting("garmin_tokens", tokens);
console.log("Garmin tokens saved.");
await pool.end();
