export const supplyEvidenceFilters = [
  "POSSIBLE_DEPOT",
  "POSSIBLE_DIRECT_SUPPLIER",
  "NO_EVIDENCE",
] as const;

export type SupplyEvidence = (typeof supplyEvidenceFilters)[number];

export function classifySupplyEvidence(input: {
  historicalDocuments: number;
  depotStock: number | null;
}): SupplyEvidence {
  if (input.historicalDocuments < 3) return "NO_EVIDENCE";
  return (input.depotStock ?? 0) > 0
    ? "POSSIBLE_DEPOT"
    : "POSSIBLE_DIRECT_SUPPLIER";
}
