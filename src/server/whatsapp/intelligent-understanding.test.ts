import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseUserMessage } from "./router";
import {
  clearAllPendingClarifications,
  getPendingClarification,
  resolvePendingClarification,
  setPendingClarification,
} from "./context";
import { processIncomingMessage } from "./processor";
import { clearMemoryDeduplicationCache } from "./deduplication";

// Mock DB client
vi.mock("@/server/db/client", () => ({
  query: vi.fn().mockRejectedValue(new Error("DB not configured in unit test")),
  withTransaction: vi.fn(),
}));

// Mock backend queries
vi.mock("./queries", () => ({
  queryProductStock: vi.fn().mockResolvedValue({
    items: [
      {
        articleId: 1052,
        description: "Bombón Bon o Bon Leche",
        brand: "Arcor",
        rubro: "Chocolates",
        stockCentro: 12,
        stockJardin: 8,
        stockDepot: 100,
      },
    ],
    totalFound: 1,
  }),
  queryLowStock: vi.fn().mockResolvedValue({
    branchName: "Centro",
    branchId: 2,
    total: 1,
    items: [{ articleId: 1052, description: "Bon o Bon", saldo: 2, stockStatus: "AVAILABLE" }],
  }),
  queryStockAlerts: vi.fn().mockResolvedValue({
    branchName: "Centro",
    negativeCount: 0,
    outOfStockCount: 0,
    negativeItems: [],
    outOfStockItems: [],
  }),
  queryReplenishment: vi.fn().mockImplementation(async (branchId: number, rubro?: string, supplierCode?: string, supplierName?: string) => ({
    branchName: branchId === 2 ? "Centro" : "Jardín",
    planningDate: "2026-10-24",
    rubro,
    supplierCode,
    supplierName,
    items: [
      {
        articleId: 1052,
        description: "Bombón Bon o Bon Leche",
        stockCurrent: 4,
        stockDepot: 100,
        suggestedQuantity: 24,
        weeklyDemand: 30,
        status: "TO_REPLENISH",
      },
    ],
    totalSuggested: 1,
  })),
  queryReplenishmentExcelData: vi.fn().mockImplementation(async (options: any) => ({
    branchName: options.branchId === 2 ? "Centro" : "Jardín",
    branchId: options.branchId,
    planningDate: "2026-10-24",
    rubro: options.rubro,
    supplierCode: options.supplierCode,
    supplierName: options.supplierName,
    totalEligible: 5,
    negativeStockCount: 0,
    negativeStockProducts: [],
    excelBuffer: Buffer.from("mock-excel-binary-content"),
    items: [],
  })),
  queryOrderDetail: vi.fn().mockResolvedValue({
    id: 1,
    order_number: 3,
    origin_branch_id: 2,
    destination_branch_id: 1,
    status: "DISPATCHED",
    created_at: "2026-10-15T09:00:00Z",
    item_count: 2,
    requested_units: 30,
    approved_units: 30,
    prepared_units: 30,
    dispatched_units: 30,
    received_units: 0,
    items: [],
  }),
  queryPendingOrders: vi.fn().mockResolvedValue({
    summary: { pending: 1, inPreparation: 0, readyToDispatch: 0, dispatched: 1, completed: 5 },
    orders: [],
  }),
  queryRecentOrders: vi.fn().mockResolvedValue({ total: 1, rows: [] }),
  querySupplierProducts: vi.fn().mockResolvedValue({ supplierName: "Arcor", products: [] }),
  queryProductSupplier: vi.fn().mockResolvedValue({ articleId: 1052, description: "Bon o Bon", suppliers: [] }),
  queryMetricsSummary: vi.fn().mockResolvedValue({ totalMovements: 100 }),
  queryPeriodComparison: vi.fn().mockResolvedValue({}),
  queryTopProducts: vi.fn().mockResolvedValue({ branchName: "Centro", products: [] }),
  querySystemHealth: vi.fn().mockResolvedValue({
    first_movement: "2026-01-01",
    last_movement: "2026-10-18",
    total_movements: 5000,
    freshness: { status: "OK", age_minutes: 15 },
  }),
}));

