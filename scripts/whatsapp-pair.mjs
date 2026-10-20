import { register } from "node:module";
register("./loader.mjs", import.meta.url);

const { normalizePhoneNumber } = await import("../src/server/whatsapp/auth.ts");
const { startBaileysWorker } = await import("../src/server/whatsapp/baileys/connection.ts");
const { ensureSessionTable, verifyPersistedSession } = await import("../src/server/whatsapp/baileys/auth-state.ts");
const { query } = await import("../src/server/db/client.ts");

const databaseUrl = process.env.DATABASE_URL;
const encryptionKey = process.env.WHATSAPP_SESSION_ENCRYPTION_KEY;

// Parse CLI flags and phone number
const rawArgs = process.argv.slice(2);
const forceClean = rawArgs.includes("--force") || rawArgs.includes("--clean");
const pairingNumber = rawArgs.find((arg) => !arg.startsWith("-")) || process.env.WHATSAPP_PAIRING_NUMBER;

if (!databaseUrl) {
  console.error("ERROR: DATABASE_URL no está configurada.");
  process.exit(1);
}

if (!encryptionKey) {
  console.error("ERROR: WHATSAPP_SESSION_ENCRYPTION_KEY no está configurada.");
  process.exit(1);
}

if (!pairingNumber) {
  console.error("ERROR: Debe especificar el número de WhatsApp para vincular.");
  console.error("Uso: node scripts/whatsapp-pair.mjs <NUMERO_TELEFONO> [--force] (ej: 5493885196480)");
  process.exit(1);
}

const cleanNumber = normalizePhoneNumber(pairingNumber);
if (!cleanNumber) {
  console.error("ERROR: El número de teléfono proporcionado no es válido.");
  process.exit(1);
}

console.log("\n=======================================================");
console.log("   LA CASA DEL KIOSKERO — HERRAMIENTA LOCAL DE VINCULACIÓN");
console.log("=======================================================");
console.log(`Número objetivo: ${cleanNumber}`);
if (forceClean) {
  console.log("Modo: --force activado (se limpiará cualquier sesión previa antes de solicitar código)");
}

console.log("Verificando conexión con PostgreSQL y asegurando tabla de sesión...");
try {
  await ensureSessionTable();
  const testRes = await query("SELECT count(*) FROM whatsapp_baileys_session WHERE session_id = 'default'");
  console.log(`Conexión con PostgreSQL exitosa (claves existentes en sesión: ${testRes.rows[0].count}).`);
} catch (dbErr) {
  console.error("\n❌ [ERROR FATAL] No se pudo conectar a PostgreSQL o inicializar la tabla de sesión:");
  console.error(dbErr?.message || dbErr);
  if (databaseUrl.includes(".railway.internal")) {
    console.error("\nAVISO: La DATABASE_URL contiene '.railway.internal', que solo es accesible dentro de Railway.");
    console.error("Para vincular localmente, debés usar la URL pública del TCP Proxy de Railway (ej: switchback.proxy.rlwy.net:PORT).\n");
  }
  process.exit(1);
}

async function setPairingLock() {
  try {
    await query(
      `INSERT INTO whatsapp_baileys_session (session_id, key_id, ciphertext, iv, tag, updated_at)
       VALUES ('default', 'lock:pairing', 'active', 'none', 'none', now())
       ON CONFLICT (session_id, key_id)
       DO UPDATE SET ciphertext = 'active', updated_at = now()`
    );
  } catch (err) {
    console.warn("[PAIR LOCK] Advertencia al actualizar bloqueo:", err?.message || err);
  }
}

async function clearPairingLock() {
  try {
    await query("DELETE FROM whatsapp_baileys_session WHERE session_id = 'default' AND key_id = 'lock:pairing'");
  } catch (err) {
    console.warn("[PAIR LOCK] Advertencia al liberar bloqueo:", err?.message || err);
  }
}

// Global state
let activeWorker = null;
let isPairingFinished = false;
let isStartingWorker = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
let stabilizationTimer = null;
let reconnectTimer = null;
const STABILIZATION_TIME_MS = 12000;
let isCleanedUp = false;

// Lock heartbeat to prevent expiry in worker daemon while pairing is active
let lockHeartbeat = setInterval(() => {
  setPairingLock().catch(() => {});
}, 25000);

