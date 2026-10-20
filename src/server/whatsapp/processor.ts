import { getSenderContext, maskPhone } from "./auth";
import { registerIncomingMessage, markMessageProcessed, markMessageFailed } from "./deduplication";
import { parseUserMessage, formatRubroLabel } from "./router";
import type { ParsedIntent } from "./types";
import {
  clearPendingClarification,
  resolvePendingClarification,
  setPendingClarification,
} from "./context";
import {
  formatAmbiguousPendingMessage,
  formatClarificationMessage,
  formatGreetingMessage,
  formatHelpMessage,
  formatLowStockResponse,
  formatNextDeliveryMessage,
  formatOrderDetailResponse,
  formatOverviewResponse,
  formatPendingOrdersResponse,
  formatProductSupplierResponse,
  formatPurchaseQueryMessage,
  formatRecentOrdersResponse,
  formatReplenishmentExcelCaption,
  formatReplenishmentExcelEmptyMessage,
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
  queryLowStock,
  queryOrderDetail,
  queryPendingOrders,
  queryPeriodOverview,
  queryProductStock,
  queryProductSupplier,
  queryRecentOrders,
  queryReplenishment,
  queryReplenishmentExcelData,
  queryStockAlerts,
  querySupplierProducts,
  querySystemHealthStatus,
  queryTopProductsMetrics,
} from "./queries";
import { sendWhatsAppDocument, sendWhatsAppMessage } from "./client";

