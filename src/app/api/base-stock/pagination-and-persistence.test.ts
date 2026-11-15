import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  listBranchBaseStock,
  upsertBranchBaseStock,
  type BranchBaseStockRow,
} from "@/server/base-stock/repository";
import type { Scope } from "@/server/analytics/types";
import { query } from "@/server/db/client";

vi.mock("@/server/db/client", () => ({
  query: vi.fn(),
}));

describe("Módulo Base Stock — Paginación Estable, Persistencia y No Regresión", () => {
  const scopeCentro: Scope = { organizationId: 1, sourceId: "pv_centro", branchId: 2 };
  const scopeJardin: Scope = { organizationId: 1, sourceId: "pv_jardin", branchId: 3 };

  // 75 productos sintéticos ordenados alfabéticamente (Pág 1: 1..25, Pág 2: 26..50, Pág 3: 51..75)
  // Cada uno tiene un código, descripción fija A-Z, proveedor y rubro
  const generateMockCatalog = () => {
    const list: Array<{
      article_id: number;
      description: string;
      brand: string;
      supplier_code: string;
      rubro: string;
      is_active: boolean;
      current_stock: string;
      depot_stock: string | null;
      erp_stopti: string | null;
      base_stock: string | null;
      notes: string | null;
      updated_at: string | null;
      history_cutoff_date: string | null;
      total_rows: string;
    }> = [];

    const rubros = ["Almacén", "Golosinas", "Bebidas", "Cigarrillos"];
    const suppliers = ["50350", "10020", "20030"];

    for (let i = 1; i <= 75; i++) {
      const pad = String(i).padStart(3, "0");
      list.push({
        article_id: 1000 + i,
        description: `PRODUCTO ART ${pad}`,
        brand: `MARCA ${pad}`,
        supplier_code: suppliers[(i - 1) % suppliers.length],
        rubro: rubros[(i - 1) % rubros.length],
        is_active: true,
        current_stock: "10",
        depot_stock: "50",
        erp_stopti: "15",
        base_stock: null,
        notes: null,
        updated_at: null,
        history_cutoff_date: null,
        total_rows: "75",
      });
    }
    return list;
  };

  // Base de datos simulada en memoria para branch_product_base_stock
  // Key: `${orgId}_${branchId}_${articleId}` -> { baseStock, notes, updatedAt }
  let inMemoryBaseStock: Map<string, { base_stock: number; notes: string | null; updated_at: string }>;
  let catalog: ReturnType<typeof generateMockCatalog>;

  beforeEach(() => {
    vi.clearAllMocks();
    inMemoryBaseStock = new Map();
    catalog = generateMockCatalog();

    // Mockeamos `query` para simular la persistencia y listado de PostgreSQL
    vi.mocked(query).mockImplementation(async (sql: string, params: any = []) => {
      // 1. MAIN CATALOG QUERY: Simula PostgreSQL con ORDER BY y LIMIT / OFFSET
      if (sql.includes("WITH stock_pv AS")) {
        const orgId = params[0];
        const branchId = params[2];
        const limit = params[5] ?? 25;
        const offset = params[6] ?? 0;

        // Adjuntar estado de base_stock actual desde la memoria
        let filtered = catalog.map((item) => {
          const key = `${orgId}_${branchId}_${item.article_id}`;
          const saved = inMemoryBaseStock.get(key);
          return {
            ...item,
            base_stock: saved ? String(saved.base_stock) : null,
            notes: saved ? saved.notes : null,
            updated_at: saved ? saved.updated_at : null,
          };
        });

        // Filtrado por proveedor si aplica
        if (params.length > 7 && sql.includes("AND supplier_code = $")) {
          const sup = params[params.length - 1];
          filtered = filtered.filter((i) => i.supplier_code === sup);
        }

        // Ordenamiento estable corregido:
        // is_active DESC, LOWER(description) ASC, article_id ASC
        filtered.sort((a, b) => {
          if (a.is_active !== b.is_active) return a.is_active ? -1 : 1;
          const descCmp = a.description.toLowerCase().localeCompare(b.description.toLowerCase());
          if (descCmp !== 0) return descCmp;
          return a.article_id - b.article_id;
        });

        const totalFiltered = filtered.length;
        const pageSlice = filtered.slice(offset, offset + limit).map((r) => ({
          ...r,
          total_rows: String(totalFiltered),
        }));

        return { rows: pageSlice } as any;
      }

      // 2. UPSERT (INSERT ... ON CONFLICT DO UPDATE)
      if (sql.includes("INSERT INTO branch_product_base_stock")) {
        const [orgId, branchId, articleId, baseStock, notes] = params;
        const key = `${orgId}_${branchId}_${articleId}`;
        const record = {
          base_stock: Number(baseStock),
          notes: notes ?? null,
          updated_at: new Date().toISOString(),
        };
        inMemoryBaseStock.set(key, record);
        return {
          rows: [
            {
              base_stock: String(record.base_stock),
              notes: record.notes,
            },
          ],
        } as any;
      }

      // 3. DELETE FROM branch_product_base_stock (Quitar base stock)
      if (sql.includes("DELETE FROM branch_product_base_stock")) {
        const [orgId, branchId, articleId] = params;
        const key = `${orgId}_${branchId}_${articleId}`;
        inMemoryBaseStock.delete(key);
        return { rows: [] } as any;
      }

      // 4. SUMMARY QUERY
      if (sql.includes("COUNT(*) FILTER")) {
        const branchId = params[2];
        let configuredCount = 0;
        let zeroCount = 0;
        catalog.forEach((item) => {
          const key = `1_${branchId}_${item.article_id}`;
          const existing = inMemoryBaseStock.get(key);
          if (existing !== undefined) {
            configuredCount++;
            if (existing.base_stock === 0) zeroCount++;
          }
        });
        return {
          rows: [
            {
              total_active: String(catalog.length),
              configured_count: String(configuredCount),
              unconfigured_count: String(catalog.length - configuredCount),
              zero_count: String(zeroCount),
            },
          ],
        } as any;
      }

      // 5. DISTINCT RUBROS / SUPPLIERS
      if (sql.includes("SELECT DISTINCT") && sql.includes("AS rubro")) {
        return { rows: [{ rubro: "Almacén" }, { rubro: "Golosinas" }] } as any;
      }
      if (sql.includes("SELECT DISTINCT") && sql.includes("AS supplier")) {
        return { rows: [{ supplier: "50350" }, { supplier: "10020" }] } as any;
      }

      // 6. DETECT SNAPSHOT MISMATCHES
      if (sql.includes("order_snapshot_diff") || sql.includes("order_snapshot_items")) {
        return { rows: [] } as any;
      }

      return { rows: [] } as any;
    });
  });

  it("Escenario 1: Editar y guardar un producto entre los primeros 50 (Página 1)", async () => {
    // Listar página 1 (artículos 1 a 25)
    const page1Before = await listBranchBaseStock(scopeCentro, "depot_src", { limit: 25, offset: 0 });
    expect(page1Before.rows).toHaveLength(25);
    const targetProduct = page1Before.rows[0];
    expect(targetProduct.article_id).toBe(1001);
    expect(targetProduct.base_stock).toBeNull();
    expect(targetProduct.is_configured).toBe(false);

    // Guardar stock base = 12 para el producto 1001 en Centro
    const upsertRes = await upsertBranchBaseStock(scopeCentro, {
      articleId: 1001,
      baseStock: 12,
      notes: "Stock mínimo góndola",
      actorId: "usr_monica",
    });
    expect(upsertRes.article_id).toBe(1001);
    expect(upsertRes.base_stock).toBe(12);
    expect(upsertRes.is_configured).toBe(true);

    // Reconsultar página 1: el producto persiste en su posición exacta sin alterar la lista
    const page1After = await listBranchBaseStock(scopeCentro, "depot_src", { limit: 25, offset: 0 });
    expect(page1After.rows[0].article_id).toBe(1001);
    expect(page1After.rows[0].base_stock).toBe(12);
    expect(page1After.rows[0].is_configured).toBe(true);
    expect(page1After.rows[0].notes).toBe("Stock mínimo góndola");

    // Verificar que los otros 24 productos de la página 1 no sufrieron cambios
    for (let i = 1; i < 25; i++) {
      expect(page1After.rows[i].article_id).toBe(page1Before.rows[i].article_id);
      expect(page1After.rows[i].base_stock).toBeNull();
    }
  });

  it("Escenario 2: Pasar a la segunda página (artículos 26..50) y guardar otro producto", async () => {
    // Listar página 2 (offset 25)
    const page2Before = await listBranchBaseStock(scopeCentro, "depot_src", { limit: 25, offset: 25 });
    expect(page2Before.rows).toHaveLength(25);
    const targetProduct = page2Before.rows[4]; // artículo 30 (1030)
    expect(targetProduct.article_id).toBe(1030);

    // Guardar stock base = 20 para artículo 1030
    await upsertBranchBaseStock(scopeCentro, {
      articleId: 1030,
      baseStock: 20,
      actorId: "usr_monica",
    });

    // Reconsultar página 2: artículo 1030 continúa en la página 2 con su valor 20
    const page2After = await listBranchBaseStock(scopeCentro, "depot_src", { limit: 25, offset: 25 });
    expect(page2After.rows[4].article_id).toBe(1030);
    expect(page2After.rows[4].base_stock).toBe(20);
    expect(page2After.rows[4].is_configured).toBe(true);

    // Verificar que la página 1 no fue afectada
    const page1 = await listBranchBaseStock(scopeCentro, "depot_src", { limit: 25, offset: 0 });
    expect(page1.rows.find((r) => r.article_id === 1030)).toBeUndefined();
  });

  it("Escenario 3: Pasar a una página posterior (Página 3, productos 51..75) y guardar un producto SIN que salte de página", async () => {
    // Simular que Mónica ya tiene 50 productos cargados (escenario exacto reportado)
    for (let i = 1; i <= 50; i++) {
      inMemoryBaseStock.set(`1_2_${1000 + i}`, {
        base_stock: 10,
        notes: null,
        updated_at: new Date().toISOString(),
      });
    }

    // Mónica avanza a la Página 3 (offset 50): productos 1051 a 1075
    const page3Before = await listBranchBaseStock(scopeCentro, "depot_src", { limit: 25, offset: 50 });
    expect(page3Before.rows).toHaveLength(25);
    expect(page3Before.rows[0].article_id).toBe(1051);
    expect(page3Before.rows[0].base_stock).toBeNull(); // sin configurar

    // Mónica edita y guarda el primer producto de la página 3 (artículo 1051)
    const saveRes = await upsertBranchBaseStock(scopeCentro, {
      articleId: 1051,
      baseStock: 8,
      actorId: "usr_monica",
    });
    expect(saveRes.base_stock).toBe(8);

    // CRÍTICO: Reconsultar página 3 (offset 50)
    // Con la ordenación estable, el producto 1051 PERMANECE EN LA PÁGINA 3 (posición 0 de la página)
    // y NO salta a la página 1 o 2.
    const page3After = await listBranchBaseStock(scopeCentro, "depot_src", { limit: 25, offset: 50 });
    expect(page3After.rows[0].article_id).toBe(1051);
    expect(page3After.rows[0].base_stock).toBe(8);
    expect(page3After.rows[0].is_configured).toBe(true);

    // Los productos posteriores de la página 3 (1052..1075) conservan sus posiciones intactas
    expect(page3After.rows[1].article_id).toBe(1052);
    expect(page3After.rows[24].article_id).toBe(1075);
  });

  it("Escenario 4: Cambiar de proveedor y guardar", async () => {
    // Filtrar catálogo por proveedor "50350"
    const supList = await listBranchBaseStock(scopeCentro, "depot_src", {
      supplier: "50350",
      limit: 25,
      offset: 0,
    });
    expect(supList.rows.length).toBeGreaterThan(0);
    const p1 = supList.rows[0];
    expect(p1.supplier_code).toBe("50350");

    // Guardar stock base = 15 para producto de proveedor 50350
    await upsertBranchBaseStock(scopeCentro, {
      articleId: p1.article_id,
      baseStock: 15,
      actorId: "usr_monica",
    });

    // Reconsultar con filtro de proveedor 50350
    const supListAfter = await listBranchBaseStock(scopeCentro, "depot_src", {
      supplier: "50350",
      limit: 25,
      offset: 0,
    });
    const updated = supListAfter.rows.find((r) => r.article_id === p1.article_id);
    expect(updated).toBeDefined();
    expect(updated?.base_stock).toBe(15);
    expect(updated?.is_configured).toBe(true);
  });

  it("Escenario 5: Cambiar de sucursal y guardar de forma estrictamente aislada", async () => {
    const articleId = 1010;

    // Configurar en Centro (branch 2) con stock base = 35
    await upsertBranchBaseStock(scopeCentro, {
      articleId,
      baseStock: 35,
      actorId: "usr_monica",
    });

    // Configurar en Jardín (branch 3) con stock base = 12
    await upsertBranchBaseStock(scopeJardin, {
      articleId,
      baseStock: 12,
      actorId: "usr_monica",
    });

    // Comprobar que Centro mantiene 35 y Jardín mantiene 12
    const centroView = await listBranchBaseStock(scopeCentro, "depot_src", { limit: 25, offset: 0 });
    const jardinView = await listBranchBaseStock(scopeJardin, "depot_src", { limit: 25, offset: 0 });

    const pCentro = centroView.rows.find((r) => r.article_id === articleId);
    const pJardin = jardinView.rows.find((r) => r.article_id === articleId);

    expect(pCentro?.base_stock).toBe(35);
    expect(pJardin?.base_stock).toBe(12);

    // Modificar Jardín a 0 explícito
    await upsertBranchBaseStock(scopeJardin, {
      articleId,
      baseStock: 0,
      actorId: "usr_monica",
    });

    // Centro NO se altera
    const centroViewAfter = await listBranchBaseStock(scopeCentro, "depot_src", { limit: 25, offset: 0 });
    const jardinViewAfter = await listBranchBaseStock(scopeJardin, "depot_src", { limit: 25, offset: 0 });

    expect(centroViewAfter.rows.find((r) => r.article_id === articleId)?.base_stock).toBe(35);
    expect(jardinViewAfter.rows.find((r) => r.article_id === articleId)?.base_stock).toBe(0);
  });

  it("Escenario 6: Recargar la página y comprobar que los valores guardados persisten", async () => {
    const articleId = 1060;

    // Guardar producto 1060 en página 3
    await upsertBranchBaseStock(scopeCentro, {
      articleId,
      baseStock: 42,
      notes: "Nota de persistencia",
      actorId: "usr_monica",
    });

    // Simular 3 recargas consecutivas de la página 3 (offset 50)
    for (let attempt = 1; attempt <= 3; attempt++) {
      const reload = await listBranchBaseStock(scopeCentro, "depot_src", { limit: 25, offset: 50 });
      const item = reload.rows.find((r) => r.article_id === articleId);
      expect(item).toBeDefined();
      expect(item?.base_stock).toBe(42);
      expect(item?.notes).toBe("Nota de persistencia");
      expect(item?.is_configured).toBe(true);
    }
  });

  it("Escenario 7: Volver a la página anterior y comprobar que no se alteraron otros productos ni hay contaminación cruzada", async () => {
    // Estado inicial en página 1
    const p1Initial = await listBranchBaseStock(scopeCentro, "depot_src", { limit: 25, offset: 0 });
    const p1Snapshot = p1Initial.rows.map((r) => ({ id: r.article_id, base: r.base_stock }));

    // Operamos intensivamente en Página 3 (productos 1055, 1065, 1070)
    await upsertBranchBaseStock(scopeCentro, { articleId: 1055, baseStock: 14, actorId: "usr_monica" });
    await upsertBranchBaseStock(scopeCentro, { articleId: 1065, baseStock: 28, actorId: "usr_monica" });
    await upsertBranchBaseStock(scopeCentro, { articleId: 1070, baseStock: 0, actorId: "usr_monica" });

    // Volvemos a Página 1 (offset 0)
    const p1After = await listBranchBaseStock(scopeCentro, "depot_src", { limit: 25, offset: 0 });

    // Verificar identidad 1:1 de los 25 productos de Página 1
    expect(p1After.rows).toHaveLength(25);
    for (let i = 0; i < 25; i++) {
      expect(p1After.rows[i].article_id).toBe(p1Snapshot[i].id);
      expect(p1After.rows[i].base_stock).toBe(p1Snapshot[i].base);
    }

    // Verificar que editar 1055 no modificó a su vecino 1054 ni a 1056
    const p3 = await listBranchBaseStock(scopeCentro, "depot_src", { limit: 25, offset: 50 });
    const neighborBefore = p3.rows.find((r) => r.article_id === 1054);
    const neighborAfter = p3.rows.find((r) => r.article_id === 1056);
    expect(neighborBefore?.base_stock).toBeNull();
    expect(neighborAfter?.base_stock).toBeNull();
  });
});
