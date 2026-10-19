import { beforeEach, describe, expect, it, vi } from "vitest";
import * as xlsx from "xlsx";
import { parseUserMessage, resolveCanonicalRubroFromText } from "./router";
import { resolvePendingClarification, clearAllPendingClarifications, setPendingClarification } from "./context";
import { queryReplenishmentExcelData } from "./queries";
import { processIncomingMessage } from "./processor";
import { clearMemoryDeduplicationCache } from "./deduplication";
import type { getWeeklyReplenishment } from "@/server/analytics/weekly-replenishment";

// Mock DB client to avoid network timeouts during unit tests
vi.mock("@/server/db/client", () => ({
  query: vi.fn().mockRejectedValue(new Error("DB not configured in unit test")),
  withTransaction: vi.fn(),
}));

// Mock weekly replenishment service from analytics
vi.mock("@/server/analytics/weekly-replenishment", () => ({
  DEPOT_BRANCH_ID: 1,
  getWeeklyReplenishment: vi.fn(),
}));

// Mock sources
vi.mock("@/server/auth/sources", () => ({
  getSourceForBranch: vi.fn().mockResolvedValue("mock_source_1"),
}));

describe("WhatsApp Bot — Excel Replenishment by Rubro", () => {
  const refDate = new Date("2026-10-18T12:00:00.000Z");
  const testPhone = "5491112345678";

  type MockReplenishmentItem = Awaited<ReturnType<typeof getWeeklyReplenishment>>["items"][number];

  function makeItem(partial: Partial<MockReplenishmentItem> & { article_id: number; description: string }): MockReplenishmentItem {
    return {
      supplier_code: "P1",
      classification_code: "006",
      rubro: "CHOCOLATES",
      unit_measure: "UN",
      package_units: null,
      presentation: "",
      presentation_display: "",
      stock_current: 2,
      stock_depot: 10,
      depot_stock_state: "DEPOT_STOCK_POSITIVE",
      weekly_demand: 10,
      weekly_average: 10,
      weekly_max: 12,
      weekly_min: 8,
      active_weeks: 6,
      target_stock: 14,
      suggested_quantity: 5,
      requested_quantity: 5,
      status: "SUGGESTION_AVAILABLE",
      supply_mode: "DEPOT",
      warnings: [],
      fulfillment_type: "INTERNAL_REPLENISHMENT_CANDIDATE",
      ...partial,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    clearAllPendingClarifications();
    clearMemoryDeduplicationCache();
  });

  describe("1. Detección de solicitudes de Excel por rubro", () => {
    it("recognizes explicit request: 'Mandame un Excel con los productos que tengo que reponer de Chocolates'", () => {
      const intent = parseUserMessage(
        "Mandame un Excel con los productos que tengo que reponer de Chocolates",
        refDate
      );
      expect(intent.type).toBe("REPLENISHMENT_EXCEL");
      expect(intent.slots.targetRubro).toBe("CHOCOLATES");
      expect(intent.slots.wantsExcel).toBe(true);
      // Missing branch -> needs clarification
      expect(intent.slots.needsClarification).toBe(true);
      expect(intent.slots.clarificationType).toBe("BRANCH");
      expect(intent.slots.clarificationMessage).toContain("Centro");
      expect(intent.slots.clarificationMessage).toContain("Jardín");
    });

    it("recognizes request with branch included: 'Mandame un Excel de Chocolates para Centro'", () => {
      const intent = parseUserMessage(
        "Mandame un Excel de Chocolates para Centro",
        refDate
      );
      expect(intent.type).toBe("REPLENISHMENT_EXCEL");
      expect(intent.slots.targetRubro).toBe("CHOCOLATES");
      expect(intent.slots.branchTarget).toBe("CENTRO");
      expect(intent.slots.branchId).toBe(2);
      expect(intent.slots.wantsExcel).toBe(true);
      expect(intent.slots.needsClarification).toBe(false);
    });

    it("recognizes natural phrasing: 'Quiero la planilla de reposición del rubro Galletitas en Jardín'", () => {
      const intent = parseUserMessage(
        "Quiero la planilla de reposición del rubro Galletitas en Jardín",
        refDate
      );
      expect(intent.type).toBe("REPLENISHMENT_EXCEL");
      expect(intent.slots.targetRubro).toBe("GALLETITAS");
      expect(intent.slots.branchTarget).toBe("JARDIN");
      expect(intent.slots.branchId).toBe(3);
      expect(intent.slots.wantsExcel).toBe(true);
      expect(intent.slots.needsClarification).toBe(false);
    });

    it("recognizes phrasing: 'Pasame los productos que tengo que pedir de Caramelos en Excel para Centro'", () => {
      const intent = parseUserMessage(
        "Pasame los productos que tengo que pedir de Caramelos en Excel para Centro",
        refDate
      );
      expect(intent.type).toBe("REPLENISHMENT_EXCEL");
      expect(intent.slots.targetRubro).toBe("CARAMELOS");
      expect(intent.slots.branchTarget).toBe("CENTRO");
      expect(intent.slots.branchId).toBe(2);
    });

    it("resolves synonyms to canonical rubro names (golosinas -> CARAMELOS, gaseosas -> BEBIDAS)", () => {
      expect(resolveCanonicalRubroFromText("excel de golosinas").canonical).toBe("CARAMELOS");
      expect(resolveCanonicalRubroFromText("excel de gaseosas").canonical).toBe("BEBIDAS");
      expect(resolveCanonicalRubroFromText("planilla de puchos").canonical).toBe("CIGARRILLOS");
      expect(resolveCanonicalRubroFromText("excel de chocolates").canonical).toBe("CHOCOLATES");
    });
  });

  describe("2. Preservación de las intenciones existentes", () => {
    it("preserves standard product stock query", () => {
      const intent = parseUserMessage("Stock alfajor marplatense en Centro", refDate);
      expect(intent.type).toBe("STOCK_PRODUCT");
      expect(intent.slots.productSearch).toBe("alfajor marplatense");
      expect(intent.slots.branchTarget).toBe("CENTRO");
    });

    it("preserves recent orders query", () => {
      const intent = parseUserMessage("¿Qué pedidos hay?", refDate);
      expect(intent.type).toBe("ORDERS_RECENT");
    });

    it("preserves order detail query", () => {
      const intent = parseUserMessage("Pedido #3", refDate);
      expect(intent.type).toBe("ORDER_DETAIL");
      expect(intent.slots.orderNumber).toBe(3);
    });

    it("preserves plain text replenishment query without excel trigger", () => {
      const intent = parseUserMessage("¿Qué productos necesitan reposición en Jardín?", refDate);
      expect(intent.type).toBe("REPLENISHMENT");
      expect(intent.slots.branchTarget).toBe("JARDIN");
      expect(intent.slots.branchId).toBe(3);
      expect(intent.slots.wantsExcel).toBeFalsy();
    });

    it("preserves business metrics summary query", () => {
      const intent = parseUserMessage("Resumen de ventas del mes", refDate);
      expect(intent.type).toBe("METRICS_SUMMARY");
    });
  });

  describe("3. Solicitud de aclaración cuando falta la sucursal", () => {
    it("asks whether Centro or Jardín when branch is omitted", () => {
      const intent = parseUserMessage("Mandame un Excel de reposición de Chocolates", refDate);
      expect(intent.slots.needsClarification).toBe(true);
      expect(intent.slots.clarificationType).toBe("BRANCH");
      expect(intent.slots.pendingIntentType).toBe("REPLENISHMENT_EXCEL");
      expect(intent.slots.clarificationMessage).toContain("Centro");
      expect(intent.slots.clarificationMessage).toContain("Jardín");
    });

    it("asks whether Centro or Jardín when user specifies Depósito", () => {
      const intent = parseUserMessage("Excel de Chocolates para Depósito", refDate);
      expect(intent.slots.needsClarification).toBe(true);
      expect(intent.slots.clarificationType).toBe("BRANCH");
      expect(intent.slots.clarificationMessage).toContain("se calcula para las sucursales de venta");
    });
  });

  describe("4. Continuación del contexto al recibir 'Centro' o 'Jardín'", () => {
    it("preserves targetRubro and resolves intent when user replies with branch", () => {
      // Step 1: Initial user query without branch
      const initialIntent = parseUserMessage("Mandame un Excel de Chocolates", refDate);
      expect(initialIntent.slots.needsClarification).toBe(true);
      expect(initialIntent.slots.targetRubro).toBe("CHOCOLATES");

      // Save pending clarification in conversation context
      setPendingClarification(testPhone, {
        intentType: "REPLENISHMENT_EXCEL",
        slots: initialIntent.slots,
        clarificationType: "BRANCH",
      });

      // Step 2: User responds simply: "Centro"
      const resolved = resolvePendingClarification(testPhone, "Centro");
      expect(resolved.type).toBe("RESOLVED");
      if (resolved.type === "RESOLVED") {
        expect(resolved.intent.type).toBe("REPLENISHMENT_EXCEL");
        expect(resolved.intent.slots.targetRubro).toBe("CHOCOLATES");
        expect(resolved.intent.slots.branchTarget).toBe("CENTRO");
        expect(resolved.intent.slots.branchId).toBe(2);
        expect(resolved.intent.slots.needsClarification).toBe(false);
      }
    });

    it("handles branch Jardín similarly without losing targetRubro", () => {
      setPendingClarification(testPhone, {
        intentType: "REPLENISHMENT_EXCEL",
        slots: {
          branchTarget: "ALL",
          targetRubro: "GALLETITAS",
          wantsExcel: true,
        },
        clarificationType: "BRANCH",
      });

      const resolved = resolvePendingClarification(testPhone, "Jardín");
      expect(resolved.type).toBe("RESOLVED");
      if (resolved.type === "RESOLVED") {
        expect(resolved.intent.type).toBe("REPLENISHMENT_EXCEL");
        expect(resolved.intent.slots.targetRubro).toBe("GALLETITAS");
        expect(resolved.intent.slots.branchTarget).toBe("JARDIN");
        expect(resolved.intent.slots.branchId).toBe(3);
      }
    });
  });

  describe("5. Exportación de productos elegibles de varias páginas", () => {
    it("fetches all products of the rubro with high limit (5000) and exports all eligible items", async () => {
      const { getWeeklyReplenishment } = await import("@/server/analytics/weekly-replenishment");

      const mockItems: MockReplenishmentItem[] = Array.from({ length: 75 }, (_, i) =>
        makeItem({
          article_id: 1000 + i,
          description: `CHOCOLATE ARTICULO ${i + 1}`,
          supplier_code: "PROV_CHOC",
          suggested_quantity: (i % 5) + 1, // All positive (1 to 5)
          requested_quantity: (i % 5) + 1,
        })
      );

      vi.mocked(getWeeklyReplenishment).mockResolvedValue({
        planning_date: "2026-10-24",
        location: { branch_id: 2, label: "Centro" },
        window_weeks: 6,
        coverage_days: 10,
        total: 75,
        rubros: ["CHOCOLATES"],
        suppliers: ["PROV_CHOC"],
        items: mockItems,
      });

      const result = await queryReplenishmentExcelData(2, "CHOCOLATES");

      expect(vi.mocked(getWeeklyReplenishment)).toHaveBeenCalledWith(
        expect.objectContaining({
          rubro: "CHOCOLATES",
          limit: 5000,
          offset: 0,
        })
      );

      expect(result.totalEligible).toBe(75);
      expect(result.excelBuffer).toBeInstanceOf(Buffer);

      // Parse the generated workbook buffer to verify all 75 data rows and totals
      const wb = xlsx.read(result.excelBuffer!, { type: "buffer" });
      const ws = wb.Sheets["Reposición"];
      expect(ws).toBeDefined();

      const rows = xlsx.utils.sheet_to_json<any[]>(ws, { header: 1 });
      const dataRows = rows.slice(4).filter((r) => typeof r[0] === "number");
      expect(dataRows.length).toBe(75);

      const totalsRow = rows[rows.length - 1];
      expect(totalsRow[0]).toBe("TOTALES");
      expect(totalsRow[1]).toBe("75 productos");
    });
  });

  describe("6. Exclusión de productos con cantidad sugerida cero", () => {
    it("excludes products with suggested_quantity <= 0 from the Excel file and summary row", async () => {
      const { getWeeklyReplenishment } = await import("@/server/analytics/weekly-replenishment");

      const mockItems: MockReplenishmentItem[] = [
        makeItem({
          article_id: 2001,
          description: "CHOCOLATE CON LECHE 100G",
          suggested_quantity: 10,
          requested_quantity: 10,
        }),
        makeItem({
          article_id: 2002,
          description: "CHOCOLATE SIN DEMANDA",
          suggested_quantity: 0,
          requested_quantity: 0,
          status: "NO_DEMAND",
        }),
      ];

      vi.mocked(getWeeklyReplenishment).mockResolvedValue({
        planning_date: "2026-10-24",
        location: { branch_id: 2, label: "Centro" },
        window_weeks: 6,
        coverage_days: 10,
        total: 2,
        rubros: ["CHOCOLATES"],
        suppliers: ["P1"],
        items: mockItems,
      });

      const result = await queryReplenishmentExcelData(2, "CHOCOLATES");

      expect(result.totalEligible).toBe(1);
      expect(result.items.some((i) => i.article_id === 2002)).toBe(false);

      const wb = xlsx.read(result.excelBuffer!, { type: "buffer" });
      const ws = wb.Sheets["Reposición"];
      const rows = xlsx.utils.sheet_to_json<any[]>(ws, { header: 1 });
      const dataRows = rows.slice(4).filter((r) => typeof r[0] === "number");

      expect(dataRows.length).toBe(1);
      expect(dataRows[0][0]).toBe(2001);

      const totalsRow = rows[rows.length - 1];
      expect(totalsRow[1]).toBe("1 productos");
      expect(totalsRow[7]).toBe(10); // Total Sugerida
      expect(totalsRow[8]).toBe(10); // Total Solicitada
    });
  });

  describe("7. Tratamiento de productos con stock negativo sin inventar cantidades", () => {
    it("detects negative stock items, does not fabricate quantities for Excel, and reports them", async () => {
      const { getWeeklyReplenishment } = await import("@/server/analytics/weekly-replenishment");

      const mockItems: MockReplenishmentItem[] = [
        makeItem({
          article_id: 3001,
          description: "CHOCOLATE BLANCO 80G",
          stock_current: 1,
          suggested_quantity: 12,
          requested_quantity: 12,
        }),
        makeItem({
          article_id: 3002,
          description: "CHOCOLATE AMARGO STOCK NEGATIVO",
          stock_current: -4,
          suggested_quantity: null, // Null as per business rule!
          requested_quantity: 0,
          status: "NEGATIVE_STOCK",
          warnings: ["NEGATIVE_STOCK"],
          fulfillment_type: "DEPOT_REVIEW_REQUIRED",
        }),
      ];

      vi.mocked(getWeeklyReplenishment).mockResolvedValue({
        planning_date: "2026-10-24",
        location: { branch_id: 2, label: "Centro" },
        window_weeks: 6,
        coverage_days: 10,
        total: 2,
        rubros: ["CHOCOLATES"],
        suppliers: ["P1"],
        items: mockItems,
      });

      const result = await queryReplenishmentExcelData(2, "CHOCOLATES");

      // Negative stock item is counted for the operational warning
      expect(result.negativeStockCount).toBe(1);
      expect(result.negativeStockProducts).toHaveLength(1);
      expect(result.negativeStockProducts?.[0].articleId).toBe(3002);
      expect(result.negativeStockProducts?.[0].currentStock).toBe(-4);

      // Negative stock item is NOT exported with fabricated quantities
      expect(result.totalEligible).toBe(1);
      expect(result.items.some((i) => i.article_id === 3002)).toBe(false);

      const wb = xlsx.read(result.excelBuffer!, { type: "buffer" });
      const ws = wb.Sheets["Reposición"];
      const rows = xlsx.utils.sheet_to_json<any[]>(ws, { header: 1 });
      const item3002Row = rows.find((r) => r[0] === 3002);
      expect(item3002Row).toBeUndefined();
    });
  });

  describe("8. Envío de documentos por Baileys mediante mocks", () => {
    it("dispatches binary Excel document to WhatsApp recipient with accurate filename and caption", async () => {
      const { getWeeklyReplenishment } = await import("@/server/analytics/weekly-replenishment");

      vi.mocked(getWeeklyReplenishment).mockResolvedValue({
        planning_date: "2026-10-24",
        location: { branch_id: 2, label: "Centro" },
        window_weeks: 6,
        coverage_days: 10,
        total: 1,
        rubros: ["CHOCOLATES"],
        suppliers: ["P1"],
        items: [
          makeItem({
            article_id: 4001,
            description: "CHOCOLATE BARRA 150G",
            suggested_quantity: 6,
            requested_quantity: 6,
          }),
        ],
      });

      const mockSendDoc = vi.fn().mockResolvedValue({
        success: true,
        messageId: "doc_test_msg_999",
      });
      const mockSendText = vi.fn().mockResolvedValue({
        success: true,
      });

      const result = await processIncomingMessage({
        messageId: "msg_excel_dispatch_test",
        senderPhone: testPhone,
        textBody: "Mandame un Excel de Chocolates para Centro",
        configuredAllowedEnv: testPhone,
        sendMessageFn: mockSendText,
        sendDocumentFn: mockSendDoc,
      });

      expect(result.processed).toBe(true);
      expect(result.intent).toBe("REPLENISHMENT_EXCEL");
      expect(mockSendDoc).toHaveBeenCalledTimes(1);

      const [to, docOptions] = mockSendDoc.mock.calls[0];
      expect(to).toBe(testPhone);
      expect(docOptions.fileName).toBe("REPOSICION_CHOCOLATES_CENTRO_2026-10-24.xlsx");
      expect(docOptions.mimetype).toBe(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
      expect(docOptions.document).toBeInstanceOf(Buffer);
      expect(docOptions.document.length).toBeGreaterThan(100);
      expect(docOptions.caption).toContain("Planilla de Reposición — Chocolates");
      expect(docOptions.caption).toContain("Centro");
      expect(docOptions.caption).toContain("*Productos a pedir:* 1");
    });
  });

  describe("9. Manejo de rubros inexistentes y resultados vacíos", () => {
    it("requests clarification when user specifies an unrecognized rubro", () => {
      const intent = parseUserMessage("Mandame un Excel de reposición de Ferretería para Centro", refDate);
      expect(intent.type).toBe("REPLENISHMENT_EXCEL");
      expect(intent.slots.needsClarification).toBe(true);
      expect(intent.slots.clarificationType).toBe("RUBRO");
      expect(intent.slots.clarificationMessage).toContain("No encontré el rubro *Ferretería*");
      expect(intent.slots.clarificationMessage).toContain("Chocolates");
      expect(intent.slots.clarificationMessage).toContain("Galletitas");
    });

    it("does not send an empty Excel when no products need replenishment; sends clear informative text", async () => {
      const { getWeeklyReplenishment } = await import("@/server/analytics/weekly-replenishment");

      // No products to replenish in this rubro
      vi.mocked(getWeeklyReplenishment).mockResolvedValue({
        planning_date: "2026-10-24",
        location: { branch_id: 2, label: "Centro" },
        window_weeks: 6,
        coverage_days: 10,
        total: 0,
        rubros: ["CHOCOLATES"],
        suppliers: [],
        items: [],
      });

      const mockSendDoc = vi.fn();
      const mockSendText = vi.fn().mockResolvedValue({ success: true });

      const result = await processIncomingMessage({
        messageId: "msg_empty_replenish_test",
        senderPhone: testPhone,
        textBody: "Mandame un Excel de Chocolates para Centro",
        configuredAllowedEnv: testPhone,
        sendMessageFn: mockSendText,
        sendDocumentFn: mockSendDoc,
      });

      // Crucial: document sender must NOT be called for empty results!
      expect(mockSendDoc).not.toHaveBeenCalled();

      // Informative text message is dispatched instead
      expect(mockSendText).toHaveBeenCalledTimes(1);
      const [to, text] = mockSendText.mock.calls[0];
      expect(to).toBe(testPhone);
      expect(text).toContain("No hay productos con necesidad de reposición en este rubro");
      expect(text).toContain("Chocolates");
      expect(text).toContain("Centro");

      expect(result.processed).toBe(true);
    });
  });

  describe("10. Manejo de errores de consulta, generación y envío", () => {
    it("catches document dispatch failure and notifies user with graceful fallback message", async () => {
      const { getWeeklyReplenishment } = await import("@/server/analytics/weekly-replenishment");

      vi.mocked(getWeeklyReplenishment).mockResolvedValue({
        planning_date: "2026-10-24",
        location: { branch_id: 2, label: "Centro" },
        window_weeks: 6,
        coverage_days: 10,
        total: 1,
        rubros: ["CHOCOLATES"],
        suppliers: [],
        items: [
          makeItem({
            article_id: 5001,
            description: "ALFAJOR TRIPLE",
            suggested_quantity: 12,
            requested_quantity: 12,
          }),
        ],
      });

      // Simulate Baileys network disconnect during document stream
      const mockSendDoc = vi.fn().mockRejectedValue(new Error("Baileys socket connection reset"));
      const mockSendText = vi.fn().mockResolvedValue({ success: true });

      const result = await processIncomingMessage({
        messageId: "msg_error_handling_test",
        senderPhone: testPhone,
        textBody: "Mandame un Excel de Chocolates para Centro",
        configuredAllowedEnv: testPhone,
        sendMessageFn: mockSendText,
        sendDocumentFn: mockSendDoc,
      });

      expect(result.processed).toBe(true);
      expect(result.error).toContain("Baileys socket connection reset");

      // Fallback message sent to recipient
      expect(mockSendText).toHaveBeenCalledWith(
        testPhone,
        expect.stringContaining("Ocurrió un error temporal al consultar los datos del sistema")
      );
    });
  });
});
