import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Hoisted mocks ──────────────────────────────────────────────────────
const {
  mockQuery,
  mockWithTransaction,
  mockGetWeeklyReplenishment,
  mockDepotArticleIds,
} = vi.hoisted(() => {
  const mockQuery = vi.fn();
  return {
    mockQuery,
    mockWithTransaction: vi.fn(
      (
        fn: (client: { query: typeof mockQuery }) => Promise<unknown>,
      ) => fn({ query: mockQuery }),
    ),
    mockGetWeeklyReplenishment: vi.fn(),
    mockDepotArticleIds: vi.fn((items: unknown[]) => items),
  };
});

vi.mock("@/server/db/client", () => ({
  withTransaction: mockWithTransaction,
}));
vi.mock("@/server/analytics/weekly-replenishment", () => ({
  DEPOT_BRANCH_ID: 1,
  getWeeklyReplenishment: mockGetWeeklyReplenishment,
}));
vi.mock("@/server/supply/branch-supply-rules", () => ({
  depotArticleIds: mockDepotArticleIds,
}));

import { confirmInternalReplenishment } from "./internal-replenishment";

// ── Fixtures ───────────────────────────────────────────────────────────
const scope = { organizationId: 1, branchId: 2, sourceId: "src-1" };

const baseInput = {
  scope,
  depotSourceId: "depot-src",
  planningDate: "2026-09-27",
  items: [{ article_id: 100, requested_quantity: 10 }],
  actorId: "user-1",
  idempotencyToken: "tok-aaa-bbb",
};

const projectionItem = {
  article_id: 100,
  description: "Test Product",
  suggested_quantity: 10,
  stock_current: 5,
  target_stock: 15,
  status: "SUGGESTION_AVAILABLE",
  weekly_demand: 7,
  supplier_code: "SUP1",
  classification_code: "CL1",
  unit_measure: "UN",
};

// ── Helper to configure mockQuery per scenario ─────────────────────────
function setupQuery(opts: {
  idempotencyHit?: string;
  activeHit?: string;
  insertedId?: string;
} = {}) {
  mockQuery.mockImplementation((sql: string) => {
    if (sql.includes("branch_product_supply_rules"))
      return Promise.resolve({
        rows: [{ article_id: 100, supply_mode: "DEPOT" }],
      });
    if (sql.includes("idempotency_key=$1"))
      return Promise.resolve({
        rows: opts.idempotencyHit ? [{ id: opts.idempotencyHit }] : [],
      });
    if (
      sql.includes("order_type='INTERNAL_REPLENISHMENT'") &&
      !sql.includes("INSERT")
    )
      return Promise.resolve({
        rows: opts.activeHit ? [{ id: opts.activeHit }] : [],
      });
    if (sql.includes("INSERT INTO orders"))
      return Promise.resolve({
        rows: [{ id: opts.insertedId ?? "42" }],
      });
    // order_events, order_items
    return Promise.resolve({ rows: [] });
  });
}

