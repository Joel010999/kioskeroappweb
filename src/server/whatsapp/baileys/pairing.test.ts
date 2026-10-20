import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { deriveSessionKey } from "./crypto";
import {
  initPostgresAuthState,
  verifyPersistedSession,
  clearMemoryAuthStateStore,
} from "./auth-state";

const testDb = new Map<string, { ciphertext: string; iv: string; tag: string }>();

vi.mock("@/server/db/client", () => ({
  query: vi.fn().mockImplementation(async (sql: string, params?: any[]) => {
    if (sql.includes("SELECT ciphertext, iv, tag FROM whatsapp_baileys_session")) {
      const [sessionId, keyId] = params || [];
      const row = testDb.get(`${sessionId}:${keyId}`);
      return { rows: row ? [row] : [] };
    }
    if (sql.includes("SELECT count(*)")) {
      const [sessionId, keyId] = params || [];
      if (keyId) {
        const row = testDb.get(`${sessionId}:${keyId}`);
        return { rows: [{ count: row ? "1" : "0" }] };
      }
      const excludeNonSignal = sql.includes("NOT IN");
      let count = 0;
      for (const k of testDb.keys()) {
        if (!sessionId || k.startsWith(`${sessionId}:`)) {
          if (excludeNonSignal) {
            const rowKeyId = k.slice((sessionId || "").length + 1);
            if (rowKeyId === "creds" || rowKeyId === "lock:pairing" || rowKeyId === "pairing_code") continue;
          }
          count++;
        }
      }
      return { rows: [{ count: String(count) }] };
    }
    if (sql.includes("lock:pairing")) {
      if (sql.includes("INSERT")) {
        testDb.set("default:lock:pairing", { ciphertext: "active", iv: "none", tag: "none" });
        return { rows: [] };
      }
      if (sql.includes("DELETE")) {
        testDb.delete("default:lock:pairing");
        return { rows: [] };
      }
    }
    if (sql.includes("INSERT INTO whatsapp_baileys_session")) {
      const [sessionId, keyId, ciphertext, iv, tag] = params || [];
      testDb.set(`${sessionId}:${keyId}`, { ciphertext, iv, tag });
      return { rows: [] };
    }
    if (sql.includes("DELETE FROM whatsapp_baileys_session WHERE session_id = $1 AND key_id = $2")) {
      const [sessionId, keyId] = params || [];
      testDb.delete(`${sessionId}:${keyId}`);
      return { rows: [] };
    }
    if (sql.includes("DELETE FROM whatsapp_baileys_session WHERE session_id = $1")) {
      const [sessionId] = params || [];
      for (const k of Array.from(testDb.keys())) {
        if (k.startsWith(`${sessionId}:`)) testDb.delete(k);
      }
      return { rows: [] };
    }
    return { rows: [] };
  }),
}));

