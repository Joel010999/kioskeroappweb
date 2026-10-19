import { describe, expect, it } from "vitest";
import * as xlsx from "xlsx";
import {
  buildReplenishmentWorkbook,
  buildOrderWorkbook,
  resolveBranchStockHeader,
  collectRubroExportItems,
  type ReplenishmentExportItem,
  type OrderExportItem,
  type RawReplenishmentItem,
} from "./order-export";

describe("Excel Export Module", () => {
  describe("buildReplenishmentWorkbook", () => {
    it("generates a valid replenishment workbook with expected headers, data and totals", () => {
      const mockItems: ReplenishmentExportItem[] = [
        {
          article_id: 101,
          description: "ALFAJOR TRIPLE CHOCOLATE",
          rubro: "GOLOSINAS",
          classification_code: "GOLOSINAS",
          stock_current: 12,
          stock_depot: 150,
          suggested_quantity: 48,
          requested_quantity: 48,
          supply_mode: "DEPOT",
          supplier_code: "PROV1",
          unit_measure: "1 UN",
          package_units: 1,
        },
        {
          article_id: 202,
          description: "GASEOSA COLA 500ML",
          rubro: null,
          classification_code: null,
          stock_current: 5,
          stock_depot: 80,
          suggested_quantity: 24,
          requested_quantity: 36,
          supply_mode: "DEPOT",
          supplier_code: "PROV2",
          unit_measure: "1 UN",
          package_units: 6,
        },
      ];

      const wb = buildReplenishmentWorkbook({
        items: mockItems,
        branchLabel: "Centro (PV 2)",
        planningDate: "2026-10-15",
      });

      expect(wb.SheetNames).toContain("Reposición");
      const ws = wb.Sheets["Reposición"];
      expect(ws).toBeDefined();

      const rows = xlsx.utils.sheet_to_json<any[]>(ws, { header: 1 });
      expect(rows.length).toBeGreaterThan(5);

      // Check title header
      expect(rows[0][0]).toContain("LA CASA DEL KIOSKERO");
      expect(rows[1][0]).toContain("Centro (PV 2)");
      expect(rows[1][1]).toContain("2026-10-15");

      // Check table column headers row (9 columns: Stock Central and Stock Depósito)
      const headersRow = rows[3];
      expect(headersRow).toEqual([
        "Código",
        "Descripción",
        "Rubro",
        "Proveedor",
        "Presentación",
        "Stock Central",
        "Stock Depósito",
        "Sugerida",
        "Solicitada",
      ]);

      // Check first product row (GOLOSINAS appears before Sin rubro)
      const firstProductRow = rows[4];
      expect(firstProductRow[0]).toBe(101);
      expect(firstProductRow[1]).toBe("ALFAJOR TRIPLE CHOCOLATE");
      expect(firstProductRow[2]).toBe("GOLOSINAS");
      expect(firstProductRow[3]).toBe("PROV1");
      expect(firstProductRow[4]).toBe("Unidad");
      expect(firstProductRow[5]).toBe(12); // Stock Central
      expect(firstProductRow[6]).toBe(150); // Stock Depósito
      expect(firstProductRow[7]).toBe(48); // Sugerida
      expect(firstProductRow[8]).toBe(48); // Solicitada

      // Check second product with null rubro (placed at end under Sin rubro)
      const secondProductRow = rows[5];
      expect(secondProductRow[0]).toBe(202);
      expect(secondProductRow[2]).toBe("Sin rubro");
      expect(secondProductRow[4]).toBe("Bulto (6 u.)");
      expect(secondProductRow[5]).toBe(5); // Stock Central
      expect(secondProductRow[6]).toBe(80); // Stock Depósito
      expect(secondProductRow[7]).toBe(24); // Sugerida
      expect(secondProductRow[8]).toBe(36); // Solicitada

      // Check totals row
      const totalsRow = rows[rows.length - 1];
      expect(totalsRow[0]).toBe("TOTALES");
      expect(totalsRow[1]).toBe("2 productos");
      // Total sugerido: 48 + 24 = 72 (column index 7)
      expect(totalsRow[7]).toBe(72);
      // Total solicitado: 48 + 36 = 84 (column index 8)
      expect(totalsRow[8]).toBe(84);
    });

    it("strictly excludes Bulto (Equiv.), Abastecimiento, and Unidad from weekly replenishment export", () => {
      const items: ReplenishmentExportItem[] = [
        {
          article_id: 501,
          description: "CARAMELOS SURTIDOS",
          rubro: "CARAMELOS",
          supplier_code: "60642",
          unit_measure: "1 UN",
          package_units: 24,
          stock_current: 10,
          stock_depot: null,
          suggested_quantity: 24,
          requested_quantity: 48,
          supply_mode: "DEPOT",
        },
        {
          article_id: 502,
          description: "YERBA 1KG",
          rubro: "ALMACEN",
          supplier_code: null,
          unit_measure: "KG",
          package_units: 1,
          stock_current: 2.5,
          stock_depot: 15.5,
          suggested_quantity: 5,
          requested_quantity: 7.5,
          supply_mode: "DIRECT_SUPPLIER",
        },
      ];

      const wb = buildReplenishmentWorkbook({
        items,
        branchLabel: "Jardín (PV 3)",
        planningDate: "2026-10-24",
      });
      const ws = wb.Sheets["Reposición"];
      const rows = xlsx.utils.sheet_to_json<any[]>(ws, { header: 1 });
      const headers = rows[3];

      // Must be exactly 9 columns
      expect(headers).toHaveLength(9);
      expect(headers).toEqual([
        "Código",
        "Descripción",
        "Rubro",
        "Proveedor",
        "Presentación",
        "Stock Jardín",
        "Stock Depósito",
        "Sugerida",
        "Solicitada",
      ]);

      // Strict negative assertions
      expect(headers).not.toContain("Bulto (Equiv.)");
      expect(headers).not.toContain("Abastecimiento");
      expect(headers).not.toContain("Unidad");
      expect(headers).not.toContain("Stock Depósito Central");
      expect(headers).not.toContain("Stock Sucursal");
      expect(headers).toContain("Stock Jardín");
      expect(headers).toContain("Stock Depósito");

      // Verify row values
      const firstRow = rows[4]; // ALMACEN comes first alphabetically
      expect(firstRow[0]).toBe(502);
      expect(firstRow[2]).toBe("ALMACEN");
      expect(firstRow[3]).toBe("-"); // Null supplier rendered as -
      expect(firstRow[4]).toBe("Unidad");
      expect(firstRow[5]).toBe(2.5); // Preserves decimals in Stock Jardín
      expect(firstRow[6]).toBe(15.5); // Stock Depósito
      expect(firstRow[7]).toBe(5);
      expect(firstRow[8]).toBe(7.5);

      const secondRow = rows[5]; // CARAMELOS comes next
      expect(secondRow[0]).toBe(501);
      expect(secondRow[2]).toBe("CARAMELOS");
      expect(secondRow[3]).toBe("60642"); // Preserves ERP code
      expect(secondRow[4]).toBe("Bulto (24 u.)");
      expect(secondRow[5]).toBe(10); // Stock Jardín
      expect(secondRow[6]).toBe("-"); // Null depot stock rendered as -
      expect(secondRow[7]).toBe(24);
      expect(secondRow[8]).toBe(48);

      // Verify buffer serialization and round-trip parsing
      const buffer = xlsx.write(wb, { type: "buffer", bookType: "xlsx" });
      const parsedWb = xlsx.read(buffer, { type: "buffer" });
      const parsedWs = parsedWb.Sheets["Reposición"];
      const parsedRows = xlsx.utils.sheet_to_json<any[]>(parsedWs, { header: 1 });
      expect(parsedRows[3]).toEqual(headers);
    });

    it("sorts items alphabetically by rubro A-Z, then by product A-Z, with Sin rubro at the end", () => {
      const items: ReplenishmentExportItem[] = [
        {
          article_id: 1,
          description: "Yerba 500g",
          rubro: "ALMACEN",
          stock_current: 5,
          stock_depot: 20,
          suggested_quantity: 10,
          requested_quantity: 10,
          supply_mode: "DEPOT",
        },
        {
          article_id: 2,
          description: "Sin Rubro Item",
          rubro: "Sin rubro",
          stock_current: 1,
          stock_depot: 10,
          suggested_quantity: 2,
          requested_quantity: 2,
          supply_mode: "DEPOT",
        },
        {
          article_id: 3,
          description: "Aceite 900ml",
          rubro: "ALMACEN",
          stock_current: 3,
          stock_depot: 15,
          suggested_quantity: 5,
          requested_quantity: 5,
          supply_mode: "DEPOT",
        },
        {
          article_id: 4,
          description: "Chocolates Barra",
          rubro: "CHOCOLATES",
          stock_current: 2,
          stock_depot: 30,
          suggested_quantity: 8,
          requested_quantity: 8,
          supply_mode: "DEPOT",
        },
      ];

      const wb = buildReplenishmentWorkbook({
        items,
        branchLabel: "Centro",
        planningDate: "2026-10-15",
      });
      const ws = wb.Sheets["Reposición"];
      const rows = xlsx.utils.sheet_to_json<any[]>(ws, { header: 1 });
      const productRows = rows.slice(4, 8);

      expect(productRows.map((r) => r[1])).toEqual([
        "Aceite 900ml",      // ALMACEN (A)
        "Yerba 500g",        // ALMACEN (Y)
        "Chocolates Barra",  // CHOCOLATES
        "Sin Rubro Item",    // Sin rubro (at the end)
      ]);
    });
  });

  describe("buildOrderWorkbook", () => {
    it("generates a valid order workbook with operational quantities, provider, presentation and central depot stock", () => {
      const mockOrderItems: OrderExportItem[] = [
        {
          id: 1,
          article_id: 301,
          product_name_snapshot: "CHICLES MENTA",
          classification_code_snapshot: "CARAMELOS",
          supplier_code_snapshot: "50350",
          package_units: 1,
          stock_depot: 250,
          requested_quantity: 50,
          approved_quantity: 50,
          prepared_quantity: 45,
          dispatched_quantity: 45,
          received_quantity: 45,
          unit_measure_snapshot: "UN",
        },
        {
          id: 2,
          article_id: 302,
          product_name_snapshot: "PAPAS FRITAS 100G",
          classification_code_snapshot: null,
          supplier_code_snapshot: "600207",
          package_units: 18,
          stock_depot: 90,
          requested_quantity: 20,
          approved_quantity: 15,
          prepared_quantity: 15,
          dispatched_quantity: 15,
          received_quantity: 15,
          unit_measure_snapshot: "1 UN",
        },
      ];

      const wb = buildOrderWorkbook({
        orderId: 42,
        status: "Despachado",
        branchLabel: "Jardín (PV 3)",
        planningDate: "2026-10-15",
        items: mockOrderItems,
      });

      expect(wb.SheetNames).toContain("Pedido_42");
      const ws = wb.Sheets["Pedido_42"];
      expect(ws).toBeDefined();

      const rows = xlsx.utils.sheet_to_json<any[]>(ws, { header: 1 });
      expect(rows[0][0]).toContain("SOLICITUD DE PEDIDO #42");
      expect(rows[1][0]).toContain("Jardín (PV 3)");
      expect(rows[1][1]).toContain("Estado: Despachado");

      const headersRow = rows[3];
      expect(headersRow).toEqual([
        "Código",
        "Descripción",
        "Rubro",
        "Proveedor",
        "Presentación",
        "Bulto (Equiv.)",
        "Stock Jardín",
        "Stock Depósito",
        "Solicitado",
        "Aprobado",
        "Preparado",
        "Despachado",
        "Recibido",
        "Unidad",
      ]);

      const item1 = rows[4];
      expect(item1[0]).toBe(301);
      expect(item1[1]).toBe("CHICLES MENTA");
      expect(item1[2]).toBe("CARAMELOS");
      expect(item1[3]).toBe("50350");
      expect(item1[4]).toBe("Unidad");
      expect(item1[5]).toBe("-");
      expect(item1[6]).toBe("-"); // Stock Jardín
      expect(item1[7]).toBe(250); // Stock Depósito
      expect(item1[8]).toBe(50);
      expect(item1[9]).toBe(50);
      expect(item1[10]).toBe(45);
      expect(item1[11]).toBe(45);
      expect(item1[12]).toBe(45);

      const item2 = rows[5];
      expect(item2[0]).toBe(302);
      expect(item2[2]).toBe("Sin rubro");
      expect(item2[3]).toBe("600207");
      expect(item2[4]).toBe("Bulto (18 u.)");
      expect(item2[5]).toBe("18 u.");
      expect(item2[6]).toBe("-"); // Stock Jardín
      expect(item2[7]).toBe(90); // Stock Depósito
      expect(item2[8]).toBe(20);
      expect(item2[9]).toBe(15);
      expect(item2[13]).toBe("1 UN");

      const totalsRow = rows[rows.length - 1];
      expect(totalsRow[0]).toBe("TOTALES");
      expect(totalsRow[1]).toBe("2 productos");
      // Total solicitado: 70
      expect(totalsRow[8]).toBe(70);
      // Total aprobado: 65
      expect(totalsRow[9]).toBe(65);
      // Total preparado: 60
      expect(totalsRow[10]).toBe(60);
    });

    it("does not mutate original items array or object properties during export", () => {
      const originalItem: OrderExportItem = {
        id: 1,
        article_id: 501,
        product_name_snapshot: "BEBIDA COLA 2L",
        classification_code_snapshot: "BEBIDAS",
        requested_quantity: 10,
        approved_quantity: null,
        prepared_quantity: null,
        dispatched_quantity: null,
        received_quantity: null,
        unit_measure_snapshot: "UN",
      };
      const copy = { ...originalItem };

      buildOrderWorkbook({
        orderId: 99,
        status: "Borrador",
        branchLabel: "Centro",
        items: [originalItem],
      });

      expect(originalItem).toEqual(copy);
    });
  });

  describe("Excel buffer generation and Depot Import compatibility", () => {
    it("generates a valid, readable .xlsx binary buffer without mutating replenishment data", async () => {
      const { generateReplenishmentExcelBuffer } = await import("./order-export");
      const mockItems: ReplenishmentExportItem[] = [
        {
          article_id: 101,
          description: "ALFAJOR",
          rubro: "GOLOSINAS",
          classification_code: "GOLOSINAS",
          stock_current: 10,
          stock_depot: 50,
          suggested_quantity: 20,
          requested_quantity: 25,
          supply_mode: "DEPOT",
          supplier_code: "PROV1",
          unit_measure: "UN",
        },
      ];

      const buffer = generateReplenishmentExcelBuffer({
        items: mockItems,
        branchLabel: "PV 1",
        planningDate: "2026-10-18",
        title: "Productos Filtrados (GOLOSINAS)",
      });

      expect(buffer).toBeInstanceOf(Buffer);
      expect(buffer.length).toBeGreaterThan(100);

      const parsedWb = xlsx.read(buffer, { type: "buffer" });
      expect(parsedWb.SheetNames).toContain("Reposición");
      const ws = parsedWb.Sheets["Reposición"];
      const rows = xlsx.utils.sheet_to_json<any[]>(ws, { header: 1 });
      expect(rows[0][0]).toContain("PRODUCTOS FILTRADOS (GOLOSINAS)");
    });

    it("preserves exact compatibility with original depot stock Excel parser", async () => {
      const { parseDepotStockExcel } = await import("@/server/workspaces/excel");

      // Build simulated depot excel with columns [id, descripcion, stock]
      const wsData = [
        ["idarti", "descripcion", "saldo"],
        [101, "ALFAJOR TRIPLE", 150],
        [202, "GASEOSA COLA", 80],
        ["CABECERA_IGNORADA", null, null],
      ];
      const ws = xlsx.utils.aoa_to_sheet(wsData);
      const wb = xlsx.utils.book_new();
      xlsx.utils.book_append_sheet(wb, ws, "Stock");
      const buf = xlsx.write(wb, { type: "buffer", bookType: "xlsx" });

      const parsed = parseDepotStockExcel(buf);
      expect(parsed).toHaveLength(2);
      expect(parsed[0]).toEqual({
        articleId: 101,
        description: "ALFAJOR TRIPLE",
        stock: 150,
      });
      expect(parsed[1]).toEqual({
        articleId: 202,
        description: "GASEOSA COLA",
        stock: 80,
      });
    });
  });

  describe("resolveBranchStockHeader", () => {
    it("resolves Centro or Central variants to Stock Central", () => {
      expect(resolveBranchStockHeader("Centro")).toBe("Stock Central");
      expect(resolveBranchStockHeader("Centro (PV 2)")).toBe("Stock Central");
      expect(resolveBranchStockHeader("Central")).toBe("Stock Central");
      expect(resolveBranchStockHeader("CENTRO")).toBe("Stock Central");
    });

    it("resolves Jardín variants to Stock Jardín", () => {
      expect(resolveBranchStockHeader("Jardín")).toBe("Stock Jardín");
      expect(resolveBranchStockHeader("Jardín (PV 3)")).toBe("Stock Jardín");
      expect(resolveBranchStockHeader("Jardin")).toBe("Stock Jardín");
    });

    it("falls back to Stock Central if label is empty or undefined", () => {
      expect(resolveBranchStockHeader("")).toBe("Stock Central");
      expect(resolveBranchStockHeader(undefined)).toBe("Stock Central");
    });

    it("resolves custom branch names to Stock {Name}", () => {
      expect(resolveBranchStockHeader("Sucursal Norte")).toBe("Stock Sucursal Norte");
    });
  });

  describe("collectRubroExportItems (Multi-page rubro export)", () => {
    const branchId = "2";
    const planningDate = "2026-10-24";

    it("exports all products of a rubro distributed across two pages in a single operation", () => {
      // Page 1: 50 products in CHOCOLATES (ids 1001 to 1050)
      const page1: RawReplenishmentItem[] = Array.from({ length: 50 }, (_, i) => ({
        article_id: 1001 + i,
        description: `CHOCOLATE BARRA #${i + 1}`,
        rubro: "CHOCOLATES",
        classification_code: "006",
        stock_current: 10,
        stock_depot: 100,
        suggested_quantity: 12,
        requested_quantity: 12,
        supply_mode: "DEPOT",
      }));

      // Page 2: 25 products in CHOCOLATES (ids 1051 to 1075)
      const page2: RawReplenishmentItem[] = Array.from({ length: 25 }, (_, i) => ({
        article_id: 1051 + i,
        description: `CHOCOLATE BLANCO #${i + 1}`,
        rubro: "CHOCOLATES",
        classification_code: "006",
        stock_current: 5,
        stock_depot: 80,
        suggested_quantity: 6,
        requested_quantity: 6,
        supply_mode: "DEPOT",
      }));

      const allItems = [...page1, ...page2];

      const exported = collectRubroExportItems({
        items: allItems,
        branchId,
        planningDate,
        targetRubro: "CHOCOLATES",
      });

      // Verify all 75 items across page 1 and page 2 are present
      expect(exported.length).toBe(75);
      expect(exported.map((item) => item.article_id)).toEqual(
        allItems.map((item) => item.article_id),
      );
    });

    it("includes selected products from all pages and respects manual requested quantities", () => {
      const page1Item: RawReplenishmentItem = {
        article_id: 2001,
        description: "CHOCOLATE AGUILA 150G",
        rubro: "CHOCOLATES",
        classification_code: "006",
        stock_current: 2,
        stock_depot: 50,
        suggested_quantity: 6,
        requested_quantity: 6,
        supply_mode: "DEPOT",
      };

      const page2Item: RawReplenishmentItem = {
        article_id: 2002,
        description: "CHOCOLATE MILKA OREO",
        rubro: "CHOCOLATES",
        classification_code: "006",
        stock_current: 0,
        stock_depot: 120,
        suggested_quantity: 18,
        requested_quantity: 18,
        supply_mode: "DEPOT",
      };

      // Mónica manually adjusted page 1 item to 10
      const requestedMap: Record<string, number> = {
        [`${branchId}:${planningDate}:2001`]: 10,
      };

      const exported = collectRubroExportItems({
        items: [page1Item, page2Item],
        branchId,
        planningDate,
        targetRubro: "CHOCOLATES",
        requestedMap,
      });

      expect(exported.length).toBe(2);

      const exp1 = exported.find((i) => i.article_id === 2001);
      const exp2 = exported.find((i) => i.article_id === 2002);

      // Verifies manual modification is preserved
      expect(exp1?.requested_quantity).toBe(10);
      expect(exp1?.suggested_quantity).toBe(6);

      // Verifies page 2 item retains calculated suggestion
      expect(exp2?.requested_quantity).toBe(18);
      expect(exp2?.suggested_quantity).toBe(18);
    });

    it("excludes destildados, items from other rubros, direct suppliers, and zero quantities", () => {
      const items: RawReplenishmentItem[] = [
        // 1. Valid chocolate item (kept checked)
        {
          article_id: 3001,
          description: "CHOCOLATE COFLER BLOCK",
          rubro: "CHOCOLATES",
          classification_code: "006",
          stock_current: 5,
          stock_depot: 40,
          suggested_quantity: 12,
          requested_quantity: 12,
          supply_mode: "DEPOT",
        },
        // 2. Destildado item (Mónica unchecked this chocolate item on page 1)
        {
          article_id: 3002,
          description: "CHOCOLATE TOBLERONE",
          rubro: "CHOCOLATES",
          classification_code: "006",
          stock_current: 10,
          stock_depot: 30,
          suggested_quantity: 8,
          requested_quantity: 8,
          supply_mode: "DEPOT",
        },
        // 3. Destildado item on page 2 (Mónica unchecked this on page 2)
        {
          article_id: 3003,
          description: "CHOCOLATE FELFORT",
          rubro: "CHOCOLATES",
          classification_code: "006",
          stock_current: 15,
          stock_depot: 50,
          suggested_quantity: 6,
          requested_quantity: 6,
          supply_mode: "DEPOT",
        },
        // 4. Other rubro item (GOLOSINAS)
        {
          article_id: 3004,
          description: "CHICLE BUBBALOO",
          rubro: "GOLOSINAS",
          classification_code: "013",
          stock_current: 20,
          stock_depot: 200,
          suggested_quantity: 24,
          requested_quantity: 24,
          supply_mode: "DEPOT",
        },
        // 5. Direct supplier item (even with rubro CHOCOLATES)
        {
          article_id: 3005,
          description: "CHOCOLATE ARTESANAL LOCAL",
          rubro: "CHOCOLATES",
          classification_code: "006",
          stock_current: 3,
          stock_depot: null,
          suggested_quantity: 10,
          requested_quantity: 10,
          supply_mode: "DIRECT_SUPPLIER",
        },
        // 6. Zero requested item
        {
          article_id: 3006,
          description: "CHOCOLATE SIN DEMANDA",
          rubro: "CHOCOLATES",
          classification_code: "006",
          stock_current: 50,
          stock_depot: 20,
          suggested_quantity: 0,
          requested_quantity: 0,
          supply_mode: "DEPOT",
        },
      ];

      const selectedMap: Record<string, boolean> = {
        [`${branchId}:${planningDate}:3001`]: true,
        [`${branchId}:${planningDate}:3002`]: false, // Unchecked by user
        [`${branchId}:${planningDate}:3003`]: false, // Unchecked by user
      };

      const exported = collectRubroExportItems({
        items,
        branchId,
        planningDate,
        targetRubro: "CHOCOLATES",
        selectedMap,
      });

      // Only item 3001 should be included!
      expect(exported.length).toBe(1);
      expect(exported[0].article_id).toBe(3001);
      expect(exported.some((i) => i.article_id === 3002)).toBe(false);
      expect(exported.some((i) => i.article_id === 3003)).toBe(false);
      expect(exported.some((i) => i.article_id === 3004)).toBe(false);
      expect(exported.some((i) => i.article_id === 3005)).toBe(false);
      expect(exported.some((i) => i.article_id === 3006)).toBe(false);
    });

    it("eliminates duplicates when an item appears in multiple pages or responses", () => {
      const duplicatedItem: RawReplenishmentItem = {
        article_id: 4001,
        description: "CHOCOLATE DUPLICADO TEST",
        rubro: "CHOCOLATES",
        classification_code: "006",
        stock_current: 4,
        stock_depot: 50,
        suggested_quantity: 15,
        requested_quantity: 15,
        supply_mode: "DEPOT",
      };

      const page1 = [duplicatedItem];
      const page2 = [{ ...duplicatedItem }]; // duplicate in page 2

      const exported = collectRubroExportItems({
        items: [...page1, ...page2],
        branchId,
        planningDate,
        targetRubro: "CHOCOLATES",
      });

      expect(exported.length).toBe(1);
      expect(exported[0].article_id).toBe(4001);
    });
  });
});


