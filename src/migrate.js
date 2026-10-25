import { readFile } from "node:fs/promises";
import pg from "pg";
import { pool } from "./db.js";

const sql = (name) => readFile(new URL(`../db/${name}`, import.meta.url), "utf8");

await pool.query(await sql("schema.sql"));
console.log("Schema up to date.");

// Read-only login for the Claude connector's SQL tool (see db/readonly.sql).
if (process.env.READONLY_DB_PASSWORD) {
  await pool.query(await sql("readonly.sql"));
  // ALTER ROLE can't take a bind parameter, so quote the password as a literal.
  await pool.query(`alter role dashboard_reader password ${pg.escapeLiteral(process.env.READONLY_DB_PASSWORD)}`);
  console.log("Read-only role up to date.");
}
await pool.end();
