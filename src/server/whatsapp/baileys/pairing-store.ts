import { query } from "@/server/db/client";
import {
  decryptSessionData,
  deriveSessionKey,
  encryptSessionData,
  type EncryptedPayload,
} from "./crypto";

const memoryPairingStore = new Map<string, EncryptedPayload>();

/**
 * Stores a pairing code securely encrypted in PostgreSQL with a short TTL (default 150s).
 */
export async function saveEncryptedPairingCode(
  sessionId: string,
  code: string,
  ttlMs = 150000,
  encryptionKey?: Buffer
): Promise<void> {
  const key = encryptionKey ?? deriveSessionKey();
  const payload = {
    code,
    expiresAt: Date.now() + ttlMs,
  };
  const serialized = JSON.stringify(payload);
  const encrypted = encryptSessionData(serialized, key);

  try {
    await query(
      `INSERT INTO whatsapp_baileys_session (session_id, key_id, ciphertext, iv, tag, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (session_id, key_id)
       DO UPDATE SET ciphertext = EXCLUDED.ciphertext, iv = EXCLUDED.iv, tag = EXCLUDED.tag, updated_at = now()`,
      [sessionId, "pairing_code", encrypted.ciphertext, encrypted.iv, encrypted.tag]
    );
  } catch {
    memoryPairingStore.set(`${sessionId}:pairing_code`, encrypted);
  }
}

/**
 * Retrieves the pairing code if valid and not expired.
 */
export async function getEncryptedPairingCode(
  sessionId = "default",
  encryptionKey?: Buffer
): Promise<{ code: string; expiresAt: number } | null> {
  const key = encryptionKey ?? deriveSessionKey();
  try {
    const res = await query<EncryptedPayload>(
      `SELECT ciphertext, iv, tag FROM whatsapp_baileys_session
       WHERE session_id = $1 AND key_id = $2`,
      [sessionId, "pairing_code"]
    );

    let encrypted: EncryptedPayload | null = null;
    if (res.rows && res.rows.length > 0) {
      encrypted = res.rows[0];
    } else {
      encrypted = memoryPairingStore.get(`${sessionId}:pairing_code`) ?? null;
    }

    if (!encrypted) return null;

    const decryptedJson = decryptSessionData(encrypted, key);
    const parsed = JSON.parse(decryptedJson) as { code: string; expiresAt: number };

    if (Date.now() > parsed.expiresAt) {
      await clearEncryptedPairingCode(sessionId);
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

/**
 * Removes the pairing code record once paired or expired.
 */
export async function clearEncryptedPairingCode(sessionId = "default"): Promise<void> {
  try {
    await query(
      `DELETE FROM whatsapp_baileys_session WHERE session_id = $1 AND key_id = $2`,
      [sessionId, "pairing_code"]
    );
  } catch {
    memoryPairingStore.delete(`${sessionId}:pairing_code`);
  }
}

export function clearMemoryPairingStore(): void {
  memoryPairingStore.clear();
}
