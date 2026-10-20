import type { ProductStockItem } from "./queries";
import type { BranchTarget } from "./types";
import type { Order } from "@/server/orders/repository";
import { formatRubroLabel } from "./router";

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "No registrada";
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit", year: "numeric" });
  } catch {
    return iso.slice(0, 10);
  }
}

function statusToEmoji(status: string): string {
  switch (status) {
    case "DRAFT":
      return "📝 Borrador";
    case "CONFIRMED":
      return "⏳ Pendiente de preparación";
    case "IN_PREPARATION":
      return "📦 En preparación";
    case "DISPATCHED":
      return "🚚 Despachado";
    case "COMPLETED":
      return "✅ Recibido / Completado";
    case "CANCELLED":
      return "❌ Cancelado";
    default:
      return status;
  }
}

/**
 * Formats stock query results across locations.
 */
export function formatStockResponse(
  data: { items: ProductStockItem[]; totalFound: number },
  branchTarget: BranchTarget
): string {
  if (data.items.length === 0) {
    return (
      "🔍 *Consulta de Stock*\n\n" +
      "No se encontraron productos con ese criterio de búsqueda.\n" +
      "_Tip: Podés buscar por nombre (ej. 'alfajor havanna') o por código (ej. 'art 1052')._"
    );
  }

  const lines: string[] = ["📦 *Stock de Productos*\n"];

  for (const item of data.items) {
    lines.push(`*${item.description}* (Art. \`${item.articleId}\`)`);
    if (item.brand || item.rubro) {
      lines.push(`_Rubro:_ ${item.rubro ?? "General"} | _Marca:_ ${item.brand ?? "-"}`);
    }

    const stockParts: string[] = [];

    if (branchTarget === "ALL" || branchTarget === "CENTRO") {
      const centroText = item.stockCentro !== null ? `${item.stockCentro} u.` : "Sin datos";
      stockParts.push(`• *Centro:* ${centroText}`);
    }
    if (branchTarget === "ALL" || branchTarget === "JARDIN") {
      const jardinText = item.stockJardin !== null ? `${item.stockJardin} u.` : "Sin datos";
      stockParts.push(`• *Jardín:* ${jardinText}`);
    }
    if (branchTarget === "ALL" || branchTarget === "DEPOSITO") {
      const snapDate = item.depotSnapshotDate ? ` (Excel ${formatDate(item.depotSnapshotDate)})` : "";
      const depotText = item.stockDepot !== null ? `${item.stockDepot} u.${snapDate}` : "Sin datos";
      stockParts.push(`• *Depósito:* ${depotText}`);
    }

    lines.push(stockParts.join("\n"));
    lines.push("");
  }

  if (data.totalFound > data.items.length) {
    lines.push(`_Mostrando los primeros ${data.items.length} de ${data.totalFound} productos encontrados._`);
  }

  return lines.join("\n").trim();
}

/**
 * Formats stock alerts (negative stock, out of stock with sales).
 */
export function formatStockAlertsResponse(data: {
  branchName: string;
  negativeCount: number;
  outOfStockCount: number;
  negativeItems: Array<{ articleId: number; description: string; saldo: number }>;
  outOfStockItems: Array<{ articleId: number; description: string }>;
}): string {
  const lines: string[] = [`⚠️ *Alertas de Stock — Sucursal ${data.branchName}*\n`];

  lines.push(`• *En cero (con ventas recientes):* ${data.outOfStockCount} productos`);
  lines.push(`• *Con saldo negativo:* ${data.negativeCount} productos\n`);

  if (data.outOfStockItems.length > 0) {
    lines.push("*Principales faltantes en cero:*");
    for (const item of data.outOfStockItems) {
      lines.push(`• ${item.description} (Art. \`${item.articleId}\`)`);
    }
    lines.push("");
  }

  if (data.negativeItems.length > 0) {
    lines.push("*Artículos con saldo negativo:*");
    for (const item of data.negativeItems) {
      lines.push(`• ${item.description}: *${item.saldo} u.* (Art. \`${item.articleId}\`)`);
    }
    lines.push("");
  }

  lines.push("_Datos basados en la última sincronización del sistema._");
  return lines.join("\n").trim();
}

