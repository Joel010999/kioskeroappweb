import { describe, expect, it, vi } from "vitest";
import { GET, POST } from "./route";
import { NextRequest } from "next/server";
import { createHmac } from "node:crypto";

const { processIncomingMessage } = vi.hoisted(() => ({
  processIncomingMessage: vi.fn().mockResolvedValue({ processed: true }),
}));

vi.mock("@/server/whatsapp/processor", () => ({
  processIncomingMessage,
}));

describe("WhatsApp Webhook API Route Handler", () => {
  const verifyToken = "test_verify_token_123";
  const appSecret = "test_app_secret_abc";

  process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = verifyToken;
  process.env.WHATSAPP_APP_SECRET = appSecret;

  describe("GET /api/whatsapp/webhook", () => {
    it("returns 200 with challenge on valid subscription handshake", async () => {
      const url = `https://kioskeroappweb.up.railway.app/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=${verifyToken}&hub.challenge=test_challenge_code_999`;
      const req = new NextRequest(url);

      const res = await GET(req);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("test_challenge_code_999");
    });

    it("returns 403 when verify_token does not match", async () => {
      const url = `https://kioskeroappweb.up.railway.app/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=wrong_token&hub.challenge=123`;
      const req = new NextRequest(url);

      const res = await GET(req);
      expect(res.status).toBe(403);
    });

    it("returns 403 when mode is not subscribe", async () => {
      const url = `https://kioskeroappweb.up.railway.app/api/whatsapp/webhook?hub.mode=unsubscribe&hub.verify_token=${verifyToken}&hub.challenge=123`;
      const req = new NextRequest(url);

      const res = await GET(req);
      expect(res.status).toBe(403);
    });
  });

  describe("POST /api/whatsapp/webhook", () => {
    function createSignedRequest(body: object, secret: string = appSecret): NextRequest {
      const rawText = JSON.stringify(body);
      const signature = createHmac("sha256", secret).update(rawText, "utf8").digest("hex");

      return new NextRequest("https://kioskeroappweb.up.railway.app/api/whatsapp/webhook", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-hub-signature-256": `sha256=${signature}`,
        },
        body: rawText,
      });
    }

    it("rejects request with invalid signature (HTTP 401)", async () => {
      const req = new NextRequest("https://kioskeroappweb.up.railway.app/api/whatsapp/webhook", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-hub-signature-256": "sha256=0000000000000000000000000000000000000000000000000000000000000000",
        },
        body: JSON.stringify({ object: "whatsapp_business_account" }),
      });

      const res = await POST(req);
      expect(res.status).toBe(401);
      expect(await res.text()).toContain("Unauthorized");
    });

    it("accepts valid signed message and dispatches to processor", async () => {
      const payload = {
        object: "whatsapp_business_account",
        entry: [
          {
            id: "WABA_ID_1",
            changes: [
              {
                field: "messages",
                value: {
                  messaging_product: "whatsapp",
                  contacts: [{ profile: { name: "Monica" }, wa_id: "5491112345678" }],
                  messages: [
                    {
                      id: "wamid.INCOMING_TEST_01",
                      from: "5491112345678",
                      timestamp: "1729290000",
                      type: "text",
                      text: { body: "Stock alfajor havanna" },
                    },
                  ],
                },
              },
            ],
          },
        ],
      };

      const req = createSignedRequest(payload);
      const res = await POST(req);

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.status).toBe("ok");

      expect(processIncomingMessage).toHaveBeenCalledWith({
        messageId: "wamid.INCOMING_TEST_01",
        senderPhone: "5491112345678",
        textBody: "Stock alfajor havanna",
        senderName: "Monica",
      });
    });

    it("handles delivery status receipts without attempting to process as messages", async () => {
      const statusPayload = {
        object: "whatsapp_business_account",
        entry: [
          {
            id: "WABA_ID_1",
            changes: [
              {
                field: "messages",
                value: {
                  messaging_product: "whatsapp",
                  statuses: [
                    {
                      id: "wamid.OUTBOUND_123",
                      status: "delivered",
                      timestamp: "1729290005",
                      recipient_id: "5491112345678",
                    },
                  ],
                },
              },
            ],
          },
        ],
      };

      vi.clearAllMocks();
      const req = createSignedRequest(statusPayload);
      const res = await POST(req);

      expect(res.status).toBe(200);
      expect(processIncomingMessage).not.toHaveBeenCalled();
    });
  });
});