async function cleanup(exitCode = 0) {
  if (isCleanedUp) return;
  isCleanedUp = true;

  if (lockHeartbeat) {
    clearInterval(lockHeartbeat);
    lockHeartbeat = null;
  }

  if (stabilizationTimer) {
    clearTimeout(stabilizationTimer);
    stabilizationTimer = null;
  }

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  if (activeWorker) {
    try {
      await activeWorker.stop();
    } catch {}
    activeWorker = null;
  }

  await clearPairingLock();
  process.exit(exitCode);
}

process.on("SIGINT", async () => {
  console.log("\nCancelando vinculación...");
  await cleanup(130);
});

process.on("SIGTERM", async () => {
  console.log("\nTerminando proceso de vinculación...");
  await cleanup(143);
});

process.on("beforeExit", async () => {
  await cleanup(0);
});

process.on("uncaughtException", async (err) => {
  console.error("\n❌ [ERROR NO CAPTURADO]:", err);
  await cleanup(1);
});

process.on("unhandledRejection", async (reason) => {
  console.error("\n❌ [RECHAZO DE PROMESA NO MANEJADO]:", reason);
  await cleanup(1);
});

// Pre-flight check: verify if a valid registered session already exists
const preflightVerification = await verifyPersistedSession("default");
if (preflightVerification.isValid && !forceClean) {
  console.log("\n⚠️ [AVISO] Ya existe una sesión registrada y válida en PostgreSQL para este bot:");
  console.log(`- JID: ${preflightVerification.jid}`);
  console.log(`- Claves totales almacenadas: ${preflightVerification.totalKeys} (Signal: ${preflightVerification.signalKeysCount})`);
  console.log("\nSi deseás volver a vincular y reemplazar esta sesión, ejecutá:");
  console.log(`node scripts/whatsapp-pair.mjs ${cleanNumber} --force\n`);
  await cleanup(0);
}

let finalizeRetries = 0;
const MAX_FINALIZE_RETRIES = 4;

async function finalizePairingIfValid() {
  if (isPairingFinished) return;

  try {
    console.log("\n[PAIR] Período de estabilización completado. Verificando persistencia y sincronización de credenciales...");

    // 1. Verify that active socket is still alive and has authenticated user JID
    const activeJid = activeWorker?.socket?.user?.id;
    if (!activeWorker || !activeJid) {
      console.error("\n❌ [ERROR CRÍTICO] El socket local no está autenticado o se desconectó antes de finalizar la sincronización.");
      await cleanup(1);
      return;
    }

    if (activeWorker?.saveCreds) {
      await activeWorker.saveCreds();
    }

    const verification = await verifyPersistedSession("default");

    if (!verification.isValid) {
      finalizeRetries++;
      if (finalizeRetries > MAX_FINALIZE_RETRIES) {
        console.error(`\n❌ [ERROR CRÍTICO] Se agotó el tiempo máximo de espera para sincronización completa: ${verification.error || "claves Signal insuficientes"}.`);
        console.error(`Estado final: registered=${verification.registered}, totalKeys=${verification.totalKeys}, signalKeys=${verification.signalKeysCount}`);
        await cleanup(1);
        return;
      }
      console.warn(`[PAIR] Sincronización aún en progreso (${verification.error || "esperando registro o claves Signal adicionales"}, intento ${finalizeRetries}/${MAX_FINALIZE_RETRIES})...`);
      console.log(`[PAIR] Diagnóstico: registered=${verification.registered}, totalKeys=${verification.totalKeys}, signalKeys=${verification.signalKeysCount}, jid=${verification.jid}`);
      stabilizationTimer = setTimeout(finalizePairingIfValid, 5000);
      return;
    }

    isPairingFinished = true;
    console.log("\n" + "=".repeat(60));
    console.log("✅ [ÉXITO TOTAL] ¡VINCULACIÓN CONFIRMADA Y VALIDADA EN POSTGRESQL!");
    console.log("=".repeat(60));
    console.log(`- Dispositivo JID: ${verification.jid}`);
    console.log(`- Claves totales en PostgreSQL: ${verification.totalKeys} (claves Signal: ${verification.signalKeysCount})`);
    console.log(`- Estado de registro: registered = true`);
    console.log(`- Cifrado autenticado: AES-256-GCM verificado con éxito.`);
    console.log("\nCerrando socket local de vinculación para ceder el control al Worker de Railway...");

    console.log("Socket local cerrado y bloqueo 'lock:pairing' liberado.");
    console.log("Las credenciales están listas en PostgreSQL para que el Worker de Railway tome el control automáticamente.\n");
    await cleanup(0);
  } catch (err) {
    console.error("\n❌ [ERROR CRÍTICO] Falló la verificación final en PostgreSQL:", err?.message || err);
    await cleanup(1);
  }
}

