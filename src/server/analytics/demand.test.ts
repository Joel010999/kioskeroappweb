import { describe, expect, it } from "vitest";
import { confidenceForHistory, isIrregularDemand, median, suggestionStatus } from "./demand-rules";

describe("suggestion demand rules", () => {
  it("calculates a six-month median", () => expect(median([0, 10, 20, 30, 40, 50])).toBe(25));
  it("classifies history conservatively", () => {
    expect(confidenceForHistory(12)).toBe("ALTA"); expect(confidenceForHistory(6)).toBe("MEDIA");
    expect(confidenceForHistory(3)).toBe("BAJA"); expect(confidenceForHistory(2)).toBe("INSUFICIENTE");
  });
  it("handles stock above, equal to, and below the target", () => {
    expect(suggestionStatus({ historyMonths: 12, currentStock: 11, stockTarget: 10, maxDemand: 10 })).toBe("NO_SUGGESTION");
    expect(suggestionStatus({ historyMonths: 12, currentStock: 10, stockTarget: 10, maxDemand: 10 })).toBe("NO_SUGGESTION");
    expect(suggestionStatus({ historyMonths: 12, currentStock: 0, stockTarget: 10, maxDemand: 10 })).toBe("SUGGESTION_AVAILABLE");
  });
  it("holds negative stock and insufficient history for review", () => {
    expect(suggestionStatus({ historyMonths: 12, currentStock: -1, stockTarget: 10, maxDemand: 10 })).toBe("MANUAL_REVIEW");
    expect(suggestionStatus({ historyMonths: 2, currentStock: 0, stockTarget: null, maxDemand: null })).toBe("INSUFFICIENT_HISTORY");
  });
  it("flags a material six-month outlier", () => expect(isIrregularDemand(10, 40)).toBe(true));
});
