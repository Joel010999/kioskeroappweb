import { describe, expect, it, vi } from "vitest";
import { sendWhatsAppMessage } from "./client";

describe("WhatsApp Graph API Client", () => {
  it("sends message with correct endpoint, headers and payload", async () => {
    let capturedUrl = "";
    let capturedOptions: any = null;

    const mockFetch = vi.fn().mockImplementation(async (url, options) => {
      capturedUrl = url;
      capturedOptions = options;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          messages: [{ id: "wamid.OUTBOUND_12345" }],
        }),
      };
    });

    const result = await sendWhatsAppMessage("+54 9 11 1234-5678", "Hola Mónica", {
      phoneNumberId: "100200300400",
      accessToken: "secret_token_abc",
      fetchFn: mockFetch as any,
    });

    expect(result.success).toBe(true);
    expect(result.messageId).toBe("wamid.OUTBOUND_12345");
    expect(capturedUrl).toBe("https://graph.facebook.com/v21.0/100200300400/messages");
    expect(capturedOptions.headers["Authorization"]).toBe("Bearer secret_token_abc");

    const body = JSON.parse(capturedOptions.body);
    expect(body.to).toBe("5491112345678");
    expect(body.text.body).toBe("Hola Mónica");
  });

  it("handles missing credentials gracefully without throwing", async () => {
    const result = await sendWhatsAppMessage("5491112345678", "Hola", {
      phoneNumberId: "",
      accessToken: "",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("credentials are not configured");
  });

  it("handles Meta API error responses without leaking secrets", async () => {
    const mockFetch = vi.fn().mockImplementation(async () => {
      return {
        ok: false,
        status: 400,
        json: async () => ({
          error: {
            message: "Recipient phone number not in allowed list during development",
            code: 131030,
          },
        }),
      };
    });

    const result = await sendWhatsAppMessage("5491112345678", "Hola", {
      phoneNumberId: "100200300400",
      accessToken: "secret_token_hidden",
      fetchFn: mockFetch as any,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("131030");
    expect(result.error).not.toContain("secret_token_hidden");
  });
});
