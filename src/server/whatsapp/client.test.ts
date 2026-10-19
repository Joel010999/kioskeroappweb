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
});
