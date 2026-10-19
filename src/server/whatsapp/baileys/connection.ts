import makeWASocket, {
  Browsers,
  DisconnectReason,
  jidNormalizedUser,
  type WASocket,
  type WAMessage,
} from "@whiskeysockets/baileys";
import pino from "pino";
import { initPostgresAuthState, saveEncryptedPairingCode, clearEncryptedPairingCode } from "./auth-state";
import { normalizePhoneNumber, getPhoneVariants, maskPhone } from "../auth";
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
 * Extracts plain text from a Baileys WAMessage, recursively unwrapping
 * ephemeral, view-once, and edited message wrappers.
 */
export function extractMessageText(msg: WAMessage): string {
  if (!msg.message) return "";

  // Recursively unwrap future-proof containers (ephemeral, view-once, edited)
  let m: Record<string, any> = msg.message as Record<string, any>;
  for (let i = 0; i < 5; i++) {
    if (!m) break;
    const inner =
      m.ephemeralMessage?.message ||
      m.viewOnceMessage?.message ||
      m.viewOnceMessageV2?.message ||
      m.viewOnceMessageV2Extension?.message ||
      m.documentWithCaptionMessage?.message ||
      m.editedMessage?.message?.protocolMessage?.editedMessage ||
      m.associatedChildMessage?.message;

    if (inner) {
      m = inner;
    } else {
      break;
    }
  }

  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.buttonsResponseMessage?.selectedButtonId ||
    m.templateButtonReplyMessage?.selectedId ||
    m.listResponseMessage?.singleSelectReply?.selectedRowId ||
    ""
  ).trim();
}

/**
 * Extracts digits from a JID string (e.g. 5491112345678@s.whatsapp.net -> 5491112345678).
 */
export function extractPhoneFromJid(jid: string | null | undefined): string {
  if (!jid) return "";
  const atIdx = jid.indexOf("@");
  let rawDigits = atIdx !== -1 ? jid.slice(0, atIdx) : jid;
  const colonIdx = rawDigits.indexOf(":");
  if (colonIdx !== -1) {
    rawDigits = rawDigits.slice(0, colonIdx);
  }
  return normalizePhoneNumber(rawDigits);
}

/**
 * Extracts normalized phone number from a Baileys WAMessage or JID string.
 * Checks remoteJidAlt / participantAlt / participant when remoteJid is a LID (@lid).
 */
