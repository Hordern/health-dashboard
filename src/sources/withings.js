// Withings scales → weights table, via the official Withings API.
// One-time setup: visit /withings/connect on the deployed app and approve access.
// After that the refresh token (stored in settings) keeps the sync running.

import { WithingsClient, Scope, MeasureType, measureValue } from "withings-node-oauth2";
import { getSetting, query, setSetting } from "../db.js";

const TOKEN_KEY = "withings_tokens";

export async function createClient() {
  const tokens = await getSetting(TOKEN_KEY);
  return new WithingsClient({
    clientId: process.env.WITHINGS_CLIENT_ID,
    clientSecret: process.env.WITHINGS_CLIENT_SECRET,
    callbackURL: process.env.WITHINGS_CALLBACK_URL,
    ...(tokens && { tokens }),
    // Withings refresh tokens are single-use, so every rotation must be saved.
    onTokenRefresh: (t) => setSetting(TOKEN_KEY, t),
  });
}

export async function authorizeUrl(state) {
  const wc = await createClient();
  return wc.oauth.authorizeUrl({ scope: [Scope.Metrics], state });
}

export async function completeAuthorization(code) {
  const wc = await createClient();
  const tokens = await wc.oauth.exchangeCode(code);
  await setSetting(TOKEN_KEY, tokens);
}

export async function syncWithings({ days = 30 } = {}) {
  if (!(await getSetting(TOKEN_KEY))) throw new Error("Withings not connected yet — visit /withings/connect");

  const wc = await createClient();
  const from = new Date(Date.now() - days * 86_400_000);
  let count = 0;

  for await (const group of wc.measures.paginate({
    types: [MeasureType.Weight, MeasureType.FatRatio, MeasureType.MuscleMass],
    category: 1, // real measurements, not goals
    from,
  })) {
    const weight = measureValue(group, MeasureType.Weight);
    if (weight == null) continue; // e.g. a body-composition-only group
    await query(
      `insert into weights (measured_at, weight_kg, fat_ratio, muscle_kg, raw)
       values (to_timestamp($1), $2, $3, $4, $5)
       on conflict (measured_at) do update set weight_kg = excluded.weight_kg,
         fat_ratio = excluded.fat_ratio, muscle_kg = excluded.muscle_kg, raw = excluded.raw`,
      [group.date, weight, measureValue(group, MeasureType.FatRatio) ?? null, measureValue(group, MeasureType.MuscleMass) ?? null, group],
    );
    count++;
  }
  return `${count} weigh-ins from the last ${days} days`;
}
