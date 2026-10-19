import type { SendMessageResult } from "./types";
import { normalizePhoneNumber } from "./auth";

export type MessageSender = (to: string, text: string) => Promise<SendMessageResult>;

let activeSender: MessageSender | null = null;

/**
 * Registers the active WhatsApp message sender (e.g. from Baileys worker).
 */
export function registerActiveSender(sender: MessageSender | null): void {
  activeSender = sender;
}

/**
 * Returns the currently active sender, if any.
 */
export function getActiveSender(): MessageSender | null {
  return activeSender;
}

/**
 * Sends a WhatsApp message using the active transport (Baileys worker).
 * Sanitizes inputs and formats clean result.
 */
export async function sendWhatsAppMessage(
  to: string,
  text: string
): Promise<SendMessageResult> {
  const normalizedTo = normalizePhoneNumber(to);
  if (!normalizedTo) {
    return {
      success: false,
      error: "Recipient phone number is invalid.",
    };
  }

  if (!activeSender) {
    return {
      success: false,
      error: "WhatsApp worker is not connected. Message cannot be sent.",
    };
  }

  try {
    return await activeSender(normalizedTo, text);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown send error";
    return {
      success: false,
      error: `Failed to send WhatsApp message: ${message}`,
    };
  }
}
