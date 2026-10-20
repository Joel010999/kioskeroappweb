import { beforeEach, describe, expect, it, vi } from "vitest";
import * as xlsx from "xlsx";
import { parseUserMessage, resolveCanonicalRubroFromText } from "./router";
import { resolvePendingClarification, clearAllPendingClarifications, setPendingClarification } from "./context";
import { queryReplenishmentExcelData } from "./queries";
import { processIncomingMessage } from "./processor";
import { clearMemoryDeduplicationCache } from "./deduplication";
import { formatGreetingMessage } from "./formatters";
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

  describe("0. Menú inicial y opción 5", () => {
    it("greeting message contains the four original options and adds the fifth option with examples", () => {
      const greeting = formatGreetingMessage("Mónica");
      // All 4 original options must be present
      expect(greeting).toContain("📦 *1. Stock de productos*");
      expect(greeting).toContain("🧾 *2. Pedidos registrados*");
      expect(greeting).toContain("🚚 *3. Reposición semanal*");
      expect(greeting).toContain("📊 *4. Resúmenes del negocio*");
      // 5th option must be present with brief explanation and real examples
      expect(greeting).toContain("📑 *5. Excel de reposición por rubro y sucursal*");
      expect(greeting).toContain("Excel de cigarrillos para Centro");
      expect(greeting).toContain("Quiero la planilla de bebidas para Jardín");
    });

    it("selecting menu option '5' routes to REPLENISHMENT_EXCEL and asks for rubro", () => {
      const intent = parseUserMessage("5", refDate);
      expect(intent.type).toBe("REPLENISHMENT_EXCEL");
      expect(intent.slots.wantsExcel).toBe(true);
      expect(intent.slots.needsClarification).toBe(true);
      expect(intent.slots.clarificationType).toBe("RUBRO");
      expect(intent.slots.clarificationMessage).toContain("Chocolates");
      expect(intent.slots.clarificationMessage).toContain("Centro");
    });
  });

  describe("1. Detección de solicitudes de Excel por rubro", () => {
    it("recognizes: 'Excel de cigarrillos para Centro'", () => {
      const intent = parseUserMessage("Excel de cigarrillos para Centro", refDate);
      expect(intent.type).toBe("REPLENISHMENT_EXCEL");
      expect(intent.slots.targetRubro).toBe("CIGARRILLOS");
      expect(intent.slots.branchTarget).toBe("CENTRO");
      expect(intent.slots.branchId).toBe(2);
      expect(intent.slots.needsClarification).toBe(false);
    });

    it("recognizes: 'Quiero la planilla de bebidas para Jardín'", () => {
      const intent = parseUserMessage("Quiero la planilla de bebidas para Jardín", refDate);
      expect(intent.type).toBe("REPLENISHMENT_EXCEL");
      expect(intent.slots.targetRubro).toBe("BEBIDAS");
      expect(intent.slots.branchTarget).toBe("JARDIN");
      expect(intent.slots.branchId).toBe(3);
      expect(intent.slots.needsClarification).toBe(false);
    });

    it("recognizes: 'Pasame la reposición de almacén para Depósito'", () => {
      const intent = parseUserMessage("Pasame la reposición de almacén para Depósito", refDate);
      expect(intent.type).toBe("REPLENISHMENT_EXCEL");
      expect(intent.slots.targetRubro).toBe("ALMACEN");
      expect(intent.slots.branchTarget).toBe("DEPOSITO");
      expect(intent.slots.branchId).toBe(1);
      // Depósito triggers clarification explaining it supplies Centro and Jardín
      expect(intent.slots.needsClarification).toBe(true);
      expect(intent.slots.clarificationType).toBe("BRANCH");
      expect(intent.slots.clarificationMessage).toContain("se calcula para las sucursales de venta");
    });

    it("recognizes: 'Necesito el Excel de galletitas'", () => {
      const intent = parseUserMessage("Necesito el Excel de galletitas", refDate);
      expect(intent.type).toBe("REPLENISHMENT_EXCEL");
      expect(intent.slots.targetRubro).toBe("GALLETITAS");
      expect(intent.slots.needsClarification).toBe(true);
      expect(intent.slots.clarificationType).toBe("BRANCH");
      expect(intent.slots.clarificationMessage).toContain("Centro");
      expect(intent.slots.clarificationMessage).toContain("Jardín");
    });

    it("recognizes: 'Quiero una planilla de reposición'", () => {
      const intent = parseUserMessage("Quiero una planilla de reposición", refDate);
      expect(intent.type).toBe("REPLENISHMENT_EXCEL");
      expect(intent.slots.needsClarification).toBe(true);
      expect(intent.slots.clarificationType).toBe("RUBRO");
      expect(intent.slots.clarificationMessage).toContain("Chocolates");
      expect(intent.slots.clarificationMessage).toContain("Galletitas");
    });

    it("recognizes: 'Excel Centro chocolates'", () => {
      const intent = parseUserMessage("Excel Centro chocolates", refDate);
      expect(intent.type).toBe("REPLENISHMENT_EXCEL");
      expect(intent.slots.targetRubro).toBe("CHOCOLATES");
      expect(intent.slots.branchTarget).toBe("CENTRO");
      expect(intent.slots.branchId).toBe(2);
      expect(intent.slots.needsClarification).toBe(false);
    });

    it("handles casing, accents, and spacing variations gracefully", () => {
      const upper = parseUserMessage("EXCEL DE CIGARRILLOS PARA CENTRO", refDate);
      expect(upper.type).toBe("REPLENISHMENT_EXCEL");
      expect(upper.slots.targetRubro).toBe("CIGARRILLOS");
      expect(upper.slots.branchTarget).toBe("CENTRO");

      const withAccents = parseUserMessage("Quiero la planilla de reposición de bebidas para Jardín", refDate);
      expect(withAccents.type).toBe("REPLENISHMENT_EXCEL");
      expect(withAccents.slots.targetRubro).toBe("BEBIDAS");
      expect(withAccents.slots.branchTarget).toBe("JARDIN");

      const extraSpaces = parseUserMessage("  excel    centro   chocolates  ", refDate);
      expect(extraSpaces.type).toBe("REPLENISHMENT_EXCEL");
      expect(extraSpaces.slots.targetRubro).toBe("CHOCOLATES");
      expect(extraSpaces.slots.branchTarget).toBe("CENTRO");
    });

    it("resolves synonyms to canonical rubro names (golosinas -> CARAMELOS, gaseosas -> BEBIDAS, puchos -> CIGARRILLOS)", () => {
      expect(resolveCanonicalRubroFromText("excel de golosinas").canonical).toBe("CARAMELOS");
      expect(resolveCanonicalRubroFromText("excel de gaseosas").canonical).toBe("BEBIDAS");
      expect(resolveCanonicalRubroFromText("planilla de puchos").canonical).toBe("CIGARRILLOS");
      expect(resolveCanonicalRubroFromText("excel de chocolates").canonical).toBe("CHOCOLATES");
      expect(resolveCanonicalRubroFromText("excel de masitas").canonical).toBe("GALLETITAS");
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

  describe("2.5. Protección contra falsos positivos con la palabra 'Excel'", () => {
    it("does not trigger REPLENISHMENT_EXCEL for 'Excel de ventas'", () => {
      const intent = parseUserMessage("Excel de ventas", refDate);
      expect(intent.type).toBe("METRICS_SUMMARY");
    });

    it("does not trigger REPLENISHMENT_EXCEL for 'Excel de pedidos'", () => {
      const intent = parseUserMessage("Excel de pedidos", refDate);
      expect(intent.type).toBe("ORDERS_RECENT");
    });

    it("does not trigger REPLENISHMENT_EXCEL for 'Stock alfajor en Excel'", () => {
      const intent = parseUserMessage("Stock alfajor havanna en Excel", refDate);
      expect(intent.type).toBe("STOCK_PRODUCT");
      expect(intent.slots.productSearch).toContain("alfajor havanna");
    });

    it("does not trigger REPLENISHMENT_EXCEL for system update question mentioning Excel", () => {
      const intent = parseUserMessage("¿De qué fecha es la sincronización del Excel?", refDate);
      expect(intent.type).toBe("SYSTEM_HEALTH");
    });
  });

  describe("3. Solicitud de aclaración cuando faltan datos o son inválidos", () => {
    it("asks whether Centro, Jardín o Depósito when branch is omitted", () => {
      const intent = parseUserMessage("Mandame un Excel de reposición de Chocolates", refDate);
      expect(intent.slots.needsClarification).toBe(true);
      expect(intent.slots.clarificationType).toBe("BRANCH");
      expect(intent.slots.pendingIntentType).toBe("REPLENISHMENT_EXCEL");
      expect(intent.slots.clarificationMessage).toContain("Centro");
      expect(intent.slots.clarificationMessage).toContain("Jardín");
      expect(intent.slots.clarificationMessage).toContain("Depósito");
    });

    it("asks whether Centro or Jardín when user specifies Depósito", () => {
      const intent = parseUserMessage("Excel de Chocolates para Depósito", refDate);
      expect(intent.slots.needsClarification).toBe(true);
      expect(intent.slots.clarificationType).toBe("BRANCH");
      expect(intent.slots.clarificationMessage).toContain("se calcula para las sucursales de venta");
      expect(intent.slots.clarificationMessage).toContain("Centro");
      expect(intent.slots.clarificationMessage).toContain("Jardín");
    });

    it("identifies invalid rubro and explains options: 'Excel de ferretería para Centro'", () => {
      const intent = parseUserMessage("Excel de ferretería para Centro", refDate);
      expect(intent.slots.needsClarification).toBe(true);
      expect(intent.slots.clarificationType).toBe("RUBRO");
      expect(intent.slots.clarificationMessage).toContain("Ferretería");
      expect(intent.slots.clarificationMessage).toContain("Chocolates");
    });

    it("identifies invalid branch and explains options: 'Excel de chocolates para Quilmes'", () => {
      const intent = parseUserMessage("Excel de chocolates para Quilmes", refDate);
      expect(intent.slots.needsClarification).toBe(true);
      expect(intent.slots.clarificationType).toBe("BRANCH");
      expect(intent.slots.clarificationMessage).toContain("Quilmes");
      expect(intent.slots.clarificationMessage).toContain("Centro");
      expect(intent.slots.clarificationMessage).toContain("Jardín");
    });
  });

  describe("4. Continuación del contexto y actualización de selecciones", () => {
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

    it("updates rubro if user switches rubro during branch clarification: 'Mejor galletitas para Centro'", () => {
      setPendingClarification(testPhone, {
        intentType: "REPLENISHMENT_EXCEL",
        slots: {
          branchTarget: "ALL",
          targetRubro: "CHOCOLATES",
          wantsExcel: true,
        },
        clarificationType: "BRANCH",
      });

      const resolved = resolvePendingClarification(testPhone, "Mejor galletitas para Centro");
      expect(resolved.type).toBe("RESOLVED");
      if (resolved.type === "RESOLVED") {
        expect(resolved.intent.type).toBe("REPLENISHMENT_EXCEL");
        expect(resolved.intent.slots.targetRubro).toBe("GALLETITAS");
        expect(resolved.intent.slots.branchTarget).toBe("CENTRO");
        expect(resolved.intent.slots.branchId).toBe(2);
      }
    });

    it("re-prompts when user replies with Depósito during clarification", () => {
      setPendingClarification(testPhone, {
        intentType: "REPLENISHMENT_EXCEL",
        slots: {
          branchTarget: "ALL",
          targetRubro: "ALMACEN",
          wantsExcel: true,
        },
        clarificationType: "BRANCH",
      });

      const reprompt = resolvePendingClarification(testPhone, "Depósito");
      expect(reprompt.type).toBe("RE_PROMPT");
      if (reprompt.type === "RE_PROMPT") {
        expect(reprompt.message).toContain("se calcula para las sucursales de venta");
        expect(reprompt.message).toContain("Almacén");
      }
    });

    it("re-prompts when user enters an invalid rubro during rubro clarification", () => {
      setPendingClarification(testPhone, {
        intentType: "REPLENISHMENT_EXCEL",
        slots: {
          branchTarget: "CENTRO",
          branchId: 2,
          wantsExcel: true,
        },
        clarificationType: "RUBRO",
      });

      const reprompt = resolvePendingClarification(testPhone, "Ferretería");
      expect(reprompt.type).toBe("RE_PROMPT");
      if (reprompt.type === "RE_PROMPT") {
        expect(reprompt.message).toContain("Ferretería");
        expect(reprompt.message).toContain("Chocolates");
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
