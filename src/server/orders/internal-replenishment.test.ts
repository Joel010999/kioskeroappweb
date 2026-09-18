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
          description: "Producto A",
          requested_quantity: 100,
          supply_mode: "DEPOT",
        },
        {
          article_id: 342,
          description: "Producto B",
          requested_quantity: 50,
          supply_mode: "DEPOT",
        }
      ],
    });
  });

  const setupQuery = (existingStatus?: string | null) => {
    return vi.fn().mockImplementation(async (sql: string, params: any[]) => {
      if (sql.includes("branch_product_supply_rules")) {
        return {
          rows: [
            { article_id: 341, supply_mode: "DEPOT" },
            { article_id: 342, supply_mode: "DEPOT" }
          ]
        };
      }
      if (sql.includes("SELECT id FROM orders WHERE order_type='INTERNAL_REPLENISHMENT'")) {
        if (existingStatus && !["COMPLETED", "CANCELLED"].includes(existingStatus)) {
           return { rows: [{ id: "8" }] };
        }
        return { rows: [] };
      }
      if (sql.includes("INSERT INTO orders")) {
        return { rows: [{ id: "9" }] };
      }
      return { rows: [] };
    });
  };

  it("permite nueva solicitud si la existente está COMPLETED", async () => {
    const query = setupQuery("COMPLETED");
    withTransaction.mockImplementation(async (callback) => callback({ query }));

    await expect(
      confirmInternalReplenishment({
        scope: { organizationId: 1, sourceId: "pv1", branchId: 2 },
        depotSourceId: "depot",
        planningDate: "2026-09-12",
        items: [{ article_id: 341, requested_quantity: 100 }],
        actorId: "101",
      }),
    ).resolves.toEqual({ id: 9, created: true });
  });

  it("permite nueva solicitud si la existente está CANCELLED", async () => {
    const query = setupQuery("CANCELLED");
    withTransaction.mockImplementation(async (callback) => callback({ query }));

    await expect(
      confirmInternalReplenishment({
        scope: { organizationId: 1, sourceId: "pv1", branchId: 2 },
        depotSourceId: "depot",
        planningDate: "2026-09-12",
        items: [{ article_id: 341, requested_quantity: 100 }],
        actorId: "101",
      }),
    ).resolves.toEqual({ id: 9, created: true });
  });

  it("detecta existente si está en DRAFT", async () => {
    const query = setupQuery("DRAFT");
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
  });

  it("detecta existente si está CONFIRMED", async () => {
    const query = setupQuery("CONFIRMED");
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
  });

  it("detecta existente si está IN_PREPARATION", async () => {
    const query = setupQuery("IN_PREPARATION");
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
  });

  it("detecta existente si está DISPATCHED", async () => {
    const query = setupQuery("DISPATCHED");
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
  });

  it("dos artículos distintos pueden pertenecer a la misma solicitud abierta", async () => {
    const query = setupQuery(null);
    withTransaction.mockImplementation(async (callback) => callback({ query }));

    await expect(
      confirmInternalReplenishment({
        scope: { organizationId: 1, sourceId: "pv1", branchId: 2 },
        depotSourceId: "depot",
        planningDate: "2026-09-12",
        items: [
          { article_id: 341, requested_quantity: 100 },
          { article_id: 342, requested_quantity: 50 }
        ],
        actorId: "101",
      }),
    ).resolves.toEqual({ id: 9, created: true });

    const existingCheckCall = query.mock.calls.find(c => c[0].includes("SELECT id FROM orders WHERE order_type='INTERNAL_REPLENISHMENT'"));
    expect(existingCheckCall).toBeDefined();
    expect(existingCheckCall![0]).not.toContain("article_id");
  });

  it("aislamiento PV1/PV2 y por organization_id", async () => {
    const query = setupQuery(null);
    withTransaction.mockImplementation(async (callback) => callback({ query }));

    await confirmInternalReplenishment({
      scope: { organizationId: 99, sourceId: "pv2", branchId: 3 },
      depotSourceId: "depot",
      planningDate: "2026-09-12",
      items: [{ article_id: 341, requested_quantity: 100 }],
      actorId: "101",
    });

    const existingCheckCall = query.mock.calls.find(c => c[0].includes("SELECT id FROM orders WHERE order_type='INTERNAL_REPLENISHMENT'"));
    expect(existingCheckCall![1]).toEqual([99, 3, 1, "2026-09-12"]);
  });
});
