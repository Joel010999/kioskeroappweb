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
import type { SendDocumentOptions, SendMessageResult } from "../types";

export type DisconnectClassification = {
  statusCode?: number;
  reason: string;
  isRecoverable: boolean;
  isLoggedOut: boolean;
  isConflict: boolean;
  isRestartRequired: boolean;
  description: string;
};

/**
 * Classifies Baileys / WhatsApp disconnection reasons from WebSocket status code and error.
 * Differentiates recoverable network/sync events from genuinely invalidated sessions.
 */
export function classifyDisconnectReason(
  statusCode?: number,
  error?: Error
): DisconnectClassification {
  if (statusCode === DisconnectReason.loggedOut) { // 401
    return {
      statusCode,
      reason: "logged_out",
      isRecoverable: false,
      isLoggedOut: true,
      isConflict: false,
      isRestartRequired: false,
      description: "WhatsApp session logged out or unauthorized (status 401). Companion unlinked on mobile device.",
    };
  }
  if (statusCode === DisconnectReason.forbidden) { // 403
    return {
      statusCode,
      reason: "forbidden",
      isRecoverable: false,
      isLoggedOut: false,
      isConflict: false,
      isRestartRequired: false,
      description: "WhatsApp connection forbidden / account restricted (status 403).",
    };
  }
  if (statusCode === DisconnectReason.connectionReplaced) { // 440
    return {
      statusCode,
      reason: "connection_replaced",
      isRecoverable: true,
      isLoggedOut: false,
      isConflict: true,
      isRestartRequired: false,
      description: "Connection conflict: another socket connected with this session (status 440).",
    };
  }
  if (statusCode === DisconnectReason.restartRequired) { // 515
    return {
      statusCode,
      reason: "restart_required",
      isRecoverable: true,
      isLoggedOut: false,
      isConflict: false,
      isRestartRequired: true,
      description: "WhatsApp server requested restart for session/crypto sync (status 515).",
    };
  }
  if (statusCode === DisconnectReason.timedOut || statusCode === DisconnectReason.connectionLost) { // 408
    return {
      statusCode,
      reason: "timed_out",
      isRecoverable: true,
      isLoggedOut: false,
      isConflict: false,
      isRestartRequired: false,
      description: "Connection timed out or keep-alive ping expired (status 408).",
    };
  }
  if (statusCode === DisconnectReason.connectionClosed) { // 428
    return {
      statusCode,
      reason: "connection_closed",
      isRecoverable: true,
      isLoggedOut: false,
      isConflict: false,
      isRestartRequired: false,
      description: "WebSocket connection closed by remote server (status 428).",
    };
  }
  if (statusCode === DisconnectReason.unavailableService) { // 503
    return {
      statusCode,
      reason: "unavailable_service",
      isRecoverable: true,
      isLoggedOut: false,
      isConflict: false,
      isRestartRequired: false,
      description: "WhatsApp service temporarily unavailable or overloaded (status 503).",
    };
  }
  if (statusCode === DisconnectReason.badSession) { // 500
    return {
      statusCode,
      reason: "bad_session",
      isRecoverable: true,
      isLoggedOut: false,
      isConflict: false,
      isRestartRequired: false,
      description: "Session data sync issue or unexpected server stream error (status 500).",
    };
  }

  return {
    statusCode,
    reason: "network_error",
    isRecoverable: true,
    isLoggedOut: false,
    isConflict: false,
    isRestartRequired: false,
    description: `Transient network disconnect or socket termination (${error?.message || "unknown"}).`,
  };
}

/**
 * Calculates progressive delay for reconnection with exponential backoff and jitter.
 * Prevents hammering WhatsApp servers during transient network or service drops.
 */
export function calculateReconnectDelay(statusCode?: number, attemptCount: number = 0): number {
  // 515 (restartRequired): companion setup sync restart, fast turnaround
  if (statusCode === DisconnectReason.restartRequired || statusCode === 515) {
    return 2000;
  }
  // 440 (connectionReplaced / conflict): allow previous socket or other instance to finish teardown
  if (statusCode === DisconnectReason.connectionReplaced || statusCode === 440) {
    return 10000 + Math.floor(Math.random() * 5000); // 10s - 15s
  }
  // 401 (loggedOut / unauthorized) or 403 (forbidden): spaced-out verification backoff to avoid rate-limiting
  // while preserving auto-recovery if WhatsApp had a transient auth or cluster glitch
  if (statusCode === DisconnectReason.loggedOut || statusCode === 401 || statusCode === DisconnectReason.forbidden || statusCode === 403) {
    const intervals = [15000, 30000, 60000, 120000, 300000];
    const base = intervals[Math.min(attemptCount, intervals.length - 1)];
    const jitter = Math.floor(Math.random() * 5000);
    return base + jitter;
  }
  // Progressive exponential backoff with jitter
  const baseDelay = 2000;
  const factor = 1.5;
  const maxDelay = 60000;
  const calculated = Math.min(maxDelay, baseDelay * Math.pow(factor, Math.min(attemptCount, 10)));
  const jitter = Math.floor(Math.random() * 2000);
  return Math.floor(calculated + jitter);
}