export function extractSenderPhone(msg: WAMessage | string | null | undefined): string {
  if (!msg) return "";

  if (typeof msg === "string") {
    return extractPhoneFromJid(msg);
  }

  const key = msg.key;
  if (!key) return "";

  // 1. If remoteJidAlt is a phone JID (@s.whatsapp.net or @c.us), prefer it
  const remoteAlt = key.remoteJidAlt;
  if (remoteAlt && (remoteAlt.endsWith("@s.whatsapp.net") || remoteAlt.endsWith("@c.us"))) {
    const phone = extractPhoneFromJid(remoteAlt);
    if (phone) return phone;
  }

  // 2. If participantAlt is a phone JID, use it
  const partAlt = key.participantAlt;
  if (partAlt && (partAlt.endsWith("@s.whatsapp.net") || partAlt.endsWith("@c.us"))) {
    const phone = extractPhoneFromJid(partAlt);
    if (phone) return phone;
  }

  // 3. If participant is a phone JID (e.g. in groups)
  const participant = key.participant;
  if (participant && (participant.endsWith("@s.whatsapp.net") || participant.endsWith("@c.us"))) {
    const phone = extractPhoneFromJid(participant);
    if (phone) return phone;
  }

  // 4. If remoteJid is a phone JID
  const remoteJid = key.remoteJid;
  if (remoteJid && (remoteJid.endsWith("@s.whatsapp.net") || remoteJid.endsWith("@c.us"))) {
    const phone = extractPhoneFromJid(remoteJid);
    if (phone) return phone;
  }

  // 5. Fallback if remoteJid is present
  if (remoteJid) {
    return extractPhoneFromJid(remoteJid);
  }

  return "";
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

  // Track message IDs dispatched by this bot process to avoid processing our own outgoing echoes
  const sentByBotMessageIds = new Set<string>();

  // 3. Sender helper for responses
  const sendMessage = async (
    to: string,
    text: string
  ): Promise<{ success: boolean; messageId?: string; error?: string }> => {
    try {
      let jid = (to || "").trim();
      if (!jid.includes("@")) {
        const cleanTo = normalizePhoneNumber(jid);
        const variants = getPhoneVariants(cleanTo);
        // For Argentine numbers, prefer the 549 variant for WhatsApp user JIDs
        const pn = variants.find((v) => v.startsWith("549")) || cleanTo;
        jid = `${pn}@s.whatsapp.net`;
      }

      logger.info(
        { recipient: maskPhone(jid), textLength: text.length },
        "[WHATSAPP BOT] Sending outgoing message via Baileys..."
      );

      const res = await sock.sendMessage(jid, { text });
      if (res?.key?.id) {
        sentByBotMessageIds.add(res.key.id);
        if (sentByBotMessageIds.size > 500) {
          const oldest = sentByBotMessageIds.values().next().value;
          if (oldest) sentByBotMessageIds.delete(oldest);
        }
      }

      logger.info(
        { recipient: maskPhone(jid), messageId: res?.key?.id },
        "[WHATSAPP BOT] Message sent successfully via Baileys."
      );
      return { success: true, messageId: res?.key?.id ?? undefined };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Send failed";
      logger.error(
        { err, recipient: maskPhone(to) },
        "[WHATSAPP BOT] Failed to send message via Baileys."
      );
      return { success: false, error: message };
    }
  };

  // 4. Incoming messages listener
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    logger.info(
      { type, count: messages.length },
      `[WHATSAPP BOT] Incoming messages.upsert event received: count=${messages.length}, type=${type}`
    );

    for (const msg of messages) {
      const messageId = msg.key.id || `baileys_${Date.now()}`;

      // 1. Ignore messages sent by our bot process
      if (sentByBotMessageIds.has(messageId)) {
        continue;
      }

      // 2. Ignore messages without body or broadcast/status updates
      if (!msg.message) continue;
      const remoteJid = msg.key.remoteJid;
      if (!remoteJid || remoteJid === "status@broadcast") continue;

      // 3. For 'append' events, only process recent messages (e.g. within 120s) to avoid replaying history
      if (type === "append") {
        const timestamp = Number(msg.messageTimestamp || 0);
        const ageSec = timestamp > 0 ? Date.now() / 1000 - timestamp : 999;
        if (ageSec > 120) {
          continue;
        }
      }

      // 4. Disallow group messages unless authorized
      if (remoteJid.endsWith("@g.us")) continue;

      // 5. Check fromMe:
      // If fromMe is true, only allow if the chat is a self-chat ("Note to self")
      // where the user sends a message to their own bot account!
      if (msg.key.fromMe) {
        const myJid = sock.user?.id ? jidNormalizedUser(sock.user.id) : null;
        const myLid = sock.user?.lid ? jidNormalizedUser(sock.user.lid) : null;
        const normalizedRemote = jidNormalizedUser(remoteJid);
        const isSelfChat =
          (myJid && normalizedRemote === myJid) ||
          (myLid && normalizedRemote === myLid) ||
          Boolean(pairingNumber && remoteJid.includes(normalizePhoneNumber(pairingNumber)));

        if (!isSelfChat) {
          // Outgoing message to another contact, ignore
          continue;
        }
        logger.info({ messageId }, "[WHATSAPP BOT] Processing self-chat incoming message.");
      }

      // 6. Extract sender phone and message text
      let senderPhone = extractSenderPhone(msg);
      // If remoteJid was a LID and no alt was attached, try signalRepository LID mapping
      if (
        (!senderPhone || remoteJid.endsWith("@lid")) &&
        (sock as any).signalRepository?.lidMapping?.getPNForLID
      ) {
        try {
          const pnJid = await (sock as any).signalRepository.lidMapping.getPNForLID(remoteJid);
          if (pnJid) {
            const resolved = extractPhoneFromJid(pnJid);
            if (resolved) senderPhone = resolved;
          }
        } catch {}
      }

      const textBody = extractMessageText(msg);
      const senderName = msg.pushName || undefined;

      logger.info(
        {
          messageId,
          senderMasked: maskPhone(senderPhone || remoteJid),
          hasText: Boolean(textBody),
          textSnippet: textBody ? textBody.slice(0, 30) : "(empty)",
          fromMe: Boolean(msg.key.fromMe),
        },
        "[WHATSAPP BOT] Received incoming message payload"
      );

      if (!textBody) {
        logger.warn({ messageId }, "[WHATSAPP BOT] Message has no text body. Skipping.");
        continue;
      }

      const effectivePhone = senderPhone || extractPhoneFromJid(remoteJid);
      if (!effectivePhone) {
        logger.warn({ messageId, remoteJid }, "[WHATSAPP BOT] Unable to resolve sender phone. Skipping.");
        continue;
      }

      await processIncomingMessage({
        messageId,
        senderPhone: effectivePhone,
        replyTo: remoteJid, // Always reply to the original conversation JID
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