// ── Tests ──────────────────────────────────────────────────────────────
describe("confirmInternalReplenishment – idempotency token", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetWeeklyReplenishment.mockResolvedValue({
      items: [projectionItem],
    });
    mockDepotArticleIds.mockImplementation((items: unknown[]) => items);
  });

  // ① Same token twice → single order
  it("creates one order even if the same token is sent twice", async () => {
    setupQuery({ insertedId: "50" });
    const first = await confirmInternalReplenishment(baseInput);
    expect(first).toEqual({ id: 50, created: true });

    setupQuery({ idempotencyHit: "50" });
    const second = await confirmInternalReplenishment(baseInput);
    expect(second).toEqual({ id: 50, created: false });
  });

  // ② Second request with same token → returns existing, created=false
  it("returns the existing order with created=false on idempotency hit", async () => {
    setupQuery({ idempotencyHit: "99" });
    const result = await confirmInternalReplenishment(baseInput);
    expect(result).toEqual({ id: 99, created: false });

    const inserts = mockQuery.mock.calls.filter(
      (call: any[]) => call[0].includes("INSERT INTO orders"),
    );
    expect(inserts).toHaveLength(0);
  });

  // ③ Different token after COMPLETED → new order allowed
  it("allows a new order with a fresh token when no active order exists (post-COMPLETED)", async () => {
    setupQuery({ insertedId: "101" });
    const result = await confirmInternalReplenishment({
      ...baseInput,
      idempotencyToken: "fresh-after-completed",
    });
    expect(result).toEqual({ id: 101, created: true });
  });

  // ④ Different token after CANCELLED → new order allowed
  it("allows a new order with a fresh token when no active order exists (post-CANCELLED)", async () => {
    setupQuery({ insertedId: "102" });
    const result = await confirmInternalReplenishment({
      ...baseInput,
      idempotencyToken: "fresh-after-cancelled",
    });
    expect(result).toEqual({ id: 102, created: true });
  });

  // ⑤⑥⑦⑧ Active orders block a second request
  it.each([
    ["DRAFT", "200"],
    ["CONFIRMED", "201"],
    ["IN_PREPARATION", "202"],
    ["DISPATCHED", "203"],
  ])(
    "blocks when an active %s order exists",
    async (_status, id) => {
      setupQuery({ activeHit: id });
      const result = await confirmInternalReplenishment(baseInput);
      expect(result).toEqual({ id: Number(id), created: false });
    },
  );

  // ⑨ Two articles → same consolidated order
  it("consolidates two articles into one order", async () => {
    const twoItems = [
      { ...projectionItem, article_id: 100 },
      { ...projectionItem, article_id: 200, description: "Second Product" },
    ];
    mockGetWeeklyReplenishment.mockResolvedValue({ items: twoItems });

    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes("branch_product_supply_rules"))
        return Promise.resolve({
          rows: [
            { article_id: 100, supply_mode: "DEPOT" },
            { article_id: 200, supply_mode: "DEPOT" },
          ],
        });
      if (sql.includes("idempotency_key=$1"))
        return Promise.resolve({ rows: [] });
      if (
        sql.includes("order_type='INTERNAL_REPLENISHMENT'") &&
        !sql.includes("INSERT")
      )
        return Promise.resolve({ rows: [] });
      if (sql.includes("INSERT INTO orders"))
        return Promise.resolve({ rows: [{ id: "300" }] });
      return Promise.resolve({ rows: [] });
    });

    const result = await confirmInternalReplenishment({
      ...baseInput,
      items: [
        { article_id: 100, requested_quantity: 5 },
        { article_id: 200, requested_quantity: 8 },
      ],
    });
    expect(result).toEqual({ id: 300, created: true });

    const orderInserts = mockQuery.mock.calls.filter(
      (call: any[]) => call[0].includes("INSERT INTO orders"),
    );
    expect(orderInserts).toHaveLength(1);

    const itemInserts = mockQuery.mock.calls.filter(
      (call: any[]) => call[0].includes("INSERT INTO order_items"),
    );
    expect(itemInserts).toHaveLength(2);
  });

  // Bonus: verify dynamic key format is used
  it("builds the idempotency key from the token, not from static fields", async () => {
    setupQuery({ insertedId: "400" });
    await confirmInternalReplenishment({
      ...baseInput,
      idempotencyToken: "my-unique-uuid",
    });

    const insertCall = mockQuery.mock.calls.find(
      (call: any[]) => call[0].includes("INSERT INTO orders"),
    );
    expect(insertCall).toBeDefined();
    const params = insertCall![1] as unknown[];
    expect(params).toContain("internal-replenishment:my-unique-uuid");
  });

  // Race condition fix test
  it("ON CONFLICT - INSERT returns empty, fallback SELECT finds existing order", async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes("branch_product_supply_rules"))
        return Promise.resolve({ rows: [{ article_id: 100, supply_mode: "DEPOT" }] });
      if (sql.includes("idempotency_key=$1")) // fast path
        return Promise.resolve({ rows: [] });
      if (sql.includes("order_type='INTERNAL_REPLENISHMENT'") && !sql.includes("INSERT"))
        return Promise.resolve({ rows: [] });
      if (sql.includes("INSERT INTO orders"))
        return Promise.resolve({ rows: [] }); // ON CONFLICT DO NOTHING
      if (sql.includes("idempotency_key = $1")) // fallback SELECT
        return Promise.resolve({ rows: [{ id: "555" }] });
      return Promise.resolve({ rows: [] });
    });

    const result = await confirmInternalReplenishment(baseInput);
    expect(result).toEqual({ id: 555, created: false });

    // Validate that items/events were NOT created
    const itemInserts = mockQuery.mock.calls.filter((call: any[]) => call[0].includes("INSERT INTO order_items"));
    expect(itemInserts).toHaveLength(0);

    const eventInserts = mockQuery.mock.calls.filter((call: any[]) => call[0].includes("INSERT INTO order_events"));
    expect(eventInserts).toHaveLength(0);
  });
});
