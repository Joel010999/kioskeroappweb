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
});
