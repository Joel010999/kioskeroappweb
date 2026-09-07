export const weeklyReplenishmentStatuses = [
  "SUGGESTION_AVAILABLE",
  "NO_SUGGESTION",
  "INSUFFICIENT_HISTORY",
  "NEGATIVE_STOCK",
  "IRREGULAR_DEMAND",
  "NO_DEMAND",
] as const;

export type WeeklyReplenishmentStatus = (typeof weeklyReplenishmentStatuses)[number];
export type DepotStockState = "DEPOT_STOCK_POSITIVE" | "DEPOT_STOCK_ZERO" | "DEPOT_STOCK_NEGATIVE" | "DEPOT_NO_ROW";

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

export function completeWeekRange(planningDate: string, weeks: number) {
  const date = new Date(`${planningDate}T00:00:00.000Z`);
  const mondayOffset = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - mondayOffset - weeks * 7);
  const from = date.toISOString().slice(0, 10);
  date.setUTCDate(date.getUTCDate() + weeks * 7);
  return { from, toExclusive: date.toISOString().slice(0, 10) };
}

export function depotStockState(stock: number | null): DepotStockState {
  if (stock === null) return "DEPOT_NO_ROW";
  if (stock < 0) return "DEPOT_STOCK_NEGATIVE";
  if (stock === 0) return "DEPOT_STOCK_ZERO";
  return "DEPOT_STOCK_POSITIVE";
}

export function isIrregularWeeklyDemand(medianDemand: number, maxDemand: number): boolean {
  return maxDemand - medianDemand >= 20 && (medianDemand === 0 ? maxDemand >= 20 : maxDemand >= medianDemand * 3);
}

export function weeklyDecision(input: { currentStock: number; activeWeeks: number; medianDemand: number; maxDemand: number }) {
  if (input.currentStock < 0) return { status: "NEGATIVE_STOCK" as const, targetStock: null, suggestedQuantity: null };
  if (input.activeWeeks === 0) return { status: "NO_DEMAND" as const, targetStock: 0, suggestedQuantity: 0 };
  if (input.activeWeeks < 3) return { status: "INSUFFICIENT_HISTORY" as const, targetStock: null, suggestedQuantity: null };
  if (isIrregularWeeklyDemand(input.medianDemand, input.maxDemand)) return { status: "IRREGULAR_DEMAND" as const, targetStock: input.medianDemand, suggestedQuantity: null };

  const suggestedQuantity = Math.max(0, input.medianDemand - input.currentStock);
  return { status: suggestedQuantity > 0 ? "SUGGESTION_AVAILABLE" as const : "NO_SUGGESTION" as const, targetStock: input.medianDemand, suggestedQuantity };
}