/**
 * Formats weekly replenishment suggestions.
 */
export function formatReplenishmentResponse(data: {
  branchName: string;
  planningDate: string;
  items: Array<{
    articleId: number;
    description: string;
    stockCurrent: number;
    stockDepot: number | null;
    suggestedQuantity: number;
    weeklyDemand: number | null;
  }>;
  totalSuggested: number;
}): string {
  if (data.items.length === 0) {
    return (
      `📋 *Reposición Semanal — Sucursal ${data.branchName}*\n\n` +
      `No hay productos pendientes de reposición según la demanda proyectada y el stock actual.`
    );
  }

  const lines: string[] = [
    `📋 *Sugerencias de Reposición — Sucursal ${data.branchName}*`,
    `_Ciclo proyectado:_ ${formatDate(data.planningDate)}`,
    `_Total a reponer sugerido:_ ${data.totalSuggested} productos\n`,
    "*Principales sugerencias recomendadas:*",
  ];

  for (const item of data.items) {
    const depotInfo = item.stockDepot !== null ? ` | Depo: ${item.stockDepot} u.` : "";
    lines.push(
      `• *${item.description}* (Art. \`${item.articleId}\`)\n` +
      `  *Pedir: ${item.suggestedQuantity} u.* (Stock actual: ${item.stockCurrent} u.${depotInfo})`
    );
  }

  lines.push("");
  lines.push("_Cálculo basado en demanda de las últimas 6 semanas y estacionalidad YoY._");
  return lines.join("\n").trim();
}

/**
 * Formats detailed order info (by visible order number).
 */
export function formatOrderDetailResponse(order: any): string {
  const visibleNumber = order.order_number ?? order.id;
  const originName = order.origin_branch_id === 2 ? "Centro" : order.origin_branch_id === 3 ? "Jardín" : "Sucursal";
  const destName = order.destination_branch_id === 1 ? "Depósito Central" : "Depósito";

  const lines: string[] = [
    `📋 *Detalle del Pedido #${visibleNumber}*`,
    `• *Origen:* ${originName}`,
    `• *Destino:* ${destName}`,
    `• *Estado:* ${statusToEmoji(order.status)}`,
    `• *Fecha de creación:* ${formatDate(order.created_at)}`,
  ];

  if (order.planning_date) {
    lines.push(`• *Fecha planificada:* ${formatDate(order.planning_date)}`);
  }
  if (order.confirmed_at) {
    lines.push(`• *Fecha confirmación:* ${formatDate(order.confirmed_at)}`);
  }
  if (order.completed_at) {
    lines.push(`• *Fecha recepción:* ${formatDate(order.completed_at)}`);
  }

  lines.push("");
  lines.push("*Cantidades acumuladas:*");
  lines.push(`• Ítems distintos: ${order.item_count}`);
  lines.push(`• Unidades pedidas: ${order.requested_units}`);
  if (order.approved_units > 0) lines.push(`• Unidades aprobadas: ${order.approved_units}`);
  if (order.prepared_units > 0) lines.push(`• Unidades preparadas: ${order.prepared_units}`);
  if (order.dispatched_units > 0) lines.push(`• Unidades despachadas: ${order.dispatched_units}`);
  if (order.received_units > 0) lines.push(`• Unidades recibidas: ${order.received_units}`);

  if (order.items && order.items.length > 0) {
    lines.push("\n*Principales artículos:*");
    const previewItems = order.items.slice(0, 6);
    for (const item of previewItems) {
      lines.push(
        `• ${item.product_name_snapshot} (Art. \`${item.article_id}\`): ` +
        `Ped: *${item.requested_quantity}* | Desp: *${item.dispatched_quantity ?? item.prepared_quantity ?? "-"}*`
      );
    }
    if (order.items.length > 6) {
      lines.push(`_... y ${order.items.length - 6} artículos más._`);
    }
  }

  return lines.join("\n").trim();
}

/**
 * Formats recent orders list.
 */
