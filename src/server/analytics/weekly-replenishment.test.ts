import { beforeEach, describe, expect, it, vi } from "vitest";
import { query } from "@/server/db/client";

vi.mock("@/server/db/client", () => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
}));

import { getWeeklyReplenishment } from "./weekly-replenishment";

describe("getWeeklyReplenishment catalog completeness, cutoffs & 42P01 resilience", () => {
  beforeEach(() => {
    vi.mocked(query).mockReset();
  });

  it("anchors query on catalog_products, filters active items by default, and includes cutoff & base stock", async () => {
    const sqlLog: string[] = [];
    vi.mocked(query).mockImplementation(async (sql: string) => {
      sqlLog.push(sql);
      if (sql.includes("total_rows")) {
        return {
          rows: [
            {
              article_id: 522,
              description: "Chupetin Pop Arcor",
              supplier_code: "50350",
              classification_code: "004",
              rubro: "Caramelos",
              unit_measure: "UN",
              bulto_raw: "1",
              is_active: true,
              stock_current: "2",
              depot_stock: "40",
              weekly_demand: "0",
              weekly_average: "0",
              weekly_max: "0",
              weekly_min: "0",
              active_weeks: "0",
              base_stock: "12",
              pending_order_quantity: "3",
              depot_committed_quantity: "5",
              history_cutoff_date: "2026-10-01",
              target_stock: "12",
              suggested_quantity: "7",
              status: "SUGGESTION_AVAILABLE",
              supply_mode: "DEPOT",
              total_rows: "1",
            },
          ],
        } as any;
      }
      return { rows: [] } as any;
    });

    const result = await getWeeklyReplenishment({
      scope: { organizationId: 1, sourceId: "pv1", branchId: 2 },
      depotSourceId: "depot1",
      planningDate: "2026-10-24",
      supplier: "50350",
      limit: 50,
      offset: 0,
    });

    expect(sqlLog[0]).toContain("catalog_products AS");
    expect(sqlLog[0]).toContain("LEFT JOIN metrics m ON m.article_id = p.article_id");
    expect(sqlLog[0]).toContain("branch_product_history_cutoffs");
    expect(sqlLog[0]).toContain("COALESCE(o.origin_branch_id, o.branch_id) = $4");
    expect(sqlLog[0]).not.toContain("o.dispatched_at");
    expect(sqlLog[0]).toContain("AND is_active = true");
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      article_id: 522,
      supplier_code: "50350",
      is_active: true,
      base_stock: 12,
      pending_order_quantity: 3,
      depot_committed_quantity: 5,
      history_cutoff_date: "2026-10-01",
      target_stock: 12,
      suggested_quantity: 7,
      status: "SUGGESTION_AVAILABLE",
    });
  });

  it("retries without unmigrated tables when PostgreSQL returns 42P01", async () => {
    let calls = 0;
    vi.mocked(query).mockImplementation(async (sql: string) => {
      if (sql.includes("total_rows")) {
        calls += 1;
        if (calls === 1) {
          const err = new Error('relation "branch_product_base_stock" does not exist') as Error & {
            code: string;
          };
          err.code = "42P01";
          throw err;
        }
        return { rows: [] } as any;
      }
      return { rows: [] } as any;
    });

    const result = await getWeeklyReplenishment({
      scope: { organizationId: 1, sourceId: "pv1", branchId: 2 },
      depotSourceId: "depot1",
      planningDate: "2026-10-24",
      filter: "INACTIVE",
      limit: 25,
      offset: 0,
    });

    expect(calls).toBe(2);
    expect(result.total).toBe(0);
    expect(result.items).toEqual([]);
  });
});

