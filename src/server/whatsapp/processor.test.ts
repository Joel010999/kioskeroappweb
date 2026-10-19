import { beforeEach, describe, expect, it, vi } from "vitest";
import { processIncomingMessage } from "./processor";
import { clearMemoryDeduplicationCache } from "./deduplication";

// Mock DB client to avoid network timeouts during unit tests
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
        description: "Alfajor Havanna Chocolate",
        brand: "Havanna",
        rubro: "Golosinas",
        stockCentro: 24,
        stockJardin: 12,
        stockDepot: 120,
        depotSnapshotDate: "2026-09-18T10:00:00Z",
      },
    ],
    totalFound: 1,
  }),
  queryStockAlerts: vi.fn().mockResolvedValue({
    branchName: "Centro",
    negativeCount: 1,
    outOfStockCount: 3,
    negativeItems: [{ articleId: 9001, description: "Chicle Globo", saldo: -5 }],
    outOfStockItems: [{ articleId: 9002, description: "Caramelos Miel" }],
  }),
  queryReplenishment: vi.fn().mockResolvedValue({
    branchName: "Centro",
    planningDate: "2026-10-24",
    items: [
      {
        articleId: 1052,
        description: "Alfajor Havanna",
        stockCurrent: 4,
        stockDepot: 120,
        suggestedQuantity: 24,
        weeklyDemand: 30,
      },
    ],
    totalSuggested: 1,
  }),
  queryOrderDetail: vi.fn().mockResolvedValue({
    id: 1,
    order_number: 3,
    origin_branch_id: 2,
    destination_branch_id: 1,
    status: "DISPATCHED",
    created_at: "2026-10-15T09:00:00Z",
    planning_date: "2026-10-17",
    item_count: 5,
    requested_units: 50,
    approved_units: 50,
    prepared_units: 50,
    dispatched_units: 50,
    received_units: 0,
    items: [
      {
        article_id: 1052,
        product_name_snapshot: "Alfajor Havanna",
        requested_quantity: 20,
        dispatched_quantity: 20,
      },
    ],
  }),
  queryPendingOrders: vi.fn().mockResolvedValue({
    summary: { pending: 1, inPreparation: 1, readyToDispatch: 1, dispatched: 2, completed: 10 },
    orders: [
      {
        id: 3,
        order_number: 3,
        origin_branch_id: 2,
        status: "DISPATCHED",
        requested_units: 50,
      },
    ],
  }),
  queryRecentOrders: vi.fn().mockResolvedValue({
    total: 3,
    rows: [
      {
        id: 3,
        order_number: 3,
        origin_branch_id: 2,
        status: "DISPATCHED",
        requested_units: 50,
        dispatched_units: 50,
        created_at: "2026-10-15T09:00:00Z",
      },
    ],
  }),
  queryProductSupplier: vi.fn().mockResolvedValue([
    {
      article_id: 1052,
      description: "Alfajor Havanna",
      supplier_code: "HAV01",
      supplier_name: "Havanna S.A.",
      brand: "Havanna",
      rubro: "Golosinas",
    },
  ]),
  querySupplierProducts: vi.fn().mockResolvedValue([
    {
      article_id: 2001,
      description: "Bon o Bon Leche",
      supplier_code: "ARC01",
      supplier_name: "Arcor",
      brand: "Arcor",
    },
  ]),
  queryPeriodOverview: vi.fn().mockResolvedValue({
    branchName: "Centro",
    periodLabel: "2026-09-01 al 2026-09-30",
    net_units: 14500,
    movements: 3200,
    variation_vs_previous_percent: 8.5,
    previous_net_units: 13360,
    stock_total: 8200,
    products_without_stock: 14,
    active_products: 420,
    last_updated_at: "2026-10-18T10:00:00Z",
  }),
  queryTopProductsMetrics: vi.fn().mockResolvedValue({
    branchName: "Centro",
    products: [
      {
        article_id: 1052,
        description: "Alfajor Havanna Chocolate",
        brand: "Havanna",
        net_units: 420,
        movements: 110,
      },
    ],
  }),
  querySystemHealthStatus: vi.fn().mockResolvedValue({
    first_movement: "2025-01-01",
    last_movement: "2026-10-18",
    total_movements: 54000,
    freshness: { status: "OK", age_minutes: 15 },
  }),
}));

