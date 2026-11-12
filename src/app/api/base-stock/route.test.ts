import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthorizationContext } from "@/server/auth/context";
import { ForbiddenError, UnauthenticatedError } from "@/server/auth/errors";

const {
  getAuthorizedScope,
  getSourceForBranch,
  listBranchBaseStock,
  upsertBranchBaseStock,
} = vi.hoisted(() => ({
  getAuthorizedScope: vi.fn(),
  getSourceForBranch: vi.fn(),
  listBranchBaseStock: vi.fn(),
  upsertBranchBaseStock: vi.fn(),
}));

vi.mock("@/server/auth/scope", () => ({ getAuthorizedScope }));
vi.mock("@/server/auth/sources", () => ({ getSourceForBranch }));
vi.mock("@/server/base-stock/repository", async () => {
  const actual = await vi.importActual<typeof import("@/server/base-stock/repository")>(
    "@/server/base-stock/repository",
  );
  return {
    ...actual,
    listBranchBaseStock,
    upsertBranchBaseStock,
  };
});

import { GET, PUT } from "./route";

const multiBranchContext: AuthorizationContext = {
  userId: 10,
  organizationId: 1,
  userActive: true,
  memberships: [
    { branchId: 2, role: "PV_OPERATOR", active: true },
    { branchId: 3, role: "PV_OPERATOR", active: true },
  ],
};

const centroOnlyContext: AuthorizationContext = {
  userId: 20,
  organizationId: 1,
  userActive: true,
  memberships: [{ branchId: 2, role: "PV_OPERATOR", active: true }],
};

describe("/api/base-stock route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSourceForBranch.mockResolvedValue("depot_1");
    listBranchBaseStock.mockResolvedValue({
      branch_id: 2,
      branch_label: "Centro",
      migrated: true,
      cutoffs_migrated: true,
      total: 1,
      summary: { total_active: 1, configured_count: 1, unconfigured_count: 0, zero_count: 0 },
      rubros: ["Chocolates"],
      suppliers: ["50350"],
      rows: [],
    });
    upsertBranchBaseStock.mockResolvedValue({
      branch_id: 2,
      article_id: 522,
      base_stock: 12,
      is_configured: true,
    });
  });

  it("lists base stock for authorized branch and returns available branches", async () => {
    getAuthorizedScope.mockResolvedValue({
      context: multiBranchContext,
      scope: { organizationId: 1, sourceId: "pv2", branchId: 2 },
    });

    const res = await GET(new Request("http://localhost/api/base-stock?branch_id=2"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.branch_id).toBe(2);
    expect(json.available_branches).toEqual([
      { branch_id: 2, label: "Centro" },
      { branch_id: 3, label: "Jardín" },
    ]);
  });

  it("blocks unauthorized cross-branch PUT for single-PV operator", async () => {
    getAuthorizedScope.mockRejectedValueOnce(new ForbiddenError("You cannot access this branch."));
    const res = await PUT(
      new Request("http://localhost/api/base-stock", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branch_id: 3, article_id: 522, base_stock: 12 }),
      }),
    );
    expect(res.status).toBe(403);
    expect(upsertBranchBaseStock).not.toHaveBeenCalled();
  });

  it("rejects negative base_stock with 400 and allows 0 or null", async () => {
    getAuthorizedScope.mockResolvedValue({
      context: centroOnlyContext,
      scope: { organizationId: 1, sourceId: "pv2", branchId: 2 },
    });

    const badRes = await PUT(
      new Request("http://localhost/api/base-stock", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branch_id: 2, article_id: 522, base_stock: -2 }),
      }),
    );
    expect(badRes.status).toBe(400);

    const zeroRes = await PUT(
      new Request("http://localhost/api/base-stock", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branch_id: 2, article_id: 522, base_stock: 0 }),
      }),
    );
    expect(zeroRes.status).toBe(200);
    expect(upsertBranchBaseStock).toHaveBeenCalledWith(
      expect.objectContaining({ branchId: 2 }),
      expect.objectContaining({ articleId: 522, baseStock: 0 }),
    );

    const clearRes = await PUT(
      new Request("http://localhost/api/base-stock", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branch_id: 2, article_id: 522, base_stock: null }),
      }),
    );
    expect(clearRes.status).toBe(200);
    expect(upsertBranchBaseStock).toHaveBeenCalledWith(
      expect.objectContaining({ branchId: 2 }),
      expect.objectContaining({ articleId: 522, baseStock: null }),
    );
    expect(upsertBranchBaseStock.mock.calls.at(-1)?.[1]).not.toHaveProperty("notes");
  });

  it("returns 401 when unauthenticated", async () => {
    getAuthorizedScope.mockRejectedValueOnce(new UnauthenticatedError());
    const res = await GET(new Request("http://localhost/api/base-stock"));
    expect(res.status).toBe(401);
  });
});