export function formatRecentOrdersResponse(data: { total: number; rows: Order[] }): string {
  if (data.rows.length === 0) {
    return "📋 *Pedidos*\n\nNo se encontraron pedidos registrados.";
  }

  const lines: string[] = [`📋 *Últimos Pedidos Registrados* (${data.total} en total)\n`];

  for (const o of data.rows) {
    const num = o.order_number ?? o.id;
    const branchName = o.origin_branch_id === 2 ? "Centro" : o.origin_branch_id === 3 ? "Jardín" : "Sucursal";
    lines.push(
      `*Pedido #${num}* — ${branchName}\n` +
      `• Estado: ${statusToEmoji(o.status)}\n` +
      `• Unidades: ${o.requested_units} pedidas | ${o.dispatched_units} despachadas\n` +
      `• Fecha: ${formatDate(o.created_at)}\n`
    );
  }

  lines.push("_Para ver el detalle completo, escribí *Pedido #3*_");
  return lines.join("\n").trim();
}

/**
 * Formats pending orders for warehouse and stores.
 */
export function formatPendingOrdersResponse(data: {
  summary: { pending: number; inPreparation: number; readyToDispatch: number; dispatched: number; completed: number };
  orders: Order[];
}): string {
  const lines: string[] = [
    "📦 *Estado de Pedidos Pendientes*\n",
    `• *Por preparar (Confirmados):* ${data.summary.pending}`,
    `• *En preparación:* ${data.summary.inPreparation}`,
    `• *Listos para despachar:* ${data.summary.readyToDispatch}`,
    `• *Despachados (en viaje / por recibir):* ${data.summary.dispatched}\n`,
  ];

  if (data.orders.length > 0) {
    lines.push("*Pedidos activos en curso:*");
    for (const o of data.orders) {
      const num = o.order_number ?? o.id;
      const origin = o.origin_branch_id === 2 ? "Centro" : o.origin_branch_id === 3 ? "Jardín" : "Sucursal";
      lines.push(
        `• *Pedido #${num}* (${origin}): ${statusToEmoji(o.status)} — ${o.requested_units} unidades`
      );
    }
    lines.push("");
  } else {
    lines.push("✅ No hay pedidos pendientes de despacho o recepción en este momento.\n");
  }

  lines.push("_Escribí *Pedido #X* para ver el contenido de cualquiera de ellos._");
  return lines.join("\n").trim();
}

/**
 * Formats supplier inquiry response.
 */
export function formatProductSupplierResponse(
  rows: Array<{
    article_id: number;
    description: string;
    supplier_code: string | null;
    supplier_name: string | null;
    brand: string | null;
    rubro: string | null;
  }>
): string {
  if (rows.length === 0) {
    return "🔍 No se encontró el producto o no tiene proveedor asignado en el catálogo.";
  }

  const lines: string[] = ["🏢 *Información de Proveedor*\n"];
  for (const r of rows) {
    const prov = r.supplier_name ? `${r.supplier_name} (${r.supplier_code})` : r.supplier_code ?? "Sin asignar";
    lines.push(
      `*${r.description}* (Art. \`${r.article_id}\`)\n` +
      `• *Proveedor:* ${prov}\n` +
      `• *Rubro:* ${r.rubro ?? "-"}\n` +
      `• *Marca:* ${r.brand ?? "-"}\n`
    );
  }

  return lines.join("\n").trim();
}

/**
 * Formats products of a supplier.
 */
export function formatSupplierProductsResponse(
  rows: Array<{
    article_id: number;
    description: string;
    supplier_code: string | null;
    supplier_name: string | null;
    brand: string | null;
  }>,
  supplierSearch: string
): string {
  if (rows.length === 0) {
    return `🔍 No se encontraron productos asociados al proveedor *"${supplierSearch}"*.`;
  }

  const prov = rows[0]?.supplier_name || rows[0]?.supplier_code || supplierSearch;
  const lines: string[] = [`🏢 *Productos del Proveedor ${prov}*\n`];

  for (const r of rows) {
    lines.push(`• *${r.description}* (Art. \`${r.article_id}\`)${r.brand ? ` — _${r.brand}_` : ""}`);
  }

  lines.push(`\n_Mostrando ${rows.length} productos registrados._`);
  return lines.join("\n").trim();
}

