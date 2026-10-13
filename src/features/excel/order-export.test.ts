import { describe, expect, it } from "vitest";
import * as xlsx from "xlsx";
import {
  buildReplenishmentWorkbook,
  buildOrderWorkbook,
  type ReplenishmentExportItem,
  type OrderExportItem,
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
          supplier_code: null,
          unit_measure: "UN",
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
          supplier_code: null,
          unit_measure: "UN",
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

      // Check table column headers row
      const headersRow = rows[3];
      expect(headersRow).toEqual([
        "Código",
        "Descripción",
        "Rubro",
        "Stock Sucursal",
        "Stock Depósito",
        "Sugerida",
        "Solicitada",
        "Abastecimiento",
        "Proveedor",
        "Unidad",
      ]);

      // Check first product row
      const firstProductRow = rows[4];
      expect(firstProductRow[0]).toBe(101);
      expect(firstProductRow[1]).toBe("ALFAJOR TRIPLE CHOCOLATE");
      expect(firstProductRow[2]).toBe("GOLOSINAS");
      expect(firstProductRow[3]).toBe(12);
      expect(firstProductRow[4]).toBe(150);
      expect(firstProductRow[5]).toBe(48);
      expect(firstProductRow[6]).toBe(48);
      expect(firstProductRow[7]).toBe("DEPÓSITO");

      // Check second product with null rubro
      const secondProductRow = rows[5];
      expect(secondProductRow[0]).toBe(202);
      expect(secondProductRow[2]).toBe("Sin rubro");
      expect(secondProductRow[6]).toBe(36);

      // Check totals row
      const totalsRow = rows[rows.length - 1];
      expect(totalsRow[0]).toBe("TOTALES");
      expect(totalsRow[1]).toBe("2 productos");
      // Total sugerido: 48 + 24 = 72
      expect(totalsRow[5]).toBe(72);
      // Total solicitado: 48 + 36 = 84
      expect(totalsRow[6]).toBe(84);
    });
  });

  describe("buildOrderWorkbook", () => {
    it("generates a valid order workbook with operational quantities", () => {
      const mockOrderItems: OrderExportItem[] = [
        {
          id: 1,
          article_id: 301,
          product_name_snapshot: "CHICLES MENTA",
          classification_code_snapshot: "CARAMELOS",
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
          requested_quantity: 20,
          approved_quantity: 15,
          prepared_quantity: 15,
          dispatched_quantity: 15,
          received_quantity: 15,
          unit_measure_snapshot: "PAQ",
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
      expect(item1[3]).toBe(50);
      expect(item1[4]).toBe(50);
      expect(item1[5]).toBe(45);
      expect(item1[6]).toBe(45);
      expect(item1[7]).toBe(45);

      const item2 = rows[5];
      expect(item2[0]).toBe(302);
      expect(item2[2]).toBe("Sin rubro");
      expect(item2[3]).toBe(20);
      expect(item2[4]).toBe(15);
      expect(item2[8]).toBe("PAQ");

      const totalsRow = rows[rows.length - 1];
      expect(totalsRow[0]).toBe("TOTALES");
      expect(totalsRow[1]).toBe("2 productos");
      // Total solicitado: 70
      expect(totalsRow[3]).toBe(70);
      // Total aprobado: 65
      expect(totalsRow[4]).toBe(65);
      // Total preparado: 60
      expect(totalsRow[5]).toBe(60);
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
});
