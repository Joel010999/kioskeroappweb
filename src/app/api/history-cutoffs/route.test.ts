import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthorizationContext } from "@/server/auth/context";
import { ForbiddenError } from "@/server/auth/errors";
import { isSignificantDescriptionChange } from "@/server/catalog/history-cutoffs";

const { getAuthorizedScope, listHistoryCutoffs, detectOrderSnapshotMismatches, upsertHistoryCutoff, deleteHistoryCutoff } =
  vi.hoisted(() => ({
    getAuthorizedScope: vi.fn(),
    listHistoryCutoffs: vi.fn(),
    detectOrderSnapshotMismatches: vi.fn(),
    upsertHistoryCutoff: vi.fn(),
    deleteHistoryCutoff: vi.fn(),
  }));

vi.mock("@/server/auth/scope", () => ({ getAuthorizedScope }));
vi.mock("@/server/catalog/history-cutoffs", async () => {
  const actual = await vi.importActual<typeof import("@/server/catalog/history-cutoffs")>(
    "@/server/catalog/history-cutoffs",
  );
  return {
    ...actual,
    listHistoryCutoffs,
    detectOrderSnapshotMismatches,
    upsertHistoryCutoff,
    deleteHistoryCutoff,
  };
});

import { DELETE, GET, PUT } from "./route";

const context: AuthorizationContext = {
  userId: 10,
  organizationId: 1,
  userActive: true,
  memberships: [{ branchId: 2, role: "PV_OPERATOR", active: true }],
};

describe("history cutoffs & /api/history-cutoffs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAuthorizedScope.mockResolvedValue({
      context,
      scope: { organizationId: 1, sourceId: "pv2", branchId: 2 },
    });
    listHistoryCutoffs.mockResolvedValue({ migrated: true, cutoffs: [] });
    detectOrderSnapshotMismatches.mockResolvedValue([]);
    upsertHistoryCutoff.mockResolvedValue({ article_id: 901, cutoff_date: "2026-11-12" });
    deleteHistoryCutoff.mockResolvedValue({ article_id: 901, deleted: true });
  });

  it("distinguishes real product reuse from minor spelling punctuation or unit formatting edits", () => {
    expect(isSignificantDescriptionChange("CARAMELOS MASTICABLES ARCOR 100G", "ENCENDEDOR BIC MINI")).toBe(
      true,
    );
    expect(isSignificantDescriptionChange("ALFAJOR JORGITO CHOC.", "ALFAJOR JORGITO CHOC")).toBe(false);
    expect(isSignificantDescriptionChange("COCA COLA 500ML", "COCA COLA 500 ML")).toBe(false);
  });

  it("handles GET, PUT, and DELETE history cutoffs safely", async () => {
    const getRes = await GET(new Request("http://localhost/api/history-cutoffs?branch_id=2"));
    expect(getRes.status).toBe(200);

    const putRes = await PUT(
      new Request("http://localhost/api/history-cutoffs", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          branch_id: 2,
          article_id: 901,
          cutoff_date: "2026-11-12",
          previous_description: "Producto anterior",
          detection_source: "ORDER_SNAPSHOT_DIFF",
        }),
      }),
    );
    expect(putRes.status).toBe(200);
    expect(upsertHistoryCutoff).toHaveBeenCalledWith(
      expect.objectContaining({ branchId: 2 }),
      expect.objectContaining({ articleId: 901, cutoffDate: "2026-11-12", actorId: "10" }),
    );

    const delRes = await DELETE(
      new Request("http://localhost/api/history-cutoffs?branch_id=2&article_id=901", {
        method: "DELETE",
      }),
    );
    expect(delRes.status).toBe(200);
    expect(deleteHistoryCutoff).toHaveBeenCalledWith(expect.objectContaining({ branchId: 2 }), 901);
  });

  it("forbids cross-branch mutation", async () => {
    getAuthorizedScope.mockRejectedValueOnce(new ForbiddenError());
    const res = await PUT(
      new Request("http://localhost/api/history-cutoffs", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branch_id: 3, article_id: 901, cutoff_date: "2026-11-12" }),
      }),
    );
    expect(res.status).toBe(403);
  });
});