export type BaileysWorkerConfig = {
  sessionId?: string;
  pairingNumber?: string;
  allowedNumbersEnv?: string;
  cleanUnregisteredSession?: boolean;
  forceCleanSession?: boolean;
  onConnectionOpen?: () => void;
  onConnectionClose?: (
    shouldReconnect: boolean,
    statusCode?: number,
    error?: Error,
    classification?: DisconnectClassification
  ) => void;
  onPairingCode?: (code: string) => void;
  logger?: pino.Logger;
};

export type ActiveBaileysWorker = {
  socket: WASocket;
  saveCreds: () => Promise<void>;
  stop: () => Promise<void>;
  sendMessage: (to: string, text: string) => Promise<SendMessageResult>;
  sendDocument: (to: string, doc: SendDocumentOptions) => Promise<SendMessageResult>;
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

  if (config.forceCleanSession || (config.cleanUnregisteredSession && !state.creds.registered)) {
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
    connectTimeoutMs: 30_000,
    keepAliveIntervalMs: 25_000, // Active ping every 25s prevents cloud proxies from closing idle TCP sockets
    defaultQueryTimeoutMs: 60_000,
    retryRequestDelayMs: 500,
    maxMsgRetryCount: 5,
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
      logger.info("[WHATSAPP BOT] Baileys connection established successfully.");
      await safeSaveCreds();
      await clearEncryptedPairingCode(sessionId);
      config.onConnectionOpen?.();
    }

    if (connection === "close") {
      const statusCode =
        (lastDisconnect?.error as { output?: { statusCode?: number } })?.output?.statusCode ??
        (lastDisconnect?.error as { statusCode?: number })?.statusCode;
      const error = lastDisconnect?.error as Error | undefined;
      const classification = classifyDisconnectReason(statusCode, error);

      logger.warn(
        {
          statusCode: classification.statusCode,
          reason: classification.reason,
          isRecoverable: classification.isRecoverable,
          description: classification.description,
        },
        `[WHATSAPP BOT] Connection closed: ${classification.description}`
      );

      if (classification.isLoggedOut || classification.reason === "forbidden") {
        logger.error(
          { statusCode: classification.statusCode, reason: classification.reason },
          "[WHATSAPP BOT] WhatsApp session unauthorized or invalidated. Preserving session data in PostgreSQL."
        );
        await clearEncryptedPairingCode(sessionId);
        config.onConnectionClose?.(false, statusCode, error, classification);
      } else if (!isStopping) {
        // Recoverable reconnection needed
        config.onConnectionClose?.(classification.isRecoverable, statusCode, error, classification);
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

  // 3b. Document sender helper for Excel and other attachments
  const sendDocument = async (
    to: string,
    doc: SendDocumentOptions
  ): Promise<SendMessageResult> => {
    try {
      let jid = (to || "").trim();
      if (!jid.includes("@")) {
        const cleanTo = normalizePhoneNumber(jid);
        const variants = getPhoneVariants(cleanTo);
        const pn = variants.find((v) => v.startsWith("549")) || cleanTo;
        jid = `${pn}@s.whatsapp.net`;
      }

      logger.info(
        { recipient: maskPhone(jid), fileName: doc.fileName, sizeBytes: doc.document?.length },
        "[WHATSAPP BOT] Sending outgoing document via Baileys..."
      );

      const res = await sock.sendMessage(jid, {
        document: doc.document,
        mimetype: doc.mimetype || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        fileName: doc.fileName,
        caption: doc.caption,
      });

      if (res?.key?.id) {
        sentByBotMessageIds.add(res.key.id);
        if (sentByBotMessageIds.size > 500) {
          const oldest = sentByBotMessageIds.values().next().value;
          if (oldest) sentByBotMessageIds.delete(oldest);
        }
      }

      logger.info(
        { recipient: maskPhone(jid), messageId: res?.key?.id, fileName: doc.fileName },
        "[WHATSAPP BOT] Document sent successfully via Baileys."
      );
      return { success: true, messageId: res?.key?.id ?? undefined };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Send document failed";
      logger.error(
        { err, recipient: maskPhone(to), fileName: doc.fileName },
        "[WHATSAPP BOT] Failed to send document via Baileys."
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
        logger.warn(
          { messageId, remoteJidMasked: maskPhone(remoteJid) },
          "[WHATSAPP BOT] Unable to resolve sender phone. Skipping."
        );
        continue;
      }

      try {
        await processIncomingMessage({
          messageId,
          senderPhone: effectivePhone,
          replyTo: remoteJid, // Always reply to the original conversation JID
          textBody,
          senderName,
          configuredAllowedEnv: config.allowedNumbersEnv,
          sendMessageFn: async (to, text) => sendMessage(to, text),
          sendDocumentFn: async (to, doc) => sendDocument(to, doc),
        });
      } catch (procErr) {
        logger.error(
          {
            messageId,
            senderMasked: maskPhone(effectivePhone),
            err: procErr instanceof Error ? procErr.message : procErr,
          },
          "[WHATSAPP BOT] Unexpected error processing incoming message."
        );
      }
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
    sendDocument,
  };
}
