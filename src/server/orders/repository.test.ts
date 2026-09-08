import { beforeEach, describe, expect, it, vi } from "vitest";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("@/server/db/client", () => ({ query }));

import { listBranchReplenishmentOrders } from "./repository";

const options = {
  planningDate: "2026-09-12",
  activeOnly: true,
  limit: 25,
  offset: 0,
};

describe("branch replenishment orders", () => {
  beforeEach(() => {
    query.mockReset();
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ count: "0" }] });
  });

  it.each([
    ["PV1", 2],
    ["PV2", 3],
  ])("uses the authorized %s origin branch", async (_label, originBranchId) => {
    await listBranchReplenishmentOrders(
      { organizationId: 1, originBranchId, destinationBranchId: 1 },
      options,
    );

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("o.organization_id=$1"),
      [1, originBranchId, 1, null, "2026-09-12", true, 25, 0],
    );
    expect(String(query.mock.calls[0][0])).toContain("o.origin_branch_id=$2");
    expect(String(query.mock.calls[0][0])).toContain(
      "o.destination_branch_id=$3",
    );
  });

  it("excludes cancelled orders when checking for an active request", async () => {
    await listBranchReplenishmentOrders(
      { organizationId: 1, originBranchId: 2, destinationBranchId: 1 },
      options,
    );

    expect(String(query.mock.calls[0][0])).toContain(
      "o.status <> 'CANCELLED'",
    );
  });

  it("keeps the organization in the lookup scope", async () => {
    await listBranchReplenishmentOrders(
      { organizationId: 9, originBranchId: 2, destinationBranchId: 1 },
      options,
    );

    expect(query.mock.calls[0][1]).toEqual([
      9,
      2,
      1,
      null,
      "2026-09-12",
      true,
      25,
      0,
    ]);
  });
});