/**
 * Formats period overview (units, movements, variation).
 */
export function formatOverviewResponse(overview: {
  branchName: string;
  periodLabel: string;
  net_units: number;
  movements: number;
  variation_vs_previous_percent: number | null;
  previous_net_units: number;
  stock_total: number;
  products_without_stock: number;
  active_products: number;
  last_updated_at: string | null;
}): string {
  const variationStr =
    overview.variation_vs_previous_percent !== null
      ? `${overview.variation_vs_previous_percent >= 0 ? "+" : ""}${overview.variation_vs_previous_percent.toFixed(1)}%`
      : "Sin datos previos";

  const lines: string[] = [
    `📊 *Resumen Operativo — Sucursal ${overview.branchName}*`,
    `_Período:_ ${overview.periodLabel}\n`,
    `• *Unidades netas vendidas:* ${overview.net_units.toLocaleString("es-AR")} u.`,
    `• *Movimientos de stock:* ${overview.movements.toLocaleString("es-AR")}`,
    `• *Variación vs. período anterior:* ${variationStr} (${overview.previous_net_units.toLocaleString("es-AR")} u.)`,
    `• *Stock total actual:* ${overview.stock_total.toLocaleString("es-AR")} u.`,
    `• *Productos en catálogo activo:* ${overview.active_products}`,
    `• *Productos sin stock:* ${overview.products_without_stock}`,
  ];

  if (overview.last_updated_at) {
    lines.push(`\n_Última sincronización:_ ${formatDate(overview.last_updated_at)}`);
  }

  lines.push("\n_Nota: Las métricas corresponden a unidades físicas registradas (VT - IN)._");
  return lines.join("\n").trim();
}

/**
 * Formats top selling products.
 */
export function formatTopProductsResponse(data: {
  branchName: string;
  products: Array<{
    article_id: number;
    description: string | null;
    brand: string | null;
    net_units: number;
    movements: number;
  }>;
}): string {
  if (data.products.length === 0) {
    return `📊 *Más Vendidos — Sucursal ${data.branchName}*\n\nNo se registraron ventas en el período consultado.`;
  }

  const lines: string[] = [
    `🏆 *Top Artículos Más Vendidos — Sucursal ${data.branchName}*\n`,
  ];

  data.products.forEach((p, idx) => {
    const desc = p.description ?? `Artículo ${p.article_id}`;
    lines.push(
      `${idx + 1}. *${desc}* (Art. \`${p.article_id}\`)\n` +
      `   • *${p.net_units} unidades netas* (${p.movements} operaciones)`
    );
  });

  return lines.join("\n").trim();
}

/**
 * Formats system health / data sync status.
 */
export function formatSystemHealthResponse(health: {
  first_movement: string | null;
  last_movement: string | null;
  total_movements: number;
  freshness: { status: string; age_minutes: number | null };
}): string {
  const statusEmoji =
    health.freshness.status === "OK" ? "🟢 Normal" :
    health.freshness.status === "WARNING" ? "🟡 Advertencia" :
    health.freshness.status === "ERROR" ? "🔴 Retrasado" : "⚪ Sin configurar";

  const lines: string[] = [
    "📡 *Estado y Salud de Sincronización*\n",
    `• *Estado del pipeline:* ${statusEmoji}`,
    `• *Demora estimada:* ${health.freshness.age_minutes !== null ? `${health.freshness.age_minutes} min` : "Desconocida"}`,
    `• *Último movimiento registrado:* ${health.last_movement ?? "Sin registros"}`,
    `• *Total histórico de movimientos:* ${health.total_movements.toLocaleString("es-AR")}`,
  ];

  return lines.join("\n").trim();
}

/**
 * Formats help menu.
 */
/**
 * Formats low stock query response.
 */
