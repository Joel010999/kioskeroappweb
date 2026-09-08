import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthorizationContext } from "@/server/auth/context";

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
});