describe("Renderbyte — Evolución Inteligente del Bot de WhatsApp", () => {
  const refDate = new Date("2026-10-18T12:00:00.000Z");
  const testPhone = "5491198765432";

  beforeEach(() => {
    clearAllPendingClarifications();
    clearMemoryDeduplicationCache();
  });

  describe("1. Comprensión de Lenguaje Natural en Reposición", () => {
    it("interprets varied expressions requesting replenishment Excel by rubro and branch", () => {
      // 1. 'Pasame el Excel de cigarrillos de Centro'
      const res1 = parseUserMessage("Pasame el Excel de cigarrillos de Centro", refDate);
      expect(res1.type).toBe("REPLENISHMENT_EXCEL");
      expect(res1.slots.targetRubro).toBe("CIGARRILLOS");
      expect(res1.slots.branchTarget).toBe("CENTRO");
      expect(res1.slots.branchId).toBe(2);
      expect(res1.slots.wantsExcel).toBe(true);

      // 2. 'Haceme la planilla para reponer el rubro cigarrillos' -> missing branch -> asks for branch
      const res2 = parseUserMessage("Haceme la planilla para reponer el rubro cigarrillos", refDate);
      expect(res2.type).toBe("REPLENISHMENT_EXCEL");
      expect(res2.slots.targetRubro).toBe("CIGARRILLOS");
      expect(res2.slots.needsClarification).toBe(true);
      expect(res2.slots.clarificationType).toBe("BRANCH");

      // 3. 'Qué tengo que pedir de cigarrillos en la sucursal Centro' -> text replenishment
      const res3 = parseUserMessage("Qué tengo que pedir de cigarrillos en la sucursal Centro", refDate);
      expect(res3.type).toBe("REPLENISHMENT");
      expect(res3.slots.targetRubro).toBe("CIGARRILLOS");
      expect(res3.slots.branchTarget).toBe("CENTRO");
      expect(res3.slots.branchId).toBe(2);

      // 4. 'Mandame el Excel de reposición del centro, el de cigarros'
      const res4 = parseUserMessage("Mandame el Excel de reposición del centro, el de cigarros", refDate);
      expect(res4.type).toBe("REPLENISHMENT_EXCEL");
      expect(res4.slots.targetRubro).toBe("CIGARRILLOS");
      expect(res4.slots.branchTarget).toBe("CENTRO");
      expect(res4.slots.branchId).toBe(2);

      // 5. 'Necesito ver qué falta reponer de cigarrillos' -> text replenishment, missing branch
      const res5 = parseUserMessage("Necesito ver qué falta reponer de cigarrillos", refDate);
      expect(res5.type).toBe("REPLENISHMENT");
      expect(res5.slots.targetRubro).toBe("CIGARRILLOS");
      expect(res5.slots.needsClarification).toBe(true);
      expect(res5.slots.clarificationType).toBe("BRANCH");
    });
  });

  describe("2. Excel de Reposición por Proveedor", () => {
    it("interprets Excel request by commercial supplier name: 'Pasame el Excel de Coca-Cola'", () => {
      const res = parseUserMessage("Pasame el Excel de Coca-Cola", refDate);
      expect(res.type).toBe("REPLENISHMENT_EXCEL");
      expect(res.slots.supplierName).toContain("Coca-Cola");
      expect(res.slots.wantsExcel).toBe(true);
      expect(res.slots.needsClarification).toBe(true);
      expect(res.slots.clarificationType).toBe("BRANCH");
    });

    it("interprets Excel request by numeric supplier code: 'Qué tengo que pedirle al proveedor 50350'", () => {
      const res = parseUserMessage("Qué tengo que pedirle al proveedor 50350", refDate);
      expect(res.type).toBe("REPLENISHMENT");
      expect(res.slots.supplierCode).toBe("50350");
      expect(res.slots.needsClarification).toBe(true);
      expect(res.slots.clarificationType).toBe("BRANCH");
    });

    it("interprets supplier and branch combined: 'Necesito reponer lo de Arcor en la sucursal Centro'", () => {
      const res = parseUserMessage("Necesito reponer lo de Arcor en la sucursal Centro", refDate);
      expect(res.type).toBe("REPLENISHMENT");
      expect(res.slots.supplierCode).toBe("50350");
      expect(res.slots.supplierName).toBe("Arcor");
      expect(res.slots.branchTarget).toBe("CENTRO");
      expect(res.slots.branchId).toBe(2);
      expect(res.slots.needsClarification).toBeFalsy();
    });

    it("interprets Excel request with supplier and rubro: 'Pasame la reposición de cigarrillos del proveedor 50001'", () => {
      const res = parseUserMessage("Pasame la reposición de cigarrillos del proveedor 50001", refDate);
      expect(res.slots.targetRubro).toBe("CIGARRILLOS");
      expect(res.slots.supplierCode).toBe("50001");
    });

    it("handles generic supplier reference: 'Haceme la planilla de reposición de este proveedor'", () => {
      const res = parseUserMessage("Haceme la planilla de reposición de este proveedor", refDate);
      expect(res.type).toBe("REPLENISHMENT_EXCEL");
      expect(res.slots.needsClarification).toBe(true);
      expect(res.slots.clarificationType).toBe("SUPPLIER");
    });

    it("handles generic supplier reference for text replenishment: 'Qué productos tengo que pedirle a este proveedor'", () => {
      const res = parseUserMessage("Qué productos tengo que pedirle a este proveedor", refDate);
      expect(res.type).toBe("REPLENISHMENT");
      expect(res.slots.needsClarification).toBe(true);
      expect(res.slots.clarificationType).toBe("SUPPLIER");
    });
  });

  describe("3. Conversación Multi-Turno y Manejo de Contexto", () => {
    it("preserves supplier context when user replies with branch", () => {
      setPendingClarification(testPhone, {
        intentType: "REPLENISHMENT_EXCEL",
        slots: {
          branchTarget: "ALL",
          supplierCode: "50350",
          supplierName: "Arcor",
          wantsExcel: true,
        },
        clarificationType: "BRANCH",
      });

      const res = resolvePendingClarification(testPhone, "Centro");
      expect(res.type).toBe("RESOLVED");
      if (res.type === "RESOLVED") {
        expect(res.intent.type).toBe("REPLENISHMENT_EXCEL");
        expect(res.intent.slots.branchTarget).toBe("CENTRO");
        expect(res.intent.slots.branchId).toBe(2);
        expect(res.intent.slots.supplierCode).toBe("50350");
        expect(res.intent.slots.supplierName).toBe("Arcor");
      }
    });

    it("handles context correction: 'No quiero Excel, decime los productos por acá'", () => {
      setPendingClarification(testPhone, {
        intentType: "REPLENISHMENT_EXCEL",
        slots: {
          branchTarget: "CENTRO",
          branchId: 2,
          supplierCode: "50350",
          supplierName: "Arcor",
          wantsExcel: true,
        },
        clarificationType: "BRANCH",
      });

      const res = resolvePendingClarification(
        testPhone,
        "No quiero Excel, decime los productos por acá"
      );
      expect(res.type).toBe("RESOLVED");
      if (res.type === "RESOLVED") {
        expect(res.intent.type).toBe("REPLENISHMENT");
        expect(res.intent.slots.wantsExcel).toBe(false);
        expect(res.intent.slots.branchTarget).toBe("CENTRO");
        expect(res.intent.slots.supplierCode).toBe("50350");
      }
    });

    it("handles branch correction: 'Mejor de la sucursal Norte' -> explains valid branches", () => {
      setPendingClarification(testPhone, {
        intentType: "REPLENISHMENT_EXCEL",
        slots: {
          branchTarget: "ALL",
          supplierCode: "50350",
          supplierName: "Arcor",
          wantsExcel: true,
        },
        clarificationType: "BRANCH",
      });

      const res = resolvePendingClarification(testPhone, "Mejor de la sucursal Norte");
      expect(res.type).toBe("RE_PROMPT");
      if (res.type === "RE_PROMPT") {
        expect(res.message).toContain("No reconozco la sucursal");
        expect(res.message).toContain("Centro");
        expect(res.message).toContain("Jardín");
      }
    });

    it("handles rubro filter change: 'Solo los cigarrillos'", () => {
      setPendingClarification(testPhone, {
        intentType: "REPLENISHMENT_EXCEL",
        slots: {
          branchTarget: "CENTRO",
          branchId: 2,
          supplierCode: "50001",
          supplierName: "Massalin Particulares",
          wantsExcel: true,
        },
        clarificationType: "BRANCH",
      });

      const res = resolvePendingClarification(testPhone, "Solo los cigarrillos");
      expect(res.type).toBe("RESOLVED");
      if (res.type === "RESOLVED") {
        expect(res.intent.slots.targetRubro).toBe("CIGARRILLOS");
        expect(res.intent.slots.supplierCode).toBe("50001");
        expect(res.intent.slots.branchTarget).toBe("CENTRO");
      }
    });

    it("handles supplier switch: 'No, el otro proveedor' when disambiguation candidates exist", () => {
      setPendingClarification(testPhone, {
        intentType: "REPLENISHMENT_EXCEL",
        slots: {
          branchTarget: "ALL",
          supplierCode: "50001",
          supplierName: "Massalin Particulares",
          disambiguationCandidates: [
            { code: "50001", label: "Massalin Particulares (50001)" },
            { code: "50002", label: "Mondelez (50002)" },
          ],
          wantsExcel: true,
        },
        clarificationType: "BRANCH",
      });

      const res = resolvePendingClarification(testPhone, "No, el otro proveedor");
      expect(res.type).toBe("RE_PROMPT");
      if (res.type === "RE_PROMPT") {
        expect(res.message).toContain("Mondelez");
      }

      // Check state was updated to Mondelez
      const updated = getPendingClarification(testPhone);
      expect(updated?.slots.supplierCode).toBe("50002");
    });
  });

  describe("4. Búsqueda Tolerante a Errores de Productos", () => {
    it("recognizes commercial aliases: 'Bonobon' and 'Bon o Bon'", () => {
      const res1 = parseUserMessage("Stock bonobon en Centro", refDate);
      expect(res1.type).toBe("STOCK_PRODUCT");
      expect(res1.slots.productSearch).toBe("bonobon");
      expect(res1.slots.branchTarget).toBe("CENTRO");

      const res2 = parseUserMessage("Stock Bon o Bon en Jardín", refDate);
      expect(res2.type).toBe("STOCK_PRODUCT");
      expect(res2.slots.productSearch).toBe("bon o bon");
      expect(res2.slots.branchTarget).toBe("JARDIN");
    });

    it("recognizes single-letter brand typo: 'alfajor havana'", () => {
      const res = parseUserMessage("Stock alfajor havana", refDate);
      expect(res.type).toBe("STOCK_PRODUCT");
      expect(res.slots.productSearch).toBe("alfajor havana");
    });
  });

  describe("5. Regresión de Opciones del Menú (1 a 5)", () => {
    it("preserves numerical shortcut 1 (Stock)", () => {
      const res = parseUserMessage("1", refDate);
      expect(res.type).toBe("STOCK_PRODUCT");
      expect(res.slots.needsClarification).toBe(true);
      expect(res.slots.clarificationType).toBe("PRODUCT");
    });

    it("preserves numerical shortcut 2 (Pedidos)", () => {
      const res = parseUserMessage("2", refDate);
      expect(res.type).toBe("ORDERS_RECENT");
    });

    it("preserves numerical shortcut 3 (Reposición)", () => {
      const res = parseUserMessage("3", refDate);
      expect(res.type).toBe("REPLENISHMENT");
      expect(res.slots.needsClarification).toBe(true);
      expect(res.slots.clarificationType).toBe("BRANCH");
    });

    it("preserves numerical shortcut 4 (Resumen)", () => {
      const res = parseUserMessage("4", refDate);
      expect(res.type).toBe("METRICS_SUMMARY");
    });

    it("preserves numerical shortcut 5 (Excel de reposición con rubro y proveedor)", () => {
      const res = parseUserMessage("5", refDate);
      expect(res.type).toBe("REPLENISHMENT_EXCEL");
      expect(res.slots.wantsExcel).toBe(true);
      expect(res.slots.needsClarification).toBe(true);
      expect(res.slots.clarificationType).toBe("RUBRO");
      expect(res.slots.clarificationMessage).toContain("Arcor");
    });
  });

  describe("6. Despacho End-to-End en Processor", () => {
    it("dispatches Excel for a supplier when requested", async () => {
      const mockSendDoc = vi.fn().mockResolvedValue({ success: true, messageId: "doc_123" });
      const mockSendText = vi.fn().mockResolvedValue({ success: true, messageId: "txt_123" });

      const result = await processIncomingMessage({
        messageId: "msg_supplier_excel_1",
        senderPhone: testPhone,
        textBody: "Mandame el Excel de Arcor para Centro",
        configuredAllowedEnv: testPhone,
        sendMessageFn: mockSendText,
        sendDocumentFn: mockSendDoc,
      });

      expect(result.processed).toBe(true);
      expect(result.intent).toBe("REPLENISHMENT_EXCEL");
      expect(mockSendDoc).toHaveBeenCalledTimes(1);
      const [to, doc] = mockSendDoc.mock.calls[0];
      expect(to).toBe(testPhone);
      expect(doc.fileName).toContain("REPOSICION");
      expect(doc.fileName).toContain("ARCOR");
      expect(doc.fileName).toContain("CENTRO");
      expect(doc.caption).toContain("Planilla de Reposición — Proveedor Arcor");
    });

    it("rejects unauthorized senders without leaking data", async () => {
      const unauthorizedPhone = "5491100000000";
      const mockSendDoc = vi.fn();
      const mockSendText = vi.fn().mockResolvedValue({ success: true });

      const result = await processIncomingMessage({
        messageId: "msg_unauth_1",
        senderPhone: unauthorizedPhone,
        textBody: "Pasame el Excel de Coca-Cola",
        configuredAllowedEnv: testPhone,
        sendMessageFn: mockSendText,
        sendDocumentFn: mockSendDoc,
      });

      expect(result.processed).toBe(true);
      expect(result.intent).toBe("UNAUTHORIZED");
      expect(mockSendDoc).not.toHaveBeenCalled();
      expect(mockSendText).toHaveBeenCalledTimes(1);
      expect(mockSendText.mock.calls[0][1]).toContain("Acceso Restringido");
    });
  });
});
