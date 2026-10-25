import pg from "pg";

// Railway's internal Postgres URL needs no SSL; its public URL (used when
// running scripts from a laptop) does.
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");

// Return dates as "YYYY-MM-DD" strings (not timezone-shifted Date objects) and
// numerics as numbers (not strings).
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);
pg.types.setTypeParser(pg.types.builtins.TIMESTAMP, (v) => v);
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => (v == null ? null : Number(v)));

export const pool = new pg.Pool({
  connectionString: url,
  ssl: url.includes(".railway.internal") || url.includes("localhost") ? false : { rejectUnauthorized: false },
});

export async function query(sql, params = []) {
  const { rows } = await pool.query(sql, params);
  return rows;
}

export async function getSetting(key) {
  const rows = await query("select value from settings where key = $1", [key]);
  return rows[0]?.value ?? null;
}

export async function setSetting(key, value) {
  await query(
    `insert into settings (key, value, updated_at) values ($1, $2, now())
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
}

export async function clearSetting(key) {
  await query("delete from settings where key = $1", [key]);
}

// Records one sync attempt for a source; the dashboard shows the latest per source.
export async function recordSync(source, fn) {
  const [{ id }] = await query("insert into sync_runs (source) values ($1) returning id", [source]);
  try {
    const message = await fn();
    await query("update sync_runs set finished_at = now(), ok = true, message = $2 where id = $1", [id, message ?? null]);
  } catch (err) {
    await query("update sync_runs set finished_at = now(), ok = false, message = $2 where id = $1", [id, err.message]);
    console.error(`[${source}]`, err);
  }
}
