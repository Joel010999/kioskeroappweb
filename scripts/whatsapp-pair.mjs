import { register } from "node:module";
register("./loader.mjs", import.meta.url);

const { normalizePhoneNumber } = await import("../src/server/whatsapp/auth.ts");
const { startBaileysWorker } = await import("../src/server/whatsapp/baileys/connection.ts");

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
  console.error("Uso: node scripts/whatsapp-pair.mjs <NUMERO_TELEFONO> (ej: 5491112345678)");
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
console.log("Conectando con WhatsApp para solicitar código de vinculación...");

let activeWorker = null;

try {
  activeWorker = await startBaileysWorker({
    sessionId: "default",
    pairingNumber: cleanNumber,
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
      console.log("\n✅ [ÉXITO] ¡Dispositivo vinculado correctamente!");
      console.log("Las credenciales fueron cifradas con AES-256-GCM y guardadas en PostgreSQL.");
      console.log("Ya podés iniciar el servicio Worker en Railway.\n");
      await activeWorker?.stop();
      process.exit(0);
    },
    onConnectionClose: (shouldReconnect) => {
      if (!shouldReconnect) {
        console.log("\nLa sesión fue cerrada o desvinculada.");
        process.exit(1);
      }
    },
  });
} catch (error) {
  console.error("Fallo al inicializar vinculación:", error);
  process.exit(1);
}
