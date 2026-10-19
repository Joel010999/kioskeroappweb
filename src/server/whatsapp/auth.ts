import type { WhatsAppSenderContext } from "./types";
import { query } from "@/server/db/client";

/**
 * Normalizes a phone number to digits only, with special handling for Argentine numbers.
 * In Argentina, mobile WhatsApp numbers often use country code + 9 + area code (e.g., 54911...).
 */
export function normalizePhoneNumber(raw: string | null | undefined): string {
  if (!raw) return "";

  // Strip non-digits
  let digits = raw.replace(/\D/g, "");

  // If starts with leading zeros (e.g. 011), strip them
  while (digits.startsWith("0")) {
    digits = digits.slice(1);
  }

  // If local Argentine number (e.g., 11xxxxxxxx or 911xxxxxxxx), prepend 54
  if (digits.length === 10 && !digits.startsWith("54")) {
    digits = `54${digits}`;
  } else if (digits.length === 11 && digits.startsWith("9") && !digits.startsWith("54")) {
    digits = `54${digits}`;
  }

  // Remove mobile '15' prefix if inserted after area code (e.g. 54 11 15 xxxxxxxx -> 54 11 xxxxxxxx)
  // Common in manual Argentine entries
  if (digits.startsWith("541115") && digits.length === 12) {
    digits = `5411${digits.slice(6)}`;
  } else if (digits.startsWith("5491115") && digits.length === 13) {
    digits = `54911${digits.slice(7)}`;
  }

  return digits;
}

/**
 * Generates alternate valid representations for a number (e.g. 54911... <-> 5411...)
 * to ensure formatting variations don't lock out authorized users.
 */
export function getPhoneVariants(normalized: string): string[] {
  if (!normalized) return [];

  const variants = new Set<string>([normalized]);

  if (normalized.startsWith("549") && normalized.length >= 12) {
    // 54911xxxx -> 5411xxxx
    variants.add(`54${normalized.slice(3)}`);
  } else if (normalized.startsWith("54") && !normalized.startsWith("549") && normalized.length >= 11) {
    // 5411xxxx -> 54911xxxx
    variants.add(`549${normalized.slice(2)}`);
  }

  return Array.from(variants);
}

/**
 * Checks if a sender's phone number is authorized.
 * Checks against WHATSAPP_ALLOWED_NUMBERS environment variable.
 */
export async function isAuthorizedSender(
  senderPhone: string,
  configuredAllowedEnv?: string
): Promise<boolean> {
  const normalizedSender = normalizePhoneNumber(senderPhone);
  if (!normalizedSender) return false;

  const senderVariants = getPhoneVariants(normalizedSender);

  // 1. Check environment variable list
  const allowedEnv = configuredAllowedEnv ?? process.env.WHATSAPP_ALLOWED_NUMBERS ?? "";
  const allowedFromEnv = allowedEnv
    .split(",")
    .map((num) => normalizePhoneNumber(num.trim()))
    .filter((num) => num.length > 0);

  for (const allowed of allowedFromEnv) {
    const allowedVariants = getPhoneVariants(allowed);
    if (senderVariants.some((v) => allowedVariants.includes(v))) {
      return true;
    }
  }

  // 2. Check database table whatsapp_authorized_numbers (if available)
  try {
    const dbResult = await query<{ phone: string; active: boolean }>(
      "SELECT phone, active FROM whatsapp_authorized_numbers WHERE active = true",
      []
    );
    for (const row of dbResult.rows) {
      const allowedVariants = getPhoneVariants(normalizePhoneNumber(row.phone));
      if (senderVariants.some((v) => allowedVariants.includes(v))) {
        return true;
      }
    }
  } catch {
    // Graceful fallback if table doesn't exist yet in early environments
  }

  return false;
}

/**
 * Resolves context and authorization for a WhatsApp sender.
 * By default, authorized numbers (like Mónica) receive SUPERVISOR role
 * allowing full read access to all three branches (Depósito, Centro, Jardín).
 */
export async function getSenderContext(
  senderPhone: string,
  displayName?: string,
  configuredAllowedEnv?: string
): Promise<WhatsAppSenderContext> {
  const normalizedPhone = normalizePhoneNumber(senderPhone);
  const isAuthorized = await isAuthorizedSender(normalizedPhone, configuredAllowedEnv);

  return {
    phone: senderPhone,
    normalizedPhone,
    isAuthorized,
    role: "SUPERVISOR",
    name: displayName || (isAuthorized ? "Mónica" : "Usuario"),
  };
}
