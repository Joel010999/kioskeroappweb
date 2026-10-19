import { getSenderContext } from "./auth";
import { registerIncomingMessage, markMessageProcessed, markMessageFailed } from "./deduplication";
import { parseUserMessage } from "./router";
import {
  formatClarificationMessage,
  formatGreetingMessage,
  formatHelpMessage,
  formatOrderDetailResponse,
  formatOverviewResponse,
  formatPendingOrdersResponse,
  formatProductSupplierResponse,
  formatRecentOrdersResponse,
  formatReplenishmentResponse,
  formatStockAlertsResponse,
  formatStockResponse,
  formatSupplierProductsResponse,
  formatSystemHealthResponse,
  formatTopProductsResponse,
  formatUnauthorizedMessage,
  formatUnknownMessage,
} from "./formatters";
import {
  queryOrderDetail,
  queryPendingOrders,
  queryPeriodOverview,
  queryProductStock,
  queryProductSupplier,
  queryRecentOrders,
  queryReplenishment,
  queryStockAlerts,
  querySupplierProducts,
  querySystemHealthStatus,
  queryTopProductsMetrics,
} from "./queries";
import { sendWhatsAppMessage } from "./client";

export type ProcessMessageInput = {
  messageId: string;
  senderPhone: string;
  textBody?: string;
  senderName?: string;
  configuredAllowedEnv?: string;
  sendMessageFn?: typeof sendWhatsAppMessage;
};

export type ProcessMessageResult = {
  processed: boolean;
  duplicate?: boolean;
  intent?: string;
  replyText?: string;
  error?: string;
};

/**
 * Main coordinator for processing an incoming WhatsApp message.
 * Pure read-only execution, authorization check, intent routing, and reply dispatch.
 */
export async function processIncomingMessage(
  input: ProcessMessageInput
): Promise<ProcessMessageResult> {
  const { messageId, senderPhone, textBody = "", senderName } = input;
  const sendFn = input.sendMessageFn ?? sendWhatsAppMessage;

  // 1. Deduplication check
  const isNew = await registerIncomingMessage(messageId, senderPhone);
  if (!isNew) {
    return { processed: false, duplicate: true };
  }

  // 2. Authorization check
  const senderContext = await getSenderContext(senderPhone, senderName, input.configuredAllowedEnv);
  if (!senderContext.isAuthorized) {
    const replyText = formatUnauthorizedMessage();
    await sendFn(senderPhone, replyText);
    await markMessageProcessed(messageId, "UNAUTHORIZED");
    return { processed: true, intent: "UNAUTHORIZED", replyText };
  }

  // 3. Message Interpretation / NLP routing
  const intent = parseUserMessage(textBody);

  // 4. Clarification check
  if (intent.slots.needsClarification && intent.slots.clarificationMessage) {
    const replyText = formatClarificationMessage(intent.slots.clarificationMessage);
    await sendFn(senderPhone, replyText);
    await markMessageProcessed(messageId, intent.type);
    return { processed: true, intent: intent.type, replyText };
  }

  // 5. Query execution & Formatting
  let replyText = "";

  try {
    switch (intent.type) {
      case "GREETING":
        replyText = formatGreetingMessage(senderContext.name);
        break;

      case "HELP":
        replyText = formatHelpMessage();
        break;

      case "STOCK_PRODUCT": {
        const stockData = await queryProductStock(
          { articleId: intent.slots.articleId, productSearch: intent.slots.productSearch },
          intent.slots.branchTarget,
          intent.slots.branchId
        );
        replyText = formatStockResponse(stockData, intent.slots.branchTarget);
        break;
      }

      case "STOCK_OUT_ALERT": {
        const alertsData = await queryStockAlerts(intent.slots.branchTarget, intent.slots.branchId);
        replyText = formatStockAlertsResponse(alertsData);
        break;
      }

      case "REPLENISHMENT": {
        const branchId = intent.slots.branchId || 2;
        const replData = await queryReplenishment(branchId);
        replyText = formatReplenishmentResponse(replData);
        break;
      }

      case "ORDER_DETAIL": {
        try {
          const order = await queryOrderDetail(intent.slots.orderNumber!);
          replyText = formatOrderDetailResponse(order);
        } catch {
          replyText = `🔍 No se encontró ningún pedido con el número *#${intent.slots.orderNumber}*.`;
        }
        break;
      }

      case "ORDERS_PENDING": {
        const pendingData = await queryPendingOrders();
        replyText = formatPendingOrdersResponse(pendingData);
        break;
      }

      case "ORDERS_RECENT": {
        const ordersData = await queryRecentOrders(
          intent.slots.branchTarget,
          intent.slots.branchId,
          5
        );
        replyText = formatRecentOrdersResponse(ordersData);
        break;
      }

      case "PRODUCT_SUPPLIER": {
        const suppliersData = await queryProductSupplier({
          articleId: intent.slots.articleId,
          productSearch: intent.slots.productSearch,
        });
        replyText = formatProductSupplierResponse(suppliersData);
        break;
      }

      case "SUPPLIER_PRODUCTS": {
        const supplierProducts = await querySupplierProducts(intent.slots.supplierSearch || "");
        replyText = formatSupplierProductsResponse(supplierProducts, intent.slots.supplierSearch || "");
        break;
      }

      case "METRICS_SUMMARY":
      case "METRICS_COMPARISON": {
        const overviewData = await queryPeriodOverview(intent.slots.period!, intent.slots.branchId);
        replyText = formatOverviewResponse(overviewData);
        break;
      }

      case "METRICS_TOP_PRODUCTS": {
        const topData = await queryTopProductsMetrics(intent.slots.period!, intent.slots.branchId, 5);
        replyText = formatTopProductsResponse(topData);
        break;
      }

      case "SYSTEM_HEALTH": {
        const healthData = await querySystemHealthStatus(intent.slots.branchId);
        replyText = formatSystemHealthResponse(healthData);
        break;
      }

      case "UNKNOWN":
      default:
        replyText = formatUnknownMessage();
        break;
    }

    // 6. Send WhatsApp reply
    await sendFn(senderPhone, replyText);
    await markMessageProcessed(messageId, intent.type);

    return {
      processed: true,
      intent: intent.type,
      replyText,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Execution failure";
    console.error("Error executing WhatsApp intent query", {
      intent: intent.type,
      error: errorMsg,
    });

    await markMessageFailed(messageId, errorMsg);

    const fallbackReply =
      "⚠️ Ocurrió un error temporal al consultar los datos del sistema. Por favor reintentá en unos minutos.";
    await sendFn(senderPhone, fallbackReply);

    return {
      processed: true,
      intent: intent.type,
      error: errorMsg,
      replyText: fallbackReply,
    };
  }
}
