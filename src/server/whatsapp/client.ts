import type { DocumentSender, MessageSender, SendDocumentOptions, SendMessageResult } from "./types";
import { normalizePhoneNumber } from "./auth";

export type { MessageSender, DocumentSender, SendDocumentOptions };

let activeSender: MessageSender | null = null;
let activeDocumentSender: DocumentSender | null = null;

/**
 * Registers the active WhatsApp message and document senders (e.g. from Baileys worker).
 */
export function registerActiveSender(
  sender: MessageSender | null,
  docSender?: DocumentSender | null
): void {
  activeSender = sender;
  activeDocumentSender = docSender ?? null;
}

/**
 * Returns the currently active text sender, if any.
 */
export function getActiveSender(): MessageSender | null {
  return activeSender;
}

/**
 * Returns the currently active document sender, if any.
 */
export function getActiveDocumentSender(): DocumentSender | null {
  return activeDocumentSender;
}

/**
 * Sends a WhatsApp message using the active transport (Baileys worker).
 * Sanitizes inputs and formats clean result.
 */
export async function sendWhatsAppMessage(
  to: string,
  text: string
): Promise<SendMessageResult> {
  const cleanTo = (to || "").trim();
  const destination = cleanTo.includes("@") ? cleanTo : normalizePhoneNumber(cleanTo);
  if (!destination) {
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
    return await activeSender(destination, text);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown send error";
    return {
      success: false,
      error: `Failed to send WhatsApp message: ${message}`,
    };
  }
}

/**
 * Sends a WhatsApp document (e.g. .xlsx binary buffer) using the active transport.
 */
export async function sendWhatsAppDocument(
  to: string,
  doc: SendDocumentOptions
): Promise<SendMessageResult> {
  const cleanTo = (to || "").trim();
  const destination = cleanTo.includes("@") ? cleanTo : normalizePhoneNumber(cleanTo);
  if (!destination) {
    return {
      success: false,
      error: "Recipient phone number is invalid.",
    };
  }

  if (!activeDocumentSender) {
    return {
      success: false,
      error: "WhatsApp worker is not connected or document sending is unavailable.",
    };
  }

  try {
    return await activeDocumentSender(destination, doc);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown send error";
    return {
      success: false,
      error: `Failed to send WhatsApp document: ${message}`,
    };
  }
}
