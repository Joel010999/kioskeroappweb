import { describe, expect, it } from "vitest";
import { completeWeekRange, depotStockState, isIrregularWeeklyDemand, median, weeklyDecision } from "./weekly-replenishment-rules";

describe("weekly replenishment rules", () => {
  it("uses completed Monday-Sunday weeks before the planning week", () => {
    expect(completeWeekRange("2026-09-05", 6)).toEqual({ from: "2026-07-20", toExclusive: "2026-08-31" });
  });
  it("keeps decimals in the weekly median and suggestion", () => {
    expect(median([1, 2, 3, 4, 5, 6])).toBe(3.5);
    expect(weeklyDecision({ currentStock: 1.25, activeWeeks: 6, medianDemand: 3.5, maxDemand: 4 })).toMatchObject({ suggestedQuantity: 2.25 });
  });
  it("holds insufficient history, negative stock, and irregular demand for review", () => {
    expect(weeklyDecision({ currentStock: 0, activeWeeks: 2, medianDemand: 4, maxDemand: 4 }).status).toBe("INSUFFICIENT_HISTORY");
    expect(weeklyDecision({ currentStock: -1, activeWeeks: 6, medianDemand: 4, maxDemand: 4 }).status).toBe("NEGATIVE_STOCK");
    expect(isIrregularWeeklyDemand(10, 40)).toBe(true);
    expect(weeklyDecision({ currentStock: 0, activeWeeks: 6, medianDemand: 10, maxDemand: 40 }).status).toBe("IRREGULAR_DEMAND");
  });
  it("distinguishes depot zero, negative, and no stock row", () => {
    expect(depotStockState(0)).toBe("DEPOT_STOCK_ZERO");
    expect(depotStockState(-2)).toBe("DEPOT_STOCK_NEGATIVE");
    expect(depotStockState(null)).toBe("DEPOT_NO_ROW");
  });
  it("does not replace a manually chosen requested quantity", () => {
    const suggested = weeklyDecision({ currentStock: 0, activeWeeks: 6, medianDemand: 10, maxDemand: 10 }).suggestedQuantity;
    const requested = 4;
    expect(suggested).toBe(10);
    expect(requested).toBe(4);
  });
});
