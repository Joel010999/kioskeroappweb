import { describe, expect, it, beforeEach, vi, afterEach } from "vitest";
import {
  initPostgresAuthState,
  saveEncryptedPairingCode,
  getEncryptedPairingCode,
  clearEncryptedPairingCode,
  clearMemoryAuthStateStore,
  verifyPersistedSession,
} from "./auth-state";
import { deriveSessionKey } from "./crypto";

const dbRows = new Map<string, { ciphertext: string; iv: string; tag: string }>();

vi.mock("@/server/db/client", () => ({
  query: vi.fn().mockImplementation(async (sql: string, params?: any[]) => {
    if (sql.includes("SELECT ciphertext, iv, tag FROM whatsapp_baileys_session")) {
      const [sessionId, keyId] = params || [];
      const row = dbRows.get(`${sessionId}:${keyId}`);
      return { rows: row ? [row] : [] };
    }
    if (sql.includes("SELECT count(*)")) {
      const [sessionId] = params || [];
      const excludeNonSignal = sql.includes("NOT IN");
      let count = 0;
      for (const k of dbRows.keys()) {
        if (!sessionId || k.startsWith(`${sessionId}:`)) {
          if (excludeNonSignal) {
            const keyId = k.slice((sessionId || "").length + 1);
            if (keyId === "creds" || keyId === "lock:pairing" || keyId === "pairing_code") continue;
          }
          count++;
        }
      }
      return { rows: [{ count: String(count) }] };
    }
    if (sql.includes("INSERT INTO whatsapp_baileys_session")) {
      const [sessionId, keyId, ciphertext, iv, tag] = params || [];
      dbRows.set(`${sessionId}:${keyId}`, { ciphertext, iv, tag });
      return { rows: [] };
    }
    if (sql.includes("DELETE FROM whatsapp_baileys_session WHERE session_id = $1 AND key_id = $2")) {
      const [sessionId, keyId] = params || [];
      dbRows.delete(`${sessionId}:${keyId}`);
      return { rows: [] };
    }
    if (sql.includes("DELETE FROM whatsapp_baileys_session WHERE session_id = $1")) {
      const [sessionId] = params || [];
      for (const k of Array.from(dbRows.keys())) {
        if (k.startsWith(`${sessionId}:`)) dbRows.delete(k);
      }
      return { rows: [] };
    }
    return { rows: [] };
  }),
}));

