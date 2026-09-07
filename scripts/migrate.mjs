import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be configured.");

const migrationsDirectory = join(process.cwd(), "migrations");
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.POSTGRES_SSL === "false" ? false : { rejectUnauthorized: false } });
const client = await pool.connect();
try {
  await client.query("BEGIN");
  await client.query("CREATE TABLE IF NOT EXISTS renderbyte_schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const applied = new Set((await client.query("SELECT version FROM renderbyte_schema_migrations")).rows.map((row) => row.version));
  for (const file of (await readdir(migrationsDirectory)).filter((name) => name.endsWith(".sql")).sort()) {
    if (applied.has(file)) continue;
    await client.query(await readFile(join(migrationsDirectory, file), "utf8"));
    await client.query("INSERT INTO renderbyte_schema_migrations (version) VALUES ($1)", [file]);
    console.log(`Applied ${file}`);
  }
  await client.query("COMMIT");
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await pool.end();
}
