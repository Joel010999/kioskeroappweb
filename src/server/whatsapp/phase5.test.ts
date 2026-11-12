import { beforeEach, describe, expect, it, vi } from "vitest";
import * as xlsx from "xlsx";
import { query } from "@/server/db/client";
import { parsePaginationCommand, parseUserMessage } from "./router";
import { processIncomingMessage } from "./processor";
import { clearMemoryDeduplicationCache } from "./deduplication";
import {
  clearAllLastFulfilledContexts,
  clearAllPaginatedLists,
  clearAllPendingClarifications,
} from "./context";
import {
  queryInventoryExcelData,
  queryProductStock,
  querySupplierProducts,
} from "./queries";

vi.mock("@/server/db/client", () => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
}));

describe("WhatsApp Phase 5 — Uncapped Search, Pagination & Complete Inventory", () => {
  const testPhone = "5491199990000";

  beforeEach(() => {
    vi.clearAllMocks();
    clearMemoryDeduplicationCache();
    clearAllPendingClarifications();
    clearAllLastFulfilledContexts();
    clearAllPaginatedLists();
  });

  it("routes complete inventory text and Excel queries cleanly without regressing replenishment", () => {
    const invChat = parseUserMessage("Inventario completo de bebidas en Jardín");
    expect(invChat.type).toBe("INVENTORY_REPORT");
    expect(invChat.slots.targetRubro).toBe("BEBIDAS");
    expect(invChat.slots.branchTarget).toBe("JARDIN");
    expect(invChat.slots.branchId).toBe(3);

    const invExcel = parseUserMessage("Pasame un Excel de inventario del proveedor 50350 en Centro");
    expect(invExcel.type).toBe("INVENTORY_EXCEL");
    expect(invExcel.slots.supplierCode).toBe("50350");
    expect(invExcel.slots.branchTarget).toBe("CENTRO");

    const invDepotExcel = parseUserMessage("Planilla de stock de chocolates en Depósito Central");
    expect(invDepotExcel.type).toBe("INVENTORY_EXCEL");
    expect(invDepotExcel.slots.targetRubro).toBe("CHOCOLATES");
    expect(invDepotExcel.slots.branchTarget).toBe("DEPOSITO");
    expect(invDepotExcel.slots.branchId).toBe(1);

    // Must remain separate intents:
    expect(parseUserMessage("Excel de cigarrillos para Centro").type).toBe("REPLENISHMENT_EXCEL");
    expect(parseUserMessage("Stock alfajor havanna en Excel").type).toBe("STOCK_PRODUCT");
  });

  it("removes legacy 5-item and 10-item SQL caps on product and supplier searches", async () => {
    const sqlQueries: string[] = [];
    vi.mocked(query).mockImplementation(async (sql: string) => {
      sqlQueries.push(sql);
      return { rows: [] } as any;
    });

    await queryProductStock({ productSearch: "Dragon Ball" }, "ALL");
    expect(sqlQueries.some((q) => q.includes("LIMIT 250"))).toBe(true);
    expect(sqlQueries.some((q) => q.includes("LIMIT 5\n"))).toBe(false);

    sqlQueries.length = 0;
    await querySupplierProducts("50350");
    expect(sqlQueries[0]).toContain("LIMIT 250");
    expect(sqlQueries[0]).not.toContain("LIMIT 10");
  });

  it("paginates 25 product stock matches across page 1 -> 'ver más' -> 'ver todos' without losing any item", async () => {
    const fakeRows = Array.from({ length: 25 }, (_, i) => ({
      article_id: 8000 + i + 1,
      description: `Figurita Dragon Ball Pack ${i + 1}`,
      brand: "Panini",
      rubro: "Coleccionables",
      bulto: "1",
    }));

    vi.mocked(query).mockImplementation(async (sql: string) => {
      if (sql.includes("INSERT INTO whatsapp_processed_messages")) {
        return { rows: [{ id: "dedup_1" }] } as any;
      }
      if (sql.includes("FROM products_raw p")) {
        return { rows: fakeRows } as any;
      }
      if (sql.includes("FROM stock_levels_raw sl")) {
        return {
          rows: fakeRows.map((r) => ({
            article_id: r.article_id,
            branch_id: 2,
            saldo: "5",
          })),
        } as any;
      }
      if (sql.includes("last_updated_at") || sql.includes("source_freshness") || sql.includes("stock_movements_raw")) {
        return { rows: [] } as any;
      }
      return { rows: [] } as any;
    });

    const sent: string[] = [];
    const mockSend = vi.fn(async (_to: string, text: string) => {
      sent.push(text);
      return { success: true, messageId: `m_${sent.length}` };
    });

    // Turn 1: Query "Dragon Ball" -> first 10 items + pagination prompt
    const turn1 = await processIncomingMessage({
      messageId: "pag_1",
      senderPhone: testPhone,
      textBody: "Stock Dragon Ball",
      configuredAllowedEnv: testPhone,
      sendMessageFn: mockSend,
    });
    expect(turn1.processed).toBe(true);
    expect(turn1.intent).toBe("STOCK_PRODUCT");
    expect(sent[0]).toContain("Figurita Dragon Ball Pack 1");
    expect(sent[0]).toContain("Figurita Dragon Ball Pack 10");
    expect(sent[0]).not.toContain("Figurita Dragon Ball Pack 11");
    expect(sent[0]).toContain("Mostrando *1–10* de *25* resultados");
    expect(sent[0]).toContain("ver más");

    // Turn 2: "ver más" -> page 2 (items 11..20)
    sent.length = 0;
    const turn2 = await processIncomingMessage({
      messageId: "pag_2",
      senderPhone: testPhone,
      textBody: "ver más",
      configuredAllowedEnv: testPhone,
      sendMessageFn: mockSend,
    });
    expect(turn2.processed).toBe(true);
    expect(sent[0]).toContain("Figurita Dragon Ball Pack 11");
    expect(sent[0]).toContain("Figurita Dragon Ball Pack 20");
    expect(sent[0]).not.toContain("Figurita Dragon Ball Pack 21");
    expect(sent[0]).toContain("Mostrando *11–20* de *25* resultados");

    // Turn 3: "ver todos" -> sends ALL 25 items (chunked safely if long)
    sent.length = 0;
    const turn3 = await processIncomingMessage({
      messageId: "pag_3",
      senderPhone: testPhone,
      textBody: "ver todos",
      configuredAllowedEnv: testPhone,
      sendMessageFn: mockSend,
    });
    expect(turn3.processed).toBe(true);
    const fullAllText = sent.join("\n");
    for (let i = 1; i <= 25; i++) {
      expect(fullAllText).toContain(`Figurita Dragon Ball Pack ${i}`);
    }
  });

  it("parses pagination commands accurately and handles expired cache / long message splitting cleanly", async () => {
    expect(parsePaginationCommand("ver más")).toEqual({ action: "NEXT" });
    expect(parsePaginationCommand("siguiente")).toEqual({ action: "NEXT" });
    expect(parsePaginationCommand("ver todos")).toEqual({ action: "ALL" });
    expect(parsePaginationCommand("página 3")).toEqual({ action: "PAGE", page: 3 });

    const { splitWhatsAppMessage } = await import("./formatters");
    const longBody = Array.from({ length: 80 }, (_, idx) => `Bloque ${idx + 1}: ` + "x".repeat(60)).join("\n\n");
    const chunks = splitWhatsAppMessage(longBody, 500);
    expect(chunks.length).toBeGreaterThan(5);
    expect(chunks.every((c) => c.length <= 500)).toBe(true);

    vi.mocked(query).mockImplementation(async (sql: string) => {
      if (sql.includes("INSERT INTO whatsapp_processed_messages")) {
        return { rows: [{ id: "dedup_exp" }] } as any;
      }
      return { rows: [] } as any;
    });

    const sent: string[] = [];
    const res = await processIncomingMessage({
      messageId: "exp_1",
      senderPhone: testPhone,
      textBody: "ver más",
      configuredAllowedEnv: testPhone,
      sendMessageFn: async (_to, text) => {
        sent.push(text);
        return { success: true, messageId: "m_exp" };
      },
    });
    expect(res.processed).toBe(true);
    expect(res.intent).toBe("PAGINATION_EXPIRED");
    expect(sent[0]).toContain("expiró");
  });

  it("generates complete Inventory Excel workbook across Centro, Jardín & Depósito including Base Stock", async () => {
    vi.mocked(query).mockImplementation(async (sql: string) => {
      if (sql.includes("WITH catalog AS")) {
        return {
          rows: [
            {
              article_id: 522,
              description: "Chupetin Pop Arcor",
              brand: "Arcor",
              rubro: "Caramelos",
              supplier_code: "50350",
              supplier_name: "Arcor",
              unit_measure: "UN",
              bulto: "24",
              is_active: true,
              stock_centro: "6",
              stock_jardin: "14",
              stock_depot: "120",
              base_stock_centro: "12",
              base_stock_jardin: "10",
            },
          ],
        } as any;
      }
      return { rows: [] } as any;
    });

    const inv = await queryInventoryExcelData({
      branchTarget: "ALL",
      supplierCode: "50350",
    });

    expect(inv.total).toBe(1);
    expect(inv.excelBuffer).toBeInstanceOf(Buffer);

    const wb = xlsx.read(inv.excelBuffer!, { type: "buffer" });
    expect(wb.SheetNames).toContain("Inventario");
    const rows = xlsx.utils.sheet_to_json(wb.Sheets["Inventario"], { header: 1 }) as any[][];
    const dataRow = rows.find((r) => r[0] === 522);
    expect(dataRow).toBeDefined();
    expect(dataRow![1]).toBe("Chupetin Pop Arcor");
    expect(dataRow![5]).toBe("Activo");
    expect(dataRow![7]).toBe(6); // Stock Centro
    expect(dataRow![8]).toBe(12); // Base Centro
    expect(dataRow![9]).toBe(14); // Stock Jardin
    expect(dataRow![10]).toBe(10); // Base Jardin
    expect(dataRow![11]).toBe(120); // Stock Depot
  });
});
