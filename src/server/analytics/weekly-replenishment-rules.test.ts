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

  it("integrates stock base using max(demandTarget, baseStock) without double counting", () => {
    // Low velocity product: 2 units/week -> 10d demand = 2.86, baseStock = 12 -> target = 12
    const slowSeller = weeklyDecision({
      currentStock: 3,
      activeWeeks: 6,
      medianDemand: 2,
      maxDemand: 3,
      isDiscrete: true,
      baseStock: 12,
    });
    expect(slowSeller).toEqual({
      status: "SUGGESTION_AVAILABLE",
      targetStock: 12,
      suggestedQuantity: 9,
    });

    // High velocity product: 21 units/week -> 10d demand = 30, baseStock = 12 -> demand wins (30)
    const fastSeller = weeklyDecision({
      currentStock: 5,
      activeWeeks: 6,
      medianDemand: 21,
      maxDemand: 24,
      isDiscrete: true,
      baseStock: 12,
    });
    expect(fastSeller).toEqual({
      status: "SUGGESTION_AVAILABLE",
      targetStock: 30,
      suggestedQuantity: 25,
    });

    // Los pedidos internos pendientes NO modifican ni reducen la cantidad sugerida
    const withPendingOrder = weeklyDecision({
      currentStock: 3,
      activeWeeks: 6,
      medianDemand: 2,
      maxDemand: 3,
      isDiscrete: true,
      baseStock: 12,
      pendingOrderQuantity: 4,
    });
    // stockTarget = max(demandTarget (3), baseStock (12)) = 12
    // available = max(0, currentStock (3)) = 3
    // suggested = max(0, 12 - 3) = 9 (los 4 pendientes NO se descuentan)
    expect(withPendingOrder).toEqual({
      status: "SUGGESTION_AVAILABLE",
      targetStock: 12,
      suggestedQuantity: 9,
    });

    // Sin pedidos pendientes, la sugerencia es exactamente idéntica (9)
    const withoutPendingOrder = weeklyDecision({
      currentStock: 3,
      activeWeeks: 6,
      medianDemand: 2,
      maxDemand: 3,
      isDiscrete: true,
      baseStock: 12,
      pendingOrderQuantity: 0,
    });
    expect(withoutPendingOrder.suggestedQuantity).toBe(9);
  });

  it("applies baseStock to new products with zero or <3 active weeks while holding negative stock", () => {
    const newProductWithBase = weeklyDecision({
      currentStock: 2,
      activeWeeks: 0,
      medianDemand: 0,
      maxDemand: 0,
      isDiscrete: true,
      baseStock: 10,
    });
    expect(newProductWithBase).toEqual({
      status: "SUGGESTION_AVAILABLE",
      targetStock: 10,
      suggestedQuantity: 8,
    });

    const explicitZeroBaseNoSales = weeklyDecision({
      currentStock: 5,
      activeWeeks: 0,
      medianDemand: 0,
      maxDemand: 0,
      isDiscrete: true,
      baseStock: 0,
    });
    expect(explicitZeroBaseNoSales).toEqual({
      status: "NO_DEMAND",
      targetStock: 0,
      suggestedQuantity: 0,
    });

    const negativeEvenWithBase = weeklyDecision({
      currentStock: -3,
      activeWeeks: 6,
      medianDemand: 2,
      maxDemand: 3,
      isDiscrete: true,
      baseStock: 12,
    });
    expect(negativeEvenWithBase).toEqual({
      status: "NEGATIVE_STOCK",
      targetStock: null,
      suggestedQuantity: null,
    });
  });

  describe("Nueva lógica de reposición: Exclusión total de pedidos pendientes", () => {
    it("garantiza que pedidos internos pendientes (solicitados, preparados, en tránsito) no alteren la sugerencia", () => {
      // Demanda = 7 u/sem -> 10d demand = 10
      // Base stock = 15
      // stockTarget = max(10, 15) = 15
      // currentBranchStock = 5 -> available = max(0, 5) = 5
      // suggested = max(0, 15 - 5) = 10
      const baseline = weeklyDecision({
        currentStock: 5,
        activeWeeks: 4,
        medianDemand: 7,
        maxDemand: 8,
        isDiscrete: true,
        baseStock: 15,
        pendingOrderQuantity: 0,
      });
      expect(baseline.suggestedQuantity).toBe(10);
      expect(baseline.targetStock).toBe(15);
      expect(baseline.status).toBe("SUGGESTION_AVAILABLE");

      // Con 3 unidades pendientes en pedido interno
      const with3Pending = weeklyDecision({
        currentStock: 5,
        activeWeeks: 4,
        medianDemand: 7,
        maxDemand: 8,
        isDiscrete: true,
        baseStock: 15,
        pendingOrderQuantity: 3,
      });
      expect(with3Pending.suggestedQuantity).toBe(10);
      expect(with3Pending.targetStock).toBe(15);

      // Con 20 unidades pendientes en pedido interno (mayor al stock objetivo)
      const with20Pending = weeklyDecision({
        currentStock: 5,
        activeWeeks: 4,
        medianDemand: 7,
        maxDemand: 8,
        isDiscrete: true,
        baseStock: 15,
        pendingOrderQuantity: 20,
      });
      expect(with20Pending.suggestedQuantity).toBe(10);
      expect(with20Pending.targetStock).toBe(15);
    });

    it("utiliza exclusivamente el stock actual de la sucursal: suggested = max(0, stockTarget - available)", () => {
      // Sin base stock, guiado por demanda estimada
      // Demanda = 14 u/sem -> 10d demand = 20
      // currentStock = 8 -> available = 8 -> suggested = 20 - 8 = 12
      const res = weeklyDecision({
        currentStock: 8,
        activeWeeks: 5,
        medianDemand: 14,
        maxDemand: 15,
        isDiscrete: true,
        pendingOrderQuantity: 5, // debe ignorarse
      });
      expect(res.targetStock).toBe(20);
      expect(res.suggestedQuantity).toBe(12);
      expect(res.status).toBe("SUGGESTION_AVAILABLE");

      // Si stock actual >= stockTarget, sugerencia es 0
      const satisfiedStock = weeklyDecision({
        currentStock: 25,
        activeWeeks: 5,
        medianDemand: 14,
        maxDemand: 15,
        isDiscrete: true,
        pendingOrderQuantity: 10,
      });
      expect(satisfiedStock.targetStock).toBe(20);
      expect(satisfiedStock.suggestedQuantity).toBe(0);
      expect(satisfiedStock.status).toBe("NO_SUGGESTION");
    });

    it("mantiene el stock base funcionando correctamente y toma el máximo entre demanda y stock base", () => {
      // Caso 1: baseStock gana sobre demanda
      // demanda = 7 (10d demand = 10), baseStock = 25 -> stockTarget = 25
      const baseWins = weeklyDecision({
        currentStock: 10,
        activeWeeks: 4,
        medianDemand: 7,
        maxDemand: 8,
        isDiscrete: true,
        baseStock: 25,
      });
      expect(baseWins.targetStock).toBe(25);
      expect(baseWins.suggestedQuantity).toBe(15);

      // Caso 2: demanda estimada gana sobre baseStock
      // demanda = 28 (10d demand = 40), baseStock = 25 -> stockTarget = 40
      const demandWins = weeklyDecision({
        currentStock: 10,
        activeWeeks: 4,
        medianDemand: 28,
        maxDemand: 30,
        isDiscrete: true,
        baseStock: 25,
      });
      expect(demandWins.targetStock).toBe(40);
      expect(demandWins.suggestedQuantity).toBe(30);
    });

    it("preserva la clasificación de stock negativo sin emitir sugerencias", () => {
      const negative = weeklyDecision({
        currentStock: -5,
        activeWeeks: 4,
        medianDemand: 14,
        maxDemand: 15,
        isDiscrete: true,
        baseStock: 20,
        pendingOrderQuantity: 15,
      });
      expect(negative).toEqual({
        status: "NEGATIVE_STOCK",
        targetStock: null,
        suggestedQuantity: null,
      });
    });

    it("preserva la detección de demanda irregular independientemente de pedidos pendientes", () => {
      // activeWeeks >= 3, maxDemand (30) - median (5) >= 20 y max >= median * 3 (30 >= 15) -> IRREGULAR_DEMAND
      // Si currentStock >= baseStock (5 >= 5) -> IRREGULAR_DEMAND
      const irregularWithSufficientStock = weeklyDecision({
        currentStock: 5,
        activeWeeks: 4,
        medianDemand: 5,
        maxDemand: 30,
        isDiscrete: true,
        baseStock: 5,
        pendingOrderQuantity: 10,
      });
      expect(irregularWithSufficientStock.status).toBe("IRREGULAR_DEMAND");
      expect(irregularWithSufficientStock.suggestedQuantity).toBeNull();
    });
  });
});

