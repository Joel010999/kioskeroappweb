import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthorizationContext } from "@/server/auth/context";

const {
  createOrder,
  getAuthorizedContext,
  getAuthorizedScope,
  listBranchReplenishmentOrders,
  listOrders,
  listWarehouseOrders,
} = vi.hoisted(() => ({
  createOrder: vi.fn(),
  getAuthorizedContext: vi.fn(),
  getAuthorizedScope: vi.fn(),
  listBranchReplenishmentOrders: vi.fn(),
  listOrders: vi.fn(),
  listWarehouseOrders: vi.fn(),
}));

vi.mock("@/server/orders/repository", () => ({
  createOrder,
  listBranchReplenishmentOrders,
  listOrders,
  listWarehouseOrders,
}));
vi.mock("@/server/auth/scope", () => ({
  getAuthorizedContext,
  getAuthorizedScope,
}));
vi.mock("@/server/analytics/weekly-replenishment", () => ({
  DEPOT_BRANCH_ID: 1,
}));

import { GET } from "./route";

const pv1: AuthorizationContext = {
  userId: 101,
  organizationId: 1,
  userActive: true,
  memberships: [{ branchId: 2, role: "PV_OPERATOR", active: true }],
};
const pv2: AuthorizationContext = {
  userId: 102,
  organizationId: 1,
  userActive: true,
  memberships: [{ branchId: 3, role: "PV_OPERATOR", active: true }],
};

describe("GET /api/orders?pv=1", () => {
  beforeEach(() => {
    getAuthorizedContext.mockReset();
    getAuthorizedScope.mockReset();
    listBranchReplenishmentOrders.mockReset();
    listBranchReplenishmentOrders.mockResolvedValue({ total: 0, rows: [] });
  });

  it("uses PV1's session branch for its own weekly request", async () => {
    getAuthorizedContext.mockResolvedValue(pv1);

    const response = await GET(
      new Request(
        "http://localhost/api/orders?pv=1&active=1&planning_date=2026-09-12",
      ),
    );

    expect(response.status).toBe(200);
    expect(listBranchReplenishmentOrders).toHaveBeenCalledWith(
      { organizationId: 1, originBranchId: 2, destinationBranchId: 1 },
      expect.objectContaining({
        planningDate: "2026-09-12",
        activeOnly: true,
      }),
    );
  });

  it("uses PV2's session branch for its own weekly request", async () => {
    getAuthorizedContext.mockResolvedValue(pv2);

    const response = await GET(
      new Request(
        "http://localhost/api/orders?pv=1&planning_date=2026-09-12",
      ),
    );

    expect(response.status).toBe(200);
    expect(listBranchReplenishmentOrders).toHaveBeenCalledWith(
      { organizationId: 1, originBranchId: 3, destinationBranchId: 1 },
      expect.any(Object),
    );
  });

  it("rejects an origin branch injected through the query string", async () => {
    getAuthorizedContext.mockResolvedValue(pv1);

    const response = await GET(
      new Request(
        "http://localhost/api/orders?pv=1&origin_branch_id=3&planning_date=2026-09-12",
      ),
    );

    expect(response.status).toBe(403);
    expect(listBranchReplenishmentOrders).not.toHaveBeenCalled();
  });

  it("does not let branch_id or source_id change the session branch", async () => {
    getAuthorizedContext.mockResolvedValue(pv1);

    const response = await GET(
      new Request(
        "http://localhost/api/orders?pv=1&branch_id=3&source_id=pv2&planning_date=2026-09-12",
      ),
    );

    expect(response.status).toBe(200);
    expect(listBranchReplenishmentOrders).toHaveBeenCalledWith(
      { organizationId: 1, originBranchId: 2, destinationBranchId: 1 },
      expect.any(Object),
    );
  });
});
