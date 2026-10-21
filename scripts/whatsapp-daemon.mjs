import { register } from "node:module";
register("./loader.mjs", import.meta.url);

import pino from "pino";

const { acquireDedicatedAdvisoryLock, DEFAULT_WHATSAPP_ADVISORY_LOCK_ID } = await import(
  "../src/server/whatsapp/baileys/lock.ts"
);
const { startBaileysWorker, classifyDisconnectReason, calculateReconnectDelay } = await import(
  "../src/server/whatsapp/baileys/connection.ts"
);
const { registerActiveSender } = await import(
  "../src/server/whatsapp/client.ts"
);
const { ensureSessionTable, verifyPersistedSession } = await import(
  "../src/server/whatsapp/baileys/auth-state.ts"
);
const { maskPhone } = await import(
  "../src/server/whatsapp/auth.ts"
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

// Module-level worker & lifecycle state
let activeWorker = null;
let currentLockHandle = null;
let isShuttingDown = false;
let isStartingSocket = false;

// Global timer handles (ensures reliable centralized teardown)
let retryTimer = null;
let reconnectTimer = null;
let pairingPoller = null;

let reconnectAttemptCount = 0;
let consecutiveLoggedOutCount = 0;
let lastKnownCredsUpdatedAtMs = 0;

/**
 * Safely converts PostgreSQL updated_at (Date or string) to epoch milliseconds.
 * Ensures consistent comparison across driver formats.
 */
function parseTimestampMs(raw) {
  if (!raw) return 0;
  if (raw instanceof Date) return raw.getTime();
  const time = new Date(raw).getTime();
  return Number.isNaN(time) ? 0 : time;
}

/**
 * Clears all active retry, reconnection and background polling timers.
 * Prevents race conditions and duplicate concurrent socket triggers.
 */
function clearAllTimers() {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (pairingPoller) {
    clearInterval(pairingPoller);
    pairingPoller = null;
  }
}

/**
 * Gracefully shuts down the worker, cancels all timers, and releases database locks.
 */
async function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info({ signal }, "Received shutdown signal. Stopping WhatsApp daemon gracefully...");

  clearAllTimers();
  registerActiveSender(null);

  if (activeWorker) {
    try {
      logger.info("Closing WhatsApp socket connection...");
      await activeWorker.stop();
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        "Error stopping WhatsApp worker socket during shutdown."
      );
    }
    activeWorker = null;
  }

  if (currentLockHandle) {
    try {
      logger.info("Releasing PostgreSQL advisory lock...");
      await currentLockHandle.release();
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        "Error releasing advisory lock during shutdown."
      );
    }
    currentLockHandle = null;
  }

  logger.info("WhatsApp daemon shutdown complete.");
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGQUIT", () => shutdown("SIGQUIT"));
process.on("SIGHUP", () => shutdown("SIGHUP"));

// Guard against unexpected promise rejections causing Railway container restart loops
process.on("unhandledRejection", (reason) => {
  logger.error(
    { err: reason instanceof Error ? reason.message : String(reason) },
    "[WHATSAPP DAEMON] Unhandled promise rejection captured. Daemon continuing in stable state."
  );
});

process.on("uncaughtException", (error) => {
  logger.error(
    { err: error instanceof Error ? error.message : String(error) },
    "[WHATSAPP DAEMON] Uncaught exception captured."
  );
});

/**
 * Starts the Baileys connection if the advisory lock is held.
 * Enforces single-socket concurrency with mutex flag and validates session integrity.
 */
