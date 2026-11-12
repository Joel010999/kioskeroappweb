import { getSenderContext, maskPhone } from "./auth";
import { registerIncomingMessage, markMessageProcessed, markMessageFailed } from "./deduplication";
import { parsePaginationCommand, parseUserMessage, formatRubroLabel } from "./router";
import type { BranchTarget, ParsedIntent } from "./types";
import {
  clearPendingClarification,
  clearPaginatedList,
  getPaginatedList,
  getPendingClarification,
  resolvePendingClarification,
  resolveContextualCorrection,
  setPaginatedList,
  setPendingClarification,
  setLastFulfilledContext,
  type PaginatedListState,
} from "./context";
import {
  WHATSAPP_PAGE_SIZE,
  formatAmbiguousPendingMessage,
  formatClarificationMessage,
  formatDepositAvailabilityResponse,
  formatGreetingMessage,
  formatHelpMessage,
  formatInventoryExcelCaption,
  formatInventoryExcelEmptyMessage,
  formatInventoryResponse,
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
  splitWhatsAppMessage,
} from "./formatters";
import {
  queryCompleteInventory,
  queryDepositAvailability,
  queryInventoryExcelData,
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
  type CompleteInventoryResult,
  type InventoryReportItem,
  type ProductStockItem,
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

function formatPaginatedListPage(
  cached: PaginatedListState,
  action: { action: "NEXT" | "PREV" | "ALL" | "PAGE"; page?: number }
): { text: string; nextPage: number; reachedEnd: boolean } {
  const totalCount = cached.items.length;
  const pageSize = cached.pageSize || WHATSAPP_PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const showAll = action.action === "ALL";

  let targetPage = cached.currentPage;
  if (action.action === "NEXT") {
    targetPage = Math.min(totalPages, cached.currentPage + 1);
  } else if (action.action === "PREV") {
    targetPage = Math.max(1, cached.currentPage - 1);
  } else if (action.action === "PAGE" && action.page) {
    targetPage = Math.max(1, Math.min(totalPages, action.page));
  }

  const slice = showAll
    ? cached.items
    : cached.items.slice((targetPage - 1) * pageSize, targetPage * pageSize);

  const pagination = {
    page: targetPage,
    pageSize,
    totalCount,
    showAll,
  };

  if (cached.kind === "STOCK_PRODUCT") {
    const items = slice as ProductStockItem[];
    return {
      text: formatStockResponse(
        {
          items,
          totalFound: totalCount,
          queriedAt: cached.meta.queriedAt as string | undefined,
        },
        (cached.meta.branchTarget as BranchTarget) ?? "ALL",
        cached.meta.productSearch as string | undefined,
        pagination
      ),
      nextPage: targetPage,
      reachedEnd: showAll || targetPage >= totalPages,
    };
  }

  if (cached.kind === "SUPPLIER_PRODUCTS") {
    const rows = slice as Array<{
      article_id: number;
      description: string;
      supplier_code: string | null;
      supplier_name: string | null;
      brand: string | null;
    }>;
    return {
      text: formatSupplierProductsResponse(
        rows,
        (cached.meta.supplierSearch as string) ?? "",
        pagination
      ),
      nextPage: targetPage,
      reachedEnd: showAll || targetPage >= totalPages,
    };
  }

  if (cached.kind === "INVENTORY_REPORT") {
    const invData = cached.meta.inventoryMeta as CompleteInventoryResult;
    return {
      text: formatInventoryResponse(invData, slice as InventoryReportItem[], pagination),
      nextPage: targetPage,
      reachedEnd: showAll || targetPage >= totalPages,
    };
  }

  // REPLENISHMENT
  const replMeta = cached.meta.replMeta as {
    branchName: string;
    planningDate: string;
    rubro?: string;
    supplierCode?: string;
    supplierName?: string;
    totalSuggested: number;
    depotProvenance?: CompleteInventoryResult["depotProvenance"];
    isDepotCurrent?: boolean;
  };
  return {
    text: formatReplenishmentResponse(
      {
        ...replMeta,
        items: slice as Array<{
          articleId: number;
          description: string;
          stockCurrent: number;
          stockDepot: number | null;
          suggestedQuantity: number;
          weeklyDemand: number | null;
        }>,
      },
      pagination
    ),
    nextPage: targetPage,
    reachedEnd: showAll || targetPage >= totalPages,
  };
}

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

  // 3. Conversational context check (prioritize pending clarifications, then active pagination)
  const pendingClarification = getPendingClarification(senderPhone);
  const paginationCmd = !pendingClarification ? parsePaginationCommand(textBody) : null;
  const activePaginated = paginationCmd ? getPaginatedList(senderPhone) : null;

  if (paginationCmd) {
    if (activePaginated) {
      const rendered = formatPaginatedListPage(activePaginated, paginationCmd);
      setPaginatedList(senderPhone, {
        ...activePaginated,
        currentPage: rendered.nextPage,
      });
      const chunks = splitWhatsAppMessage(rendered.text);
      for (const chunk of chunks) {
        await sendFn(replyTarget, chunk);
      }
      await markMessageProcessed(messageId, `${activePaginated.kind}_PAGE`);
      return {
        processed: true,
        intent: activePaginated.kind,
        replyText: rendered.text,
      };
    }

    const expiredReply =
      "⌛ No hay un listado activo para seguir paginando (expiró luego de 15 minutos o el bot se reinició). Repetí tu consulta para verlo nuevamente.";
    await sendFn(replyTarget, expiredReply);
    await markMessageProcessed(messageId, "PAGINATION_EXPIRED");
    return {
      processed: true,
      intent: "PAGINATION_EXPIRED",
      replyText: expiredReply,
    };
  }

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
    // Brand-new intent or contextual continuation
    const baseIntent = parseUserMessage(textBody);
    const contextualIntent = resolveContextualCorrection(senderPhone, textBody, baseIntent);
    intent = contextualIntent || baseIntent;
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
        const showAll = Boolean(intent.slots.wantsAllResults);
        if (!showAll && stockData.items.length > WHATSAPP_PAGE_SIZE) {
          setPaginatedList(senderPhone, {
            kind: "STOCK_PRODUCT",
            items: stockData.items,
            pageSize: WHATSAPP_PAGE_SIZE,
            currentPage: 1,
            meta: {
              branchTarget: intent.slots.branchTarget,
              productSearch: intent.slots.productSearch,
              queriedAt: stockData.items[0]?.queriedAt,
            },
          });
        } else {
          clearPaginatedList(senderPhone);
        }
        const displayed = showAll
          ? stockData.items
          : stockData.items.slice(0, WHATSAPP_PAGE_SIZE);
        replyText = formatStockResponse(
          { ...stockData, items: displayed },
          intent.slots.branchTarget,
          intent.slots.productSearch,
          stockData.items.length > WHATSAPP_PAGE_SIZE
            ? {
                page: 1,
                pageSize: WHATSAPP_PAGE_SIZE,
                totalCount: stockData.items.length,
                showAll,
              }
            : undefined
        );
        break;
      }

      case "INVENTORY_REPORT": {
        const invData = await queryCompleteInventory({
          branchTarget: intent.slots.branchTarget,
          branchId: intent.slots.branchId,
          rubro: intent.slots.targetRubro,
          supplierCode: intent.slots.supplierCode,
          supplierName: intent.slots.supplierName,
          supplierSearch: intent.slots.supplierSearch,
          includeInactive: intent.slots.includeInactive,
        });
        const showAll = Boolean(intent.slots.wantsAllResults);
        if (!showAll && invData.items.length > WHATSAPP_PAGE_SIZE) {
          setPaginatedList(senderPhone, {
            kind: "INVENTORY_REPORT",
            items: invData.items,
            pageSize: WHATSAPP_PAGE_SIZE,
            currentPage: 1,
            meta: { inventoryMeta: invData },
          });
        } else {
          clearPaginatedList(senderPhone);
        }
        const displayed = showAll
          ? invData.items
          : invData.items.slice(0, WHATSAPP_PAGE_SIZE);
        replyText = formatInventoryResponse(
          invData,
          displayed,
          invData.items.length > WHATSAPP_PAGE_SIZE
            ? {
                page: 1,
                pageSize: WHATSAPP_PAGE_SIZE,
                totalCount: invData.items.length,
                showAll,
              }
            : undefined
        );
        break;
      }

      case "INVENTORY_EXCEL": {
        const invExcel = await queryInventoryExcelData({
          branchTarget: intent.slots.branchTarget,
          branchId: intent.slots.branchId,
          rubro: intent.slots.targetRubro,
          supplierCode: intent.slots.supplierCode,
          supplierName: intent.slots.supplierName,
          supplierSearch: intent.slots.supplierSearch,
          includeInactive: intent.slots.includeInactive,
        });

        if (!invExcel.excelBuffer || invExcel.items.length === 0) {
          replyText = formatInventoryExcelEmptyMessage(invExcel);
        } else {
          const cleanScope = (
            invExcel.rubro ||
            invExcel.supplierName ||
            invExcel.supplierCode ||
            "COMPLETO"
          )
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .replace(/\s+/g, "_")
            .toUpperCase();
          const cleanBranch = invExcel.branchName
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .replace(/[^A-Z0-9]+/gi, "_")
            .toUpperCase();
          const dateSlug = invExcel.queriedAt.slice(0, 10);
          const fileName = `INVENTARIO_${cleanScope}_${cleanBranch}_${dateSlug}.xlsx`;
          const caption = formatInventoryExcelCaption(invExcel);

          const docSendRes = await sendDocFn(replyTarget, {
            document: invExcel.excelBuffer,
            fileName,
            mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            caption,
          });
          if (!docSendRes.success) {
            throw new Error(docSendRes.error || "Error al enviar Excel de inventario");
          }
          await markMessageProcessed(messageId, intent.type);
          setLastFulfilledContext(senderPhone, {
            intentType: intent.type,
            slots: intent.slots,
          });
          return {
            processed: true,
            intent: intent.type,
            replyText: caption,
          };
        }
        break;
      }

      case "STOCK_LOW": {
        const lowStockData = await queryLowStock(
          intent.slots.branchTarget,
          intent.slots.branchId,
          10,
          intent.slots.targetRubro,
          intent.slots.supplierCode
        );
        replyText = formatLowStockResponse(lowStockData);
        break;
      }

      case "DEPOSIT_AVAILABILITY": {
        const branchId = intent.slots.branchId || (intent.slots.branchTarget === "JARDIN" ? 3 : 2);
        const depData = await queryDepositAvailability(
          branchId,
          intent.slots.targetRubro,
          10
        );
        replyText = formatDepositAvailabilityResponse(depData);
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
        const showAll = Boolean(intent.slots.wantsAllResults);
        if (!showAll && replData.items.length > WHATSAPP_PAGE_SIZE) {
          setPaginatedList(senderPhone, {
            kind: "REPLENISHMENT",
            items: replData.items,
            pageSize: WHATSAPP_PAGE_SIZE,
            currentPage: 1,
            meta: { replMeta: replData },
          });
        } else {
          clearPaginatedList(senderPhone);
        }
        const displayed = showAll
          ? replData.items
          : replData.items.slice(0, WHATSAPP_PAGE_SIZE);
        replyText = formatReplenishmentResponse(
          { ...replData, items: displayed },
          replData.items.length > WHATSAPP_PAGE_SIZE
            ? {
                page: 1,
                pageSize: WHATSAPP_PAGE_SIZE,
                totalCount: replData.items.length,
                showAll,
              }
            : undefined
        );
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
          const cleanRubro = excelData.rubro ? excelData.rubro.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, "_").toUpperCase() : "";
          const cleanSupplier = (excelData.supplierName || (excelData.supplierCode ? `PROV_${excelData.supplierCode}` : "")).normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, "_").toUpperCase();
          const cleanBranch = excelData.branchName.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, "_").toUpperCase();
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

          setLastFulfilledContext(senderPhone, {
            intentType: intent.type,
            slots: {
              ...intent.slots,
              targetRubro: excelData.rubro,
              supplierCode: excelData.supplierCode,
              supplierName: excelData.supplierName,
              branchId: excelData.branchId,
              branchTarget: excelData.branchId === 2 ? "CENTRO" : "JARDIN",
            },
          });

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
        const searchTerm = intent.slots.supplierSearch || "";
        const supplierProducts = await querySupplierProducts(searchTerm);
        const showAll = Boolean(intent.slots.wantsAllResults);
        if (!showAll && supplierProducts.length > WHATSAPP_PAGE_SIZE) {
          setPaginatedList(senderPhone, {
            kind: "SUPPLIER_PRODUCTS",
            items: supplierProducts,
            pageSize: WHATSAPP_PAGE_SIZE,
            currentPage: 1,
            meta: { supplierSearch: searchTerm },
          });
        } else {
          clearPaginatedList(senderPhone);
        }
        const displayed = showAll
          ? supplierProducts
          : supplierProducts.slice(0, WHATSAPP_PAGE_SIZE);
        replyText = formatSupplierProductsResponse(
          displayed,
          searchTerm,
          supplierProducts.length > WHATSAPP_PAGE_SIZE
            ? {
                page: 1,
                pageSize: WHATSAPP_PAGE_SIZE,
                totalCount: supplierProducts.length,
                showAll,
              }
            : undefined
        );
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

    // 6. Record fulfilled context for follow-up questions/corrections
    if (
      intent.type !== "UNKNOWN" &&
      intent.type !== "HELP" &&
      intent.type !== "GREETING"
    ) {
      setLastFulfilledContext(senderPhone, {
        intentType: intent.type,
        slots: intent.slots,
      });
    }

    // 7. Send WhatsApp reply (split automatically if exceeding message threshold)
    console.log(`[WHATSAPP PROCESSOR] Attempting to send reply for intent=${intent.type} to ${maskPhone(replyTarget)}`);
    const chunks = splitWhatsAppMessage(replyText);
    for (const chunk of chunks) {
      const sendResult = await sendFn(replyTarget, chunk);
      console.log(`[WHATSAPP PROCESSOR] Reply dispatch result: success=${Boolean(sendResult?.success)}`);
    }
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
