import { describe, expect, it, vi, beforeEach } from "vitest";
import * as xlsx from "xlsx";
import { parseOrderExcel, validateExcelAgainstCatalog, confirmOrderFromExcel } from "./excel-import";
import { query, withTransaction } from "@/server/db/client";
import { POST as previewHandler } from "@/app/api/orders/import-excel/preview/route";
import { POST as confirmHandler } from "@/app/api/orders/import-excel/confirm/route";
import { getAuthorizedContext, getAuthorizedScope } from "@/server/auth/scope";
import { canConfirmReplenishment } from "@/server/auth/policies";
import { NextRequest } from "next/server";

vi.mock("@/server/db/client", () => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
}));

vi.mock("@/server/auth/scope", () => ({
  getAuthorizedContext: vi.fn(),
  getAuthorizedScope: vi.fn(),
}));

vi.mock("@/server/auth/policies", () => ({
  canConfirmReplenishment: vi.fn(),
}));

describe("Integration: Ciclo Completo de Importación de Pedidos desde Excel", () => {
  const branchId = 2; // PV Centro
  const depotBranchId = 1; // Depósito Central
  const planningDate = "2026-10-31";
  const mockScope = { organizationId: 1, sourceId: "pv_centro", branchId };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("ejecuta el recorrido completo de previsualización, corrección y confirmación sin modificar inventario", async () => {
    // -------------------------------------------------------------------------
    // 1. Crear un libro Excel real en memoria con casos del negocio
    // -------------------------------------------------------------------------
    const rowsData = [
      ["articulo", "descri", "stock", "PEDIDO"],
      ["FIGURITAS"], // Fila separadora temática (debe ser ignorada automáticamente)
      [170012, "ALBUM MUNDIAL 2026", 5, "10 UNID"], // Figuritas (prefijo 017)
      [173632, "PAQUETE FIGURITAS MUNDIAL", 20, "100 UNID"], // Figuritas (prefijo 017)
      [2222, "ACEITE CANUELAS 900cc", 2, "12 UNID"], // Almacén normal
      [910002, "CIGARRILLOS DIRECTOS", 10, "50 UNID"], // Proveedor directo
      [2222, "ACEITE CANUELAS 900cc", 2, "6 UNID"], // Duplicado en el archivo
      [999999, "PRODUCTO DESCONOCIDO", 0, "5 UNID"], // Inexistente en catálogo
      [11109, "ALICANTE BICARBONATO", 1, "0 UNID"], // Cantidad inválida (0)
      [null, null, null, null], // Fila vacía
    ];

    const wb = xlsx.utils.book_new();
    const ws = xlsx.utils.aoa_to_sheet(rowsData);
    xlsx.utils.book_append_sheet(wb, ws, "PEDIDO");
    const excelBuffer = xlsx.write(wb, { type: "buffer", bookType: "xlsx" });

    // -------------------------------------------------------------------------
    // 2. Simular Catálogo de la sucursal en PostgreSQL
    // -------------------------------------------------------------------------
    const mockCatalogDb = [
      {
        article_id: 170012,
        description: "ALBUM MUNDIAL 2026",
        classification_code: "0170012",
        supplier_code: "50013",
        unit_measure: "UN",
        bulto: "10",
        stock_current: "5",
        depot_stock: "25",
        supply_mode: "DEPOT",
      },
      {
        article_id: 173632,
        description: "PAQUETE FIGURITAS MUNDIAL",
        classification_code: "0173632",
        supplier_code: "50013",
        unit_measure: "SOBRE",
        bulto: "50",
        stock_current: "20",
        depot_stock: "500",
        supply_mode: "DEPOT",
      },
      {
        article_id: 2222,
        description: "ACEITE CANUELAS 900cc",
        classification_code: "0114462",
        supplier_code: "50001",
        unit_measure: "UN",
        bulto: "12",
        stock_current: "2",
        depot_stock: "100",
        supply_mode: "DEPOT",
      },
      {
        article_id: 910002,
        description: "CIGARRILLOS DIRECTOS",
        classification_code: "0010012",
        supplier_code: "50099",
        unit_measure: "ATADO",
        bulto: "10",
        stock_current: "10",
        depot_stock: "0",
        supply_mode: "DIRECT_SUPPLIER",
      },
      {
        article_id: 11109,
        description: "ALICANTE BICARBONATO",
        classification_code: "0114462",
        supplier_code: "50002",
        unit_measure: "UN",
        bulto: "24",
        stock_current: "1",
        depot_stock: "50",
        supply_mode: "DEPOT",
      },
    ];

    (query as any).mockImplementation(async (sql: string) => {
      if (sql.includes("FROM products_raw")) {
        return { rows: mockCatalogDb };
      }
      return { rows: [] };
    });

    // -------------------------------------------------------------------------
    // 3. Fase de Previsualización: parseo y validación de reglas
    // -------------------------------------------------------------------------
    const parsed = parseOrderExcel(excelBuffer, "PEDIDO CENTRO 12-9.xlsx");
    // Se omitió la fila 'FIGURITAS' y la fila vacía
    expect(parsed.rows.length).toBe(7);

    const validation = await validateExcelAgainstCatalog(parsed.rows, mockScope);

    // Resumen de validaciones
    expect(validation.summary.totalRows).toBe(7);
    expect(validation.summary.errorRows).toBe(2); // 999999 (inexistente) y 11109 (0 unidades)
    expect(validation.summary.warningRows).toBe(2); // 2222 duplicado y 910002 proveedor directo
    expect(validation.summary.validRows).toBe(5);

    // Verificación de rubro FIGURITAS
    const figuAlbum = validation.items.find((i) => i.articleId === 170012);
    expect(figuAlbum).toBeDefined();
    expect(figuAlbum?.rubro).toBe("FIGURITAS");
    expect(figuAlbum?.status).toBe("VALID");
    expect(figuAlbum?.requestedQuantity).toBe(10);

    const figuSobre = validation.items.find((i) => i.articleId === 173632);
    expect(figuSobre).toBeDefined();
    expect(figuSobre?.rubro).toBe("FIGURITAS");
    expect(figuSobre?.requestedQuantity).toBe(100);

    // Verificación de advertencia Proveedor Directo
    const directProd = validation.items.find((i) => i.articleId === 910002);
    expect(directProd).toBeDefined();
    expect(directProd?.message).toContain("PROVEEDOR DIRECTO");

    // Verificación de advertencia Duplicado
    const duplicates = validation.items.filter((i) => i.articleId === 2222);
    expect(duplicates.length).toBe(2);
    expect(duplicates[1].status).toBe("WARNING_DUPLICATE");

    // Verificación de filas con error
    expect(validation.unmatchedRows.length).toBe(2);
    expect(validation.unmatchedRows[0].rawCode).toBe("999999");
    expect(validation.unmatchedRows[0].error).toContain("no encontrado");
    expect(validation.unmatchedRows[1].rawCode).toBe("11109");
    expect(validation.unmatchedRows[1].error).toContain("Cantidad inválida");

    // -------------------------------------------------------------------------
    // 4. Fase de Confirmación: Mónica aprueba los ítems válidos (excluye errores)
    // -------------------------------------------------------------------------
    const itemsToConfirm = validation.items
      .filter((i) => i.requestedQuantity > 0)
      .map((i) => ({
        article_id: i.articleId,
        requested_quantity: i.requestedQuantity,
      }));

    // Simulación de transacción PostgreSQL en memoria
    const executedQueries: Array<{ sql: string; values: any[] }> = [];
    const mockTxClient = {
      query: vi.fn().mockImplementation(async (sql: string, values: any[]) => {
        executedQueries.push({ sql, values });

        // Idempotency check: primera vez, no existe
        if (sql.includes("SELECT id, order_number FROM orders WHERE idempotency_key")) {
          return { rows: [] };
        }
        // Catalog lookup for articles
        if (sql.includes("FROM products_raw p")) {
          return { rows: mockCatalogDb };
        }
        // Insert order
        if (sql.includes("INSERT INTO orders")) {
          return { rows: [{ id: "1042", order_number: "42" }] };
        }
        // Insert events or order_items
        return { rows: [] };
      }),
    };

    (withTransaction as any).mockImplementation(async (callback: any) => {
      return callback(mockTxClient);
    });

    const idempotencyToken = `${branchId}:${planningDate}:${parsed.fileHash}`;

    const orderResult = await confirmOrderFromExcel({
      scope: mockScope,
      branchId,
      planningDate,
      items: itemsToConfirm,
      notes: "PEDIDO CENTRO 12-9.xlsx",
      fileHash: parsed.fileHash,
      idempotencyToken,
      actorId: "usr_monica",
    });

    // -------------------------------------------------------------------------
    // 5. Validaciones de Integridad y Reglas de Negocio
    // -------------------------------------------------------------------------
    expect(orderResult.created).toBe(true);
    expect(orderResult.id).toBe(1042);
    expect(orderResult.order_number).toBe(42);
    expect(orderResult.items_count).toBe(5);

    // 5a. Verificación del INSERT INTO orders:
    // - order_type = 'INTERNAL_REPLENISHMENT'
    // - status = 'CONFIRMED'
    // - destination_branch_id = 1 (Depósito Central)
    const orderInsert = executedQueries.find((q) => q.sql.includes("INSERT INTO orders"));
    expect(orderInsert).toBeDefined();
    expect(orderInsert!.sql).toContain("'CONFIRMED'");
    expect(orderInsert!.sql).toContain("'INTERNAL_REPLENISHMENT'");
    expect(orderInsert!.sql).toContain(`origin_branch_id, destination_branch_id, planning_date`);
    expect(orderInsert!.values).toContain(branchId);
    expect(orderInsert!.values).toContain(planningDate);
    expect(orderInsert!.values).toContain(`excel-import:${idempotencyToken}`);

    // 5b. Verificación de los eventos registrados: ORDER_CREATED y ORDER_CONFIRMED
    const eventsInsert = executedQueries.find((q) => q.sql.includes("INSERT INTO order_events"));
    expect(eventsInsert).toBeDefined();
    expect(eventsInsert!.sql).toContain("ORDER_CREATED");
    expect(eventsInsert!.sql).toContain("ORDER_CONFIRMED");

    // 5c. Verificación de los renglones en order_items:
    const itemInserts = executedQueries.filter((q) => q.sql.includes("INSERT INTO order_items"));
    expect(itemInserts.length).toBe(5);

    // 5d. REGLA CRÍTICA: Ninguna consulta debe modificar 'stock_levels_raw' (inventario)
    const stockMutations = executedQueries.filter(
      (q) =>
        (q.sql.includes("UPDATE") || q.sql.includes("DELETE") || q.sql.includes("INSERT INTO")) &&
        q.sql.includes("stock_levels_raw")
    );
    expect(stockMutations.length).toBe(0);

    // -------------------------------------------------------------------------
    // 6. Prueba de Idempotencia: reintento accidental con el mismo archivo
    // -------------------------------------------------------------------------
    const retryExecutedQueries: Array<{ sql: string; values: any[] }> = [];
    const mockRetryTxClient = {
      query: vi.fn().mockImplementation(async (sql: string, values: any[]) => {
        retryExecutedQueries.push({ sql, values });
        // En el reintento, el token ya existe en base de datos:
        if (sql.includes("SELECT id, order_number FROM orders WHERE idempotency_key")) {
          return { rows: [{ id: "1042", order_number: "42" }] };
        }
        return { rows: [] };
      }),
    };

    (withTransaction as any).mockImplementation(async (callback: any) => {
      return callback(mockRetryTxClient);
    });

    const retryResult = await confirmOrderFromExcel({
      scope: mockScope,
      branchId,
      planningDate,
      items: itemsToConfirm,
      idempotencyToken,
      actorId: "usr_monica",
    });

    expect(retryResult.created).toBe(false);
    expect(retryResult.id).toBe(1042);
    expect(retryResult.order_number).toBe(42);
    // Ningún pedido nuevo fue insertado
    const retryInserts = retryExecutedQueries.filter((q) => q.sql.includes("INSERT INTO orders"));
    expect(retryInserts.length).toBe(0);
  });

  it("rechaza el flujo si el usuario no tiene permisos sobre la sucursal", async () => {
    (getAuthorizedContext as any).mockResolvedValueOnce({
      userId: 44,
      organizationId: 1,
      memberships: [{ role: "PV_OPERATOR", branchId: 3 }], // branchId 3, pero pide branchId 2
    });
    (getAuthorizedScope as any).mockResolvedValueOnce({
      scope: { organizationId: 1, sourceId: "pv_otro", branchId: 3 },
    });
    (canConfirmReplenishment as any).mockReturnValueOnce(false);

    const req = new NextRequest("http://localhost:3000/api/orders/import-excel/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        branch_id: 2,
        planning_date: planningDate,
        items: [{ article_id: 2222, requested_quantity: 10 }],
        idempotency_token: "token-forbidden",
      }),
    });

    const res = await confirmHandler(req);
    expect(res.status).toBe(403);
  });
});
