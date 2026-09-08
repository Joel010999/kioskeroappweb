import { beforeEach, describe, expect, it, vi } from "vitest";

const { getWeeklyReplenishment, withTransaction } = vi.hoisted(() => ({
  getWeeklyReplenishment: vi.fn(),
  withTransaction: vi.fn(),
}));

vi.mock("@/server/analytics/weekly-replenishment", () => ({
  DEPOT_BRANCH_ID: 1,
  getWeeklyReplenishment,
}));
vi.mock("@/server/db/client", () => ({ withTransaction }));

import { confirmInternalReplenishment } from "./internal-replenishment";

describe("internal replenishment idempotency", () => {
  beforeEach(() => {
    getWeeklyReplenishment.mockReset();
    withTransaction.mockReset();
    getWeeklyReplenishment.mockResolvedValue({
      items: [
        {
          article_id: 341,
          description: "Producto de prueba",
          requested_quantity: 100,
          supply_mode: "DEPOT",
        },
      ],
    });
  });

  it("returns the existing active request for the same organization, PV, depot and date", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [{ article_id: 341, supply_mode: "DEPOT" }],
      })
      .mockResolvedValueOnce({ rows: [{ id: "8" }] });
    withTransaction.mockImplementation(async (callback) => callback({ query }));

    await expect(
      confirmInternalReplenishment({
        scope: { organizationId: 1, sourceId: "pv1", branchId: 2 },
        depotSourceId: "depot",
        planningDate: "2026-09-12",
        items: [{ article_id: 341, requested_quantity: 100 }],
        actorId: "101",
      }),
    ).resolves.toEqual({ id: 8, created: false });

    expect(String(query.mock.calls[1][0])).toContain(
      "destination_branch_id=$3",
    );
    expect(query.mock.calls[1][1]).toEqual([1, 2, 1, "2026-09-12"]);
    expect(query).toHaveBeenCalledTimes(2);
  });
});
