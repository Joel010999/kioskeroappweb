import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { query } from "@/server/db/client";

vi.mock("@/server/db/client", () => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
}));

import {
  formatBuenosAiresDate,
  formatBuenosAiresDateTime,
  getBranchProvenance,
  calculateAgeHours,
} from "@/server/inventory/freshness";

import {
  queryProductStock,
  queryLowStock,
  queryDepositAvailability,
  queryStockAlerts,
  queryReplenishment,
} from "./queries";

import {
  formatStockResponse,
  formatDepositAvailabilityResponse,
  formatLowStockResponse,
  formatStockAlertsResponse,
  formatReplenishmentResponse,
} from "./formatters";

describe("Auditoría Crítica de Inventario: Conexión en Tiempo Real de Depósito y Detección de Regresiones", () => {
  const orgId = 1;
  // Reference server time: 2026-10-22T16:00:00.000Z
  const mockNow = new Date("2026-10-22T16:00:00.000Z");

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(mockNow);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("1. Determinación de Fuente y Frescura en Tiempo Real para Depósito", () => {
    it("identifica Depósito como LIVE_SYNC y CURRENT cuando la conexión en tiempo real (stock_levels_raw) está actualizada", async () => {
      vi.mocked(query).mockImplementation(async (sql: string) => {
        if (sql.includes("stock_snapshots")) {
          return {
            rows: [
              {
                id: "11",
                uploaded_at: "2026-10-16T19:22:18.674Z", // Old snapshot for reference
                original_filename: "STOCK DEPO 16-10.xlsx",
              },
            ],
          } as any;
        }
        if (sql.includes("stock_levels_raw") && sql.includes("MAX(sl.source_seen_at)")) {
          return {
            rows: [
              {
                last_seen: "2026-10-22T15:30:00.000Z", // 30 minutes ago in real time!
                row_count: "3489",
              },
            ],
          } as any;
        }
        return { rows: [] } as any;
      });

      const prov = await getBranchProvenance(1, orgId, mockNow);
      expect(prov.branchName).toBe("Depósito Central");
      expect(prov.sourceType).toBe("LIVE_SYNC");
      expect(prov.freshnessLevel).toBe("CURRENT");
      expect(prov.totalItems).toBe(3489);
      expect(prov.ageHours).toBeCloseTo(0.5, 1);
      // Historical snapshot metadata is preserved for reference, not for stock
      expect(prov.historicalSnapshot?.originalFilename).toBe("STOCK DEPO 16-10.xlsx");
    });

    it("identifica Depósito como OUTDATED si la última sincronización en tiempo real tiene demora", async () => {
      vi.mocked(query).mockImplementation(async (sql: string) => {
        if (sql.includes("stock_snapshots")) {
          return { rows: [] } as any;
        }
        if (sql.includes("stock_levels_raw") && sql.includes("MAX(sl.source_seen_at)")) {
          return {
            rows: [
              {
                last_seen: "2026-10-19T10:00:00.000Z", // 3 days ago
                row_count: "3489",
              },
            ],
          } as any;
        }
        return { rows: [] } as any;
      });

      const prov = await getBranchProvenance(1, orgId, mockNow);
      expect(prov.branchName).toBe("Depósito Central");
      expect(prov.freshnessLevel).toBe("OUTDATED");
      expect(prov.ageHours).toBeGreaterThan(48);
    });

    it("identifica Depósito como UNAVAILABLE si la base de datos o la conexión fallan", async () => {
      vi.mocked(query).mockRejectedValue(new Error("Database connection timed out"));

      const prov = await getBranchProvenance(1, orgId, mockNow);
      expect(prov.branchName).toBe("Depósito Central");
      expect(prov.freshnessLevel).toBe("UNAVAILABLE");
      expect(prov.lastUpdatedAt).toBeNull();
    });
  });

  describe("2. Caso Real: Velas Lunares (Art. 117, 139, 141, 142, 143) en Tiempo Real vs. Excel del 16/10", () => {
    it("utiliza el stock en tiempo real (stock_levels_raw branch_id 1) y NO el snapshot antiguo del Excel", async () => {
      // Mock database setup:
      // In Excel snapshot 11 (16/10/2026): Art 139 had 4 units.
      // In real-time stock_levels_raw: Art 139 is 0 units (AGOTADO)!
      vi.mocked(query).mockImplementation(async (sql: string) => {
        if (sql.includes("products_raw") && sql.includes("article_id = $2")) {
          return {
            rows: [
              {
                article_id: 139,
                description: "Velas Lunares Rosa X10",
                brand: null,
                rubro: "Cotillón",
                bulto: null,
              },
            ],
          } as any;
        }

        if (sql.includes("stock_snapshots")) {
          return {
            rows: [
              {
                id: "11",
                uploaded_at: "2026-10-16T19:22:18.674Z",
                original_filename: "STOCK DEPO 16-10.xlsx",
              },
            ],
          } as any;
        }

        if (sql.includes("stock_levels_raw") && sql.includes("MAX(sl.source_seen_at)")) {
          return {
            rows: [{ last_seen: "2026-10-22T15:00:00.000Z", row_count: "3489" }],
          } as any;
        }

        // Live stock query for article 139 across all branches:
        if (sql.includes("stock_levels_raw") && sql.includes("SUM(sl.saldo)")) {
          return {
            rows: [
              { article_id: 139, branch_id: 1, saldo: "0.000" }, // REAL TIME DEPOT: 0!
              { article_id: 139, branch_id: 2, saldo: "6.000" }, // Centro: 6
              { article_id: 139, branch_id: 3, saldo: "2.000" }, // Jardín: 2
            ],
          } as any;
        }

        return { rows: [] } as any;
      });

      const result = await queryProductStock({ articleId: 139 }, "ALL");
      expect(result.items.length).toBe(1);
      const velaRosa = result.items[0];

      // Verification: must reflect real-time stock (0), NOT 4 from snapshot!
      expect(velaRosa.articleId).toBe(139);
      expect(velaRosa.stockDepot).toBe(0); // 0 in real-time!
      expect(velaRosa.stockCentro).toBe(6);
      expect(velaRosa.stockJardin).toBe(2);
      expect(velaRosa.isDepotCurrent).toBe(true);

      // Formatted response
      const responseText = formatStockResponse(result, "ALL");

      // The bot MUST state "Depósito: Sin stock", NOT "4 u." from Excel!
      expect(responseText).toContain("• *Depósito:* Sin stock");
      expect(responseText).toContain("• *Centro:* 6 u.");
      expect(responseText).toContain("• *Jardín:* 2 u.");
      expect(responseText).not.toContain("4 u.");
    });

    it("Velas Lunares Negra (Art. 117): reporta 1 u. real en Depósito, no las 4 u. del Excel viejo", async () => {
      vi.mocked(query).mockImplementation(async (sql: string) => {
        if (sql.includes("products_raw") && sql.includes("article_id = $2")) {
          return {
            rows: [
              {
                article_id: 117,
                description: "Velas Lunares Negra X10",
                brand: null,
                rubro: "Cotillón",
                bulto: null,
              },
            ],
          } as any;
        }

        if (sql.includes("stock_snapshots")) {
          return {
            rows: [
              {
                id: "11",
                uploaded_at: "2026-10-16T19:22:18.674Z",
                original_filename: "STOCK DEPO 16-10.xlsx",
              },
            ],
          } as any;
        }

        if (sql.includes("stock_levels_raw") && sql.includes("MAX(sl.source_seen_at)")) {
          return {
            rows: [{ last_seen: "2026-10-22T15:00:00.000Z", row_count: "3489" }],
          } as any;
        }

        if (sql.includes("stock_levels_raw") && sql.includes("SUM(sl.saldo)")) {
          return {
            rows: [
              { article_id: 117, branch_id: 1, saldo: "1.000" }, // REAL TIME DEPOT: 1!
              { article_id: 117, branch_id: 2, saldo: "5.000" }, // Centro: 5
              { article_id: 117, branch_id: 3, saldo: "2.000" }, // Jardín: 2
            ],
          } as any;
        }

        return { rows: [] } as any;
      });

      const result = await queryProductStock({ articleId: 117 }, "ALL");
      const velaNegra = result.items[0];

      expect(velaNegra.stockDepot).toBe(1);
      const responseText = formatStockResponse(result, "ALL");
      expect(responseText).toContain("• *Depósito:* 1 u.");
      expect(responseText).not.toContain("4 u.");
    });
  });

  describe("3. Detección de Regresiones hacia Snapshots Históricos", () => {
    it("NUNCA recurre silenciosamente al Excel si la conexión en tiempo real de Depósito falla", async () => {
      vi.mocked(query).mockImplementation(async (sql: string) => {
        if (sql.includes("products_raw") && sql.includes("article_id = $2")) {
          return {
            rows: [
              {
                article_id: 117,
                description: "Velas Lunares Negra X10",
              },
            ],
          } as any;
        }

        // Snapshot exists with 4 units:
        if (sql.includes("stock_snapshots")) {
          return {
            rows: [
              {
                id: "11",
                uploaded_at: "2026-10-16T19:22:18.674Z",
                original_filename: "STOCK DEPO 16-10.xlsx",
              },
            ],
          } as any;
        }

        // Live connection fails for branch 1:
        if (sql.includes("stock_levels_raw") && sql.includes("sl.branch_id = $2")) {
          throw new Error("Warehouse connection offline");
        }

        return { rows: [] } as any;
      });

      const result = await queryProductStock({ articleId: 117 }, "ALL");
      const item = result.items[0];

      // Must be null, NOT the 4 units from Excel snapshot!
      expect(item.stockDepot).toBeNull();
      expect(item.isDepotCurrent).toBe(false);

      const responseText = formatStockResponse(result, "ALL");
      expect(responseText).toContain("• *Depósito:* Fuente no disponible en este momento");
      expect(responseText).not.toContain("4 u.");
    });

    it("un artículo sin registro en el sistema se informa como 'Sin registro en sistema', nunca como '0 u.'", () => {
      const result = {
        totalFound: 1,
        items: [
          {
            articleId: 9999,
            description: "Producto Fantasma",
            stockCentro: null,
            stockJardin: null,
            stockDepot: null,
            centroRecorded: false,
            jardinRecorded: false,
            depotRecorded: false,
            centroProvenance: {
              branchId: 2,
              branchName: "Centro" as const,
              sourceType: "LIVE_SYNC" as const,
              lastUpdatedAt: "2026-10-22T15:00:00.000Z",
              freshnessLevel: "CURRENT" as const,
              ageHours: 1,
              queriedAt: "2026-10-22T16:00:00.000Z",
            },
            jardinProvenance: {
              branchId: 3,
              branchName: "Jardín" as const,
              sourceType: "LIVE_SYNC" as const,
              lastUpdatedAt: "2026-10-22T15:00:00.000Z",
              freshnessLevel: "CURRENT" as const,
              ageHours: 1,
              queriedAt: "2026-10-22T16:00:00.000Z",
            },
            depotProvenance: {
              branchId: 1,
              branchName: "Depósito Central" as const,
              sourceType: "LIVE_SYNC" as const,
              lastUpdatedAt: "2026-10-22T15:00:00.000Z",
              freshnessLevel: "CURRENT" as const,
              ageHours: 1,
              queriedAt: "2026-10-22T16:00:00.000Z",
            },
          },
        ],
      };

      const responseText = formatStockResponse(result, "ALL");
      expect(responseText).toContain("• *Centro:* Sin registro en sistema");
      expect(responseText).toContain("• *Jardín:* Sin registro en sistema");
      expect(responseText).toContain("• *Depósito:* Sin registro en sistema");
      expect(responseText).not.toContain("0 u.");
    });
  });

  describe("4. Disponibilidad y Reposición con Depósito en Tiempo Real", () => {
    it("queryDepositAvailability consulta stock_levels_raw branch_id 1 y retorna productos disponibles", async () => {
      vi.mocked(query).mockImplementation(async (sql: string) => {
        if (sql.includes("stock_levels_raw") && sql.includes("MAX(sl.source_seen_at)")) {
          return {
            rows: [{ last_seen: "2026-10-22T15:00:00.000Z", row_count: "3489" }],
          } as any;
        }

        if (sql.includes("WITH depot_stock AS")) {
          // Verify that SQL queries stock_levels_raw for branch 1, NOT stock_snapshot_items!
          expect(sql).toContain("FROM stock_levels_raw sl");
          expect(sql).toContain("sl.branch_id = 1");
          expect(sql).not.toContain("stock_snapshot_items");

          return {
            rows: [
              {
                article_id: 117,
                description: "Velas Lunares Negra X10",
                rubro: "Cotillón",
                branch_stock: "0",
                depot_stock: "1.000",
              },
            ],
          } as any;
        }

        return { rows: [] } as any;
      });

      const res = await queryDepositAvailability(2, "Cotillón", 10);
      expect(res.isDepotCurrent).toBe(true);
      expect(res.items.length).toBe(1);
      expect(res.items[0].depotStock).toBe(1);

      const responseText = formatDepositAvailabilityResponse(res);
      expect(responseText).toContain("• *Velas Lunares Negra X10*");
      expect(responseText).toContain("Depósito: *1 u.*");
    });

    it("queryDepositAvailability rechaza afirmar disponibilidad si la conexión de Depósito está desactualizada", async () => {
      vi.mocked(query).mockImplementation(async (sql: string) => {
        if (sql.includes("stock_levels_raw") && sql.includes("MAX(sl.source_seen_at)")) {
          return {
            rows: [{ last_seen: "2026-10-18T10:00:00.000Z", row_count: "3489" }], // Outdated!
          } as any;
        }
        return { rows: [] } as any;
      });

      const res = await queryDepositAvailability(2);
      expect(res.isDepotCurrent).toBe(false);
      expect(res.items.length).toBe(0);

      const responseText = formatDepositAvailabilityResponse(res);
      expect(responseText).toContain("No es posible confirmar la disponibilidad actual en Depósito");
      expect(responseText).toContain("La conexión con la fuente de Depósito Central no se encuentra actualizada");
    });

    it("queryLowStock para Depósito (branch 1) consulta stock_levels_raw directamente sin recurrir a Excel", async () => {
      vi.mocked(query).mockImplementation(async (sql: string) => {
        if (sql.includes("stock_levels_raw") && sql.includes("MAX(sl.source_seen_at)")) {
          return {
            rows: [{ last_seen: "2026-10-22T15:00:00.000Z", row_count: "3489" }],
          } as any;
        }

        if (sql.includes("sources")) {
          return {
            rows: [{ source_id: "9cf93a89-de59-4e14-8b04-a7cc06690613" }],
          } as any;
        }

        if (sql.includes("stock_levels_raw") && sql.includes("ORDER BY") && sql.includes("LIMIT")) {
          // Direct stock_levels_raw query for low stock
          return {
            rows: [
              {
                article_id: 139,
                description: "Velas Lunares Rosa X10",
                saldo: "0.000",
              },
            ],
          } as any;
        }

        return { rows: [] } as any;
      });

      const res = await queryLowStock("DEPOSITO", 1, 5, "Cotillón");
      expect(res.branchName).toBe("Depósito Central");
      expect(res.isCurrent).toBe(true);
      expect(res.items.length).toBe(1);
      expect(res.items[0].saldo).toBe(0);
      expect(res.items[0].stockStatus).toBe("OUT_OF_STOCK");
    });
  });
});
