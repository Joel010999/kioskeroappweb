import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { DisconnectReason } from "@whiskeysockets/baileys";
import {
  extractMessageText,
  extractSenderPhone,
  startBaileysWorker,
  classifyDisconnectReason,
  calculateReconnectDelay,
} from "./connection";
import { clearMemoryAuthStateStore } from "./auth-state";

// Mock makeWASocket
const mockEv = new EventEmitter();
const mockSocket = {
  ev: mockEv,
  sendMessage: vi.fn().mockResolvedValue({ key: { id: "msg_out_999" } }),
  requestPairingCode: vi.fn().mockResolvedValue("1234-5678"),
  end: vi.fn(),
};

vi.mock("@whiskeysockets/baileys", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@whiskeysockets/baileys")>();
  return {
    ...actual,
    default: vi.fn().mockImplementation(() => mockSocket),
  };
});

// Mock DB client to avoid network timeouts during unit tests
vi.mock("@/server/db/client", () => ({
  query: vi.fn().mockRejectedValue(new Error("Database not connected in unit test")),
}));

// Mock processor
vi.mock("../processor", () => ({
  processIncomingMessage: vi.fn().mockResolvedValue({ processed: true }),
}));

describe("Baileys Worker Lifecycle & Event Handling", () => {
  const originalEnv = process.env.WHATSAPP_SESSION_ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.WHATSAPP_SESSION_ENCRYPTION_KEY = "test-secret-key-32-bytes-long-12345678";
    clearMemoryAuthStateStore();
    mockEv.removeAllListeners();
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env.WHATSAPP_SESSION_ENCRYPTION_KEY = originalEnv;
  });

  describe("Utility extractors", () => {
    it("extracts phone number from WhatsApp remoteJid and WAMessage correctly", () => {
      expect(extractSenderPhone("5491112345678@s.whatsapp.net")).toBe("5491112345678");
      expect(extractSenderPhone("5491155554444:12@s.whatsapp.net")).toBe("5491155554444");
      expect(extractSenderPhone(null)).toBe("");
      expect(extractSenderPhone(undefined)).toBe("");

      // Resolves phone from remoteJidAlt when remoteJid is a LID (@lid)
      const lidMsg = {
        key: {
          remoteJid: "241852951711822@lid",
          remoteJidAlt: "5493885196480@s.whatsapp.net",
        },
      } as any;
      expect(extractSenderPhone(lidMsg)).toBe("5493885196480");

      // Resolves phone from participantAlt in group or companion chats
      const groupMsg = {
        key: {
          remoteJid: "123456-789@g.us",
          participant: "987654321@lid",
          participantAlt: "5491155554444@s.whatsapp.net",
        },
      } as any;
      expect(extractSenderPhone(groupMsg)).toBe("5491155554444");
    });

    it("extracts text from various WAMessage structures including ephemeral and view-once", () => {
      expect(extractMessageText({ message: { conversation: "stock alfajores" } } as any)).toBe(
        "stock alfajores"
      );
      expect(
        extractMessageText({
          message: { extendedTextMessage: { text: "pedidos pendientes" } },
        } as any)
      ).toBe("pedidos pendientes");
      expect(
        extractMessageText({
          message: { imageMessage: { caption: "comprobante" } },
        } as any)
      ).toBe("comprobante");
      // Ephemeral / Disappearing message unwrapping
      expect(
        extractMessageText({
          message: {
            ephemeralMessage: {
              message: {
                conversation: "Hola desde mensaje temporal",
              },
            },
          },
        } as any)
      ).toBe("Hola desde mensaje temporal");
      // View-once message unwrapping
      expect(
        extractMessageText({
          message: {
            viewOnceMessage: {
              message: {
                extendedTextMessage: { text: "Hola view once" },
              },
            },
          },
        } as any)
      ).toBe("Hola view once");
      expect(extractMessageText({ message: null } as any)).toBe("");
    });
  });

  describe("Worker Lifecycle & Reconnection", () => {
    it("notifies onConnectionOpen when connection opens", async () => {
      const onConnectionOpen = vi.fn();
      const worker = await startBaileysWorker({ onConnectionOpen });

      mockEv.emit("connection.update", { connection: "open" });

      await vi.waitFor(() => {
        expect(onConnectionOpen).toHaveBeenCalledTimes(1);
      });
      await worker.stop();
    });

    it("signals reconnection required on transient disconnect", async () => {
      const onConnectionClose = vi.fn();
      const worker = await startBaileysWorker({ onConnectionClose });

      mockEv.emit("connection.update", {
        connection: "close",
        lastDisconnect: {
          error: {
            output: { statusCode: DisconnectReason.connectionLost },
          },
        },
      });

      await vi.waitFor(() => {
        expect(onConnectionClose).toHaveBeenCalled();
        expect(onConnectionClose.mock.calls[0][0]).toBe(true);
        expect(onConnectionClose.mock.calls[0][1]).toBe(DisconnectReason.connectionLost);
      });
      await worker.stop();
    });

    it("signals NO reconnect and clears session when logged out", async () => {
      const onConnectionClose = vi.fn();
      const worker = await startBaileysWorker({ onConnectionClose });

      mockEv.emit("connection.update", {
        connection: "close",
        lastDisconnect: {
          error: {
            output: { statusCode: DisconnectReason.loggedOut },
          },
        },
      });

      await vi.waitFor(() => {
        expect(onConnectionClose).toHaveBeenCalled();
        expect(onConnectionClose.mock.calls[0][0]).toBe(false);
        expect(onConnectionClose.mock.calls[0][1]).toBe(DisconnectReason.loggedOut);
      });
      await worker.stop();
    });

    it("terminates socket when worker.stop() is invoked (e.g. advisory lock lost)", async () => {
      const worker = await startBaileysWorker({});
      await worker.stop();
      expect(mockSocket.end).toHaveBeenCalledTimes(1);
    });

    it("signals reconnection required when 515 (restartRequired) is received during companion pairing handshake", async () => {
      const onConnectionClose = vi.fn();
      const worker = await startBaileysWorker({ onConnectionClose });

      mockEv.emit("connection.update", {
        connection: "close",
        lastDisconnect: {
          error: {
            output: { statusCode: DisconnectReason.restartRequired },
          },
        },
      });

      await vi.waitFor(() => {
        expect(onConnectionClose).toHaveBeenCalled();
        expect(onConnectionClose.mock.calls[0][0]).toBe(true);
        expect(onConnectionClose.mock.calls[0][1]).toBe(515);
      });
      await worker.stop();
    });

    it("forces session clearing on start when forceCleanSession is true", async () => {
      const onPairingCode = vi.fn();
      const worker = await startBaileysWorker({
        sessionId: "test-force-clean",
        forceCleanSession: true,
        pairingNumber: "5493885196480",
        onPairingCode,
      });

      await vi.waitFor(
        () => {
          expect(mockSocket.requestPairingCode).toHaveBeenCalledWith("5493885196480");
        },
        { timeout: 4500 }
      );
      await worker.stop();
    });

    it("safely closes socket on worker.stop() without error", async () => {
      const worker = await startBaileysWorker({});
      await worker.stop();
      expect(mockSocket.end).toHaveBeenCalledTimes(1);
    });

    it("sends message through worker instance to bare number and JID destination", async () => {
      const worker = await startBaileysWorker({});

      // Bare phone number gets formatted with 549 user JID
      const res = await worker.sendMessage("5491112345678", "Hola Mónica");
      expect(res.success).toBe(true);
      expect(res.messageId).toBe("msg_out_999");
      expect(mockSocket.sendMessage).toHaveBeenCalledWith(
        "5491112345678@s.whatsapp.net",
        { text: "Hola Mónica" }
      );

      // Direct LID JID is preserved without conversion to invalid phone JID
      const lidRes = await worker.sendMessage("241852951711822@lid", "Hola LID");
      expect(lidRes.success).toBe(true);
      expect(mockSocket.sendMessage).toHaveBeenCalledWith(
        "241852951711822@lid",
        { text: "Hola LID" }
      );

      await worker.stop();
    });

    it("processes incoming messages from messages.upsert and forwards replyTo", async () => {
      const { processIncomingMessage } = await import("../processor");
      const worker = await startBaileysWorker({});

      mockEv.emit("messages.upsert", {
        type: "notify",
        messages: [
          {
            key: {
              id: "msg_in_001",
              fromMe: false,
              remoteJid: "241852951711822@lid",
              remoteJidAlt: "5493885196480@s.whatsapp.net",
            },
            message: {
              conversation: "Hola",
            },
          },
        ],
      });

      await vi.waitFor(() => {
        expect(processIncomingMessage).toHaveBeenCalled();
        const callArgs = (processIncomingMessage as any).mock.calls[0][0];
        expect(callArgs.messageId).toBe("msg_in_001");
        expect(callArgs.senderPhone).toBe("5493885196480");
        expect(callArgs.replyTo).toBe("241852951711822@lid");
        expect(callArgs.textBody).toBe("Hola");
      });

      await worker.stop();
    });
  });

  describe("Disconnect Reason Classification & Progressive Backoff", () => {
    it("accurately classifies all Baileys and WhatsApp status codes", () => {
      // 401 loggedOut: unrecoverable session
      const c401 = classifyDisconnectReason(DisconnectReason.loggedOut);
      expect(c401.isRecoverable).toBe(false);
      expect(c401.isLoggedOut).toBe(true);
      expect(c401.reason).toBe("logged_out");

      // 403 forbidden: unrecoverable
      const c403 = classifyDisconnectReason(DisconnectReason.forbidden);
      expect(c403.isRecoverable).toBe(false);
      expect(c403.reason).toBe("forbidden");

      // 440 connectionReplaced: conflict, recoverable after other instance backs off
      const c440 = classifyDisconnectReason(DisconnectReason.connectionReplaced);
      expect(c440.isRecoverable).toBe(true);
      expect(c440.isConflict).toBe(true);
      expect(c440.reason).toBe("connection_replaced");

      // 515 restartRequired: companion sync restart, recoverable immediately
      const c515 = classifyDisconnectReason(DisconnectReason.restartRequired);
      expect(c515.isRecoverable).toBe(true);
      expect(c515.isRestartRequired).toBe(true);
      expect(c515.reason).toBe("restart_required");

      // 408 timedOut: keep-alive or network drop, recoverable
      const c408 = classifyDisconnectReason(DisconnectReason.timedOut);
      expect(c408.isRecoverable).toBe(true);
      expect(c408.reason).toBe("timed_out");

      // 428 connectionClosed: recoverable
      const c428 = classifyDisconnectReason(DisconnectReason.connectionClosed);
      expect(c428.isRecoverable).toBe(true);
      expect(c428.reason).toBe("connection_closed");

      // 500 badSession: recoverable
      const c500 = classifyDisconnectReason(DisconnectReason.badSession);
      expect(c500.isRecoverable).toBe(true);
      expect(c500.reason).toBe("bad_session");

      // 503 unavailableService: recoverable
      const c503 = classifyDisconnectReason(DisconnectReason.unavailableService);
      expect(c503.isRecoverable).toBe(true);
      expect(c503.reason).toBe("unavailable_service");

      // Generic node socket error without status code: recoverable
      const cNet = classifyDisconnectReason(undefined, new Error("ECONNRESET"));
      expect(cNet.isRecoverable).toBe(true);
      expect(cNet.reason).toBe("network_error");
    });

    it("calculates progressive reconnect delay with jitter and specific overrides", () => {
      // 515 restartRequired: quick restart
      expect(calculateReconnectDelay(515, 0)).toBe(2000);
      expect(calculateReconnectDelay(DisconnectReason.restartRequired, 4)).toBe(2000);

      // 440 conflict: 10s - 15s window to allow other instance to release
      const delay440 = calculateReconnectDelay(440, 1);
      expect(delay440).toBeGreaterThanOrEqual(10000);
      expect(delay440).toBeLessThanOrEqual(15000);

      // Progressive backoff increases with consecutive attempts
      const delayAttempt0 = calculateReconnectDelay(408, 0);
      const delayAttempt2 = calculateReconnectDelay(408, 2);
      const delayAttempt4 = calculateReconnectDelay(408, 4);

      expect(delayAttempt0).toBeGreaterThanOrEqual(2000);
      expect(delayAttempt2).toBeGreaterThanOrEqual(delayAttempt0);
      expect(delayAttempt4).toBeGreaterThanOrEqual(delayAttempt2);

      // Cap at ~60s (+ jitter up to 2s) for recoverable network drops
      const delayCapped = calculateReconnectDelay(408, 20);
      expect(delayCapped).toBeLessThanOrEqual(62000);

      // 401 / 403 spaced-out verification intervals
      const delay401_0 = calculateReconnectDelay(401, 0);
      expect(delay401_0).toBeGreaterThanOrEqual(15000);
      expect(delay401_0).toBeLessThanOrEqual(20000);

      const delay401_1 = calculateReconnectDelay(401, 1);
      expect(delay401_1).toBeGreaterThanOrEqual(30000);
      expect(delay401_1).toBeLessThanOrEqual(35000);

      const delay401_4 = calculateReconnectDelay(401, 4);
      expect(delay401_4).toBeGreaterThanOrEqual(300000);
      expect(delay401_4).toBeLessThanOrEqual(305000);
    });

    it("passes structured classification into onConnectionClose callback", async () => {
      const onConnectionClose = vi.fn();
      const worker = await startBaileysWorker({ onConnectionClose });

      mockEv.emit("connection.update", {
        connection: "close",
        lastDisconnect: {
          error: {
            output: { statusCode: DisconnectReason.connectionReplaced },
          },
        },
      });

      await vi.waitFor(() => {
        expect(onConnectionClose).toHaveBeenCalled();
        const [shouldReconnect, statusCode, error, classification] = onConnectionClose.mock.calls[0];
        expect(shouldReconnect).toBe(true);
        expect(statusCode).toBe(440);
        expect(classification).toBeDefined();
        expect(classification.reason).toBe("connection_replaced");
        expect(classification.isConflict).toBe(true);
        expect(classification.isRecoverable).toBe(true);
      });

      await worker.stop();
    });
  });
});

