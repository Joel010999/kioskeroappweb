import pg from "pg";

export const DEFAULT_WHATSAPP_ADVISORY_LOCK_ID = 7429103;

export type AdvisoryLockHandle = {
  acquired: boolean;
  lockId: number;
  release: () => Promise<void>;
};

export type AdvisoryLockOptions = {
  onLockLost: (error: Error) => void;
  lockId?: number;
  connectionString?: string;
  client?: pg.Client;
};

/**
 * Acquires a dedicated, persistent PostgreSQL advisory lock.
 * If the connection to PostgreSQL drops, the onLockLost callback is immediately triggered
 * so the Baileys socket can be instantly closed to avoid dual-instance conflicts (error 440).
 */
export async function acquireDedicatedAdvisoryLock(
  options: AdvisoryLockOptions
): Promise<AdvisoryLockHandle> {
  const lockId = options.lockId ?? DEFAULT_WHATSAPP_ADVISORY_LOCK_ID;
  const connectionString = options.connectionString ?? process.env.DATABASE_URL;

  if (!connectionString && !options.client) {
    throw new Error("DATABASE_URL must be configured to acquire an advisory lock.");
  }

  const client =
    options.client ??
    new pg.Client({
      connectionString,
      ssl: process.env.POSTGRES_SSL === "false" ? false : { rejectUnauthorized: false },
    });

  let isLockHeld = false;

  try {
    if (!options.client) {
      await client.connect();
    }

    const res = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS acquired",
      [lockId]
    );

    const acquired = Boolean(res.rows?.[0]?.acquired);
    if (!acquired) {
      if (!options.client) {
        await client.end().catch(() => {});
      }
      return {
        acquired: false,
        lockId,
        release: async () => {},
      };
    }

    isLockHeld = true;

    // Attach disconnection and error listeners on the dedicated client
    client.on("error", (err) => {
      if (isLockHeld) {
        isLockHeld = false;
        options.onLockLost(new Error(`Advisory lock connection failed: ${err.message}`));
      }
    });

    client.on("end", () => {
      if (isLockHeld) {
        isLockHeld = false;
        options.onLockLost(new Error("Advisory lock PostgreSQL connection closed."));
      }
    });

    const release = async (): Promise<void> => {
      if (isLockHeld) {
        isLockHeld = false;
        try {
          await client.query("SELECT pg_advisory_unlock($1)", [lockId]);
        } catch {
          // Connection may already be closed
        }
      }
      if (!options.client) {
        await client.end().catch(() => {});
      }
    };

    return {
      acquired: true,
      lockId,
      release,
    };
  } catch (error) {
    if (!options.client) {
      await client.end().catch(() => {});
    }
    throw error;
  }
}
