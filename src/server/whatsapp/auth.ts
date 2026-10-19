import type { WhatsAppSenderContext } from "./types";
import { query } from "@/server/db/client";

/**
 * Masks a phone number or JID for privacy and security in logs (e.g. 549***6480).
 * Never exposes full credentials or phone identifiers.
 */
export function maskPhone(raw: string | null | undefined): string {
  if (!raw) return "unknown";
  const str = raw.trim();
  if (str.length <= 6) return "***";
  const atIdx = str.indexOf("@");
  if (atIdx !== -1) {
    const user = str.slice(0, atIdx);
    const domain = str.slice(atIdx);
    if (user.length <= 6) return `***${domain}`;
    return `${user.slice(0, 3)}***${user.slice(-4)}${domain}`;
  }
  return `${str.slice(0, 3)}***${str.slice(-4)}`;
}

/**
 * Normalizes a phone number to digits only, with robust handling for Argentine numbers.
 * In Argentina, mobile numbers in WhatsApp use 54 + 9 + area code (2-4 digits) + subscriber (6-8 digits).
 * Handles stripping mobile '15' prefix across all Argentine area codes (11, 388, 351, 387, etc.).
 */
export function normalizePhoneNumber(raw: string | null | undefined): string {
  if (!raw) return "";

  // Strip non-digits
  let digits = raw.replace(/\D/g, "");

  // Strip leading zeros (e.g. 011 or 0388)
  while (digits.startsWith("0")) {
    digits = digits.slice(1);
  }

  // Handle local mobile with '15' prefix after area code (total 12 digits, e.g. 388 15 5196480)
  if (digits.length === 12 && !digits.startsWith("54")) {
    for (const areaLen of [2, 3, 4]) {
      if (digits.slice(areaLen, areaLen + 2) === "15") {
        digits = `${digits.slice(0, areaLen)}${digits.slice(areaLen + 2)}`;
        break;
      }
    }
  }

  // Handle international numbers with '15' prefix after area code:
  // e.g. 54 9 11 15 xxxxxxxx (15 digits) or 54 11 15 xxxxxxxx (14 digits)
  if (digits.startsWith("549") && digits.length === 15) {
    for (const areaLen of [2, 3, 4]) {
      if (digits.slice(3 + areaLen, 3 + areaLen + 2) === "15") {
        digits = `549${digits.slice(3, 3 + areaLen)}${digits.slice(3 + areaLen + 2)}`;
        break;
      }
    }
  } else if (digits.startsWith("54") && !digits.startsWith("549") && digits.length === 14) {
    for (const areaLen of [2, 3, 4]) {
      if (digits.slice(2 + areaLen, 2 + areaLen + 2) === "15") {
        digits = `54${digits.slice(2, 2 + areaLen)}${digits.slice(2 + areaLen + 2)}`;
        break;
      }
    }
  }

  // Prepend Argentina country code 54 if missing:
  // 10 digits = local Argentine number (area code + subscriber) -> prepend 54
  if (digits.length === 10 && !digits.startsWith("54")) {
    digits = `54${digits}`;
  } else if (digits.length === 11 && digits.startsWith("9") && !digits.startsWith("54")) {
    // 9 + 10 digits -> prepend 54 -> 549...
    digits = `54${digits}`;
  }

  return digits;
}

/**
 * Generates alternate valid representations for a number (e.g. 54911... <-> 5411... <-> 11...)
 * to ensure formatting variations don't lock out authorized users.
 */
export function getPhoneVariants(normalized: string): string[] {
  if (!normalized) return [];

  const variants = new Set<string>([normalized]);

  if (normalized.startsWith("549") && normalized.length >= 12) {
    // 54911xxxx -> 5411xxxx
    variants.add(`54${normalized.slice(3)}`);
    // 10-digit national number
    variants.add(normalized.slice(3));
  } else if (normalized.startsWith("54") && !normalized.startsWith("549") && normalized.length >= 11) {
    // 5411xxxx -> 54911xxxx
    variants.add(`549${normalized.slice(2)}`);
    // 10-digit national number
    variants.add(normalized.slice(2));
  } else if (normalized.length === 10 && !normalized.startsWith("54")) {
    // 10-digit national number: 3885196480 -> 543885196480 and 5493885196480
    variants.add(`54${normalized}`);
    variants.add(`549${normalized}`);
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
  const allowedEnv = (configuredAllowedEnv ?? process.env.WHATSAPP_ALLOWED_NUMBERS ?? "").trim();
  if (allowedEnv === "*") {
    return true;
  }

  const allowedFromEnv = allowedEnv
    .split(/[,;\n]+/)
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
