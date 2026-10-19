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

  // 1. Ensure any previous worker socket is cleanly stopped before opening a new one
  if (activeWorker) {
    try {
      logger.info("Stopping previous Baileys worker socket before opening a new connection...");
      await activeWorker.stop();
    } catch (stopErr) {
      logger.warn({ err: stopErr }, "Notice: error stopping previous worker socket.");
    }
    activeWorker = null;
  }

  try {
    await ensureSessionTable();

    // 2. Clean expired pairing locks (>3 minutes old)
    try {
      await query(
        "DELETE FROM whatsapp_baileys_session WHERE session_id = $1 AND key_id = 'lock:pairing' AND updated_at < now() - interval '3 minutes'",
        ["default"]
      );
    } catch {}

    // 3. Check if local pairing is currently in progress
    const pairingLockCheck = await query(
      "SELECT count(*) FROM whatsapp_baileys_session WHERE session_id = $1 AND key_id = 'lock:pairing'",
      ["default"]
    );
    const isPairingActive = parseInt(pairingLockCheck.rows?.[0]?.count || "0", 10) > 0;
    if (isPairingActive) {
      logger.info(
        "[WHATSAPP DAEMON] Pairing is in progress from a local pairing tool. Standing by to avoid dual socket conflicts (checking again in 10s)..."
      );
      if (!isShuttingDown) {
        reconnectTimer = setTimeout(startSocket, 10000);
      }
      return;
    }

    // 4. Verify session credentials exist before opening a socket
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

    if (!hasCreds) {
      logger.warn(
        { totalKeys, hasCreds },
        `[WHATSAPP DAEMON DIAGNOSTIC] No registered credentials found in PostgreSQL for key 'creds'. ` +
        "Daemon will not open an unauthenticated QR socket in headless mode. " +
        "Standing by until device is paired via 'node scripts/whatsapp-pair.mjs <phone>' (checking in 15s)..."
      );
      if (!isShuttingDown) {
        reconnectTimer = setTimeout(startSocket, 15000);
      }
      return;
    }

    logger.info("[WHATSAPP DAEMON DIAGNOSTIC] Found registered session credentials in PostgreSQL. Resuming connection...");
    logger.info("Connecting to WhatsApp via Baileys...");

    const allowedEnv = process.env.WHATSAPP_ALLOWED_NUMBERS;
    const allowedCount = allowedEnv ? allowedEnv.split(/[,;\n]+/).filter(Boolean).length : 0;
    logger.info(
      { allowedCount, hasAllowedEnv: Boolean(allowedEnv) },
      `[WHATSAPP DAEMON] Allowed senders filter configured with ${allowedCount} entries.`
    );

    activeWorker = await startBaileysWorker({
      sessionId: "default",
      allowedNumbersEnv: process.env.WHATSAPP_ALLOWED_NUMBERS,
      logger,
      onConnectionOpen: () => {
        logger.info("WhatsApp bot is connected and ready to receive messages.");
        if (activeWorker) {
          registerActiveSender(activeWorker.sendMessage, activeWorker.sendDocument);
        }
      },
      onConnectionClose: async (shouldReconnect, statusCode) => {
        registerActiveSender(null);
        if (isShuttingDown) return;

        if (activeWorker) {
          try {
            await activeWorker.stop();
          } catch {}
          activeWorker = null;
        }

        if (shouldReconnect) {
          logger.warn({ statusCode }, "WhatsApp connection closed. Scheduling reconnection in 5s...");
          reconnectTimer = setTimeout(() => {
            if (!isShuttingDown && currentLockHandle?.acquired) {
              startSocket();
            }
          }, 5000);
        } else {
          logger.error(
            { statusCode },
            "WhatsApp session was disconnected or unauthorized (status 401). " +
            "Session data is preserved in PostgreSQL. Pausing for 30s before checking..."
          );
          reconnectTimer = setTimeout(() => {
            if (!isShuttingDown && currentLockHandle?.acquired) {
              startSocket();
            }
          }, 30000);
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
