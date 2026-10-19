import { describe, expect, it } from "vitest";
import { decryptSessionData, deriveSessionKey, encryptSessionData } from "./crypto";

describe("Baileys Session AES-256-GCM Encryption", () => {
  const sampleKey = deriveSessionKey("a_secure_random_passphrase_for_testing_123");

  it("derives a valid 32-byte key from passphrase", () => {
    expect(sampleKey.length).toBe(32);
  });

  it("derives 32-byte key from 64-character hex string", () => {
    const hexKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const key = deriveSessionKey(hexKey);
    expect(key.length).toBe(32);
    expect(key.toString("hex")).toBe(hexKey);
  });

  it("encrypts and decrypts session data losslessly", () => {
    const sessionPayload = JSON.stringify({
      creds: { me: { id: "5491112345678:1@s.whatsapp.net", name: "Monica" } },
      keys: { "pre-key-1": "sample_secret_key_material" },
    });

    const encrypted = encryptSessionData(sessionPayload, sampleKey);
    expect(encrypted.ciphertext).toBeDefined();
    expect(encrypted.iv).toBeDefined();
    expect(encrypted.tag).toBeDefined();
    expect(encrypted.ciphertext).not.toContain("Monica"); // Ciphertext is not plain text

    const decrypted = decryptSessionData(encrypted, sampleKey);
    expect(decrypted).toBe(sessionPayload);
    expect(JSON.parse(decrypted).creds.me.name).toBe("Monica");
  });

  it("fails to decrypt if the authentication tag is tampered with", () => {
    const encrypted = encryptSessionData("top_secret_session_data", sampleKey);
    // Tamper with the tag
    const tamperedTag = Buffer.from(encrypted.tag, "base64");
    tamperedTag[0] ^= 0xff; // flip bits

    expect(() => {
      decryptSessionData(
        { ...encrypted, tag: tamperedTag.toString("base64") },
        sampleKey
      );
    }).toThrow();
  });

  it("fails to decrypt if the ciphertext is tampered with", () => {
    const encrypted = encryptSessionData("top_secret_session_data", sampleKey);
    const tamperedCipher = Buffer.from(encrypted.ciphertext, "base64");
    tamperedCipher[0] ^= 0xff;

    expect(() => {
      decryptSessionData(
        { ...encrypted, ciphertext: tamperedCipher.toString("base64") },
        sampleKey
      );
    }).toThrow();
  });

  it("fails to decrypt with a different key", () => {
    const otherKey = deriveSessionKey("another_completely_different_passphrase");
    const encrypted = encryptSessionData("secret_data", sampleKey);

    expect(() => {
      decryptSessionData(encrypted, otherKey);
    }).toThrow();
  });
});
