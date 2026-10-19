import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH_BYTES = 12;

export type EncryptedPayload = {
  ciphertext: string;
  iv: string;
  tag: string;
};

/**
 * Derives or parses a 32-byte key from the environment variable or custom input.
 * Accepts a 64-character hex string, a 32-byte base64 string, or hashes arbitrary passphrases with SHA-256.
 */
export function deriveSessionKey(keyInput?: string): Buffer {
  const secret = keyInput ?? process.env.WHATSAPP_SESSION_ENCRYPTION_KEY;
  if (!secret) {
    throw new Error("WHATSAPP_SESSION_ENCRYPTION_KEY must be configured.");
  }

  const trimmed = secret.trim();

  // If 64 hex characters (32 bytes)
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }

  // If base64 encoding 32 bytes (44 chars ending with = or without)
  if (trimmed.length === 44 && /^[A-Za-z0-9+/=]+$/.test(trimmed)) {
    try {
      const buf = Buffer.from(trimmed, "base64");
      if (buf.length === 32) return buf;
    } catch {
      // fallback to hashing
    }
  }

  // Consistent SHA-256 derivation for any other passphrase string
  return createHash("sha256").update(trimmed, "utf8").digest();
}

/**
 * Encrypts plaintext using AES-256-GCM.
 * Produces ciphertext, random IV, and authentication tag.
 */
export function encryptSessionData(plaintext: string, key: Buffer): EncryptedPayload {
  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return {
    ciphertext: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
  };
}

/**
 * Decrypts AES-256-GCM ciphertext using the given key, IV, and authentication tag.
 * Throws if the authentication tag fails (ensuring integrity and authenticity).
 */
export function decryptSessionData(
  payload: EncryptedPayload,
  key: Buffer
): string {
  const iv = Buffer.from(payload.iv, "base64");
  const tag = Buffer.from(payload.tag, "base64");
  const ciphertext = Buffer.from(payload.ciphertext, "base64");

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}