describe("PostgreSQL Baileys Auth State Adapter", () => {
  const originalEnv = process.env.WHATSAPP_SESSION_ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.WHATSAPP_SESSION_ENCRYPTION_KEY = "test-encryption-key-with-sufficient-entropy-32b";
    dbRows.clear();
    clearMemoryAuthStateStore();
  });

  afterEach(() => {
    process.env.WHATSAPP_SESSION_ENCRYPTION_KEY = originalEnv;
  });

  it("initializes new auth state with default credentials and Buffer support", async () => {
    const { state } = await initPostgresAuthState({ sessionId: "test-session" });

    expect(state.creds).toBeDefined();
    expect(state.creds.noiseKey).toBeDefined();
    expect(Buffer.isBuffer(state.creds.noiseKey.private)).toBe(true);
    expect(Buffer.isBuffer(state.creds.noiseKey.public)).toBe(true);
  });

  it("persists and reloads credentials including Buffers accurately", async () => {
    const key = deriveSessionKey();
    const { state: state1, saveCreds } = await initPostgresAuthState({
      sessionId: "test-session",
      encryptionKey: key,
    });

    const originalNoisePub = Buffer.from(state1.creds.noiseKey.public);
    state1.creds.me = { id: "5491112345678:0@s.whatsapp.net", name: "Kioskero Bot" };
    state1.creds.registered = true;

    await saveCreds();

    // Verify row was encrypted into DB
    expect(dbRows.has("test-session:creds")).toBe(true);
    const stored = dbRows.get("test-session:creds")!;
    expect(stored.ciphertext).toBeDefined();
    expect(stored.iv).toBeDefined();
    expect(stored.tag).toBeDefined();

    // Reload in a separate instance
    const { state: state2 } = await initPostgresAuthState({
      sessionId: "test-session",
      encryptionKey: key,
    });

    expect(state2.creds.registered).toBe(true);
    expect(state2.creds.me?.name).toBe("Kioskero Bot");
    expect(Buffer.isBuffer(state2.creds.noiseKey.public)).toBe(true);
    expect(Buffer.compare(state2.creds.noiseKey.public, originalNoisePub)).toBe(0);
  });

  it("stores, retrieves, and deletes Signal keys with BufferJSON serialization", async () => {
    const key = deriveSessionKey();
    const { state } = await initPostgresAuthState({
      sessionId: "test-session",
      encryptionKey: key,
    });

    const dummyKey = {
      private: Buffer.from("super-secret-private-buffer"),
      public: Buffer.from("public-key-buffer"),
    };

    // Save key
    await state.keys.set({
      "pre-key": {
        "1": dummyKey,
      },
    });

    // Retrieve key
    const retrieved = await state.keys.get("pre-key", ["1"]);
    const savedKey = retrieved["1"] as typeof dummyKey;

    expect(savedKey).toBeDefined();
    expect(Buffer.isBuffer(savedKey.private)).toBe(true);
    expect(savedKey.private.toString("utf8")).toBe("super-secret-private-buffer");
    expect(savedKey.public.toString("utf8")).toBe("public-key-buffer");

    // Delete key
    await state.keys.set({
      "pre-key": {
        "1": null,
      },
    });

    const retrievedAfterDelete = await state.keys.get("pre-key", ["1"]);
    expect(retrievedAfterDelete["1"]).toBeUndefined();
  });

  it("clears entire session data on clearSession", async () => {
    const key = deriveSessionKey();
    const { state, saveCreds, clearSession } = await initPostgresAuthState({
      sessionId: "test-session",
      encryptionKey: key,
    });

    state.creds.registered = true;
    await saveCreds();
    await state.keys.set({
      "session": { "user1": Buffer.from("active-session") },
    });

    await clearSession();

    // Verify existing state.creds reference was reset in-place
    expect(state.creds.registered).toBe(false);

    // Reload in separate instance
    const { state: newState } = await initPostgresAuthState({
      sessionId: "test-session",
      encryptionKey: key,
    });
    expect(newState.creds.registered).toBe(false);
    const sessionKey = await newState.keys.get("session", ["user1"]);
    expect(sessionKey["user1"]).toBeUndefined();
  });

  describe("verifyPersistedSession", () => {
    it("reports isValid: false when session storage is empty", async () => {
      const res = await verifyPersistedSession("non-existent");
      expect(res.isValid).toBe(false);
      expect(res.registered).toBe(false);
      expect(res.jid).toBeNull();
      expect(res.totalKeys).toBe(0);
      expect(res.hasSignalKeys).toBe(false);
    });

    it("reports isValid: false when creds cannot be decrypted (mismatched key)", async () => {
      const key1 = deriveSessionKey("passphrase-one-32-chars-long-123");
      const key2 = deriveSessionKey("passphrase-two-32-chars-long-123");

      const { state, saveCreds } = await initPostgresAuthState({
        sessionId: "crypto-mismatch",
        encryptionKey: key1,
      });
      state.creds.registered = true;
      state.creds.me = { id: "5491112345678@s.whatsapp.net" };
      await saveCreds();

      // Attempt verification with mismatched key2
      const res = await verifyPersistedSession("crypto-mismatch", key2);
      expect(res.isValid).toBe(false);
      expect(res.error).toBeDefined();
      expect(res.error).toContain("Decryption failed");
    });

    it("reports isValid: false when creds exists but registered is false", async () => {
      const key = deriveSessionKey();
      const { state, saveCreds } = await initPostgresAuthState({
        sessionId: "unregistered-session",
        encryptionKey: key,
      });
      state.creds.registered = false;
      await saveCreds();

      const res = await verifyPersistedSession("unregistered-session", key);
      expect(res.isValid).toBe(false);
      expect(res.registered).toBe(false);
    });

    it("reports isValid: false when creds exists with registered: true but without Signal keys (premature stop)", async () => {
      const key = deriveSessionKey();
      const { state, saveCreds } = await initPostgresAuthState({
        sessionId: "premature-session",
        encryptionKey: key,
      });
      state.creds.registered = true;
      state.creds.me = { id: "5491112345678@s.whatsapp.net" };
      await saveCreds();

      // Add a lock:pairing row to simulate pairing lock active
      dbRows.set("premature-session:lock:pairing", { ciphertext: "active", iv: "none", tag: "none" });

      const res = await verifyPersistedSession("premature-session", key);
      expect(res.isValid).toBe(false);
      expect(res.registered).toBe(true);
      expect(res.hasSignalKeys).toBe(false);
      expect(res.signalKeysCount).toBe(0);
      expect(res.totalKeys).toBe(2);
    });

    it("reports isValid: false when creds is registered but lacks companion ADV account or signalIdentities", async () => {
      const key = deriveSessionKey();
      const { state, saveCreds } = await initPostgresAuthState({
        sessionId: "no-adv-account",
        encryptionKey: key,
      });
      state.creds.registered = true;
      state.creds.me = { id: "5493885196480:1@s.whatsapp.net" };
      delete (state.creds as any).account;
      state.creds.signalIdentities = [];
      await saveCreds();

      // Add Signal keys
      await state.keys.set({
        "pre-key": { "1": { private: Buffer.from("priv"), public: Buffer.from("pub") } },
      });

      const res = await verifyPersistedSession("no-adv-account", key);
      expect(res.isValid).toBe(false);
      expect(res.registered).toBe(true);
      expect(res.hasSignalKeys).toBe(true);
    });

    it("reports isValid: true when session is registered, has valid companion JID, ADV account, and contains Signal keys", async () => {
      const key = deriveSessionKey();
      const { state, saveCreds } = await initPostgresAuthState({
        sessionId: "valid-session",
        encryptionKey: key,
      });
      state.creds.registered = true;
      state.creds.me = { id: "5493885196480:1@s.whatsapp.net" };
      state.creds.account = { details: Buffer.from("adv-account-signature") } as any;
      await saveCreds();

      // Add Signal keys
      await state.keys.set({
        "pre-key": { "1": { private: Buffer.from("priv"), public: Buffer.from("pub") } },
        "app-state-sync-key": { "key1": { keyData: Buffer.from("app-sync") } as any },
      });

      const res = await verifyPersistedSession("valid-session", key);
      expect(res.isValid).toBe(true);
      expect(res.registered).toBe(true);
      expect(res.jid).toBe("5493885196480:1@s.whatsapp.net");
      expect(res.hasSignalKeys).toBe(true);
      expect(res.totalKeys).toBeGreaterThanOrEqual(3);
    });
  });

  it("stores, retrieves, and expires encrypted pairing codes without exposing secrets", async () => {
    const key = deriveSessionKey();

    // Save pairing code with 500ms TTL
    await saveEncryptedPairingCode("test-session", "ABCD-1234", 500, key);

    const active = await getEncryptedPairingCode("test-session", key);
    expect(active).not.toBeNull();
    expect(active?.code).toBe("ABCD-1234");

    // Clear pairing code
    await clearEncryptedPairingCode("test-session");
    const afterClear = await getEncryptedPairingCode("test-session", key);
    expect(afterClear).toBeNull();
  });

  it("returns null for expired pairing codes", async () => {
    const key = deriveSessionKey();

    // Save with expired TTL (-100ms)
    await saveEncryptedPairingCode("test-session", "EXPIRED1", -100, key);

    const result = await getEncryptedPairingCode("test-session", key);
    expect(result).toBeNull();
  });
});