export function formatLowStockResponse(data: {
  branchName: string;
  branchId: number;
  total: number;
  items: Array<{
    articleId: number;
    description: string;
    saldo: number;
    stockStatus: "OUT_OF_STOCK" | "AVAILABLE";
  }>;
}): string {
  if (data.items.length === 0) {
    return (
      `📉 *Productos con menor stock — ${data.branchName}*\n\n` +
      `No se registraron productos con stock bajo o sin existencias para esta sucursal.`
    );
  }

  const lines: string[] = [
    `📉 *Productos con menor stock — ${data.branchName}*\n`,
  ];

  for (const item of data.items) {
    let saldoText = `${item.saldo} u.`;
    if (item.saldo < 0) {
      saldoText = `${item.saldo} u. ⚠️ (Saldo negativo, revisar)`;
    } else if (item.saldo === 0) {
      saldoText = `0 u. ⚠️ (Sin stock)`;
    }
    lines.push(`• *${item.description}* (Art. \`${item.articleId}\`): *${saldoText}*`);
  }

  if (data.total > data.items.length) {
    lines.push(`\n_Mostrando los primeros ${data.items.length} de ${data.total} productos registrados con menor stock._`);
  }

  return lines.join("\n").trim();
}

/**
 * Formats next delivery query response.
 */
export function formatNextDeliveryMessage(): string {
  return (
    "🚚 *Próximos Pedidos*\n\n" +
    "Todavía no tengo una fecha de llegada confirmada disponible en el sistema. Podés consultar los pedidos registrados o la reposición semanal."
  );
}

/**
 * Formats ambiguous pending query response.
 */
export function formatAmbiguousPendingMessage(): string {
  return (
    "❓ *Consulta de Pendientes*\n\n" +
    "¿Querés consultar pedidos pendientes o productos que necesitan reposición?"
  );
}

/**
 * Formats purchase query response.
 */
export function formatPurchaseQueryMessage(): string {
  return (
    "🛒 *Sugerencia de Compras*\n\n" +
    "El sistema no genera órdenes de compra automáticas arbitrarias. Las necesidades de compra se determinan en base al cálculo de reposición semanal.\n\n" +
    "Podés consultar: _«Reposición Centro»_ o _«Reposición Jardín»_ para ver las cantidades sugeridas a reponer."
  );
}

/**
 * Formats greeting message matching Section 4 specification.
 */
export function formatGreetingMessage(name?: string): string {
  const greeted = name ? name : "Mónica";
  return (
    `👋 ¡Hola, ${greeted}! Soy el asistente de La Casa del Kioskero.\n\n` +
    "Puedo ayudarte a consultar la información del negocio:\n\n" +
    "📦 *1. Stock de productos*\n" +
    "Buscá un artículo por nombre o código y consultá las cantidades disponibles en Centro, Jardín y Depósito Central.\n\n" +
    "🧾 *2. Pedidos registrados*\n" +
    "Consultá los últimos pedidos, sus fechas, estados y cantidades.\n\n" +
    "🚚 *3. Reposición semanal*\n" +
    "Consultá qué productos se recomienda reponer en cada sucursal, según la información disponible.\n\n" +
    "📊 *4. Resúmenes del negocio*\n" +
    "Consultá indicadores y movimientos disponibles en el sistema.\n\n" +
    "📑 *5. Excel de reposición por rubro y sucursal*\n" +
    "Generá la planilla lista para armar el pedido indicando el rubro y la sucursal (por ejemplo: _«Excel de cigarrillos para Centro»_ o _«Quiero la planilla de bebidas para Jardín»_).\n\n" +
    "Podés escribirme una pregunta directamente o pedirme `ayuda` para ver estas opciones.\n\n" +
    "_Si una función todavía no está disponible, te lo voy a indicar._"
  );
}

/**
 * Formats help menu.
 */
export function formatHelpMessage(name?: string): string {
  return formatGreetingMessage(name);
}

/**
 * Formats unauthorized refusal message.
 */
export function formatUnauthorizedMessage(): string {
  return (
    "🔒 *Acceso Restringido*\n\n" +
    "Este canal de WhatsApp es de uso exclusivo y privado para la administración de *La Casa del Kioskero*.\n\n" +
    "Tu número de teléfono no se encuentra en la lista de accesos autorizados."
  );
}

/**
 * Formats clarification message.
 */
export function formatClarificationMessage(msg: string): string {
  return `ℹ️ *Aclaración requerida*\n\n${msg}`;
}

