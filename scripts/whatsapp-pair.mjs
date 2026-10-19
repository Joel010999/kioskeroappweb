import { register } from "node:module";
register("./loader.mjs", import.meta.url);

const { normalizePhoneNumber } = await import("../src/server/whatsapp/auth.ts");
const { startBaileysWorker } = await import("../src/server/whatsapp/baileys/connection.ts");
const { ensureSessionTable } = await import("../src/server/whatsapp/baileys/auth-state.ts");
const { query } = await import("../src/server/db/client.ts");

const databaseUrl = process.env.DATABASE_URL;
const encryptionKey = process.env.WHATSAPP_SESSION_ENCRYPTION_KEY;
const pairingNumber = process.argv[2] || process.env.WHATSAPP_PAIRING_NUMBER;

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
  console.error("Uso: node scripts/whatsapp-pair.mjs <NUMERO_TELEFONO> (ej: 5493885196480)");
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

console.log("Conectando con WhatsApp para solicitar código de vinculación...");

let activeWorker = null;
let isLinked = false;
let reconnectAttempts = 0;

async function runPairing(cleanPreviousSession = false) {
  try {
    activeWorker = await startBaileysWorker({
      sessionId: "default",
      pairingNumber: cleanNumber,
      cleanUnregisteredSession: cleanPreviousSession,
      onPairingCode: (code) => {
        console.log("\n" + "=".repeat(50));
        console.log(`>>> CÓDIGO DE VINCULACIÓN: ${code} <<<`);
        console.log("=".repeat(50));
        console.log("\nPasos para vincular:");
        console.log("1. Abrí WhatsApp en tu teléfono celular.");
        console.log("2. Andá a Ajustes / Menú > Dispositivos Vinculados.");
        console.log("3. Seleccioná 'Vincular un dispositivo' > 'Vincular con el número de teléfono'.");
        console.log(`4. Ingresá el código de 8 dígitos mostrado arriba: ${code}`);
        console.log("\nEsperando confirmación de WhatsApp...\n");
      },
      onConnectionOpen: async () => {
        isLinked = true;
        try {
          if (activeWorker?.saveCreds) {
            await activeWorker.saveCreds();
          }
          const check = await query(
            "SELECT count(*) FROM whatsapp_baileys_session WHERE session_id = $1 AND key_id = $2",
            ["default", "creds"]
          );
          const allKeysCheck = await query(
            "SELECT count(*) FROM whatsapp_baileys_session WHERE session_id = $1",
            ["default"]
          );
          const count = parseInt(check.rows?.[0]?.count || "0", 10);
          const totalKeys = parseInt(allKeysCheck.rows?.[0]?.count || "0", 10);
          if (count === 0) {
            console.error("\n❌ [ERROR CRÍTICO] La conexión abrió pero el registro 'creds' no existe en PostgreSQL.");
            process.exit(1);
          }
          console.log(`\n[PAIR DIAGNOSTIC] Verificación en PostgreSQL: ${totalKeys} claves guardadas, registro 'creds' confirmado.`);
          console.log("✅ [ÉXITO] ¡Dispositivo vinculado correctamente!");
          console.log("Las credenciales fueron cifradas con AES-256-GCM y confirmadas en PostgreSQL.");
          console.log("Ya podés iniciar el servicio Worker en Railway.\n");
        } catch (err) {
          console.error("\n❌ [ERROR CRÍTICO] Falló la verificación de persistencia en PostgreSQL:", err?.message || err);
          process.exit(1);
        }
        setTimeout(async () => {
          await activeWorker?.stop();
          process.exit(0);
        }, 2000);
      },
      onConnectionClose: async (shouldReconnect, statusCode) => {
        if (isLinked) return;

        if (shouldReconnect && reconnectAttempts < 5) {
          reconnectAttempts++;
          console.log(`\n[INFO] Conexión cerrada con código ${statusCode ?? 515} (reinicio requerido para finalizar enlace). Reconectando intento ${reconnectAttempts}/5...`);
          setTimeout(async () => {
            try {
              await activeWorker?.stop();
              // Reconnect without wiping credentials so it finalizes the companion handshake!
              await runPairing(false);
            } catch (err) {
              console.error("Fallo al reconectar:", err?.message || err);
            }
          }, 1500);
        } else {
          console.error(`\n❌ [ERROR] La sesión no se pudo vincular (código de desconexión: ${statusCode ?? "desconocido"}).`);
          console.error("Si el error persiste, esperá 2 minutos para evitar límites de intentos de WhatsApp y volvé a probar.");
          process.exit(1);
        }
      },
    });
  } catch (error) {
    console.error("Fallo al inicializar vinculación:", error?.message || error);
    process.exit(1);
  }
}

// On first run, clean any previous abandoned/broken pairing attempts
await runPairing(true);
