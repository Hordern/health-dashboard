// Data syncs shared by the scheduled job (daily.js) and the dashboard's
// "Sync now" button. Each source is recorded separately in sync_runs.

import { query, recordSync } from "./db.js";
import { syncGarmin } from "./sources/garmin.js";
import { syncWithings } from "./sources/withings.js";
import { syncJefit } from "./sources/jefit.js";

export const SOURCES = ["garmin", "withings", "jefit"];
const MIN_GAP_MINUTES = 5; // Sync now won't run again this soon after a sync started

let running = null; // one sync at a time per process

export async function syncData() {
  if (running) return running;
  running = (async () => {
    await recordSync("garmin", () => syncGarmin());
    await recordSync("withings", () => syncWithings());
    await recordSync("jefit", () => syncJefit());
  })().finally(() => (running = null));
  return running;
}

// For the button: refuses if a sync is running or one started in the last few minutes.
export async function requestSync() {
  if (running) return { started: false, reason: "A sync is already running." };
  const [last] = await query(`select max(started_at) as at from sync_runs where source = any($1)`, [SOURCES]);
  if (last.at && Date.now() - new Date(last.at) < MIN_GAP_MINUTES * 60_000) {
    return { started: false, reason: `Synced less than ${MIN_GAP_MINUTES} minutes ago.` };
  }
  syncData().catch((err) => console.error("sync now", err)); // runs in the background; the page polls status
  return { started: true };
}

export const isSyncing = () => Boolean(running);
