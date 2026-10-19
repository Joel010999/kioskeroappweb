import {
  BufferJSON,
  initAuthCreds,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataSet,
  type SignalDataTypeMap,
  type SignalKeyStore,
} from "@whiskeysockets/baileys";
import { query } from "@/server/db/client";
import { decryptSessionData, deriveSessionKey, encryptSessionData, type EncryptedPayload } from "./crypto";

type SessionStoreOptions = {
  sessionId?: string;
  encryptionKey?: Buffer;
};

// Fallback in-memory map for unit tests when DB is mocked or unavailable
const memorySessionStore = new Map<string, EncryptedPayload>();
let tableEnsured = false;

/**
 * Ensures the whatsapp_baileys_session table exists in PostgreSQL.
 */
export async function ensureSessionTable(): Promise<void> {
  if (tableEnsured) return;
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS whatsapp_baileys_session (
        session_id text NOT NULL DEFAULT 'default',
        key_id text NOT NULL,
        ciphertext text NOT NULL,
        iv text NOT NULL,
        tag text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (session_id, key_id)
      )
    `);
    await query(`
      CREATE INDEX IF NOT EXISTS whatsapp_baileys_session_lookup_idx
        ON whatsapp_baileys_session (session_id, key_id)
    `);
    tableEnsured = true;
  } catch (err) {
    if (!process.env.VITEST) {
      console.warn("[POSTGRES AUTH] Warning: Could not ensure whatsapp_baileys_session table:", err instanceof Error ? err.message : err);
    }
  }
}

/**
 * Custom PostgreSQL authentication state adapter for Baileys.
 * Serializes Buffers using BufferJSON and encrypts all stored keys with AES-256-GCM.
 */
export async function initPostgresAuthState(options: SessionStoreOptions = {}): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
  clearSession: () => Promise<void>;
}> {
  const sessionId = options.sessionId ?? "default";
  const key = options.encryptionKey ?? deriveSessionKey();

  await ensureSessionTable();

  // Helper to read an encrypted item from DB (or in-memory fallback)
  async function readItem<T>(keyId: string): Promise<T | null> {
    try {
      const res = await query<EncryptedPayload>(
        `SELECT ciphertext, iv, tag FROM whatsapp_baileys_session
         WHERE session_id = $1 AND key_id = $2`,
        [sessionId, keyId]
      );

      if (res.rows && res.rows.length > 0) {
        try {
          const decryptedJson = decryptSessionData(res.rows[0], key);
          return JSON.parse(decryptedJson, BufferJSON.reviver) as T;
        } catch (decryptErr) {
          console.error(
            `[POSTGRES AUTH ERROR] Failed to decrypt session item "${keyId}". ` +
            `Verify that WHATSAPP_SESSION_ENCRYPTION_KEY matches the key used during pairing! ` +
            `Error: ${decryptErr instanceof Error ? decryptErr.message : decryptErr}`
          );
          return null;
        }
      }
    } catch (err) {
      // In-memory fallback
      const inMemory = memorySessionStore.get(`${sessionId}:${keyId}`);
      if (inMemory) {
        try {
          const decryptedJson = decryptSessionData(inMemory, key);
          return JSON.parse(decryptedJson, BufferJSON.reviver) as T;
        } catch {
          return null;
        }
      }
      if (!process.env.VITEST) {
        console.error(`[POSTGRES AUTH ERROR] Failed to read "${keyId}" from PostgreSQL:`, err instanceof Error ? err.message : err);
      }
    }
    return null;
  }

  // Helper to write an encrypted item to DB
  async function writeItem(keyId: string, value: unknown): Promise<void> {
    const serialized = JSON.stringify(value, BufferJSON.replacer);
    const encrypted = encryptSessionData(serialized, key);

    try {
      await query(
        `INSERT INTO whatsapp_baileys_session (session_id, key_id, ciphertext, iv, tag, updated_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (session_id, key_id)
         DO UPDATE SET ciphertext = EXCLUDED.ciphertext, iv = EXCLUDED.iv, tag = EXCLUDED.tag, updated_at = now()`,
        [sessionId, keyId, encrypted.ciphertext, encrypted.iv, encrypted.tag]
      );
    } catch (err) {
      // In-memory fallback
      memorySessionStore.set(`${sessionId}:${keyId}`, encrypted);
      if (!process.env.VITEST) {
        console.error(`[POSTGRES AUTH ERROR] CRITICAL: Failed to write "${keyId}" to PostgreSQL:`, err instanceof Error ? err.message : err);
        throw err;
      }
    }
  }

  // Helper to remove an item
  async function deleteItem(keyId: string): Promise<void> {
    try {
      await query(
        `DELETE FROM whatsapp_baileys_session WHERE session_id = $1 AND key_id = $2`,
        [sessionId, keyId]
      );
    } catch {
      memorySessionStore.delete(`${sessionId}:${keyId}`);
    }
  }

  // 1. Initialize or load credentials
  const existingCreds = await readItem<AuthenticationCreds>("creds");
  const creds: AuthenticationCreds = existingCreds ?? initAuthCreds();

  // 2. AuthenticationState keys getter and setter
  const keys: SignalKeyStore = {
    get: async <T extends keyof SignalDataTypeMap>(
      type: T,
      ids: string[]
    ): Promise<{ [id: string]: SignalDataTypeMap[T] }> => {
      const data: { [id: string]: SignalDataTypeMap[T] } = {};
      if (ids.length === 0) return data;

      await Promise.all(
        ids.map(async (id) => {
          const keyId = `${type}:${id}`;
          let value = await readItem<SignalDataTypeMap[T]>(keyId);
          if (type === "app-state-sync-key" && value) {
            value = (proto.Message.AppStateSyncKeyData.fromObject(value as any) as unknown) as SignalDataTypeMap[T];
          }
          if (value !== null && value !== undefined) {
            data[id] = value;
          }
        })
      );

      return data;
    },
    set: async (data: SignalDataSet): Promise<void> => {
      const tasks: Promise<void>[] = [];

      for (const category of Object.keys(data) as Array<keyof SignalDataTypeMap>) {
        const categoryData = data[category];
        if (!categoryData) continue;

        for (const id of Object.keys(categoryData)) {
          const value = categoryData[id];
          const keyId = `${category}:${id}`;

          if (value === null || value === undefined) {
            tasks.push(deleteItem(keyId));
          } else {
            tasks.push(writeItem(keyId, value));
          }
        }
      }

      await Promise.all(tasks);
    },
  };

  const saveCreds = async (): Promise<void> => {
    await writeItem("creds", creds);
  };

  const clearSession = async (): Promise<void> => {
    try {
      await query(
        `DELETE FROM whatsapp_baileys_session WHERE session_id = $1`,
        [sessionId]
      );
    } catch {
      for (const k of Array.from(memorySessionStore.keys())) {
        if (k.startsWith(`${sessionId}:`)) memorySessionStore.delete(k);
      }
    }
  };

  return {
    state: { creds, keys },
    saveCreds,
    clearSession,
  };
}

export {
  saveEncryptedPairingCode,
  getEncryptedPairingCode,
  clearEncryptedPairingCode,
} from "./pairing-store";

/**
 * Clears the in-memory fallback store (for tests).
 */
export function clearMemoryAuthStateStore(): void {
  memorySessionStore.clear();
}
