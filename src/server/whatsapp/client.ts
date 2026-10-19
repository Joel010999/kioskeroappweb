import type { SendMessageResult } from "./types";
import { normalizePhoneNumber } from "./auth";

type SendOptions = {
  previewUrl?: boolean;
  phoneNumberId?: string;
  accessToken?: string;
  fetchFn?: typeof fetch;
};

/**
 * Sends a WhatsApp text message via Meta's WhatsApp Cloud API.
 * Safely sanitizes errors to avoid leaking tokens or secrets in logs.
 */
export async function sendWhatsAppMessage(
  to: string,
  text: string,
  options?: SendOptions
): Promise<SendMessageResult> {
  const phoneNumberId = options?.phoneNumberId ?? process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken = options?.accessToken ?? process.env.WHATSAPP_ACCESS_TOKEN;
  const fetcher = options?.fetchFn ?? fetch;

  if (!phoneNumberId || !accessToken) {
    return {
      success: false,
      error: "WhatsApp Cloud API credentials are not configured.",
    };
  }

  const normalizedTo = normalizePhoneNumber(to);
  if (!normalizedTo) {
    return {
      success: false,
      error: "Recipient phone number is invalid.",
    };
  }

  const url = `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`;

  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: normalizedTo,
    type: "text",
    text: {
      preview_url: options?.previewUrl ?? false,
      body: text,
    },
  };

  try {
    const response = await fetcher(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      let errorMessage = `Meta API error (HTTP ${response.status})`;
      try {
        const errorData = (await response.json()) as { error?: { message?: string; code?: number } };
        if (errorData?.error?.message) {
          errorMessage = `Meta API error [${errorData.error.code ?? response.status}]: ${errorData.error.message}`;
        }
      } catch {
        // Body was not JSON
      }

      console.error("Failed to send WhatsApp message", {
        status: response.status,
        recipient: normalizedTo,
      });

      return {
        success: false,
        error: errorMessage,
      };
    }

    const data = (await response.json()) as { messages?: Array<{ id: string }> };
    const messageId = data?.messages?.[0]?.id;

    return {
      success: true,
      messageId,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("Network or unexpected error sending WhatsApp message", {
      recipient: normalizedTo,
      message,
    });

    return {
      success: false,
      error: `Network failure: ${message}`,
    };
  }
}
