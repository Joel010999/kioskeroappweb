import { NextRequest, NextResponse } from "next/server";
import { verifyWebhookHandshake, verifyWebhookSignature } from "@/server/whatsapp/security";
import { processIncomingMessage } from "@/server/whatsapp/processor";
import type { MetaWebhookPayload } from "@/server/whatsapp/types";

export const runtime = "nodejs";

/**
 * GET: Handshake verification required by Meta during Webhook configuration.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  const verification = verifyWebhookHandshake(mode, token, challenge);

  if (verification.isValid && verification.challenge) {
    return new Response(verification.challenge, {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  }

  return new Response("Forbidden", { status: 403 });
}

/**
 * POST: Handles incoming WhatsApp messages from Meta Graph API.
 */
export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const signature = request.headers.get("x-hub-signature-256");

  // 1. Cryptographic signature check
  const isSignatureValid = verifyWebhookSignature(rawBody, signature);
  if (!isSignatureValid) {
    return new Response("Unauthorized signature", { status: 401 });
  }

  // 2. Safe JSON parsing
  let payload: MetaWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as MetaWebhookPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // 3. Process entries and messages
  if (payload.object === "whatsapp_business_account" && Array.isArray(payload.entry)) {
    for (const entry of payload.entry) {
      if (!Array.isArray(entry.changes)) continue;

      for (const change of entry.changes) {
        const value = change.value;
        if (!value || value.messaging_product !== "whatsapp") continue;

        // Ignore status receipts (sent, delivered, read)
        if (!Array.isArray(value.messages) || value.messages.length === 0) {
          continue;
        }

        const contactName = value.contacts?.[0]?.profile?.name;

        for (const message of value.messages) {
          const messageId = message.id;
          const senderPhone = message.from;
          const textBody = message.type === "text" ? message.text?.body ?? "" : "";

          // If message is media, location or unsupported type
          const effectiveBody =
            message.type === "text"
              ? textBody
              : "ayuda"; // Fallback to help prompt if user sends media

          await processIncomingMessage({
            messageId,
            senderPhone,
            textBody: effectiveBody,
            senderName: contactName,
          });
        }
      }
    }
  }

  // Always acknowledge Meta with 200 OK
  return NextResponse.json({ status: "ok" });
}
