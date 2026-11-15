import { beforeEach, describe, expect, it, vi } from "vitest";
import { weeklyDecision } from "./weekly-replenishment-rules";
import { getWeeklyReplenishment } from "./weekly-replenishment";
import { confirmInternalReplenishment } from "@/server/orders/internal-replenishment";
import { query, withTransaction } from "@/server/db/client";

vi.mock("@/server/db/client", () => ({
  query: vi.fn(),
  withTransaction: vi.fn((fn: (client: any) => Promise<unknown>) => fn({ query: vi.fn() })),
}));

describe("Verificación Integral: Eliminación de Pedidos Internos Pendientes en Reposición", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 1. Un pedido interno pendiente NO modifica la sugerencia
  // ──────────────────────────────────────────────────────────────────────────
  describe("1. Independencia total de pedidos internos pendientes", () => {
    it("devuelve exactamente la misma cantidad sugerida con 0, 5 o 50 unidades pendientes", () => {
      // Demanda = 7 u/sem (10d demand = 10)
      // Stock base = 20
      // stockTarget = max(10, 20) = 20
      // currentStock = 6 -> available = 6
      // suggested = max(0, 20 - 6) = 14
      const withoutPending = weeklyDecision({
        currentStock: 6,
        activeWeeks: 4,
        medianDemand: 7,
        maxDemand: 8,
        isDiscrete: true,
        baseStock: 20,
        pendingOrderQuantity: 0,
      });

      const with5Pending = weeklyDecision({
        currentStock: 6,
        activeWeeks: 4,
        medianDemand: 7,
        maxDemand: 8,
        isDiscrete: true,
        baseStock: 20,
        pendingOrderQuantity: 5,
      });

      const with50Pending = weeklyDecision({
        currentStock: 6,
        activeWeeks: 4,
        medianDemand: 7,
        maxDemand: 8,
        isDiscrete: true,
        baseStock: 20,
        pendingOrderQuantity: 50,
      });

      expect(withoutPending.suggestedQuantity).toBe(14);
      expect(with5Pending.suggestedQuantity).toBe(14);
      expect(with50Pending.suggestedQuantity).toBe(14);
      expect(withoutPending.targetStock).toBe(20);
      expect(with5Pending.targetStock).toBe(20);
      expect(with50Pending.targetStock).toBe(20);
    });

    it("la consulta SQL de reposición semanal no descuenta pedidos pendientes en su fórmula", async () => {
      const capturedSqls: string[] = [];
      vi.mocked(query).mockImplementation(async (sql: string) => {
        capturedSqls.push(sql);
        return { rows: [] } as any;
      });

      await getWeeklyReplenishment({
        scope: { organizationId: 1, sourceId: "pv_centro", branchId: 2 },
        depotSourceId: "depot_central",
        planningDate: "2026-10-24",
        limit: 25,
        offset: 0,
      });

      const mainQuery = capturedSqls.find((s) => s.includes("total_rows")) ?? "";

      // Se verifica que la fórmula en PostgreSQL use exclusivamente GREATEST(0, stock_current)
      expect(mainQuery).not.toContain("(stock_current + pending_order_quantity)");
      expect(mainQuery).toContain("GREATEST(0, target_stock_calc - GREATEST(0, stock_current))");
      expect(mainQuery).toContain("GREATEST(0, effective_target - GREATEST(0, stock_current))");
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 2. El cálculo utiliza únicamente el stock actual de la sucursal
  // ──────────────────────────────────────────────────────────────────────────
  describe("2. Uso exclusivo del stock actual de la sucursal", () => {
    it("calcula: stockTarget = max(demandTarget, baseStock), available = max(0, currentStock), suggested = max(0, stockTarget - available)", () => {
      // Target = 15
      // Stock = 5 -> available = 5 -> suggested = 10
      const stock5 = weeklyDecision({
        currentStock: 5,
        activeWeeks: 4,
        medianDemand: 7, // demandTarget = 10
        maxDemand: 8,
        isDiscrete: true,
        baseStock: 15,
      });
      expect(stock5.targetStock).toBe(15);
      expect(stock5.suggestedQuantity).toBe(10);

      // Stock = 0 -> available = 0 -> suggested = 15
      const stock0 = weeklyDecision({
        currentStock: 0,
        activeWeeks: 4,
        medianDemand: 7,
        maxDemand: 8,
        isDiscrete: true,
        baseStock: 15,
      });
      expect(stock0.suggestedQuantity).toBe(15);

      // Stock = 20 (mayor al target 15) -> available = 20 -> suggested = 0 (min 0)
      const stock20 = weeklyDecision({
        currentStock: 20,
        activeWeeks: 4,
        medianDemand: 7,
        maxDemand: 8,
        isDiscrete: true,
        baseStock: 15,
      });
      expect(stock20.suggestedQuantity).toBe(0);
      expect(stock20.status).toBe("NO_SUGGESTION");
    });

    it("mantiene el tratamiento de stock negativo con revisión manual (NEGATIVE_STOCK)", () => {
      const negativeStock = weeklyDecision({
        currentStock: -3,
        activeWeeks: 5,
        medianDemand: 10,
        maxDemand: 12,
        isDiscrete: true,
        baseStock: 10,
      });
      expect(negativeStock.status).toBe("NEGATIVE_STOCK");
      expect(negativeStock.targetStock).toBeNull();
      expect(negativeStock.suggestedQuantity).toBeNull();
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 3. El stock base sigue funcionando
  // ──────────────────────────────────────────────────────────────────────────
  describe("3. Funcionamiento de stock base", () => {
    it("toma el stock base cuando este supera la demanda estimada", () => {
      // demanda = 7 (demandTarget = 10), baseStock = 25 -> stockTarget = 25
      const baseWins = weeklyDecision({
        currentStock: 5,
        activeWeeks: 4,
        medianDemand: 7,
        maxDemand: 8,
        isDiscrete: true,
        baseStock: 25,
      });
      expect(baseWins.targetStock).toBe(25);
      expect(baseWins.suggestedQuantity).toBe(20);
    });

    it("permite sugerir reposición en productos nuevos (activeWeeks < 3) si tienen stock base configurado", () => {
      const newProduct = weeklyDecision({
        currentStock: 2,
        activeWeeks: 0,
        medianDemand: 0,
        maxDemand: 0,
        isDiscrete: true,
        baseStock: 12,
      });
      expect(newProduct.status).toBe("SUGGESTION_AVAILABLE");
      expect(newProduct.targetStock).toBe(12);
      expect(newProduct.suggestedQuantity).toBe(10);
    });

    it("devuelve NO_DEMAND cuando activeWeeks=0 y baseStock=0", () => {
      const noDemand = weeklyDecision({
        currentStock: 0,
        activeWeeks: 0,
        medianDemand: 0,
        maxDemand: 0,
        isDiscrete: true,
        baseStock: 0,
      });
      expect(noDemand.status).toBe("NO_DEMAND");
      expect(noDemand.suggestedQuantity).toBe(0);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 4. La demanda estimada sigue funcionando
  // ──────────────────────────────────────────────────────────────────────────
  describe("4. Demanda estimada", () => {
    it("calcula sugerencias basadas en demanda estimada cuando supera al stock base o no hay stock base", () => {
      // demanda = 21 u/sem -> 10d demand = (21 * 10) / 7 = 30
      // baseStock = 10 -> stockTarget = max(30, 10) = 30
      // currentStock = 5 -> suggested = 30 - 5 = 25
      const demandWins = weeklyDecision({
        currentStock: 5,
        activeWeeks: 6,
        medianDemand: 21,
        maxDemand: 24,
        isDiscrete: true,
        baseStock: 10,
      });
      expect(demandWins.targetStock).toBe(30);
      expect(demandWins.suggestedQuantity).toBe(25);
      expect(demandWins.status).toBe("SUGGESTION_AVAILABLE");
    });

    it("clasifica como INSUFFICIENT_HISTORY si activeWeeks < 3 y no hay stock base", () => {
      const insufficient = weeklyDecision({
        currentStock: 2,
        activeWeeks: 2,
        medianDemand: 10,
        maxDemand: 12,
        isDiscrete: true,
      });
      expect(insufficient.status).toBe("INSUFFICIENT_HISTORY");
      expect(insufficient.suggestedQuantity).toBeNull();
    });

    it("clasifica como IRREGULAR_DEMAND ante picos de demanda inusuales", () => {
      // medianDemand = 5, maxDemand = 28 -> max - median >= 20 y max >= median * 3
      const irregular = weeklyDecision({
        currentStock: 2,
        activeWeeks: 4,
        medianDemand: 5,
        maxDemand: 28,
        isDiscrete: true,
      });
      expect(irregular.status).toBe("IRREGULAR_DEMAND");
      expect(irregular.suggestedQuantity).toBeNull();
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 5. Los pedidos internos continúan funcionando normalmente fuera del cálculo de reposición
  // ──────────────────────────────────────────────────────────────────────────
  describe("5. Funcionamiento normal de pedidos internos fuera del cálculo de reposición", () => {
    it("confirma y genera pedidos internos a partir de las cantidades seleccionadas", async () => {
      const mockClient = {
        query: vi.fn((sql: string) => {
          if (sql.includes("branch_product_supply_rules")) {
            return Promise.resolve({
              rows: [{ article_id: 1001, supply_mode: "DEPOT" }],
            });
          }
          if (sql.includes("idempotency_key=$1")) {
            return Promise.resolve({ rows: [] });
          }
          if (sql.includes("order_type='INTERNAL_REPLENISHMENT'") && !sql.includes("INSERT")) {
            return Promise.resolve({ rows: [] });
          }
          if (sql.includes("INSERT INTO orders")) {
            return Promise.resolve({ rows: [{ id: "99" }] });
          }
          if (sql.includes("INSERT INTO order_events") || sql.includes("INSERT INTO order_items")) {
            return Promise.resolve({ rows: [] });
          }
          return Promise.resolve({ rows: [] });
        }),
      };

      vi.mocked(withTransaction).mockImplementation(async (fn: any) => fn(mockClient));

      // Simulamos la respuesta de getWeeklyReplenishment con la nueva lógica (stockTarget=15, currentStock=5 -> suggested=10)
      vi.mocked(query).mockImplementation(async (sql: string) => {
        if (sql.includes("total_rows")) {
          return {
            rows: [
              {
                article_id: 1001,
                description: "Alfajor Guaymallen",
                supplier_code: "50350",
                classification_code: "001",
                rubro: "Golosinas",
                unit_measure: "UN",
                bulto_raw: "1",
                is_active: true,
                stock_current: "5",
                depot_stock: "100",
                weekly_demand: "7",
                weekly_average: "7",
                weekly_max: "8",
                weekly_min: "6",
                active_weeks: "4",
                base_stock: "15",
                pending_order_quantity: "8", // Existen 8 en pedido, pero la sugerencia NO los descuenta
                depot_committed_quantity: "0",
                history_cutoff_date: null,
                target_stock: "15",
                suggested_quantity: "10",
                status: "SUGGESTION_AVAILABLE",
                supply_mode: "DEPOT",
                total_rows: "1",
              },
            ],
          } as any;
        }
        return { rows: [] } as any;
      });

      const orderResult = await confirmInternalReplenishment({
        scope: { organizationId: 1, sourceId: "pv_centro", branchId: 2 },
        depotSourceId: "depot_central",
        planningDate: "2026-10-24",
        items: [{ article_id: 1001, requested_quantity: 10 }],
        actorId: "monica",
        idempotencyToken: "test-token-replenish-1",
      });

      expect(orderResult).toEqual({ id: 99, created: true });
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO orders"),
        expect.arrayContaining([1, "pv_centro", 2, 1, "2026-10-24"]),
      );
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO order_items"),
        expect.arrayContaining([
          99,
          1001,
          "Alfajor Guaymallen",
          10, // suggested_quantity
          10, // requested_quantity
          5,  // stock_current
          15, // target_stock
        ]),
      );
    });
  });
});
