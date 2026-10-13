import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthorizationContext } from "@/server/auth/context";
import { UnauthenticatedError } from "@/server/auth/errors";

const { getAuthorizedScope, getSourceForBranch, getWeeklyReplenishment } =
  vi.hoisted(() => ({
    getAuthorizedScope: vi.fn(),
    getSourceForBranch: vi.fn(),
    getWeeklyReplenishment: vi.fn(),
  }));

vi.mock("@/server/auth/scope", () => ({ getAuthorizedScope }));
vi.mock("@/server/auth/sources", () => ({ getSourceForBranch }));
vi.mock("@/server/analytics/weekly-replenishment", () => ({
  DEPOT_BRANCH_ID: 1,
  getWeeklyReplenishment,
}));

import { GET } from "./route";

const context: AuthorizationContext = {
  userId: 101,
  organizationId: 1,
  userActive: true,
  memberships: [{ branchId: 2, role: "PV_OPERATOR", active: true }],
};

describe("GET /api/replenishment/weekly", () => {
  beforeEach(() => {
    getAuthorizedScope.mockReset();
    getSourceForBranch.mockReset();
    getWeeklyReplenishment.mockReset();
    getAuthorizedScope.mockResolvedValue({
      context,
      scope: { organizationId: 1, sourceId: "pv1", branchId: 2 },
    });
    getSourceForBranch.mockResolvedValue("depot");
    getWeeklyReplenishment.mockResolvedValue({ items: [], total: 0 });
  });

  it("uses the session scope when the requested branch matches", async () => {
    const response = await GET(
      new Request(
        "http://localhost/api/replenishment/weekly?branch_id=2&planning_date=2026-09-12",
      ),
    );

    expect(response.status).toBe(200);
    expect(getAuthorizedScope).toHaveBeenCalledWith(expect.any(URLSearchParams));
    expect(getWeeklyReplenishment).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: { organizationId: 1, sourceId: "pv1", branchId: 2 },
      }),
    );
  });

  it("rejects a branch_id that does not match the authenticated PV", async () => {
    const response = await GET(
      new Request(
        "http://localhost/api/replenishment/weekly?branch_id=3&planning_date=2026-09-12",
      ),
    );

    expect(response.status).toBe(403);
    expect(getWeeklyReplenishment).not.toHaveBeenCalled();
  });

  it("passes rubro filter and RUBRO_ASC sort to getWeeklyReplenishment", async () => {
    getWeeklyReplenishment.mockResolvedValue({
      items: [
        {
          article_id: 1,
          description: "Alfajor",
          rubro: "GOLOSINAS",
          stock_current: 5,
          stock_depot: 100,
          suggested_quantity: 20,
          supply_mode: "DEPOT",
        },
      ],
      total: 1,
      rubros: ["ALMACEN", "BEBIDAS", "GOLOSINAS"],
    });

    const response = await GET(
      new Request(
        "http://localhost/api/replenishment/weekly?branch_id=2&planning_date=2026-09-12&rubro=GOLOSINAS&sort=RUBRO_ASC",
      ),
    );

    expect(response.status).toBe(200);
    expect(getWeeklyReplenishment).toHaveBeenCalledWith(
      expect.objectContaining({
        rubro: "GOLOSINAS",
        sort: "RUBRO_ASC",
      }),
    );

    const data = await response.json();
    expect(data.rubros).toEqual(["ALMACEN", "BEBIDAS", "GOLOSINAS"]);
    expect(data.items[0].rubro).toBe("GOLOSINAS");
  });

  it("rejects an unauthenticated session with 401 and human-friendly message", async () => {
    getAuthorizedScope.mockRejectedValueOnce(
      new UnauthenticatedError("Session has expired. Please log in again."),
    );

    const response = await GET(
      new Request(
        "http://localhost/api/replenishment/weekly?branch_id=2&planning_date=2026-09-12",
      ),
    );

    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error).toBe("UNAUTHENTICATED");
    expect(data.message).toContain("Tu sesión ha expirado");
    expect(getWeeklyReplenishment).not.toHaveBeenCalled();
  });

  it("handles __SIN_RUBRO__ parameter and search query", async () => {
    getWeeklyReplenishment.mockResolvedValue({
      items: [],
      total: 0,
      rubros: ["BEBIDAS"],
    });

    const response = await GET(
      new Request(
        "http://localhost/api/replenishment/weekly?branch_id=2&planning_date=2026-09-12&rubro=__SIN_RUBRO__&search=Agua",
      ),
    );

    expect(response.status).toBe(200);
    expect(getWeeklyReplenishment).toHaveBeenCalledWith(
      expect.objectContaining({
        rubro: "__SIN_RUBRO__",
        search: "Agua",
      }),
    );
  });
});
