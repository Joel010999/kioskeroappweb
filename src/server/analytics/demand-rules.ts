export const suggestionStatuses = ["SUGGESTION_AVAILABLE", "NO_SUGGESTION", "MANUAL_REVIEW", "INSUFFICIENT_HISTORY", "IRREGULAR_DEMAND"] as const;
export const suggestionConfidences = ["ALTA", "MEDIA", "BAJA", "INSUFICIENTE"] as const;

export type SuggestionStatus = (typeof suggestionStatuses)[number];
export type SuggestionConfidence = (typeof suggestionConfidences)[number];

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

export function confidenceForHistory(historyMonths: number): SuggestionConfidence {
  if (historyMonths >= 12) return "ALTA";
  if (historyMonths >= 6) return "MEDIA";
  if (historyMonths >= 3) return "BAJA";
  return "INSUFICIENTE";
}

export function isIrregularDemand(medianDemand: number, maxDemand: number): boolean {
  return maxDemand - medianDemand >= 20 && (medianDemand === 0 ? maxDemand >= 20 : maxDemand >= medianDemand * 3);
}

export function suggestionStatus(input: { historyMonths: number; currentStock: number; stockTarget: number | null; maxDemand: number | null }): SuggestionStatus {
  if (input.currentStock < 0) return "MANUAL_REVIEW";
  if (input.stockTarget === null || input.historyMonths < 3) return "INSUFFICIENT_HISTORY";
  if (input.maxDemand !== null && isIrregularDemand(input.stockTarget, input.maxDemand)) return "IRREGULAR_DEMAND";
  return Math.max(0, input.stockTarget - input.currentStock) > 0 ? "SUGGESTION_AVAILABLE" : "NO_SUGGESTION";
}
