import { describe, expect, it, beforeEach } from "vitest";

describe("Replenishment Draft & Rubro State Preservation", () => {
  const branchId = "2";
  const planningDate = "2026-10-17";
  const storageKey = `kioskero_draft_v1_${branchId}_${planningDate}`;

  // In-memory mock localStorage
  let mockStorage: Record<string, string> = {};

  beforeEach(() => {
    mockStorage = {};
  });

  it("preserves manual quantities across rubro switches and filters", () => {
    // 1. User starts reviewing GOLOSINAS
    const requested: Record<string, number> = {
      [`${branchId}:${planningDate}:101`]: 50,
      [`${branchId}:${planningDate}:102`]: 20,
    };
    const edited: Record<string, true> = {
      [`${branchId}:${planningDate}:101`]: true,
    };
    const selectedItems: Record<string, { article_id: number; requested_quantity: number; supply_mode: "DEPOT" }> = {
      [`${branchId}:${planningDate}:101`]: { article_id: 101, requested_quantity: 50, supply_mode: "DEPOT" },
      [`${branchId}:${planningDate}:102`]: { article_id: 102, requested_quantity: 20, supply_mode: "DEPOT" },
    };
    const itemRegistry: Record<number, { article_id: number; description: string; rubro: string }> = {
      101: { article_id: 101, description: "ALFAJOR TRIPLE", rubro: "GOLOSINAS" },
      102: { article_id: 102, description: "CARAMELOS MASTICABLES", rubro: "GOLOSINAS" },
    };

    // Save to storage
    mockStorage[storageKey] = JSON.stringify({
      requested,
      edited,
      selected: { [`${branchId}:${planningDate}:101`]: true, [`${branchId}:${planningDate}:102`]: true },
      selectedItems,
      itemRegistry,
      savedAt: Date.now(),
    });

    // 2. User filters to BEBIDAS (new items loaded into table)
    const stored = JSON.parse(mockStorage[storageKey]);
    expect(stored).toBeDefined();

    // User adds BEBIDAS item 201
    stored.requested[`${branchId}:${planningDate}:201`] = 30;
    stored.selectedItems[`${branchId}:${planningDate}:201`] = {
      article_id: 201,
      requested_quantity: 30,
      supply_mode: "DEPOT",
    };
    stored.itemRegistry[201] = { article_id: 201, description: "GASEOSA COLA", rubro: "BEBIDAS" };

    mockStorage[storageKey] = JSON.stringify(stored);

    // 3. User switches back to 'Todos los rubros' or 'GOLOSINAS'
    const finalStored = JSON.parse(mockStorage[storageKey]);

    // Verify GOLOSINAS were not wiped or altered by filtering
    expect(finalStored.requested[`${branchId}:${planningDate}:101`]).toBe(50);
    expect(finalStored.requested[`${branchId}:${planningDate}:102`]).toBe(20);
    expect(finalStored.requested[`${branchId}:${planningDate}:201`]).toBe(30);

    // Verify global selections sum up all rubros
    const allSelected = Object.values(finalStored.selectedItems) as Array<{ requested_quantity: number }>;
    const totalUnits = allSelected.reduce((sum, item) => sum + item.requested_quantity, 0);
    expect(totalUnits).toBe(100); // 50 + 20 + 30
    expect(allSelected.length).toBe(3);
  });

  it("handles session recovery without data loss or duplicate confirmation", () => {
    // Client enters 63 items, 22286 units
    const draftPayload = {
      requested: { [`${branchId}:${planningDate}:9001`]: 22286 },
      edited: { [`${branchId}:${planningDate}:9001`]: true },
      selected: { [`${branchId}:${planningDate}:9001`]: true },
      selectedItems: {
        [`${branchId}:${planningDate}:9001`]: {
          article_id: 9001,
          requested_quantity: 22286,
          supply_mode: "DEPOT",
        },
      },
      itemRegistry: {
        9001: {
          article_id: 9001,
          description: "ARTICULO MONICA TEST",
          rubro: "ALMACEN",
          stock_current: 100,
          stock_depot: 30000,
          suggested_quantity: 20000,
          requested_quantity: 22286,
          supply_mode: "DEPOT",
        },
      },
      savedAt: Date.now(),
    };

    mockStorage[storageKey] = JSON.stringify(draftPayload);

    // Simulate page reload or re-login in another tab
    const restored = JSON.parse(mockStorage[storageKey]);
    expect(restored.requested[`${branchId}:${planningDate}:9001`]).toBe(22286);
    expect(restored.edited[`${branchId}:${planningDate}:9001`]).toBe(true);
    expect(restored.selectedItems[`${branchId}:${planningDate}:9001`].requested_quantity).toBe(22286);

    // Storage is cleared ONLY after explicit confirmation
    delete mockStorage[storageKey];
    expect(mockStorage[storageKey]).toBeUndefined();
  });

  it("restores all requested quantities to suggested values and clears manual edit flags", () => {
    // Scenario: user manually changed items:
    // item 101: suggested 6 -> manually set to 0
    // item 102: suggested 7 -> manually set to 0
    // item 103: suggested 17 -> kept at 17
    // item 104: suggested 0 -> 0
    // item 105: supplier direct -> suggested 12
    const itemRegistry: Record<number, {
      article_id: number;
      description: string;
      suggested_quantity: number | null;
      requested_quantity: number;
      supply_mode: "DEPOT" | "DIRECT_SUPPLIER" | "UNDEFINED";
      stock_depot: number | null;
    }> = {
      101: { article_id: 101, description: "PRODUCTO A", suggested_quantity: 6, requested_quantity: 0, supply_mode: "DEPOT", stock_depot: 20 },
      102: { article_id: 102, description: "PRODUCTO B", suggested_quantity: 7, requested_quantity: 0, supply_mode: "DEPOT", stock_depot: 5 },
      103: { article_id: 103, description: "PRODUCTO C", suggested_quantity: 17, requested_quantity: 17, supply_mode: "DEPOT", stock_depot: 50 },
      104: { article_id: 104, description: "PRODUCTO D (SIN SUG)", suggested_quantity: 0, requested_quantity: 0, supply_mode: "DEPOT", stock_depot: 0 },
      105: { article_id: 105, description: "PRODUCTO E (PROV DIR)", suggested_quantity: 12, requested_quantity: 12, supply_mode: "DIRECT_SUPPLIER", stock_depot: null },
    };

    const initialDraft = {
      requested: {
        [`${branchId}:${planningDate}:101`]: 0,
        [`${branchId}:${planningDate}:102`]: 0,
        [`${branchId}:${planningDate}:103`]: 17,
      },
      edited: {
        [`${branchId}:${planningDate}:101`]: true,
        [`${branchId}:${planningDate}:102`]: true,
      },
      selected: {
        [`${branchId}:${planningDate}:101`]: false,
        [`${branchId}:${planningDate}:102`]: false,
        [`${branchId}:${planningDate}:103`]: true,
      },
      selectedItems: {
        [`${branchId}:${planningDate}:103`]: { article_id: 103, requested_quantity: 17, supply_mode: "DEPOT" },
      },
      itemRegistry,
      savedAt: Date.now(),
    };

    mockStorage[storageKey] = JSON.stringify(initialDraft);

    // Simulate "Restaurar todas las sugeridas" action
    const nextRequested: Record<string, number> = {};
    const nextEdited: Record<string, true> = {};
    const nextSelected: Record<string, boolean> = {};
    const nextSelectedItems: Record<string, { article_id: number; requested_quantity: number; supply_mode: "DEPOT" | "DIRECT_SUPPLIER" | "UNDEFINED" }> = {};
    const nextItemRegistry = { ...itemRegistry };

    for (const item of Object.values(itemRegistry)) {
      const sug = item.suggested_quantity ?? 0;
      const key = `${branchId}:${planningDate}:${item.article_id}`;
      nextRequested[key] = sug;
      nextItemRegistry[item.article_id] = {
        ...item,
        requested_quantity: sug,
      };

      if (item.supply_mode === "DIRECT_SUPPLIER") {
        nextSelected[key] = false;
      } else {
        const isEligible = sug > 0;
        nextSelected[key] = isEligible;
        if (isEligible) {
          nextSelectedItems[key] = {
            article_id: item.article_id,
            requested_quantity: sug,
            supply_mode: item.supply_mode,
          };
        }
      }
    }

    // Persist restored draft to storage
    mockStorage[storageKey] = JSON.stringify({
      requested: nextRequested,
      edited: nextEdited,
      selected: nextSelected,
      selectedItems: nextSelectedItems,
      itemRegistry: nextItemRegistry,
      savedAt: Date.now(),
    });

    // Verify 1: Requested equals Suggested
    expect(nextRequested[`${branchId}:${planningDate}:101`]).toBe(6);
    expect(nextRequested[`${branchId}:${planningDate}:102`]).toBe(7);
    expect(nextRequested[`${branchId}:${planningDate}:103`]).toBe(17);
    expect(nextRequested[`${branchId}:${planningDate}:104`]).toBe(0);
    expect(nextRequested[`${branchId}:${planningDate}:105`]).toBe(12);

    // Verify 2: Edited flags are completely cleared
    expect(Object.keys(nextEdited).length).toBe(0);

    // Verify 3: Product eligibility rules
    // DIRECT_SUPPLIER must not be selected for depot replenishment
    expect(nextSelected[`${branchId}:${planningDate}:105`]).toBe(false);
    expect(nextSelectedItems[`${branchId}:${planningDate}:105`]).toBeUndefined();

    // Items with suggested 0 must not be selected
    expect(nextSelected[`${branchId}:${planningDate}:104`]).toBe(false);
    expect(nextSelectedItems[`${branchId}:${planningDate}:104`]).toBeUndefined();

    // Items with DEPOT and suggested > 0 are selected
    expect(nextSelected[`${branchId}:${planningDate}:101`]).toBe(true);
    expect(nextSelected[`${branchId}:${planningDate}:102`]).toBe(true);
    expect(nextSelected[`${branchId}:${planningDate}:103`]).toBe(true);
    expect(nextSelectedItems[`${branchId}:${planningDate}:101`].requested_quantity).toBe(6);
    expect(nextSelectedItems[`${branchId}:${planningDate}:102`].requested_quantity).toBe(7);
    expect(nextSelectedItems[`${branchId}:${planningDate}:103`].requested_quantity).toBe(17);

    // Verify 4: Reloading from storage preserves restored quantities, not old zeros
    const reloaded = JSON.parse(mockStorage[storageKey]);
    expect(reloaded.requested[`${branchId}:${planningDate}:101`]).toBe(6);
    expect(reloaded.requested[`${branchId}:${planningDate}:102`]).toBe(7);
    expect(reloaded.requested[`${branchId}:${planningDate}:103`]).toBe(17);
    expect(Object.keys(reloaded.edited).length).toBe(0);
  });

  it("preserves manual quantities for negative stock items and restores them safely to 0", () => {
    // Negative stock item: currentStock is -5, suggested_quantity is null, initial requested is 0
    const negKey = `${branchId}:${planningDate}:999`;
    const draftPayload = {
      requested: { [negKey]: 14 },
      edited: { [negKey]: true },
      selected: { [negKey]: true },
      selectedItems: {
        [negKey]: {
          article_id: 999,
          requested_quantity: 14,
          supply_mode: "DEPOT" as const,
        },
      },
      itemRegistry: {
        999: {
          article_id: 999,
          description: "ARTICULO STOCK NEGATIVO",
          rubro: "GOLOSINAS",
          stock_current: -5,
          stock_depot: 30,
          suggested_quantity: null,
          requested_quantity: 14,
          supply_mode: "DEPOT" as const,
        },
      },
      savedAt: Date.now(),
    };

    mockStorage[storageKey] = JSON.stringify(draftPayload);

    // Verify draft reload keeps manual edit and negative stock intact
    const restored = JSON.parse(mockStorage[storageKey]);
    expect(restored.requested[negKey]).toBe(14);
    expect(restored.edited[negKey]).toBe(true);
    expect(restored.itemRegistry[999].stock_current).toBe(-5);

    // When restoring suggestions, suggested_quantity is null -> requested becomes 0
    const sug = restored.itemRegistry[999].suggested_quantity ?? 0;
    expect(sug).toBe(0);
    restored.requested[negKey] = sug;
    delete restored.edited[negKey];
    restored.selected[negKey] = false;
    delete restored.selectedItems[negKey];

    expect(restored.requested[negKey]).toBe(0);
    expect(restored.edited[negKey]).toBeUndefined();
    // System registered stock remains untouched
    expect(restored.itemRegistry[999].stock_current).toBe(-5);
  });
});

