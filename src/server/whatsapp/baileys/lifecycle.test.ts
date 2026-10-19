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
    it("extracts phone number from WhatsApp remoteJid correctly", () => {
      expect(extractSenderPhone("5491112345678@s.whatsapp.net")).toBe("5491112345678");
      expect(extractSenderPhone("5491155554444:12@s.whatsapp.net")).toBe("5491155554444");
      expect(extractSenderPhone(null)).toBe("");
      expect(extractSenderPhone(undefined)).toBe("");
    });

    it("extracts text from various WAMessage structures", () => {
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
        expect(onConnectionClose).toHaveBeenCalledWith(true);
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
        expect(onConnectionClose).toHaveBeenCalledWith(false);
      });
      await worker.stop();
    });

    it("terminates socket when worker.stop() is invoked (e.g. advisory lock lost)", async () => {
      const worker = await startBaileysWorker({});
      await worker.stop();
      expect(mockSocket.end).toHaveBeenCalledTimes(1);
    });

    it("sends message through worker instance", async () => {
      const worker = await startBaileysWorker({});
      const res = await worker.sendMessage("5491112345678", "Hola Mónica");

      expect(res.success).toBe(true);
      expect(res.messageId).toBe("msg_out_999");
      expect(mockSocket.sendMessage).toHaveBeenCalledWith(
        "5491112345678@s.whatsapp.net",
        { text: "Hola Mónica" }
      );
      await worker.stop();
    });
  });
});
