import { query } from "@/server/db/client";

// Fallback in-memory cache for unit tests or transient connection outages
const memoryCache = new Set<string>();

/**
 * Registers an incoming message ID to prevent duplicate processing.
 * Returns true if the message is NEW, or false if it is a DUPLICATE.
 */
export async function registerIncomingMessage(
  messageId: string,
  senderPhone: string
): Promise<boolean> {
  if (!messageId) return false;

  try {
    const res = await query<{ id: string }>(
      `INSERT INTO whatsapp_processed_messages (message_id, sender_phone, status)
       VALUES ($1, $2, 'PROCESSING')
       ON CONFLICT (message_id) DO NOTHING
       RETURNING id`,
      [messageId, senderPhone]
    );

    // If an ID was returned, this is a new message
    if (res.rows && res.rows.length > 0) {
      memoryCache.add(messageId);
      return true;
    }

    // Already exists in DB -> duplicate
    return false;
  } catch {
    // If the table does not exist yet (e.g. pre-migration or isolated test), use memory cache
    if (memoryCache.has(messageId)) {
      return false;
    }
    memoryCache.add(messageId);
    return true;
  }
}

/**
 * Marks a message as successfully processed.
 */
export async function markMessageProcessed(messageId: string, intent?: string): Promise<void> {
  if (!messageId) return;
  try {
    await query(
      `UPDATE whatsapp_processed_messages
       SET status = 'PROCESSED', intent = $2, processed_at = now()
       WHERE message_id = $1`,
      [messageId, intent ?? null]
    );
  } catch {
    // Graceful fallback
  }
}

/**
 * Marks a message as failed during execution.
 */
export async function markMessageFailed(messageId: string, errorMessage?: string): Promise<void> {
  if (!messageId) return;
  try {
    await query(
      `UPDATE whatsapp_processed_messages
       SET status = 'FAILED', error_message = $2, processed_at = now()
       WHERE message_id = $1`,
      [messageId, errorMessage ?? null]
    );
  } catch {
    // Graceful fallback
  }
}

/**
 * Resets the in-memory cache (useful for testing).
 */
export function clearMemoryDeduplicationCache(): void {
  memoryCache.clear();
}