async function startSocket() {
  if (isShuttingDown || !currentLockHandle?.acquired) return;
  if (isStartingSocket) {
    logger.warn("[WHATSAPP DAEMON] startSocket is already in progress. Skipping overlapping invocation.");
    return;
  }

  isStartingSocket = true;
  // Always clear any pending reconnect or poller timers before opening a socket
  clearAllTimers();

  // 1. Ensure any previous worker socket is cleanly stopped before opening a new one
  if (activeWorker) {
    try {
      logger.info("Stopping previous Baileys worker socket before opening a new connection...");
      await activeWorker.stop();
    } catch (stopErr) {
      logger.warn(
        { err: stopErr instanceof Error ? stopErr.message : String(stopErr) },
        "Notice: error stopping previous worker socket."
      );
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
    } catch (cleanErr) {
      logger.debug(
        { err: cleanErr instanceof Error ? cleanErr.message : String(cleanErr) },
        "Notice: could not clean expired pairing locks."
      );
    }

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

    // 4. Verify session integrity in PostgreSQL before opening a socket
    const verification = await verifyPersistedSession("default");
    logger.info(
      {
        registered: verification.registered,
        totalKeys: verification.totalKeys,
        signalKeysCount: verification.signalKeysCount,
        hasSignalKeys: verification.hasSignalKeys,
        isValid: verification.isValid,
        jid: verification.jid ? maskPhone(verification.jid) : null,
      },
      `[WHATSAPP DAEMON DIAGNOSTIC] Session 'default' in PostgreSQL: registered=${verification.registered}, totalKeys=${verification.totalKeys}, signalKeys=${verification.signalKeysCount}`
    );

    // If query failed due to temporary DB connectivity issue, retry without assuming session is gone
    if (verification.error && verification.error.includes("Database query failed")) {
      logger.warn(
        { error: verification.error },
        "[WHATSAPP DAEMON] Transient database error verifying session in PostgreSQL. Retrying in 5s..."
      );
      if (!isShuttingDown) {
        reconnectTimer = setTimeout(startSocket, 5000);
      }
      return;
    }

    if (verification.error && verification.error.includes("Decryption failed")) {
      logger.error(
        { error: verification.error },
        "[WHATSAPP DAEMON CRITICAL] Decryption failed for persisted credentials! " +
        "WHATSAPP_SESSION_ENCRYPTION_KEY does not match the key used to encrypt the session. " +
        "Daemon cannot proceed until the correct encryption key is configured in Railway. Retrying in 30s..."
      );
      if (!isShuttingDown) {
        reconnectTimer = setTimeout(startSocket, 30000);
      }
      return;
    }

    if (!verification.registered) {
      logger.warn(
        { totalKeys: verification.totalKeys, error: verification.error },
        "[WHATSAPP DAEMON DIAGNOSTIC] No registered credentials found in PostgreSQL. " +
        "Daemon will not open an unauthenticated QR socket in headless mode. " +
        "Standing by until device is paired via 'node scripts/whatsapp-pair.mjs <phone>' (checking in 15s)..."
      );
      if (!isShuttingDown) {
        reconnectTimer = setTimeout(startSocket, 15000);
      }
      return;
    }

    // Record last known updated_at timestamp of creds row to accurately detect subsequent re-pairings
    try {
      const credsRow = await query(
        "SELECT updated_at FROM whatsapp_baileys_session WHERE session_id = 'default' AND key_id = 'creds'"
      );
      lastKnownCredsUpdatedAtMs = parseTimestampMs(credsRow.rows?.[0]?.updated_at);
    } catch (tsErr) {
      logger.debug(
        { err: tsErr instanceof Error ? tsErr.message : String(tsErr) },
        "Notice: could not read creds updated_at timestamp."
      );
    }

    logger.info(
      { jid: verification.jid ? maskPhone(verification.jid) : null },
      "[WHATSAPP DAEMON DIAGNOSTIC] Found valid registered session in PostgreSQL. Connecting to WhatsApp via Baileys..."
    );

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
        reconnectAttemptCount = 0;
        consecutiveLoggedOutCount = 0;
        logger.info(
          "[WHATSAPP DAEMON] WhatsApp bot is connected and ready to receive messages. Reconnection counter reset."
        );
        if (activeWorker) {
          registerActiveSender(activeWorker.sendMessage, activeWorker.sendDocument);
        }
      },
      onConnectionClose: async (shouldReconnect, statusCode, error, classification) => {
        registerActiveSender(null);
        if (isShuttingDown) return;

        if (activeWorker) {
          try {
            await activeWorker.stop();
          } catch (stopErr) {
            logger.warn(
              { err: stopErr instanceof Error ? stopErr.message : String(stopErr) },
              "Notice: error stopping worker on connection close."
            );
          }
          activeWorker = null;
        }

        const cls = classification || classifyDisconnectReason(statusCode, error);

        if (cls.isLoggedOut || cls.reason === "forbidden") {
          consecutiveLoggedOutCount++;
          const delayMs = calculateReconnectDelay(cls.statusCode, consecutiveLoggedOutCount - 1);

          logger.warn(
            {
              statusCode: cls.statusCode,
              reason: cls.reason,
              consecutiveCount: consecutiveLoggedOutCount,
              nextRetryDelayMs: delayMs,
            },
            `[WHATSAPP DAEMON] WhatsApp session reported 401 Unauthorized (#${consecutiveLoggedOutCount}). ` +
            "Preserving credentials in PostgreSQL without deleting. " +
            (consecutiveLoggedOutCount === 1
              ? `Checking for transient WhatsApp server glitch in ${delayMs / 1000}s...`
              : `Standing by with spaced-out verification in ${Math.round(delayMs / 1000)}s (or immediately if credentials are updated in DB)...`)
          );

          // Clear any active timers before scheduling standby poller
          clearAllTimers();

          // Fast background poller: detects if an operator pairs anew with scripts/whatsapp-pair.mjs
          pairingPoller = setInterval(async () => {
            if (isShuttingDown || !currentLockHandle?.acquired) {
              clearAllTimers();
              return;
            }
            try {
              const checkRow = await query(
                "SELECT updated_at FROM whatsapp_baileys_session WHERE session_id = 'default' AND key_id = 'creds'"
              );
              const currentTimestampMs = parseTimestampMs(checkRow.rows?.[0]?.updated_at);
              if (currentTimestampMs > 0 && currentTimestampMs > lastKnownCredsUpdatedAtMs) {
                logger.info(
                  "[WHATSAPP DAEMON] Detected newly updated credentials in PostgreSQL! Resuming connection immediately..."
                );
                clearAllTimers();
                consecutiveLoggedOutCount = 0;
                lastKnownCredsUpdatedAtMs = currentTimestampMs;
                startSocket();
              }
            } catch (pollErr) {
              logger.debug(
                { err: pollErr instanceof Error ? pollErr.message : String(pollErr) },
                "[WHATSAPP DAEMON] Notice: temporary error querying credentials update during standby poll."
              );
            }
          }, 10000);

          reconnectTimer = setTimeout(() => {
            clearAllTimers();
            if (!isShuttingDown && currentLockHandle?.acquired) {
              logger.info(
                "[WHATSAPP DAEMON] Testing connection with existing credentials in case 401 was a transient WhatsApp server glitch..."
              );
              startSocket();
            }
          }, delayMs);

          return;
        }

        // Recoverable disconnections: apply progressive backoff with jitter
        reconnectAttemptCount++;
        const delayMs = calculateReconnectDelay(statusCode, reconnectAttemptCount);

        logger.warn(
          {
            statusCode: cls.statusCode,
            reason: cls.reason,
            attempt: reconnectAttemptCount,
            delayMs,
          },
          `[WHATSAPP DAEMON] WhatsApp disconnected (${cls.description}). Scheduling reconnection in ${delayMs}ms (attempt #${reconnectAttemptCount})...`
        );

        clearAllTimers();
        reconnectTimer = setTimeout(() => {
          if (!isShuttingDown && currentLockHandle?.acquired) {
            startSocket();
          }
        }, delayMs);
      },
    });

    if (activeWorker && activeWorker.socket?.user) {
      registerActiveSender(activeWorker.sendMessage, activeWorker.sendDocument);
    }
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : error },
      "[WHATSAPP DAEMON] Failed to start Baileys worker socket."
    );
    if (!isShuttingDown) {
      reconnectAttemptCount++;
      const delayMs = Math.min(30000, 5000 * Math.pow(1.5, Math.min(reconnectAttemptCount, 5)));
      clearAllTimers();
      reconnectTimer = setTimeout(startSocket, delayMs);
    }
  } finally {
    isStartingSocket = false;
  }
}

/**
 * Main daemon loop: acquires advisory lock and maintains single-instance execution.
 */
async function runDaemon() {
  if (isShuttingDown) return;

  clearAllTimers();

  try {
    const lock = await acquireDedicatedAdvisoryLock({
      lockId: DEFAULT_WHATSAPP_ADVISORY_LOCK_ID,
      connectionString: databaseUrl,
      onLockLost: async (error) => {
        logger.error(
          { error: error.message },
          "CRITICAL: PostgreSQL connection for advisory lock was lost! Closing WhatsApp socket immediately..."
        );
        clearAllTimers();
        registerActiveSender(null);
        if (activeWorker) {
          try {
            await activeWorker.stop();
          } catch (stopErr) {
            logger.warn(
              { err: stopErr instanceof Error ? stopErr.message : String(stopErr) },
              "Notice: error stopping worker on advisory lock loss."
            );
          }
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
    logger.error(
      { error: error instanceof Error ? error.message : error },
      "Database connection error trying to acquire advisory lock. Retrying in 5s..."
    );
    if (!isShuttingDown) {
      retryTimer = setTimeout(runDaemon, 5000);
    }
  }
}

// Start the daemon
runDaemon();
