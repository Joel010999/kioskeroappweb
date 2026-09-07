import { RequestValidationError, parseOptionalNonNegativeNumber, parseOptionalPositiveInteger } from "@/server/validation/request";
import { orderStatuses, type OrderStatus } from "./rules";

export async function body(request: Request): Promise<Record<string, unknown>> {
  try { const value: unknown = await request.json(); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(); return value as Record<string, unknown>; }
  catch { throw new RequestValidationError("Request body must be a JSON object."); }
}

export function id(value: string, name: string): number {
  const parsed = parseOptionalPositiveInteger(value, name); if (!parsed) throw new RequestValidationError(`${name} must be a positive integer.`); return parsed;
}

export function articleIds(value: unknown): number[] {
  if (!Array.isArray(value) || !value.length || value.some((item) => !Number.isSafeInteger(item) || item < 1)) throw new RequestValidationError("article_ids must be a non-empty array of positive integers.");
  return value as number[];
}

export function quantity(value: unknown): number {
  const parsed = parseOptionalNonNegativeNumber(value === undefined ? null : String(value), "requested_quantity");
  if (parsed === undefined) throw new RequestValidationError("requested_quantity is required.");
  return parsed;
}

export function operationalQuantity(value: unknown, name: string): number {
  const parsed = parseOptionalNonNegativeNumber(value === undefined ? null : String(value), name);
  if (parsed === undefined) throw new RequestValidationError(`${name} is required.`);
  return parsed;
}

export function operationalItems(value: unknown): Array<{ itemId: number; quantity: number }> {
  if (!Array.isArray(value) || !value.length) throw new RequestValidationError("items must be a non-empty array.");
  return value.map((item) => {
    if (!item || typeof item !== "object") throw new RequestValidationError("Each item must be an object.");
    const row = item as { item_id?: unknown; quantity?: unknown };
    if (!Number.isSafeInteger(row.item_id) || Number(row.item_id) < 1) throw new RequestValidationError("item_id must be a positive integer.");
    return { itemId: Number(row.item_id), quantity: operationalQuantity(row.quantity, "quantity") };
  });
}

export function notes(value: unknown): string {
  if (value === undefined) return ""; if (typeof value !== "string" || value.length > 2_000) throw new RequestValidationError("notes must be text up to 2000 characters."); return value.trim();
}

export function orderStatus(value: unknown): OrderStatus {
  if (typeof value !== "string" || !(orderStatuses as readonly string[]).includes(value)) throw new RequestValidationError("status is not valid."); return value as OrderStatus;
}