async function runPairing(cleanSession = false) {
  if (isPairingFinished || isStartingWorker) return;
  isStartingWorker = true;

  try {
    await setPairingLock();

    // Ensure any previous worker instance is stopped before creating a new socket
    if (activeWorker) {
      try {
        await activeWorker.stop();
      } catch {}
      activeWorker = null;
    }

    console.log("Conectando con WhatsApp para solicitar código de vinculación...");

    activeWorker = await startBaileysWorker({
      sessionId: "default",
      pairingNumber: cleanNumber,
      forceCleanSession: cleanSession,
      onPairingCode: (code) => {
        console.log("\n" + "=".repeat(50));
        console.log(`>>> CÓDIGO DE VINCULACIÓN: ${code} <<<`);
        console.log("=".repeat(50));
        console.log("\nPasos para vincular:");
        console.log("1. Abrí WhatsApp en tu teléfono celular.");
        console.log("2. Andá a Ajustes / Menú > Dispositivos Vinculados.");
        console.log("3. Seleccioná 'Vincular un dispositivo' > 'Vincular con el número de teléfono'.");
        console.log(`4. Ingresá el código de 8 dígitos mostrado arriba: ${code}`);
        console.log("\nEsperando confirmación e ingreso en WhatsApp...\n");
      },
      onConnectionOpen: async () => {
        if (isPairingFinished) return;
        console.log("\n[PAIR] ¡Canal abierto con WhatsApp (connection: 'open')!");
        console.log("[PAIR] Esperando estabilización del enlace y sincronización de claves Signal (12s)...");

        try {
          if (activeWorker?.saveCreds) {
            await activeWorker.saveCreds();
          }
        } catch {}

        if (stabilizationTimer) clearTimeout(stabilizationTimer);
        stabilizationTimer = setTimeout(finalizePairingIfValid, STABILIZATION_TIME_MS);
      },
      onConnectionClose: async (shouldReconnect, statusCode) => {
        if (isPairingFinished) return;

        // Cancel any pending stabilization timer
        if (stabilizationTimer) {
          clearTimeout(stabilizationTimer);
          stabilizationTimer = null;
        }

        // Close and null previous active worker immediately so no two sockets exist during the backoff delay
        if (activeWorker) {
          try {
            await activeWorker.stop();
          } catch {}
          activeWorker = null;
        }

        // WhatsApp sends 515 (Restart Required) during initial companion setup
        const isRestartRequired = statusCode === 515 || (shouldReconnect && statusCode !== 401);

        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }

        if (isRestartRequired && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
          reconnectAttempts++;
          console.log(`\n[INFO] Conexión cerrada con código ${statusCode ?? 515} (reinicio requerido para sincronización de credenciales).`);
          console.log(`[INFO] Reconectando intento ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} conservando credenciales...`);

          reconnectTimer = setTimeout(async () => {
            reconnectTimer = null;
            try {
              // CRITICAL: Reconnect without wiping credentials (cleanSession = false)
              await runPairing(false);
            } catch (err) {
              console.error("Fallo al reconectar:", err?.message || err);
              await cleanup(1);
            }
          }, 2000);
        } else {
          console.error(`\n❌ [ERROR] La sesión no se pudo vincular (código de desconexión: ${statusCode ?? "desconocido"}).`);
          if (statusCode === 401) {
            console.error("WhatsApp rechazó la autenticación (401 Unauthorized). Verificá que el número no esté vinculado a otra sesión o que el código se haya ingresado a tiempo.");
          }
          await cleanup(1);
        }
      },
    });
  } catch (error) {
    console.error("Fallo al inicializar vinculación:", error?.message || error);
    await cleanup(1);
  } finally {
    isStartingWorker = false;
  }
}

// On first run, clean any previous abandoned/broken pairing attempts if requested or unregistered
const shouldCleanOnStart = forceClean || !preflightVerification.isValid;
await runPairing(shouldCleanOnStart);
