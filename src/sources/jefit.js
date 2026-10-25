// JEFIT → gym_sessions.
//
// JEFIT has no public API and no maintained Node client, so this sync is not
// built yet. The next step is to inspect what jefit.com's logged-in workout log
// pages request, then fetch the same data here and save it with saveSession().

import { query } from "../db.js";

export async function saveSession({ id, date, name, exercises, raw }) {
  await query(
    `insert into gym_sessions (id, date, name, exercises, raw) values ($1, $2, $3, $4, $5)
     on conflict (id) do update set name = excluded.name, exercises = excluded.exercises, raw = excluded.raw`,
    [id, date, name, JSON.stringify(exercises), raw],
  );
}

export async function syncJefit() {
  throw new Error("JEFIT sync not built yet");
}
