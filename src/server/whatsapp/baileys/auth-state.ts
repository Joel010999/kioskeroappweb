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

  let totalKeysInDb = 0;
  if (!process.env.VITEST) {
    try {
      const stats = await query<{ count: string }>(
        `SELECT count(*)::text as count FROM whatsapp_baileys_session WHERE session_id = $1`,
        [sessionId]
      );
      totalKeysInDb = parseInt(stats.rows[0]?.count || "0", 10);
      console.log(
        `[POSTGRES AUTH DIAGNOSTIC] Session "${sessionId}": found ${totalKeysInDb} total encrypted keys in PostgreSQL.`
      );
    } catch (statsErr) {
      console.warn(
        `[POSTGRES AUTH DIAGNOSTIC] Could not query session stats:`,
        statsErr instanceof Error ? statsErr.message : statsErr
      );
    }
  }

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
          const parsed = JSON.parse(decryptedJson, BufferJSON.reviver) as T;
          if (!process.env.VITEST && (keyId === "creds" || keyId.startsWith("app-state-sync-key"))) {
            console.log(
              `[POSTGRES AUTH DIAGNOSTIC] Key "${keyId}" successfully read from PostgreSQL and decrypted.`
            );
          }
          return parsed;
        } catch (decryptErr) {
          console.error(
            `[POSTGRES AUTH DIAGNOSTIC ERROR] Failed to decrypt session item "${keyId}". ` +
            `Verify that WHATSAPP_SESSION_ENCRYPTION_KEY matches the key used during pairing! ` +
            `Error: ${decryptErr instanceof Error ? decryptErr.message : decryptErr}`
          );
          return null;
        }
      } else if (!process.env.VITEST && keyId === "creds") {
        console.log(`[POSTGRES AUTH DIAGNOSTIC] Key "${keyId}" does not exist in PostgreSQL for session "${sessionId}".`);
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
      if (!process.env.VITEST && keyId === "creds") {
        console.log(`[POSTGRES AUTH DIAGNOSTIC] Key "creds" successfully encrypted with AES-256-GCM and saved to PostgreSQL.`);
      }
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
  if (!process.env.VITEST) {
    if (existingCreds) {
      console.log(
        `[POSTGRES AUTH DIAGNOSTIC] Loaded credentials from PostgreSQL. Registered: ${Boolean(existingCreds.registered)}.`
      );
    } else {
      console.log(
        `[POSTGRES AUTH DIAGNOSTIC] No existing "creds" record found in PostgreSQL for session "${sessionId}". Initializing unauthenticated state.`
      );
    }
  }
  const creds: AuthenticationCreds = existingCreds ?? initAuthCreds();

  // 2. AuthenticationState keys getter and setter
  const keys: SignalKeyStore = {
    get: async <T extends keyof SignalDataTypeMap>(
      type: T,
      ids: string[]
    ): Promise<{ [id: string]: SignalDataTypeMap[T] }> => {
      const data: { [id: string]: SignalDataTypeMap[T] } = {};
      if (ids.length === 0) return data;

      let retrievedCount = 0;
      await Promise.all(
        ids.map(async (id) => {
          const keyId = `${type}:${id}`;
          let value = await readItem<SignalDataTypeMap[T]>(keyId);
          if (type === "app-state-sync-key" && value) {
            value = (proto.Message.AppStateSyncKeyData.fromObject(value as any) as unknown) as SignalDataTypeMap[T];
          }
          if (value !== null && value !== undefined) {
            data[id] = value;
            retrievedCount++;
          }
        })
      );

      if (!process.env.VITEST && ids.length > 0) {
        console.log(
          `[POSTGRES AUTH DIAGNOSTIC] Signal keys batch: type="${type}", requested=${ids.length}, retrieved=${retrievedCount}.`
        );
      }

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
    } catch (err) {
      if (!process.env.VITEST) {
        console.error(`[POSTGRES AUTH ERROR] Failed to clear session "${sessionId}":`, err);
      }
    } finally {
      for (const k of Array.from(memorySessionStore.keys())) {
        if (k.startsWith(`${sessionId}:`)) memorySessionStore.delete(k);
      }
      // Mutate existing creds object in place so any reference holding state.creds receives fresh unauthenticated state
      const freshCreds = initAuthCreds();
      for (const k of Object.keys(creds)) {
        delete (creds as any)[k];
      }
      Object.assign(creds, freshCreds);
    }
  };

  return {
    state: { creds, keys },
    saveCreds,
    clearSession,
  };
}

