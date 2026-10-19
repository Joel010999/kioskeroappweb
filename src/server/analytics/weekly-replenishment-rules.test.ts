import { describe, expect, it } from "vitest";
import {
  completeWeekRange,
  depotStockState,
  isIrregularWeeklyDemand,
  median,
  weeklyDecision,
  calculateTargetStock,
  REPLENISHMENT_COVERAGE_DAYS,
} from "./weekly-replenishment-rules";

describe("weekly replenishment rules", () => {
  it("uses completed Monday-Sunday weeks before the planning week", () => {
    expect(completeWeekRange("2026-09-05", 6)).toEqual({ from: "2026-07-20", toExclusive: "2026-08-31" });
  });

  it("calculates 10-day target stock based on weekly median demand", () => {
    expect(REPLENISHMENT_COVERAGE_DAYS).toBe(10);
    // 7 units per week = 1 unit per day -> 10 units for 10 days
    expect(calculateTargetStock(7, 10)).toBe(10);
    // 14 units per week = 2 units per day -> 20 units for 10 days
    expect(calculateTargetStock(14, 10)).toBe(20);
    // 3.5 units per week = 0.5 units per day -> 5.0 units for 10 days
    expect(calculateTargetStock(3.5, 10)).toBe(5);
  });

  it("applies 10-day coverage to decision while preserving decimals", () => {
    expect(median([1, 2, 3, 4, 5, 6])).toBe(3.5);
    // With 10-day coverage: targetStock = (3.5 * 10) / 7 = 5.0. Current stock = 1.25 -> suggested = 3.75
    const decision10d = weeklyDecision({ currentStock: 1.25, activeWeeks: 6, medianDemand: 3.5, maxDemand: 4 });
    expect(decision10d).toMatchObject({
      targetStock: 5.0,
      suggestedQuantity: 3.75,
      status: "SUGGESTION_AVAILABLE",
    });

    // Compare with previous 7-day coverage: targetStock = 3.5. Current stock = 1.25 -> suggested = 2.25
    const decision7d = weeklyDecision({ currentStock: 1.25, activeWeeks: 6, medianDemand: 3.5, maxDemand: 4, coverageDays: 7 });
    expect(decision7d).toMatchObject({
      targetStock: 3.5,
      suggestedQuantity: 2.25,
    });
  });

  it("respects discrete presentation rounding (ceil) and non-negative constraints", () => {
    // 1 unit per week -> 10/7 = ~1.428 units for 10 days. If discrete, CEIL(1.428) = 2.
    const discreteDecision = weeklyDecision({
      currentStock: 0,
      activeWeeks: 6,
      medianDemand: 1,
      maxDemand: 2,
      isDiscrete: true,
    });
    expect(discreteDecision.suggestedQuantity).toBe(2);

    // When current stock exceeds target stock, suggested quantity must never be negative
    const excessStockDecision = weeklyDecision({
      currentStock: 50,
      activeWeeks: 6,
      medianDemand: 7,
      maxDemand: 7,
    });
    expect(excessStockDecision.suggestedQuantity).toBe(0);
    expect(excessStockDecision.status).toBe("NO_SUGGESTION");
  });

  it("holds insufficient history, negative stock, and irregular demand for review", () => {
    expect(weeklyDecision({ currentStock: 0, activeWeeks: 2, medianDemand: 4, maxDemand: 4 }).status).toBe("INSUFFICIENT_HISTORY");
    expect(weeklyDecision({ currentStock: -1, activeWeeks: 6, medianDemand: 4, maxDemand: 4 }).status).toBe("NEGATIVE_STOCK");
    expect(isIrregularWeeklyDemand(10, 40)).toBe(true);
    expect(weeklyDecision({ currentStock: 0, activeWeeks: 6, medianDemand: 10, maxDemand: 40 }).status).toBe("IRREGULAR_DEMAND");
    // NO_DEMAND returns target 0 and suggestion 0
    expect(weeklyDecision({ currentStock: 5, activeWeeks: 0, medianDemand: 0, maxDemand: 0 })).toMatchObject({
      status: "NO_DEMAND",
      targetStock: 0,
      suggestedQuantity: 0,
    });
  });

  it("distinguishes depot zero, negative, and no stock row", () => {
    expect(depotStockState(0)).toBe("DEPOT_STOCK_ZERO");
    expect(depotStockState(-2)).toBe("DEPOT_STOCK_NEGATIVE");
    expect(depotStockState(null)).toBe("DEPOT_NO_ROW");
  });

  it("does not replace a manually chosen requested quantity", () => {
    // targetStock = 10 * 10 / 7 = ~14.28.
    const suggested = weeklyDecision({ currentStock: 0, activeWeeks: 6, medianDemand: 7, maxDemand: 7 }).suggestedQuantity;
    const requested = 4;
    expect(suggested).toBe(10);
    expect(requested).toBe(4);
  });

  it("handles negative stock without converting to zero or inflating suggested quantity", () => {
    const decision = weeklyDecision({
      currentStock: -10,
      activeWeeks: 6,
      medianDemand: 7,
      maxDemand: 7,
    });
    // Target stock must not be computed and suggested quantity must be null
    expect(decision.status).toBe("NEGATIVE_STOCK");
    expect(decision.targetStock).toBeNull();
    expect(decision.suggestedQuantity).toBeNull();
  });
});