describe("WhatsApp Companion Pairing & Verification Integrity", () => {
  const originalEnv = process.env.WHATSAPP_SESSION_ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.WHATSAPP_SESSION_ENCRYPTION_KEY = "test-companion-pairing-encryption-key-32b";
    testDb.clear();
    clearMemoryAuthStateStore();
  });

  afterEach(() => {
    process.env.WHATSAPP_SESSION_ENCRYPTION_KEY = originalEnv;
  });

  describe("Premature Close & Incomplete Sync Prevention", () => {
    it("fails validation if socket closes after only saving 'creds' without Signal keys", async () => {
      const key = deriveSessionKey();
      const { state, saveCreds } = await initPostgresAuthState({
        sessionId: "default",
        encryptionKey: key,
      });

      // Emulate initial creds write after user enters 8-digit code
      state.creds.registered = true;
      state.creds.me = { id: "5493885196480:1@s.whatsapp.net", name: "~" };
      state.creds.account = { details: Buffer.from("adv-account") } as any;
      await saveCreds();

      // Only 'creds' is in the database; sync has NOT occurred
      expect(testDb.has("default:creds")).toBe(true);
      expect(testDb.size).toBe(1);

      const verification = await verifyPersistedSession("default", key);

      // Must NOT be declared valid just because 'creds' row exists
      expect(verification.isValid).toBe(false);
      expect(verification.registered).toBe(true);
      expect(verification.hasSignalKeys).toBe(false);
      expect(verification.totalKeys).toBe(1);
    });

    it("succeeds validation only after credentials AND Signal pre-keys/app-state keys are synced", async () => {
      const key = deriveSessionKey();
      const { state, saveCreds } = await initPostgresAuthState({
        sessionId: "default",
        encryptionKey: key,
      });

      state.creds.registered = true;
      state.creds.me = { id: "5493885196480:1@s.whatsapp.net", name: "~" };
      state.creds.account = { details: Buffer.from("adv-account") } as any;
      await saveCreds();

      // Emulate post-open sync: WhatsApp sends Signal pre-keys and app-state keys
      await state.keys.set({
        "pre-key": {
          "1": { private: Buffer.from("priv1"), public: Buffer.from("pub1") },
          "2": { private: Buffer.from("priv2"), public: Buffer.from("pub2") },
        },
        "app-state-sync-key": {
          "sync1": { keyData: Buffer.from("sync-data-1") } as any,
        },
      });

      expect(testDb.size).toBeGreaterThanOrEqual(4);

      const verification = await verifyPersistedSession("default", key);

      expect(verification.isValid).toBe(true);
      expect(verification.registered).toBe(true);
      expect(verification.jid).toBe("5493885196480:1@s.whatsapp.net");
      expect(verification.hasSignalKeys).toBe(true);
      expect(verification.totalKeys).toBeGreaterThanOrEqual(4);
    });
  });

  describe("Lock Lifecycle during Pairing & Teardown", () => {
    it("sets, refreshes, and releases 'lock:pairing' in PostgreSQL", async () => {
      const { query } = await import("@/server/db/client");

      // Set pairing lock
      await query(
        `INSERT INTO whatsapp_baileys_session (session_id, key_id, ciphertext, iv, tag, updated_at)
         VALUES ('default', 'lock:pairing', 'active', 'none', 'none', now())`
      );
      expect(testDb.has("default:lock:pairing")).toBe(true);

      // Check lock active
      const checkRes = await query(
        "SELECT count(*) FROM whatsapp_baileys_session WHERE session_id = $1 AND key_id = $2",
        ["default", "lock:pairing"]
      );
      expect(checkRes.rows[0].count).toBe("1");

      // Clean lock on teardown
      await query("DELETE FROM whatsapp_baileys_session WHERE session_id = 'default' AND key_id = 'lock:pairing'");
      expect(testDb.has("default:lock:pairing")).toBe(false);

      const afterClear = await query(
        "SELECT count(*) FROM whatsapp_baileys_session WHERE session_id = $1 AND key_id = $2",
        ["default", "lock:pairing"]
      );
      expect(afterClear.rows[0].count).toBe("0");
    });
  });

  describe("515 Reconnect Credentials Preservation", () => {
    it("preserves updated companion credentials across 515 reconnection cycles", async () => {
      const key = deriveSessionKey();

      // Cycle 1: User types code, Baileys emits creds.update
      const cycle1 = await initPostgresAuthState({
        sessionId: "default",
        encryptionKey: key,
      });
      cycle1.state.creds.registered = true;
      cycle1.state.creds.me = { id: "5493885196480:1@s.whatsapp.net" };
      await cycle1.saveCreds();

      // Cycle 2: WhatsApp server sends 515 (restart required). Reconnect with cleanSession = false
      const cycle2 = await initPostgresAuthState({
        sessionId: "default",
        encryptionKey: key,
      });

      // Credentials saved in Cycle 1 MUST be loaded in Cycle 2
      expect(cycle2.state.creds.registered).toBe(true);
      expect(cycle2.state.creds.me?.id).toBe("5493885196480:1@s.whatsapp.net");
    });
  });

  describe("Failure Modes & Defensive Validations", () => {
    it("fails validation when companion JID is missing or does not contain @", async () => {
      const key = deriveSessionKey();
      const { state, saveCreds } = await initPostgresAuthState({
        sessionId: "invalid-jid",
        encryptionKey: key,
      });
      state.creds.registered = true;
      state.creds.me = { id: "raw-number-without-at" };
      state.creds.account = { details: Buffer.from("adv") } as any;
      await saveCreds();

      await state.keys.set({
        "pre-key": { "1": { private: Buffer.from("p"), public: Buffer.from("q") } },
      });

      const res = await verifyPersistedSession("invalid-jid", key);
      expect(res.isValid).toBe(false);
      expect(res.jid).toBe("raw-number-without-at");
    });

    it("returns isValid: false with error message when DB query throws", async () => {
      const { query } = await import("@/server/db/client");
      (query as any).mockRejectedValueOnce(new Error("Postgres connection timeout"));

      const res = await verifyPersistedSession("db-down");
      expect(res.isValid).toBe(false);
      expect(res.error).toBeDefined();
      expect(res.error).toContain("Postgres connection timeout");
    });
  });
});
