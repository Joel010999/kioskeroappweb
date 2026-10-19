import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { verifyWebhookHandshake, verifyWebhookSignature } from "./security";

describe("WhatsApp Webhook Security", () => {
  const secret = "test_meta_app_secret_123";
  const rawBody = JSON.stringify({ object: "whatsapp_business_account", entry: [] });

  it("validates legitimate Meta HMAC-SHA256 signature", () => {
    const validHash = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
    const header = `sha256=${validHash}`;

    expect(verifyWebhookSignature(rawBody, header, secret)).toBe(true);
  });

  it("rejects invalid HMAC-SHA256 signature", () => {
    const header = "sha256=0000000000000000000000000000000000000000000000000000000000000000";
    expect(verifyWebhookSignature(rawBody, header, secret)).toBe(false);
  });

  it("rejects tampered body", () => {
    const validHash = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
    const header = `sha256=${validHash}`;
    const tamperedBody = `${rawBody} `;

    expect(verifyWebhookSignature(tamperedBody, header, secret)).toBe(false);
  });

  it("rejects missing signature or missing secret", () => {
    expect(verifyWebhookSignature(rawBody, null, secret)).toBe(false);
    expect(verifyWebhookSignature(rawBody, undefined, secret)).toBe(false);
    expect(verifyWebhookSignature(rawBody, "invalid_header", secret)).toBe(false);
    expect(verifyWebhookSignature(rawBody, "sha256=abc", "")).toBe(false);
  });

  describe("Webhook Handshake GET", () => {
    const verifyToken = "my_custom_verify_token_xyz";

    it("accepts valid subscription handshake", () => {
      const result = verifyWebhookHandshake("subscribe", verifyToken, "1234567890", verifyToken);
      expect(result.isValid).toBe(true);
      expect(result.challenge).toBe("1234567890");
    });

    it("rejects invalid token", () => {
      const result = verifyWebhookHandshake("subscribe", "wrong_token", "1234567890", verifyToken);
      expect(result.isValid).toBe(false);
      expect(result.challenge).toBeUndefined();
    });

    it("rejects non-subscribe mode", () => {
      const result = verifyWebhookHandshake("unsubscribe", verifyToken, "1234567890", verifyToken);
      expect(result.isValid).toBe(false);
    });

    it("rejects missing parameters", () => {
      expect(verifyWebhookHandshake(null, verifyToken, "123", verifyToken).isValid).toBe(false);
      expect(verifyWebhookHandshake("subscribe", null, "123", verifyToken).isValid).toBe(false);
      expect(verifyWebhookHandshake("subscribe", verifyToken, null, verifyToken).isValid).toBe(false);
    });
  });
});