export type SessionVerificationResult = {
  isValid: boolean;
  registered: boolean;
  jid: string | null;
  totalKeys: number;
  signalKeysCount: number;
  hasSignalKeys: boolean;
  error?: string;
};

/**
 * Validates that a session exists in PostgreSQL, can be decrypted with the encryption key,
 * is marked registered, contains a valid companion JID, and includes Signal pre-keys/app-state keys.
 * Does NOT assume a session is valid just because a 'creds' or lock row exists.
 */
export async function verifyPersistedSession(
  sessionId: string = "default",
  customKey?: Buffer
): Promise<SessionVerificationResult> {
  const key = customKey ?? deriveSessionKey();
  try {
    let credsPayload: EncryptedPayload | null = null;
    try {
      const credsRes = await query<EncryptedPayload>(
        `SELECT ciphertext, iv, tag FROM whatsapp_baileys_session WHERE session_id = $1 AND key_id = $2`,
        [sessionId, "creds"]
      );
      if (credsRes.rows && credsRes.rows.length > 0) {
        credsPayload = credsRes.rows[0];
      }
    } catch (dbErr) {
      // In tests or if DB fails, check memory fallback
      const inMem = memorySessionStore.get(`${sessionId}:creds`);
      if (inMem) credsPayload = inMem;
      if (!credsPayload) {
        return {
          isValid: false,
          registered: false,
          jid: null,
          totalKeys: 0,
          signalKeysCount: 0,
          hasSignalKeys: false,
          error: `Database query failed: ${dbErr instanceof Error ? dbErr.message : dbErr}`,
        };
      }
    }

    if (!credsPayload) {
      const inMem = memorySessionStore.get(`${sessionId}:creds`);
      if (inMem) credsPayload = inMem;
    }

    if (!credsPayload) {
      return {
        isValid: false,
        registered: false,
        jid: null,
        totalKeys: 0,
        signalKeysCount: 0,
        hasSignalKeys: false,
        error: "No 'creds' record exists in storage.",
      };
    }

    let parsedCreds: AuthenticationCreds;
    try {
      const decryptedJson = decryptSessionData(credsPayload, key);
      parsedCreds = JSON.parse(decryptedJson, BufferJSON.reviver) as AuthenticationCreds;
    } catch (decryptErr) {
      return {
        isValid: false,
        registered: false,
        jid: null,
        totalKeys: 0,
        signalKeysCount: 0,
        hasSignalKeys: false,
        error: `Decryption failed: ${decryptErr instanceof Error ? decryptErr.message : decryptErr}`,
      };
    }

    const isRegistered = Boolean(parsedCreds?.registered);
    const jid = parsedCreds?.me?.id || null;

    let totalKeys = 0;
    let signalKeysCount = 0;
    try {
      const countRes = await query<{ count: string }>(
        `SELECT count(*)::text as count FROM whatsapp_baileys_session WHERE session_id = $1`,
        [sessionId]
      );
      totalKeys = parseInt(countRes.rows?.[0]?.count || "0", 10);

      const signalRes = await query<{ count: string }>(
        `SELECT count(*)::text as count FROM whatsapp_baileys_session
         WHERE session_id = $1 AND key_id NOT IN ('creds', 'lock:pairing', 'pairing_code')`,
        [sessionId]
      );
      signalKeysCount = parseInt(signalRes.rows?.[0]?.count || "0", 10);
    } catch {
      let memTotal = 0;
      let memSignal = 0;
      for (const k of memorySessionStore.keys()) {
        if (k.startsWith(`${sessionId}:`)) {
          memTotal++;
          const keyId = k.slice(sessionId.length + 1);
          if (keyId !== "creds" && keyId !== "lock:pairing" && keyId !== "pairing_code") {
            memSignal++;
          }
        }
      }
      totalKeys = memTotal;
      signalKeysCount = memSignal;
    }

    const hasSignalKeys = signalKeysCount > 0;
    const hasCompanionCrypto =
      Boolean(parsedCreds?.noiseKey) &&
      Boolean(parsedCreds?.signedIdentityKey) &&
      Boolean(
        parsedCreds?.account ||
        (parsedCreds?.signalIdentities && parsedCreds.signalIdentities.length > 0)
      );
    const isValid =
      isRegistered &&
      Boolean(jid && jid.includes("@")) &&
      hasCompanionCrypto &&
      hasSignalKeys;

    return {
      isValid,
      registered: isRegistered,
      jid,
      totalKeys,
      signalKeysCount,
      hasSignalKeys,
    };
  } catch (err) {
    return {
      isValid: false,
      registered: false,
      jid: null,
      totalKeys: 0,
      signalKeysCount: 0,
      hasSignalKeys: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
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
