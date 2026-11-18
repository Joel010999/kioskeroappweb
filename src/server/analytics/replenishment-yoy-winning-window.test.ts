import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  selectWinningDemandWindow,
  weeklyDecision,
  type WindowDemandMetrics,
} from "./weekly-replenishment-rules";

vi.mock("@/server/db/client", () => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
}));

import { query } from "@/server/db/client";
import { getWeeklyReplenishment } from "./weekly-replenishment";

describe("YoY winning-window coherent metrics (Bombuchas #186 root cause fix)", () => {
  beforeEach(() => {
    vi.mocked(query).mockReset();
  });

  it("Caso 1 (Bombuchas #186): YoY wins when current window has 0 active weeks -> suggests 62 units instead of NO_DEMAND", () => {
    const current: WindowDemandMetrics = {
      activeWeeks: 0,
      weeklyDemand: 0,
      weeklyAverage: 0,
      weeklyMax: 0,
      weeklyMin: 0,
    };
    const yoy: WindowDemandMetrics = {
      activeWeeks: 5,
      weeklyDemand: 45,
      weeklyAverage: 45.5,
      weeklyMax: 85,
      weeklyMin: 0,
    };

    const winning = selectWinningDemandWindow(current, yoy);
    expect(winning).toEqual({ ...yoy, source: "YOY" });

    const decision = weeklyDecision({
      currentStock: 3,
      activeWeeks: winning.activeWeeks,
      medianDemand: winning.weeklyDemand,
      maxDemand: winning.weeklyMax,
      isDiscrete: true,
    });

    expect(decision.status).toBe("SUGGESTION_AVAILABLE");
    expect(Math.ceil(decision.targetStock ?? 0)).toBe(65);
    expect(decision.suggestedQuantity).toBe(62);
  });

  it("Caso 2 (Estacional con 1-2 semanas recientes): YoY wins when current window has 2 active weeks -> suggests 26 instead of INSUFFICIENT_HISTORY", () => {
    const current: WindowDemandMetrics = {
      activeWeeks: 2,
      weeklyDemand: 0,
      weeklyAverage: 1.67,
      weeklyMax: 5,
      weeklyMin: 0,
    };
    const yoy: WindowDemandMetrics = {
      activeWeeks: 6,
      weeklyDemand: 20,
      weeklyAverage: 20,
      weeklyMax: 25,
      weeklyMin: 15,
    };

    const winning = selectWinningDemandWindow(current, yoy);
    expect(winning.source).toBe("YOY");
    expect(winning.activeWeeks).toBe(6);

    const decision = weeklyDecision({
      currentStock: 3,
      activeWeeks: winning.activeWeeks,
      medianDemand: winning.weeklyDemand,
      maxDemand: winning.weeklyMax,
      isDiscrete: true,
    });

    expect(decision.status).toBe("SUGGESTION_AVAILABLE");
    expect(Math.ceil(decision.targetStock ?? 0)).toBe(29);
    expect(decision.suggestedQuantity).toBe(26);
  });

  it("Caso 3 (Irregular actual, regular YoY ganadora): does not contaminate regular YoY with current window spike", () => {
    const current: WindowDemandMetrics = {
      activeWeeks: 4,
      weeklyDemand: 10,
      weeklyAverage: 30,
      weeklyMax: 100, // Irregular en ventana actual
      weeklyMin: 0,
    };
    const yoy: WindowDemandMetrics = {
      activeWeeks: 6,
      weeklyDemand: 20,
      weeklyAverage: 21,
      weeklyMax: 30, // Regular en ventana YoY ganadora
      weeklyMin: 14,
    };

    const winning = selectWinningDemandWindow(current, yoy);
    expect(winning.source).toBe("YOY");
    expect(winning.weeklyMax).toBe(30);

    const decision = weeklyDecision({
      currentStock: 3,
      activeWeeks: winning.activeWeeks,
      medianDemand: winning.weeklyDemand,
      maxDemand: winning.weeklyMax,
      isDiscrete: true,
    });

    expect(decision.status).toBe("SUGGESTION_AVAILABLE");
    expect(decision.suggestedQuantity).toBe(26);
  });

  it("Caso 4 (Pico anómalo en YoY): detects IRREGULAR_DEMAND using yoy_max instead of hiding it with current_max = 0", () => {
    const current: WindowDemandMetrics = {
      activeWeeks: 0,
      weeklyDemand: 0,
      weeklyAverage: 0,
      weeklyMax: 0,
      weeklyMin: 0,
    };
    const yoy: WindowDemandMetrics = {
      activeWeeks: 3,
      weeklyDemand: 2,
      weeklyAverage: 11,
      weeklyMax: 60, // 60 - 2 >= 20 y 60 >= 2 * 3
      weeklyMin: 0,
    };

    const winning = selectWinningDemandWindow(current, yoy);
    expect(winning.source).toBe("YOY");
    expect(winning.weeklyMax).toBe(60);

    const decision = weeklyDecision({
      currentStock: 0,
      activeWeeks: winning.activeWeeks,
      medianDemand: winning.weeklyDemand,
      maxDemand: winning.weeklyMax,
      isDiscrete: true,
    });

    expect(decision.status).toBe("IRREGULAR_DEMAND");
    expect(decision.suggestedQuantity).toBeNull();
  });

  it("Caso 5 (base_stock + demanda YoY mayor): uses max(demand_10d, base_stock) when YoY wins", () => {
    const current: WindowDemandMetrics = {
      activeWeeks: 2,
      weeklyDemand: 0,
      weeklyAverage: 0.5,
      weeklyMax: 2,
      weeklyMin: 0,
    };
    const yoy: WindowDemandMetrics = {
      activeWeeks: 4,
      weeklyDemand: 1.5,
      weeklyAverage: 1.5,
      weeklyMax: 3,
      weeklyMin: 0,
    };

    const winning = selectWinningDemandWindow(current, yoy);
    expect(winning.source).toBe("YOY");
    expect(winning.activeWeeks).toBe(4);

    const decision = weeklyDecision({
      currentStock: 2,
      activeWeeks: winning.activeWeeks,
      medianDemand: winning.weeklyDemand,
      maxDemand: winning.weeklyMax,
      baseStock: 2,
      isDiscrete: true,
    });

    expect(decision.status).toBe("SUGGESTION_AVAILABLE");
    expect(decision.suggestedQuantity).toBe(1);
  });

  it("Caso 6 (Empate o actual mayor): prioritizes current window metrics", () => {
    const current: WindowDemandMetrics = {
      activeWeeks: 5,
      weeklyDemand: 30,
      weeklyAverage: 31,
      weeklyMax: 40,
      weeklyMin: 0,
    };
    const yoy: WindowDemandMetrics = {
      activeWeeks: 6,
      weeklyDemand: 30,
      weeklyAverage: 32,
      weeklyMax: 45,
      weeklyMin: 20,
    };

    const winning = selectWinningDemandWindow(current, yoy);
    expect(winning).toEqual({ ...current, source: "CURRENT" });
  });

  it("Preserves exclusion of pending internal orders and negative stock guard when YoY wins", () => {
    const current: WindowDemandMetrics = {
      activeWeeks: 0,
      weeklyDemand: 0,
      weeklyAverage: 0,
      weeklyMax: 0,
      weeklyMin: 0,
    };
    const yoy: WindowDemandMetrics = {
      activeWeeks: 5,
      weeklyDemand: 45,
      weeklyAverage: 45.5,
      weeklyMax: 85,
      weeklyMin: 0,
    };
    const winning = selectWinningDemandWindow(current, yoy);

    const withPending = weeklyDecision({
      currentStock: 3,
      activeWeeks: winning.activeWeeks,
      medianDemand: winning.weeklyDemand,
      maxDemand: winning.weeklyMax,
      pendingOrderQuantity: 50,
      isDiscrete: true,
    });
    expect(withPending.status).toBe("SUGGESTION_AVAILABLE");
    expect(withPending.suggestedQuantity).toBe(62);

    const negativeStock = weeklyDecision({
      currentStock: -4,
      activeWeeks: winning.activeWeeks,
      medianDemand: winning.weeklyDemand,
      maxDemand: winning.weeklyMax,
      isDiscrete: true,
    });
    expect(negativeStock.status).toBe("NEGATIVE_STOCK");
    expect(negativeStock.suggestedQuantity).toBeNull();
  });

  it("SQL generated by getWeeklyReplenishment propagates the full coherent YoY metric tuple while preserving cutoffs, supplier filter, and no-pending-order formula", async () => {
    const sqlLog: string[] = [];
    vi.mocked(query).mockImplementation(async (sql: string) => {
      sqlLog.push(sql);
      if (sql.includes("total_rows")) {
        return {
          rows: [
            {
              article_id: 186,
              description: "BOMBUCHAS x100u.",
              supplier_code: "50922",
              classification_code: "0243222",
              rubro: "VARIOS",
              unit_measure: "1 UN",
              bulto_raw: "300",
              is_active: true,
              stock_current: "3",
              depot_stock: "867",
              weekly_demand: "45",
              weekly_average: "45.5",
              weekly_max: "85",
              weekly_min: "0",
              active_weeks: "5",
              base_stock: null,
              pending_order_quantity: "0",
              depot_committed_quantity: "0",
              history_cutoff_date: null,
              target_stock: "65",
              suggested_quantity: "62",
              status: "SUGGESTION_AVAILABLE",
              supply_mode: "UNDEFINED",
              total_rows: "1",
            },
          ],
        } as never;
      }
      return { rows: [] } as never;
    });

    const res = await getWeeklyReplenishment({
      scope: { organizationId: 1, sourceId: "pv2", branchId: 2 },
      depotSourceId: "depot1",
      planningDate: "2026-11-21",
      supplier: "50922",
      limit: 25,
      offset: 0,
    });

    const mainSql = sqlLog[0];
    // 1. yoy_metrics calcula la tupla completa
    expect(mainSql).toContain("AS yoy_active_weeks");
    expect(mainSql).toContain("AS weekly_demand_yoy");
    expect(mainSql).toContain("AS weekly_average_yoy");
    expect(mainSql).toContain("AS weekly_max_yoy");
    expect(mainSql).toContain("AS weekly_min_yoy");

    // 2. metrics selecciona la tupla coherente de la ventana ganadora
    expect(mainSql).toContain(
      "CASE WHEN COALESCE(ym.weekly_demand_yoy, 0) > cm.weekly_demand",
    );
    expect(mainSql).toContain("THEN COALESCE(ym.yoy_active_weeks, 0)");
    expect(mainSql).toContain("THEN COALESCE(ym.weekly_average_yoy, 0)");
    expect(mainSql).toContain("THEN COALESCE(ym.weekly_max_yoy, 0)");
    expect(mainSql).toContain("THEN COALESCE(ym.weekly_min_yoy, 0)");

    // 3. Preserva cortes históricos, exclusión de pedidos pendientes y filtro temprano de proveedor
    expect(mainSql).toContain("branch_product_history_cutoffs");
    expect(mainSql).toContain("m.fedepo::date >= hc.cutoff_date");
    expect(mainSql).not.toContain("(stock_current + pending_order_quantity)");
    expect(mainSql).toContain("p.payload->>'Proveedor'");

    // 4. Respuesta mapeada correctamente
    expect(res.items).toHaveLength(1);
    expect(res.items[0]).toMatchObject({
      article_id: 186,
      description: "BOMBUCHAS x100u.",
      active_weeks: 5,
      weekly_demand: 45,
      target_stock: 65,
      suggested_quantity: 62,
      status: "SUGGESTION_AVAILABLE",
    });
  });
});
