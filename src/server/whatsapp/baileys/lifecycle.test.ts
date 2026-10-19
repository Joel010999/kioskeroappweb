import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { DisconnectReason } from "@whiskeysockets/baileys";
import {
  extractMessageText,
  extractSenderPhone,
  startBaileysWorker,
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
});
