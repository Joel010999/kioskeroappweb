import { beforeEach, describe, expect, it, vi } from "vitest";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("@/server/db/client", () => ({ query }));

import { listSupplyRules, updateSupplyRule } from "./rules-repository";

const scope = {
  organizationId: 1,
  sourceId: "pv1-source",
  branchId: 2,
};

describe("supply rules repository", () => {
  beforeEach(() => {
    query.mockReset();
  });

  it("returns a candidate without changing its human rule", async () => {
    query
      .mockResolvedValueOnce({
        rows: [{
          article_id: 9043,
          description: "Producto",
          brand: "Marca",
          supply_mode: "UNDEFINED",
          historical_documents: "12",
          depot_stock: "0",
          reviewed: false,
          total_rows: "1",
        }],
      })
      .mockResolvedValueOnce({ rows: [{ supply_mode: "UNDEFINED", count: "1" }] })
      .mockResolvedValueOnce({
        rows: [{ evidence: "POSSIBLE_DIRECT_SUPPLIER", count: "1" }],
      });

    const result = await listSupplyRules(
      scope,
      { limit: 25, offset: 0 },
      "depot-source",
    );

    expect(result.rows[0]).toMatchObject({
      supply_mode: "UNDEFINED",
      evidence: "POSSIBLE_DIRECT_SUPPLIER",
      historical_documents: 12,
    });
    expect(String(query.mock.calls[0][0])).not.toContain("UPDATE");
  });

  it.each(["DEPOT", "DIRECT_SUPPLIER", "UNDEFINED"] as const)(
    "persists the explicit %s decision for the authorized branch",
    async (supplyMode) => {
      query
        .mockResolvedValueOnce({ rows: [{ article_id: 9043 }] })
        .mockResolvedValueOnce({ rows: [{ supply_mode: supplyMode }] });

      await expect(updateSupplyRule(scope, 9043, supplyMode)).resolves.toEqual({
        article_id: 9043,
        supply_mode: supplyMode,
      });
      expect(query.mock.calls[1][1]).toEqual([1, 2, 9043, supplyMode]);
    },
  );
});
