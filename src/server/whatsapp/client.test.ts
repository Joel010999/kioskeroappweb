import { beforeEach, describe, expect, it, vi } from "vitest";
import { getActiveSender, registerActiveSender, sendWhatsAppMessage } from "./client";

describe("WhatsApp Message Client", () => {
  beforeEach(() => {
    registerActiveSender(null);
  });

  it("returns error when no active worker is registered", async () => {
    const res = await sendWhatsAppMessage("5491112345678", "Hola");
    expect(res.success).toBe(false);
    expect(res.error).toContain("WhatsApp worker is not connected");
  });

  it("returns error for invalid recipient number", async () => {
    const res = await sendWhatsAppMessage("", "Hola");
    expect(res.success).toBe(false);
    expect(res.error).toContain("Recipient phone number is invalid");
  });

  it("dispatches message when active sender is registered", async () => {
    const mockSender = vi.fn().mockResolvedValue({
      success: true,
      messageId: "msg_baileys_123",
    });

    registerActiveSender(mockSender);
    expect(getActiveSender()).toBe(mockSender);

    const res = await sendWhatsAppMessage("+54 9 11 1234-5678", "Resumen de stock");
    expect(res.success).toBe(true);
    expect(res.messageId).toBe("msg_baileys_123");
    expect(mockSender).toHaveBeenCalledWith("5491112345678", "Resumen de stock");
  });

  it("catches sender exceptions gracefully", async () => {
    registerActiveSender(async () => {
      throw new Error("Socket closed unexpectedly");
    });

    const res = await sendWhatsAppMessage("5491112345678", "Hola");
    expect(res.success).toBe(false);
    expect(res.error).toContain("Socket closed unexpectedly");
  });

  describe("Document Transport", () => {
    it("returns error when no active document sender is registered", async () => {
      const { sendWhatsAppDocument } = await import("./client");
      const res = await sendWhatsAppDocument("5491112345678", {
        document: Buffer.from("test"),
        fileName: "test.xlsx",
      });
      expect(res.success).toBe(false);
      expect(res.error).toContain("WhatsApp worker is not connected");
    });

    it("returns error for invalid recipient number when sending document", async () => {
      const { sendWhatsAppDocument } = await import("./client");
      const res = await sendWhatsAppDocument("", {
        document: Buffer.from("test"),
        fileName: "test.xlsx",
      });
      expect(res.success).toBe(false);
      expect(res.error).toContain("Recipient phone number is invalid");
    });

    it("dispatches binary document when active document sender is registered", async () => {
      const { registerActiveSender, getActiveDocumentSender, sendWhatsAppDocument } = await import("./client");
      const mockDocSender = vi.fn().mockResolvedValue({
        success: true,
        messageId: "doc_msg_baileys_456",
      });

      registerActiveSender(null, mockDocSender);
      expect(getActiveDocumentSender()).toBe(mockDocSender);

      const fakeBuffer = Buffer.from("PK\x03\x04fake_excel_content");
      const res = await sendWhatsAppDocument("+54 9 11 1234-5678", {
        document: fakeBuffer,
        fileName: "REPOSICION_CHOCOLATES_CENTRO.xlsx",
        mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        caption: "Planilla de chocolates",
      });

      expect(res.success).toBe(true);
      expect(res.messageId).toBe("doc_msg_baileys_456");
      expect(mockDocSender).toHaveBeenCalledWith("5491112345678", {
        document: fakeBuffer,
        fileName: "REPOSICION_CHOCOLATES_CENTRO.xlsx",
        mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        caption: "Planilla de chocolates",
      });
    });

    it("catches document sender exceptions gracefully", async () => {
      const { registerActiveSender, sendWhatsAppDocument } = await import("./client");
      registerActiveSender(null, async () => {
        throw new Error("Baileys socket stream timeout");
      });

      const res = await sendWhatsAppDocument("5491112345678", {
        document: Buffer.from("dummy"),
        fileName: "dummy.xlsx",
      });
      expect(res.success).toBe(false);
      expect(res.error).toContain("Baileys socket stream timeout");
    });
  });
});