/**
 * Formats fallback message for unknown or unsupported intents.
 */
export function formatUnknownMessage(): string {
  return (
    "🤔 No pude reconocer tu consulta.\n\n" +
    "Puedo ayudarte con:\n" +
    "• *1. Stock:* _«Stock alfajor»_, _«Art 1052»_, _«Stock bajo en Depósito Central»_\n" +
    "• *2. Pedidos:* _«¿Qué pedidos hay?»_, _«Pedidos pendientes»_, _«Detalle del pedido 2»_\n" +
    "• *3. Reposición:* _«Reposición semanal»_, _«Reposición Centro»_, _«Reposición Jardín»_\n" +
    "• *4. Resumen:* _«Resumen del negocio»_, _«¿Cómo estamos de stock?»_\n" +
    "• *5. Excel de reposición:* _«Excel de cigarrillos para Centro»_, _«Planilla de bebidas para Jardín»_\n\n" +
    "_Escribí `ayuda` para ver las opciones completas o haceme una pregunta directa._"
  );
}

/**
 * Formats caption for replenishment Excel document sent via WhatsApp.
 */
export function formatReplenishmentExcelCaption(params: {
  rubro: string;
  branchName: string;
  totalEligible: number;
  planningDate: string;
  negativeStockCount: number;
  negativeStockProducts?: Array<{
    articleId: number;
    description: string | null;
    currentStock: number;
  }>;
}): string {
  const { rubro, branchName, totalEligible, planningDate, negativeStockCount, negativeStockProducts } = params;
  const rubroLabel = formatRubroLabel(rubro);
  const lines: string[] = [
    `📊 *Planilla de Reposición — ${rubroLabel}*`,
    `📍 *Sucursal:* ${branchName}`,
    `📅 *Planificación:* ${planningDate}`,
    `📦 *Productos a pedir:* ${totalEligible}`,
  ];

  if (negativeStockCount > 0) {
    lines.push(
      `\n⚠️ *Atención:* Se detectaron *${negativeStockCount} producto${negativeStockCount === 1 ? "" : "s"} con stock negativo* en el local. No fueron incluidos con cantidad automática y requieren revisión manual.`
    );
    if (negativeStockProducts && negativeStockProducts.length > 0) {
      const preview = negativeStockProducts.slice(0, 3);
      for (const p of preview) {
        lines.push(`• Art. \`${p.articleId}\` — ${p.description ?? "Sin descripción"} (Stock: *${p.currentStock}*)`);
      }
      if (negativeStockProducts.length > 3) {
        lines.push(`_... y ${negativeStockProducts.length - 3} producto(s) más con saldo negativo._`);
      }
    }
  }

  return lines.join("\n").trim();
}

/**
 * Formats message when a replenishment Excel query returns 0 eligible products.
 */
export function formatReplenishmentExcelEmptyMessage(params: {
  rubro: string;
  branchName: string;
  negativeStockCount: number;
  negativeStockProducts?: Array<{
    articleId: number;
    description: string | null;
    currentStock: number;
  }>;
}): string {
  const { rubro, branchName, negativeStockCount, negativeStockProducts } = params;
  const rubroLabel = formatRubroLabel(rubro);
  let text = `ℹ️ *Reposición — ${rubroLabel} (${branchName})*\n\nNo hay productos con necesidad de reposición en este rubro (todos los artículos cuentan con stock suficiente para cubrir la demanda proyectada).`;

  if (negativeStockCount > 0) {
    text += `\n\n⚠️ *Atención:* Hay *${negativeStockCount} producto${negativeStockCount === 1 ? "" : "s"} con stock negativo* que requieren revisión manual en la sucursal:`;
    if (negativeStockProducts && negativeStockProducts.length > 0) {
      const preview = negativeStockProducts.slice(0, 3);
      for (const p of preview) {
        text += `\n• Art. \`${p.articleId}\` — ${p.description ?? "Sin descripción"} (Stock: *${p.currentStock}*)`;
      }
      if (negativeStockProducts.length > 3) {
        text += `\n_... y ${negativeStockProducts.length - 3} producto(s) más con saldo negativo._`;
      }
    }
  }

  return text;
}
