import { describe, expect, it, vi } from "vitest";

// ── Hoisted mocks ──────────────────────────────────────────────────────
const { mockConfirm } = vi.hoisted(() => ({
  mockConfirm: vi
    .fn()
    .mockResolvedValue({ id: 1, created: true }),
}));

vi.mock("@/server/orders/internal-replenishment", () => ({
  confirmInternalReplenishment: mockConfirm,
}));
vi.mock("@/server/auth/scope", () => ({
  getAuthorizedScope: vi.fn().mockResolvedValue({
    context: { userId: 1, organizationId: 1 },
    scope: { organizationId: 1, branchId: 2, sourceId: "src-1" },
  }),
}));
vi.mock("@/server/auth/sources", () => ({
  getSourceForBranch: vi.fn().mockResolvedValue("depot-src"),
}));
vi.mock("@/server/auth/policies", () => ({
  canConfirmReplenishment: vi.fn().mockReturnValue(true),
}));
vi.mock("@/server/analytics/weekly-replenishment", () => ({
  DEPOT_BRANCH_ID: 1,
}));

import { POST } from "./route";

// ── Helpers ────────────────────────────────────────────────────────────
function makeRequest(body: unknown) {
  return new Request(
    "http://localhost/api/replenishment/weekly/confirm",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

// ── Test ⑩ ─────────────────────────────────────────────────────────────
describe("POST /api/replenishment/weekly/confirm – idempotency_token validation", () => {
  it("returns 400 when idempotency_token is missing", async () => {
    const response = await POST(
      makeRequest({
        branch_id: 2,
        planning_date: "2026-09-27",
        items: [{ article_id: 100, requested_quantity: 10 }],
      }),
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("idempotency_token");
  });

  it("returns 400 when idempotency_token is not a string", async () => {
    const response = await POST(
      makeRequest({
        branch_id: 2,
        planning_date: "2026-09-27",
        items: [{ article_id: 100, requested_quantity: 10 }],
        idempotency_token: 12345,
      }),
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("idempotency_token");
  });

  it("does not return 500 for missing token", async () => {
    const response = await POST(
      makeRequest({
        branch_id: 2,
        planning_date: "2026-09-27",
        items: [{ article_id: 100, requested_quantity: 10 }],
      }),
    );
    expect(response.status).not.toBe(500);
  });
});