export type ProcessMessageInput = {
  messageId: string;
  senderPhone: string;
  replyTo?: string;
  textBody?: string;
  senderName?: string;
  configuredAllowedEnv?: string;
  sendMessageFn?: typeof sendWhatsAppMessage;
  sendDocumentFn?: typeof sendWhatsAppDocument;
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
  const replyTarget = input.replyTo || senderPhone;
  const sendFn = input.sendMessageFn ?? sendWhatsAppMessage;
  const sendDocFn = input.sendDocumentFn ?? sendWhatsAppDocument;

  // 1. Deduplication check
  const isNew = await registerIncomingMessage(messageId, senderPhone);
  if (!isNew) {
    console.log(`[WHATSAPP PROCESSOR] Message id=${messageId} already processed (duplicate). Skipping.`);
    return { processed: false, duplicate: true };
  }

  console.log(`[WHATSAPP PROCESSOR] Processing message id=${messageId} from ${maskPhone(senderPhone)}`);

  // 2. Authorization check
  const senderContext = await getSenderContext(senderPhone, senderName, input.configuredAllowedEnv);
  console.log(
    `[WHATSAPP PROCESSOR] Authorization check for ${maskPhone(senderPhone)}: ` +
    `${senderContext.isAuthorized ? "AUTHORIZED" : "UNAUTHORIZED"}`
  );

  if (!senderContext.isAuthorized) {
    const replyText = formatUnauthorizedMessage();
    console.warn(`[WHATSAPP PROCESSOR] Sender ${maskPhone(senderPhone)} unauthorized. Sending restricted notice.`);
    const res = await sendFn(replyTarget, replyText);
    console.log(`[WHATSAPP PROCESSOR] Unauthorized notice sent: success=${Boolean(res?.success)}`);
    await markMessageProcessed(messageId, "UNAUTHORIZED");
    return { processed: true, intent: "UNAUTHORIZED", replyText };
  }

  // 3. Conversational context check (prioritize pending clarifications)
  let intent: ParsedIntent;
  const clarificationResult = resolvePendingClarification(senderPhone, textBody);

  if (clarificationResult.type === "RESOLVED") {
    console.log(
      `[WHATSAPP PROCESSOR] Resolved pending clarification to intent=${clarificationResult.intent.type} for ${maskPhone(senderPhone)}`
    );
    intent = clarificationResult.intent;
  } else if (clarificationResult.type === "CANCELLED") {
    console.log(`[WHATSAPP PROCESSOR] Clarification cancelled by user for ${maskPhone(senderPhone)}`);
    const replyText = clarificationResult.message;
    const res = await sendFn(replyTarget, replyText);
    console.log(`[WHATSAPP PROCESSOR] Cancel reply sent: success=${Boolean(res?.success)}`);
    await markMessageProcessed(messageId, "CANCELLED");
    return { processed: true, intent: "CANCELLED", replyText };
  } else if (clarificationResult.type === "RE_PROMPT") {
    console.log(`[WHATSAPP PROCESSOR] Re-prompting clarification for ${maskPhone(senderPhone)}`);
    const replyText = clarificationResult.message;
    const res = await sendFn(replyTarget, replyText);
    console.log(`[WHATSAPP PROCESSOR] Re-prompt sent: success=${Boolean(res?.success)}`);
    await markMessageProcessed(messageId, "RE_PROMPT");
    return { processed: true, intent: "RE_PROMPT", replyText };
  } else {
    // Brand-new intent
    intent = parseUserMessage(textBody);
  }

  console.log(`[WHATSAPP PROCESSOR] Intent resolved: ${intent.type} for id=${messageId}`);

  // 4. Clarification check
  if (intent.slots.needsClarification && intent.slots.clarificationMessage) {
    setPendingClarification(senderPhone, {
      intentType: intent.slots.pendingIntentType ?? intent.type,
      slots: intent.slots,
      clarificationType: intent.slots.clarificationType ?? "BRANCH",
    });

    const replyText = formatClarificationMessage(intent.slots.clarificationMessage);
    console.log(`[WHATSAPP PROCESSOR] Requesting clarification for intent=${intent.type}`);
    const res = await sendFn(replyTarget, replyText);
    console.log(`[WHATSAPP PROCESSOR] Clarification prompt sent: success=${Boolean(res?.success)}`);
    await markMessageProcessed(messageId, intent.type);
    return { processed: true, intent: intent.type, replyText };
  }

  // Clear any existing clarification for clean slate once a query proceeds
  clearPendingClarification(senderPhone);

  // 5. Query execution & Formatting
  let replyText = "";

  try {
    switch (intent.type) {
      case "GREETING":
        replyText = formatGreetingMessage(senderContext.name);
        break;

      case "HELP":
        replyText = formatHelpMessage(senderContext.name);
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

      case "STOCK_LOW": {
        const lowStockData = await queryLowStock(
          intent.slots.branchTarget,
          intent.slots.branchId,
          10
        );
        replyText = formatLowStockResponse(lowStockData);
        break;
      }

      case "STOCK_OUT_ALERT": {
        const alertsData = await queryStockAlerts(intent.slots.branchTarget, intent.slots.branchId);
        replyText = formatStockAlertsResponse(alertsData);
        break;
      }

      case "REPLENISHMENT": {
        const branchId = intent.slots.branchId || 2;
        const replData = await queryReplenishment(
          branchId,
          intent.slots.targetRubro,
          intent.slots.supplierCode,
          intent.slots.supplierName
        );
        replyText = formatReplenishmentResponse(replData);
        break;
      }

      case "REPLENISHMENT_EXCEL": {
        const targetRubro = intent.slots.targetRubro;
        const supplierCode = intent.slots.supplierCode;
        const supplierName = intent.slots.supplierName;
        const branchId = intent.slots.branchId;

        if (!targetRubro && !supplierCode) {
          replyText = formatClarificationMessage(
            "Para generar el Excel de reposición, podés indicarme el rubro (ej. *Chocolates*, *Galletitas*, *Bebidas*, *Cigarrillos*) o el proveedor (ej. *Arcor*, *Baggio*, *50350*)."
          );
          setPendingClarification(senderPhone, {
            intentType: "REPLENISHMENT_EXCEL",
            slots: intent.slots,
            clarificationType: "RUBRO",
          });
          break;
        }

        if (!branchId || (branchId !== 2 && branchId !== 3)) {
          const targetDesc =
            targetRubro && (supplierName || supplierCode)
              ? `de *${formatRubroLabel(targetRubro)}* del proveedor *${supplierName || supplierCode}*`
              : supplierName || supplierCode
              ? `del proveedor *${supplierName || supplierCode}*`
              : `de *${formatRubroLabel(targetRubro!)}*`;

          replyText = formatClarificationMessage(
            branchId === 1
              ? `La reposición semanal se calcula para las sucursales de venta (*Centro* o *Jardín*) que se abastecen desde el Depósito Central. ¿Para cuál querés generar el Excel ${targetDesc}?`
              : `Para generar el Excel de reposición ${targetDesc}, por favor indicame si lo necesitás para *Centro*, *Jardín* o *Depósito*.`
          );
          setPendingClarification(senderPhone, {
            intentType: "REPLENISHMENT_EXCEL",
            slots: { ...intent.slots, targetRubro, supplierCode, supplierName },
            clarificationType: "BRANCH",
          });
          break;
        }

        const excelData = await queryReplenishmentExcelData({
          branchId,
          rubro: targetRubro,
          supplierCode,
          supplierName,
        });

        if (!excelData.excelBuffer || excelData.totalEligible === 0) {
          replyText = formatReplenishmentExcelEmptyMessage({
            rubro: excelData.rubro,
            supplierCode: excelData.supplierCode,
            supplierName: excelData.supplierName,
            branchName: excelData.branchName,
            negativeStockCount: excelData.negativeStockCount,
            negativeStockProducts: excelData.negativeStockProducts,
          });
        } else {
          const cleanRubro = excelData.rubro ? excelData.rubro.replace(/\s+/g, "_").toUpperCase() : "";
          const cleanSupplier = (excelData.supplierName || (excelData.supplierCode ? `PROV_${excelData.supplierCode}` : "")).replace(/\s+/g, "_").toUpperCase();
          const cleanBranch = excelData.branchName.replace(/\s+/g, "_").toUpperCase();
          const cleanTarget = cleanRubro && cleanSupplier ? `${cleanRubro}_${cleanSupplier}` : cleanSupplier || cleanRubro || "GENERAL";
          const fileName = `REPOSICION_${cleanTarget}_${cleanBranch}_${excelData.planningDate}.xlsx`;
          const caption = formatReplenishmentExcelCaption({
            rubro: excelData.rubro,
            supplierCode: excelData.supplierCode,
            supplierName: excelData.supplierName,
            branchName: excelData.branchName,
            totalEligible: excelData.totalEligible,
            planningDate: excelData.planningDate,
            negativeStockCount: excelData.negativeStockCount,
            negativeStockProducts: excelData.negativeStockProducts,
          });

          console.log(
            `[WHATSAPP PROCESSOR] Sending Excel document: ${fileName} to ${maskPhone(replyTarget)}`
          );

          const docSendRes = await sendDocFn(replyTarget, {
            document: excelData.excelBuffer,
            fileName,
            mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            caption,
          });

          if (!docSendRes.success) {
            throw new Error(docSendRes.error || "Error al enviar documento por WhatsApp");
          }

          console.log(`[WHATSAPP PROCESSOR] Excel document dispatch result: success=true`);
          await markMessageProcessed(messageId, intent.type);

          return {
            processed: true,
            intent: intent.type,
            replyText: caption,
          };
        }
        break;
      }

      case "NEXT_DELIVERY": {
        replyText = formatNextDeliveryMessage();
        break;
      }

      case "AMBIGUOUS_PENDING": {
        replyText = formatAmbiguousPendingMessage();
        setPendingClarification(senderPhone, {
          intentType: "AMBIGUOUS_PENDING",
          slots: intent.slots,
          clarificationType: "AMBIGUOUS_PENDING",
        });
        break;
      }

      case "PURCHASE_QUERY": {
        replyText = formatPurchaseQueryMessage();
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
    console.log(`[WHATSAPP PROCESSOR] Attempting to send reply for intent=${intent.type} to ${maskPhone(replyTarget)}`);
    const sendResult = await sendFn(replyTarget, replyText);
    console.log(`[WHATSAPP PROCESSOR] Reply dispatch result: success=${Boolean(sendResult?.success)}`);
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
    try {
      console.log(`[WHATSAPP PROCESSOR] Attempting to send fallback reply to ${maskPhone(replyTarget)}`);
      await sendFn(replyTarget, fallbackReply);
    } catch {
      // Ignore fallback send error
    }

    return {
      processed: true,
      intent: intent.type,
      error: errorMsg,
      replyText: fallbackReply,
    };
  }
}
