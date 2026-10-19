import { register } from "node:module";
register("./loader.mjs", import.meta.url);

import pino from "pino";

const { acquireDedicatedAdvisoryLock, DEFAULT_WHATSAPP_ADVISORY_LOCK_ID } = await import(
  "../src/server/whatsapp/baileys/lock.ts"
);
const { startBaileysWorker } = await import(
  "../src/server/whatsapp/baileys/connection.ts"
);
const { registerActiveSender } = await import(
  "../src/server/whatsapp/client.ts"
);
const { ensureSessionTable } = await import(
  "../src/server/whatsapp/baileys/auth-state.ts"
);
const { query } = await import(
  "../src/server/db/client.ts"
);

const logger = pino({
  level: process.env.LOG_LEVEL || "info",
});

logger.info("Initializing WhatsApp Baileys Worker Daemon...");

const databaseUrl = process.env.DATABASE_URL;
const sessionEncryptionKey = process.env.WHATSAPP_SESSION_ENCRYPTION_KEY;

if (!databaseUrl) {
  logger.error("FATAL: DATABASE_URL environment variable is missing.");
  process.exit(1);
}

if (!sessionEncryptionKey) {
  logger.error("FATAL: WHATSAPP_SESSION_ENCRYPTION_KEY environment variable is missing.");
  process.exit(1);
}

let activeWorker = null;
let currentLockHandle = null;
let isShuttingDown = false;
let retryTimer = null;
let reconnectTimer = null;

/**
 * Gracefully shuts down the worker and releases database locks.
 */
async function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info({ signal }, "Received shutdown signal. Stopping WhatsApp daemon gracefully...");

  if (retryTimer) clearTimeout(retryTimer);
  if (reconnectTimer) clearTimeout(reconnectTimer);

  registerActiveSender(null);

  if (activeWorker) {
    try {
      logger.info("Closing WhatsApp socket connection...");
      await activeWorker.stop();
    } catch (err) {
      logger.error({ err }, "Error stopping WhatsApp worker socket.");
    }
    activeWorker = null;
  }

  if (currentLockHandle) {
    try {
      logger.info("Releasing PostgreSQL advisory lock...");
      await currentLockHandle.release();
    } catch (err) {
      logger.error({ err }, "Error releasing advisory lock.");
    }
    currentLockHandle = null;
  }

  logger.info("WhatsApp daemon shutdown complete.");
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

/**
 * Starts the Baileys connection if the advisory lock is held.
 */
async function startSocket() {
  if (isShuttingDown || !currentLockHandle?.acquired) return;

  try {
    await ensureSessionTable();
    try {
      const credsCheck = await query(
        "SELECT count(*) FROM whatsapp_baileys_session WHERE session_id = $1 AND key_id = $2",
        ["default", "creds"]
      );
      const totalKeysCheck = await query(
        "SELECT count(*) FROM whatsapp_baileys_session WHERE session_id = $1",
        ["default"]
      );
      const hasCreds = parseInt(credsCheck.rows?.[0]?.count || "0", 10) > 0;
      const totalKeys = parseInt(totalKeysCheck.rows?.[0]?.count || "0", 10);

      logger.info(
        { hasCreds, totalKeys, sessionId: "default" },
        `[WHATSAPP DAEMON DIAGNOSTIC] Session 'default' in PostgreSQL: ${totalKeys} total keys stored, 'creds' present: ${hasCreds}`
      );

      if (hasCreds) {
        logger.info("[WHATSAPP DAEMON DIAGNOSTIC] Found registered session credentials in PostgreSQL. Resuming connection...");
      } else {
        logger.warn(
          { totalKeys, hasCreds },
          `[WHATSAPP DAEMON DIAGNOSTIC] No registered credentials found in PostgreSQL for key 'creds' (total keys: ${totalKeys}). ` +
          "Baileys cannot resume a session because PostgreSQL does not have pairing credentials. " +
          "Execute pairing using 'node scripts/whatsapp-pair.mjs <phone>' against the Railway database to store credentials."
        );
      }
    } catch (checkErr) {
      logger.warn({ err: checkErr instanceof Error ? checkErr.message : checkErr }, "Warning checking session table.");
    }

    logger.info("Connecting to WhatsApp via Baileys...");
    activeWorker = await startBaileysWorker({
      sessionId: "default",
      pairingNumber: process.env.WHATSAPP_PAIRING_NUMBER,
      allowedNumbersEnv: process.env.WHATSAPP_ALLOWED_NUMBERS,
      logger,
      onConnectionOpen: () => {
        logger.info("WhatsApp bot is connected and ready to receive messages.");
        if (activeWorker) {
          registerActiveSender(activeWorker.sendMessage);
        }
      },
      onConnectionClose: async (shouldReconnect) => {
        registerActiveSender(null);
        if (isShuttingDown) return;

        if (shouldReconnect) {
          logger.warn("WhatsApp connection closed. Scheduling reconnection in 5s...");
          reconnectTimer = setTimeout(() => {
            if (!isShuttingDown && currentLockHandle?.acquired) {
              startSocket();
            }
          }, 5000);
        } else {
          logger.error("WhatsApp session was logged out. Please re-pair the device.");
        }
      },
    });
  } catch (error) {
    logger.error({ error }, "Failed to start Baileys worker socket.");
    if (!isShuttingDown) {
      reconnectTimer = setTimeout(startSocket, 10000);
    }
  }
}

/**
 * Main daemon loop: acquires advisory lock and maintains single-instance execution.
 */
async function runDaemon() {
  try {
    const lock = await acquireDedicatedAdvisoryLock({
      lockId: DEFAULT_WHATSAPP_ADVISORY_LOCK_ID,
      connectionString: databaseUrl,
      onLockLost: async (error) => {
        logger.error(
          { error: error.message },
          "CRITICAL: PostgreSQL connection for advisory lock was lost! Closing WhatsApp socket immediately..."
        );
        registerActiveSender(null);
        if (activeWorker) {
          try {
            await activeWorker.stop();
          } catch {}
          activeWorker = null;
        }
        currentLockHandle = null;

        // Attempt to re-acquire lock
        if (!isShuttingDown) {
          logger.info("Attempting to re-acquire advisory lock in 5s...");
          retryTimer = setTimeout(runDaemon, 5000);
        }
      },
    });

    if (!lock.acquired) {
      logger.warn(
        `Advisory lock ${DEFAULT_WHATSAPP_ADVISORY_LOCK_ID} is currently held by another worker instance. Standing by (retry in 5s)...`
      );
      if (!isShuttingDown) {
        retryTimer = setTimeout(runDaemon, 5000);
      }
      return;
    }

    logger.info(
      `Dedicated PostgreSQL advisory lock ${DEFAULT_WHATSAPP_ADVISORY_LOCK_ID} acquired. This worker is the primary instance.`
    );
    currentLockHandle = lock;

    // Start WhatsApp socket
    await startSocket();
  } catch (error) {
    logger.error({ error: error instanceof Error ? error.message : error }, "Database connection error trying to acquire advisory lock. Retrying in 5s...");
    if (!isShuttingDown) {
      retryTimer = setTimeout(runDaemon, 5000);
    }
  }
}

// Start the daemon
runDaemon();
