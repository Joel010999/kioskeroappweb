import makeWASocket, {
  Browsers,
  DisconnectReason,
  type WASocket,
  type WAMessage,
} from "@whiskeysockets/baileys";
import pino from "pino";
import { initPostgresAuthState, saveEncryptedPairingCode, clearEncryptedPairingCode } from "./auth-state";
import { normalizePhoneNumber } from "../auth";
import { processIncomingMessage } from "../processor";

export type BaileysWorkerConfig = {
  sessionId?: string;
  pairingNumber?: string;
  allowedNumbersEnv?: string;
  cleanUnregisteredSession?: boolean;
  onConnectionOpen?: () => void;
  onConnectionClose?: (shouldReconnect: boolean, statusCode?: number, error?: Error) => void;
  onPairingCode?: (code: string) => void;
  logger?: pino.Logger;
};

export type ActiveBaileysWorker = {
  socket: WASocket;
  saveCreds: () => Promise<void>;
  stop: () => Promise<void>;
  sendMessage: (to: string, text: string) => Promise<{ success: boolean; messageId?: string; error?: string }>;
};

/**
 * Extracts plain text from a Baileys WAMessage.
 */
export function extractMessageText(msg: WAMessage): string {
  const m = msg.message;
  if (!m) return "";

  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    ""
  ).trim();
}

/**
 * Extracts normalized phone number from a remoteJid (e.g. 5491112345678@s.whatsapp.net).
 */
export function extractSenderPhone(remoteJid: string | null | undefined): string {
  if (!remoteJid) return "";
  const atIdx = remoteJid.indexOf("@");
  let rawDigits = atIdx !== -1 ? remoteJid.slice(0, atIdx) : remoteJid;
  const colonIdx = rawDigits.indexOf(":");
  if (colonIdx !== -1) {
    rawDigits = rawDigits.slice(0, colonIdx);
  }
  return normalizePhoneNumber(rawDigits);
}

/**
 * Creates and manages a Baileys WhatsApp WebSocket connection.
 */
export async function startBaileysWorker(
  config: BaileysWorkerConfig = {}
): Promise<ActiveBaileysWorker> {
  const sessionId = config.sessionId ?? "default";
  const logger = config.logger ?? pino({ level: "silent" });
  const { state, saveCreds, clearSession } = await initPostgresAuthState({
    sessionId,
  });

  if (config.cleanUnregisteredSession && !state.creds.registered) {
    await clearSession();
  }

  let isStopping = false;

  const sock = makeWASocket({
    auth: state,
    logger,
    browser: Browsers.ubuntu("Chrome"),
    printQRInTerminal: false,
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  // Pairing Code handling (if phone number provided and device is not yet registered)
  const pairingNumber = config.pairingNumber ?? process.env.WHATSAPP_PAIRING_NUMBER;
  if (pairingNumber && !state.creds.registered) {
    const cleanNumber = normalizePhoneNumber(pairingNumber);
    if (cleanNumber) {
      setTimeout(async () => {
        try {
          const code = await sock.requestPairingCode(cleanNumber);
          // Persist pairing code encrypted with 2.5 min TTL for protected admin retrieval
          await saveEncryptedPairingCode(sessionId, code, 150000);
          if (config.onPairingCode) {
            config.onPairingCode(code);
          }
          // Never log raw pairing code to stdout/logs to avoid leaking sensitive data
          logger.info("[WHATSAPP BOT] Pairing code generated and saved encrypted for admin retrieval.");
        } catch (err) {
          logger.error({ err }, "Failed to request WhatsApp pairing code");
        }
      }, 3000);
    }
  }

  let pendingCredsSave: Promise<void> | null = null;
  const safeSaveCreds = async (): Promise<void> => {
    try {
      pendingCredsSave = saveCreds();
      await pendingCredsSave;
    } catch (saveErr) {
      logger.error({ err: saveErr }, "Error saving credentials to PostgreSQL.");
    } finally {
      pendingCredsSave = null;
    }
  };

  // 1. Credentials update listener
  sock.ev.on("creds.update", async () => {
    await safeSaveCreds();
  });

  // 2. Connection update listener (reconnection & lifecycle)
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === "open") {
      logger.info("Baileys connection established successfully.");
      await safeSaveCreds();
      await clearEncryptedPairingCode(sessionId);
      config.onConnectionOpen?.();
    }

    if (connection === "close") {
      const statusCode = (lastDisconnect?.error as { output?: { statusCode?: number } })?.output?.statusCode;
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;

      logger.warn({ statusCode, isLoggedOut, err: lastDisconnect?.error }, "Baileys connection closed.");

      if (isLoggedOut) {
        logger.error(
          { statusCode, err: lastDisconnect?.error },
          "WhatsApp session disconnected or conflict encountered (status 401). Preserving session data in PostgreSQL."
        );
        await clearEncryptedPairingCode(sessionId);
        config.onConnectionClose?.(false, statusCode, lastDisconnect?.error as Error);
      } else if (!isStopping) {
        // Reconnect needed
        config.onConnectionClose?.(true, statusCode, lastDisconnect?.error as Error);
      }
    }
  });

  // 3. Sender helper for responses
  const sendMessage = async (
    to: string,
    text: string
  ): Promise<{ success: boolean; messageId?: string; error?: string }> => {
    try {
      const cleanTo = normalizePhoneNumber(to);
      const jid = cleanTo.includes("@") ? cleanTo : `${cleanTo}@s.whatsapp.net`;
      const res = await sock.sendMessage(jid, { text });
      return { success: true, messageId: res?.key?.id ?? undefined };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Send failed";
      return { success: false, error: message };
    }
  };

  // 4. Incoming messages listener
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    // Only process notify events (new incoming messages)
    if (type !== "notify") return;

    for (const msg of messages) {
      // Ignore messages sent by the bot itself or broadcast/status updates
      if (msg.key.fromMe) continue;
      if (!msg.message) continue;
      if (msg.key.remoteJid === "status@broadcast") continue;

      const remoteJid = msg.key.remoteJid;
      const senderPhone = extractSenderPhone(remoteJid);
      const textBody = extractMessageText(msg);
      const messageId = msg.key.id || `baileys_${Date.now()}`;
      const senderName = msg.pushName || undefined;

      // Disallow group messages unless authorized
      if (remoteJid?.endsWith("@g.us")) continue;

      if (!senderPhone || !textBody) continue;

      await processIncomingMessage({
        messageId,
        senderPhone,
        textBody,
        senderName,
        configuredAllowedEnv: config.allowedNumbersEnv,
        sendMessageFn: async (to, text) => sendMessage(to, text),
      });
    }
  });

  const stop = async (): Promise<void> => {
    isStopping = true;
    try {
      if (pendingCredsSave) {
        await pendingCredsSave;
      }
      await safeSaveCreds();
      sock.end(undefined);
    } catch {
      // socket end
    }
  };

  return {
    socket: sock,
    saveCreds,
    stop,
    sendMessage,
  };
}
