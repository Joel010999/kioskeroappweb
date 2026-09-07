import { Pool, type PoolClient, type QueryResultRow } from "pg";

let pool: Pool | undefined;

function getPool(): Pool {
  if (pool) return pool;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("Database connection is not configured.");
  }

  pool = new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // Railway requires TLS. This can be disabled only for an explicitly configured local DB.
    ssl: process.env.POSTGRES_SSL === "false" ? false : { rejectUnauthorized: false },
  });

  pool.on("error", (error) => {
    console.error("Unexpected PostgreSQL pool error", { message: error.message });
  });

  return pool;
}

export async function query<T extends QueryResultRow>(text: string, values: readonly unknown[] = []) {
  return getPool().query<T>(text, [...values]);
}

export async function withTransaction<T>(handler: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await handler(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
