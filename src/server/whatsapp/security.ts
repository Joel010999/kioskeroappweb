import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Validates Meta's X-Hub-Signature-256 header using the raw request body and app secret.
 * Uses timingSafeEqual to prevent timing attacks.
 */
export function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | null | undefined,
  configuredSecret?: string
): boolean {
  const secret = configuredSecret ?? process.env.WHATSAPP_APP_SECRET;
  if (!secret || !signatureHeader) {
    return false;
  }

  // Header format is sha256=<hex_digest>
  const parts = signatureHeader.split("=");
  if (parts.length !== 2 || parts[0] !== "sha256") {
    return false;
  }

  const expectedSignatureHex = parts[1].trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expectedSignatureHex)) {
    return false;
  }

  const calculatedSignatureHex = createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("hex")
    .toLowerCase();

  const expectedBuffer = Buffer.from(expectedSignatureHex, "hex");
  const calculatedBuffer = Buffer.from(calculatedSignatureHex, "hex");

  if (expectedBuffer.length !== calculatedBuffer.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, calculatedBuffer);
}

/**
 * Verifies the GET handshake from Meta for webhook registration.
 */
export function verifyWebhookHandshake(
  mode: string | null,
  token: string | null,
  challenge: string | null,
  configuredVerifyToken?: string
): { isValid: boolean; challenge?: string } {
  const verifyToken = configuredVerifyToken ?? process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;

  if (mode !== "subscribe" || !token || !challenge || !verifyToken) {
    return { isValid: false };
  }

  const tokenBuffer = Buffer.from(token);
  const expectedBuffer = Buffer.from(verifyToken);

  if (
    tokenBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(tokenBuffer, expectedBuffer)
  ) {
    return { isValid: false };
  }

  return { isValid: true, challenge };
}
