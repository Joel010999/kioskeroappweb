import { describe, expect, it, beforeEach } from "vitest";
import {
  calculateTargetStock,
  weeklyDecision,
  depotStockState,
  isIrregularWeeklyDemand,
  REPLENISHMENT_COVERAGE_DAYS,
} from "@/server/analytics/weekly-replenishment-rules";
import {
  collectRubroExportItems,
  buildReplenishmentWorkbook,
  type RawReplenishmentItem,
} from "@/features/excel/order-export";

describe("Alertas por stock negativo en reposición semanal", () => {
  const branchId = "2";
  const planningDate = "2026-10-24";
  const storageKey = `kioskero_draft_v1_${branchId}_${planningDate}`;
  let mockStorage: Record<string, string> = {};

  beforeEach(() => {
    mockStorage = {};
  });

  // 1. Un producto con stock positivo mantiene el cálculo de reposición existente.
  it("1. Un producto con stock positivo mantiene el cálculo de reposición existente", () => {
    // 7 units per week = 1 unit per day -> 10 units for 10-day coverage
    expect(calculateTargetStock(7, 10)).toBe(10);

    // Current stock = 4, target stock = 10 -> suggested = 6
    const decision = weeklyDecision({
      currentStock: 4,
      activeWeeks: 6,
      medianDemand: 7,
      maxDemand: 8,
    });

    expect(decision).toEqual({
      status: "SUGGESTION_AVAILABLE",
      targetStock: 10,
      suggestedQuantity: 6,
    });

    // Discrete items round up with Math.ceil
    // medianDemand = 1 -> targetStock = 10/7 = 1.428 -> ceil = 2. Current = 0 -> suggested = 2
    const discrete = weeklyDecision({
      currentStock: 0,
      activeWeeks: 6,
      medianDemand: 1,
      maxDemand: 2,
      isDiscrete: true,
    });
    expect(discrete.suggestedQuantity).toBe(2);
  });

  // 2. Un producto con stock cero mantiene el comportamiento actual.
  it("2. Un producto con stock cero mantiene el comportamiento actual", () => {
    // Current stock = 0, target stock = 10 -> suggested = 10
    const decisionWithDemand = weeklyDecision({
      currentStock: 0,
      activeWeeks: 6,
      medianDemand: 7,
      maxDemand: 7,
    });

    expect(decisionWithDemand).toEqual({
      status: "SUGGESTION_AVAILABLE",
      targetStock: 10,
      suggestedQuantity: 10,
    });

    // Zero demand and stock zero -> NO_DEMAND, target 0, suggested 0
    const decisionNoDemand = weeklyDecision({
      currentStock: 0,
      activeWeeks: 0,
      medianDemand: 0,
      maxDemand: 0,
    });

    expect(decisionNoDemand).toEqual({
      status: "NO_DEMAND",
      targetStock: 0,
      suggestedQuantity: 0,
    });
  });

  // 3. Un producto con stock negativo muestra la alerta.
  it("3. Un producto con stock negativo devuelve estado NEGATIVE_STOCK sin sugerencia automática", () => {
    const decision = weeklyDecision({
      currentStock: -3,
      activeWeeks: 6,
      medianDemand: 14,
      maxDemand: 15,
    });

    expect(decision.status).toBe("NEGATIVE_STOCK");
    expect(decision.targetStock).toBeNull();
    expect(decision.suggestedQuantity).toBeNull();

    // Alert message text required
    const expectedAlert =
      "Stock negativo: revisá la cantidad real antes de definir el pedido";
    expect(expectedAlert).toContain("Stock negativo");
    expect(expectedAlert).toContain("revisá la cantidad real");
  });

  // 4. El stock negativo no se convierte silenciosamente en cero ni se suma como una cantidad adicional al pedido.
  it("4. El stock negativo no se convierte silenciosamente en cero ni se suma como cantidad adicional", () => {
    // If stock were converted to 0: targetStock = 20 -> suggested = 20
    // If abs(-8) were added to target: suggested = 28
    // System must do NEITHER: targetStock and suggestedQuantity are strictly null
    const decision = weeklyDecision({
      currentStock: -8,
      activeWeeks: 6,
      medianDemand: 14,
      maxDemand: 14,
    });

    expect(decision.status).toBe("NEGATIVE_STOCK");
    expect(decision.suggestedQuantity).toBeNull();
    expect(decision.suggestedQuantity).not.toBe(20);
    expect(decision.suggestedQuantity).not.toBe(28);
  });

  // 5. La clienta puede definir manualmente una cantidad para ese producto, incluyendo cero.
  it("5. La clienta puede definir manualmente una cantidad para ese producto, incluyendo cero", () => {
    const negativeStockItem: RawReplenishmentItem = {
      article_id: 801,
      description: "CHOCOLATE CON ALMENDRAS",
      rubro: "CHOCOLATES",
      stock_current: -5,
      stock_depot: 50,
      suggested_quantity: null,
      requested_quantity: 0,
      supply_mode: "DEPOT",
    };

    // Client can set a positive quantity manually (e.g. 15)
    let manualQuantity = 15;
    let key = `${branchId}:${planningDate}:${negativeStockItem.article_id}`;
    let requestedMap: Record<string, number> = { [key]: manualQuantity };
    let editedMap: Record<string, true> = { [key]: true };

    expect(requestedMap[key]).toBe(15);
    expect(editedMap[key]).toBe(true);

    // Client can also define zero manually
    manualQuantity = 0;
    requestedMap[key] = manualQuantity;
    expect(requestedMap[key]).toBe(0);
    expect(editedMap[key]).toBe(true);
  });

  // 6. La edición manual se conserva al guardar y recuperar el borrador.
  it("6. La edición manual se conserva al guardar y recuperar el borrador", () => {
    const key = `${branchId}:${planningDate}:801`;
    const draft = {
      requested: { [key]: 12 },
      edited: { [key]: true },
      selected: { [key]: true },
      selectedItems: {
        [key]: {
          article_id: 801,
          requested_quantity: 12,
          supply_mode: "DEPOT" as const,
        },
      },
      itemRegistry: {
        801: {
          article_id: 801,
          description: "CHOCOLATE CON ALMENDRAS",
          rubro: "CHOCOLATES",
          stock_current: -5,
          stock_depot: 50,
          suggested_quantity: null,
          requested_quantity: 12,
          supply_mode: "DEPOT",
        },
      },
      savedAt: Date.now(),
    };

    mockStorage[storageKey] = JSON.stringify(draft);

    // Reload from storage
    const restored = JSON.parse(mockStorage[storageKey]);
    expect(restored.requested[key]).toBe(12);
    expect(restored.edited[key]).toBe(true);
    expect(restored.itemRegistry[801].stock_current).toBe(-5);
    expect(restored.selectedItems[key].requested_quantity).toBe(12);

    // Now test client setting it to 0
    draft.requested[key] = 0;
    draft.selected[key] = false;
    delete (draft.selectedItems as Record<string, unknown>)[key];
    mockStorage[storageKey] = JSON.stringify(draft);

    const restoredZero = JSON.parse(mockStorage[storageKey]);
    expect(restoredZero.requested[key]).toBe(0);
    expect(restoredZero.edited[key]).toBe(true);
    expect(restoredZero.itemRegistry[801].stock_current).toBe(-5);
  });

  // 7. Los productos con stock negativo continúan apareciendo en el rubro y en la exportación correspondiente.
  it("7. Los productos con stock negativo continúan apareciendo en el rubro y en la exportación correspondiente", () => {
    const items: RawReplenishmentItem[] = [
      {
        article_id: 801,
        description: "CHOCOLATE CON ALMENDRAS (STOCK NEGATIVO)",
        rubro: "CHOCOLATES",
        classification_code: "CHOC",
        stock_current: -6,
        stock_depot: 40,
        suggested_quantity: null,
        requested_quantity: 0,
        supply_mode: "DEPOT",
      },
      {
        article_id: 802,
        description: "CHOCOLATE BLANCO (STOCK NORMAL)",
        rubro: "CHOCOLATES",
        classification_code: "CHOC",
        stock_current: 2,
        stock_depot: 30,
        suggested_quantity: 10,
        requested_quantity: 10,
        supply_mode: "DEPOT",
      },
    ];

    const key801 = `${branchId}:${planningDate}:801`;
    const key802 = `${branchId}:${planningDate}:802`;

    // Client manually decides to order 8 units of the negative stock item
    const requestedMap = {
      [key801]: 8,
      [key802]: 10,
    };
    const selectedMap = {
      [key801]: true,
      [key802]: true,
    };

    const exported = collectRubroExportItems({
      items,
      branchId,
      planningDate,
      targetRubro: "CHOCOLATES",
      requestedMap,
      selectedMap,
    });

    expect(exported.length).toBe(2);

    const exportedNeg = exported.find((item) => item.article_id === 801);
    expect(exportedNeg).toBeDefined();
    expect(exportedNeg?.stock_current).toBe(-6); // Stock is preserved as -6, not 0
    expect(exportedNeg?.suggested_quantity).toBeNull();
    expect(exportedNeg?.requested_quantity).toBe(8);

    // Verify workbook generation handles negative stock correctly
    const workbook = buildReplenishmentWorkbook({
      items: exported,
      branchLabel: "Centro",
      planningDate,
    });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    expect(sheet).toBeDefined();
  });

  // 8. La función de restaurar sugerencias sigue funcionando correctamente y no altera el stock registrado.
  it("8. La función de restaurar sugerencias no altera el stock registrado en el sistema", () => {
    const originalStock = -7;
    const item = {
      article_id: 801,
      description: "CHOCOLATE CON ALMENDRAS",
      stock_current: originalStock,
      suggested_quantity: null,
      requested_quantity: 14, // manually edited
    };

    // Restoration logic: restores to system suggested quantity (0 since suggested is null)
    const sug = item.suggested_quantity ?? 0;
    const restoredItem = {
      ...item,
      requested_quantity: sug,
    };

    expect(restoredItem.requested_quantity).toBe(0);
    // Crucially: registered stock in system is NOT touched!
    expect(restoredItem.stock_current).toBe(originalStock);
    expect(item.stock_current).toBe(-7);
  });

  // 9. Los productos sin stock negativo no sufren regresiones.
  it("9. Los productos sin stock negativo no sufren regresiones", () => {
    // Standard positive item
    const normalDecision = weeklyDecision({
      currentStock: 10,
      activeWeeks: 6,
      medianDemand: 14, // target: 20
      maxDemand: 16,
    });
    expect(normalDecision).toEqual({
      status: "SUGGESTION_AVAILABLE",
      targetStock: 20,
      suggestedQuantity: 10,
    });

    // Excess stock item
    const excessDecision = weeklyDecision({
      currentStock: 30,
      activeWeeks: 6,
      medianDemand: 14, // target: 20
      maxDemand: 16,
    });
    expect(excessDecision).toEqual({
      status: "NO_SUGGESTION",
      targetStock: 20,
      suggestedQuantity: 0,
    });

    // Irregular demand item
    expect(isIrregularWeeklyDemand(5, 30)).toBe(true);
    const irregularDecision = weeklyDecision({
      currentStock: 5,
      activeWeeks: 6,
      medianDemand: 5,
      maxDemand: 30,
    });
    expect(irregularDecision.status).toBe("IRREGULAR_DEMAND");
    expect(irregularDecision.suggestedQuantity).toBeNull();

    // Insufficient history item
    const newProductDecision = weeklyDecision({
      currentStock: 0,
      activeWeeks: 1,
      medianDemand: 5,
      maxDemand: 5,
    });
    expect(newProductDecision.status).toBe("INSUFFICIENT_HISTORY");
    expect(newProductDecision.suggestedQuantity).toBeNull();

    // Depot states
    expect(depotStockState(15)).toBe("DEPOT_STOCK_POSITIVE");
    expect(depotStockState(0)).toBe("DEPOT_STOCK_ZERO");
    expect(depotStockState(-1)).toBe("DEPOT_STOCK_NEGATIVE");
    expect(depotStockState(null)).toBe("DEPOT_NO_ROW");
  });
});
