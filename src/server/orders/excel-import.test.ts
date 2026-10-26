import { describe, expect, it, vi, beforeEach } from "vitest";
import * as xlsx from "xlsx";
import {
  parseOrderExcel,
  parseQuantityValue,
  isCategorySeparatorRow,
  generateOrderTemplateWorkbook,
  validateExcelAgainstCatalog,
  confirmOrderFromExcel,
} from "./excel-import";
import { RequestValidationError } from "@/server/validation/request";
import { query, withTransaction } from "@/server/db/client";

vi.mock("@/server/db/client", () => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
}));

describe("Importación de pedidos desde Excel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("1. parseQuantityValue", () => {
    it("parsea números directos", () => {
      expect(parseQuantityValue(12)).toBe(12);
      expect(parseQuantityValue(4.5)).toBe(4.5);
    });

    it("parsea strings con sufijo UNID (formato PEDIDO CENTRO)", () => {
      expect(parseQuantityValue("12 UNID")).toBe(12);
      expect(parseQuantityValue("48 UNID")).toBe(48);
      expect(parseQuantityValue("1000 UNID")).toBe(1000);
    });

    it("parsea strings con coma o punto decimal y sufijos", () => {
      expect(parseQuantityValue("12,5 u")).toBe(12.5);
      expect(parseQuantityValue("2.5 unidades")).toBe(2.5);
    });

    it("retorna null para cantidades inválidas o <= 0", () => {
      expect(parseQuantityValue(0)).toBeNull();
      expect(parseQuantityValue(-5)).toBeNull();
      expect(parseQuantityValue("0 UNID")).toBeNull();
      expect(parseQuantityValue("abc")).toBeNull();
      expect(parseQuantityValue("")).toBeNull();
      expect(parseQuantityValue(null)).toBeNull();
      expect(parseQuantityValue(undefined)).toBeNull();
    });
  });

  describe("2. isCategorySeparatorRow", () => {
    it("identifica filas de categorías como ALMACEN, CHOCOLATES", () => {
      expect(isCategorySeparatorRow(["ALMACEN"])).toBe(true);
      expect(isCategorySeparatorRow(["CHOCOLATES", null, null])).toBe(true);
      expect(isCategorySeparatorRow([null, "GALLETITAS"])).toBe(true);
    });

    it("no confunde filas con código o múltiples valores con separadores", () => {
      expect(isCategorySeparatorRow([2222, "ACEITE"])).toBe(false);
      expect(isCategorySeparatorRow(["2222", "ACEITE"])).toBe(false);
      expect(isCategorySeparatorRow([])).toBe(false);
    });
  });

  describe("3. parseOrderExcel - Archivo válido", () => {
    it("lee formato PEDIDO CENTRO con separadores de rubro y cantidades 'XX UNID'", () => {
      const aoa = [
        ["articulo", "descri", null, "stock", "PEDIDO"],
        ["ALMACEN"],
        [2222, "ACEITE CANUELAS 900cc (12)", null, 90, "12 UNID"],
        [11109, "ALICANTE-BICARBONATO 50G (12)", null, 222, "24 UNID"],
        ["FIGURITAS"],
        [5336, "ADRENALYN FIFA 2026 x12uni", null, 15, "10 UNID"],
      ];

      const wb = xlsx.utils.book_new();
      const ws = xlsx.utils.aoa_to_sheet(aoa);
      xlsx.utils.book_append_sheet(wb, ws, "Hoja1");
      const buffer = xlsx.write(wb, { type: "buffer", bookType: "xlsx" });

      const parsed = parseOrderExcel(buffer, "PEDIDO CENTRO.xlsx");
      expect(parsed.rows.length).toBe(3);
      expect(parsed.rows[0].articleId).toBe(2222);
      expect(parsed.rows[0].parsedQuantity).toBe(12);
      expect(parsed.rows[1].articleId).toBe(11109);
      expect(parsed.rows[1].parsedQuantity).toBe(24);
      expect(parsed.rows[2].articleId).toBe(5336);
      expect(parsed.rows[2].parsedQuantity).toBe(10);
      expect(parsed.fileHash).toBeDefined();
    });

    it("lee formato de plantilla con columnas Código, Descripción, Cantidad", () => {
      const aoa = [
        ["Código", "Descripción", "Cantidad"],
        [2222, "ACEITE CANUELAS", 10],
        [697, "FERRERO ROCHER", 5],
      ];

      const wb = xlsx.utils.book_new();
      const ws = xlsx.utils.aoa_to_sheet(aoa);
      xlsx.utils.book_append_sheet(wb, ws, "Pedido");
      const buffer = xlsx.write(wb, { type: "buffer", bookType: "xlsx" });

      const parsed = parseOrderExcel(buffer, "plantilla.xlsx");
      expect(parsed.rows.length).toBe(2);
      expect(parsed.rows[0].articleId).toBe(2222);
      expect(parsed.rows[0].parsedQuantity).toBe(10);
      expect(parsed.rows[1].articleId).toBe(697);
      expect(parsed.rows[1].parsedQuantity).toBe(5);
    });

    it("soporta formato CSV", () => {
      const csv = "articulo,descri,stock,PEDIDO\n2222,ACEITE,90,12 UNID\n11109,ALICANTE,222,6 UNID";
      const buffer = Buffer.from(csv, "utf-8");

      const parsed = parseOrderExcel(buffer, "pedido.csv");
      expect(parsed.rows.length).toBe(2);
      expect(parsed.rows[0].articleId).toBe(2222);
      expect(parsed.rows[0].parsedQuantity).toBe(12);
    });
  });

  describe("4. parseOrderExcel - Archivo vacío, corrupto o fuera de límites", () => {
    it("falla si el archivo excede los 10 MB", () => {
      const hugeBuffer = Buffer.alloc(11 * 1024 * 1024);
      expect(() => parseOrderExcel(hugeBuffer, "huge.xlsx")).toThrow(RequestValidationError);
      expect(() => parseOrderExcel(hugeBuffer, "huge.xlsx")).toThrow(/10 MB/);
    });

    it("falla si el archivo está corrupto", () => {
      const corrupt = Buffer.from("esto no es un zip ni un excel");
      expect(() => parseOrderExcel(corrupt, "bad.xlsx")).toThrow(RequestValidationError);
    });

    it("falla si la hoja está vacía", () => {
      const wb = xlsx.utils.book_new();
      const ws = xlsx.utils.aoa_to_sheet([]);
      xlsx.utils.book_append_sheet(wb, ws, "Vacia");
      const buffer = xlsx.write(wb, { type: "buffer", bookType: "xlsx" });
      expect(() => parseOrderExcel(buffer, "vacia.xlsx")).toThrow(RequestValidationError);
    });
  });

  describe("5. validateExcelAgainstCatalog - Validaciones de catálogo", () => {
    const mockScope = { organizationId: 1, sourceId: "pv_pos", branchId: 2 };

    it("valida productos existentes y detecta inexistentes, duplicados y cantidades inválidas", async () => {
      (query as any).mockResolvedValueOnce({
        rows: [
          {
            article_id: 2222,
            description: "ACEITE CANUELAS 900cc (12)",
            classification_code: "0114462",
            supplier_code: "50001",
            unit_measure: "UN",
            bulto: "12",
            stock_current: "90",
            depot_stock: "150",
            supply_mode: "DEPOT",
          },
          {
            article_id: 5336,
            description: "ADRENALYN FIFA 2026 x12uni",
            classification_code: "0170012",
            supplier_code: "50013",
            unit_measure: "UN",
            bulto: "12",
            stock_current: "5",
            depot_stock: "30",
            supply_mode: "DEPOT",
          },
        ],
      });

      const parsedRows = [
        // 1. Válido
        { rowNumber: 2, rawCode: "2222", rawDescription: "ACEITE", rawQuantity: "12 UNID", parsedQuantity: 12, articleId: 2222 },
        // 2. Producto inexistente
        { rowNumber: 3, rawCode: "99999", rawDescription: "INEXISTENTE", rawQuantity: "6 UNID", parsedQuantity: 6, articleId: 99999 },
        // 3. Cantidad inválida
        { rowNumber: 4, rawCode: "5336", rawDescription: "ADRENALYN", rawQuantity: "0", parsedQuantity: null, articleId: 5336 },
        // 4. Duplicado en el mismo archivo
        { rowNumber: 5, rawCode: "2222", rawDescription: "ACEITE", rawQuantity: "6 UNID", parsedQuantity: 6, articleId: 2222 },
      ];

      const result = await validateExcelAgainstCatalog(parsedRows, mockScope);

      // Resumen
      expect(result.summary.totalRows).toBe(4);
      expect(result.summary.validRows).toBe(2); // 1 válido + 1 duplicado con warning
      expect(result.summary.errorRows).toBe(2); // 1 inexistente + 1 cantidad inválida

      // Ítems validados
      expect(result.items.length).toBe(2);
      expect(result.items[0].articleId).toBe(2222);
      expect(result.items[0].status).toBe("VALID");
      expect(result.items[0].rubro).toBe("ALMACEN");

      // Duplicado marcado con status WARNING_DUPLICATE
      expect(result.items[1].articleId).toBe(2222);
      expect(result.items[1].status).toBe("WARNING_DUPLICATE");

      // No coincidentes / con errores
      expect(result.unmatchedRows.length).toBe(2);
      expect(result.unmatchedRows[0].rawCode).toBe("99999");
      expect(result.unmatchedRows[0].error).toContain("no encontrado");
      expect(result.unmatchedRows[1].rawCode).toBe("5336");
      expect(result.unmatchedRows[1].error).toContain("Cantidad inválida");
    });

    it("asocia correctamente productos de Figuritas con rubro 'FIGURITAS'", async () => {
      (query as any).mockResolvedValueOnce({
        rows: [
          {
            article_id: 5336,
            description: "ADRENALYN FIFA 2026 x12uni",
            classification_code: "0170012",
            supplier_code: "50013",
            unit_measure: "UN",
            bulto: "12",
            stock_current: "10",
            depot_stock: "50",
            supply_mode: "DEPOT",
          },
        ],
      });

      const parsedRows = [
        { rowNumber: 2, rawCode: "5336", rawDescription: "ADRENALYN", rawQuantity: "12 UNID", parsedQuantity: 12, articleId: 5336 },
      ];

      const result = await validateExcelAgainstCatalog(parsedRows, mockScope);
      expect(result.items[0].rubro).toBe("FIGURITAS");
      expect(result.items[0].catalogDescription).toBe("ADRENALYN FIFA 2026 x12uni");
    });
  });

  describe("6. confirmOrderFromExcel - Creación e idempotencia", () => {
    const mockScope = { organizationId: 1, sourceId: "pv_pos", branchId: 2 };

    it("crea un pedido exitosamente respetando las reglas del sistema", async () => {
      const mockClient = {
        query: vi.fn(),
      };

      // 1. Idempotency check: not found
      mockClient.query.mockResolvedValueOnce({ rows: [] });
      // 2. Catalog lookup for articles
      mockClient.query.mockResolvedValueOnce({
        rows: [
          {
            article_id: 2222,
            description: "ACEITE CANUELAS 900cc (12)",
            classification_code: "0114462",
            supplier_code: "50001",
            unit_measure: "UN",
            bulto: "12",
            stock_current: "90",
          },
        ],
      });
      // 3. Insert order
      mockClient.query.mockResolvedValueOnce({
        rows: [{ id: "25", order_number: "3" }],
      });
      // 4. Insert events
      mockClient.query.mockResolvedValueOnce({ rows: [] });
      // 5. Insert order item
      mockClient.query.mockResolvedValueOnce({ rows: [] });

      (withTransaction as any).mockImplementation(async (cb: any) => cb(mockClient));

      const result = await confirmOrderFromExcel({
        scope: mockScope,
        branchId: 2,
        planningDate: "2026-10-31",
        items: [{ article_id: 2222, requested_quantity: 12 }],
        notes: "PEDIDO CENTRO 12-9.xlsx",
        idempotencyToken: "token-12345",
        actorId: "1",
      });

      expect(result.created).toBe(true);
      expect(result.id).toBe(25);
      expect(result.order_number).toBe(3);
      expect(result.total_units).toBe(12);
      expect(result.items_count).toBe(1);

      // Verify order creation SQL was called with INTERNAL_REPLENISHMENT and CONFIRMED
      const insertOrderCall = mockClient.query.mock.calls.find((call) =>
        typeof call[0] === "string" && call[0].includes("INSERT INTO orders")
      );
      expect(insertOrderCall).toBeDefined();
      expect(insertOrderCall![0]).toContain("'CONFIRMED'");
      expect(insertOrderCall![0]).toContain("'INTERNAL_REPLENISHMENT'");
      expect(insertOrderCall![1]).toContain(2); // origin branch 2
      expect(insertOrderCall![1]).toContain("2026-10-31"); // planning date
    });

    it("previene duplicados mediante token de idempotencia ante reintentos", async () => {
      const mockClient = {
        query: vi.fn(),
      };

      // Idempotency check: already exists!
      mockClient.query.mockResolvedValueOnce({
        rows: [{ id: "25", order_number: "3" }],
      });

      (withTransaction as any).mockImplementation(async (cb: any) => cb(mockClient));

      const result = await confirmOrderFromExcel({
        scope: mockScope,
        branchId: 2,
        planningDate: "2026-10-31",
        items: [{ article_id: 2222, requested_quantity: 12 }],
        idempotencyToken: "token-12345",
        actorId: "1",
      });

      expect(result.created).toBe(false);
      expect(result.id).toBe(25);
      expect(result.order_number).toBe(3);
      // No order insert was executed
      const insertCalls = mockClient.query.mock.calls.filter((call) =>
        typeof call[0] === "string" && call[0].includes("INSERT INTO orders")
      );
      expect(insertCalls.length).toBe(0);
    });

    it("falla si no hay ítems válidos para importar", async () => {
      await expect(
        confirmOrderFromExcel({
          scope: mockScope,
          branchId: 2,
          planningDate: "2026-10-31",
          items: [],
          idempotencyToken: "empty-token",
          actorId: "1",
        })
      ).rejects.toThrow(RequestValidationError);
    });
  });

  describe("7. generateOrderTemplateWorkbook - Plantilla Excel", () => {
    it("genera un archivo Excel válido con hojas 'Pedido' e 'Instrucciones'", () => {
      const buffer = generateOrderTemplateWorkbook();
      expect(buffer).toBeInstanceOf(Buffer);

      const wb = xlsx.read(buffer, { type: "buffer" });
      expect(wb.SheetNames).toContain("Pedido");
      expect(wb.SheetNames).toContain("Instrucciones");

      const orderSheet = wb.Sheets["Pedido"];
      const rows = xlsx.utils.sheet_to_json<any[]>(orderSheet, { header: 1 });
      expect(rows[0]).toEqual(["Código", "Descripción", "Cantidad", "Observaciones"]);
      expect(rows.length).toBeGreaterThan(3);
    });
  });
});
