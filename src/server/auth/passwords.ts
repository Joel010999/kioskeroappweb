import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const keyLength = 64;

export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("base64url");
  const derived = await scrypt(password, salt, keyLength) as Buffer;
  return `scrypt$${salt}$${derived.toString("base64url")}`;
}

export async function verifyPassword(password: string, stored: string | null) {
  if (!stored) return false;
  const [algorithm, salt, hash, extra] = stored.split("$");
  if (algorithm !== "scrypt" || !salt || !hash || extra) return false;
  const expected = Buffer.from(hash, "base64url");
  const derived = await scrypt(password, salt, keyLength) as Buffer;
  return expected.length === derived.length && timingSafeEqual(expected, derived);
}