describe("WhatsApp Message Processor Integration", () => {
  const allowedNumbers = "5491112345678, +54 9 11 9999-8888";
  let sentReplies: Array<{ to: string; text: string }> = [];

  const mockSend = vi.fn().mockImplementation(async (to: string, text: string) => {
    sentReplies.push({ to, text });
    return { success: true, messageId: "wamid.REPLY_123" };
  });

  beforeEach(() => {
    clearMemoryDeduplicationCache();
    sentReplies = [];
    vi.clearAllMocks();
  });

  it("rejects unauthorized senders with polite restriction notice", async () => {
    const result = await processIncomingMessage({
      messageId: "wamid.UNAUTH_01",
      senderPhone: "5491100000000",
      textBody: "Stock alfajor havanna",
      configuredAllowedEnv: allowedNumbers,
      sendMessageFn: mockSend,
    });

    expect(result.processed).toBe(true);
    expect(result.intent).toBe("UNAUTHORIZED");
    expect(sentReplies.length).toBe(1);
    expect(sentReplies[0].text).toContain("Acceso Restringido");
    expect(sentReplies[0].text).not.toContain("Havanna"); // No commercial info leaked
  });

  it("processes stock query for authorized sender", async () => {
    const result = await processIncomingMessage({
      messageId: "wamid.AUTH_STOCK_01",
      senderPhone: "5491112345678",
      textBody: "¿Cuánto stock de alfajor havanna hay en Centro?",
      configuredAllowedEnv: allowedNumbers,
      sendMessageFn: mockSend,
    });

    expect(result.processed).toBe(true);
    expect(result.intent).toBe("STOCK_PRODUCT");
    expect(sentReplies.length).toBe(1);
    expect(sentReplies[0].text).toContain("Alfajor Havanna Chocolate");
    expect(sentReplies[0].text).toContain("Centro:* 24 u.");
  });

  it("processes order detail query by visible number #3", async () => {
    const result = await processIncomingMessage({
      messageId: "wamid.AUTH_ORDER_01",
      senderPhone: "5491112345678",
      textBody: "Pedido #3",
      configuredAllowedEnv: allowedNumbers,
      sendMessageFn: mockSend,
    });

    expect(result.processed).toBe(true);
    expect(result.intent).toBe("ORDER_DETAIL");
    expect(sentReplies.length).toBe(1);
    expect(sentReplies[0].text).toContain("Detalle del Pedido #3");
    expect(sentReplies[0].text).toContain("Despachado");
  });

  it("asks for clarification if replenishment branch is missing", async () => {
    const result = await processIncomingMessage({
      messageId: "wamid.AUTH_REPL_01",
      senderPhone: "5491112345678",
      textBody: "Sugerencias de reposición",
      configuredAllowedEnv: allowedNumbers,
      sendMessageFn: mockSend,
    });

    expect(result.processed).toBe(true);
    expect(result.intent).toBe("REPLENISHMENT");
    expect(sentReplies.length).toBe(1);
    expect(sentReplies[0].text).toContain("Aclaración requerida");
    expect(sentReplies[0].text).toContain("Centro");
  });

  it("skips duplicate messages by messageId without sending duplicate replies", async () => {
    const msgId = "wamid.DUP_MSG_TEST";
    const phone = "5491112345678";

    const first = await processIncomingMessage({
      messageId: msgId,
      senderPhone: phone,
      textBody: "Hola",
      configuredAllowedEnv: allowedNumbers,
      sendMessageFn: mockSend,
    });
    expect(first.processed).toBe(true);
    expect(sentReplies.length).toBe(1);

    const second = await processIncomingMessage({
      messageId: msgId,
      senderPhone: phone,
      textBody: "Hola",
      configuredAllowedEnv: allowedNumbers,
      sendMessageFn: mockSend,
    });
    expect(second.processed).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(sentReplies.length).toBe(1); // No second message sent!
  });

  it("processes metrics summary query for september", async () => {
    const result = await processIncomingMessage({
      messageId: "wamid.AUTH_METRICS_01",
      senderPhone: "5491112345678",
      textBody: "¿Qué pasó durante septiembre?",
      configuredAllowedEnv: allowedNumbers,
      sendMessageFn: mockSend,
    });

    expect(result.processed).toBe(true);
    expect(result.intent).toBe("METRICS_SUMMARY");
    expect(sentReplies.length).toBe(1);
    expect(sentReplies[0].text).toContain("Resumen Operativo");
    expect(sentReplies[0].text).toContain("Unidades netas vendidas");
  });
});
