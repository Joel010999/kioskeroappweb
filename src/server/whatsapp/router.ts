import type { Period } from "@/server/analytics/types";
import type { BranchTarget, ParsedIntent, ParsedSlots } from "./types";

/**
 * Normalizes text for matching: converts to lower case, normalizes accents (keeps ñ),
 * trims multiple whitespaces.
 */
export function cleanText(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // removes accents (a, e, i, o, u)
    .replace(/[¿?¡!,;:."']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Formats a Date object to YYYY-MM-DD.
 */
function toDateString(d: Date): string {
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Builds the canonical Period object matching the project's Period type.
 */
export function buildPeriod(fromStr: string, toStr: string): Period {
  const fromDate = new Date(`${fromStr}T00:00:00.000Z`);
  const toDate = new Date(`${toStr}T00:00:00.000Z`);

  const durationMs = toDate.getTime() - fromDate.getTime() + 86_400_000;
  const days = Math.round(durationMs / 86_400_000);

  const toExclusive = new Date(toDate.getTime() + 86_400_000);
  const previousFrom = new Date(fromDate.getTime() - days * 86_400_000);
  const previousToExclusive = fromDate;

  return {
    from: fromStr,
    to: toStr,
    toExclusive: toDateString(toExclusive),
    previousFrom: toDateString(previousFrom),
    previousToExclusive: toDateString(previousToExclusive),
  };
}

/**
 * Resolves date periods based on natural language expressions.
 * Defaults reference date to current system date (2026-10-18).
 */
export function resolvePeriodFromText(
  text: string,
  referenceDate: Date = new Date("2026-10-18T12:00:00.000Z")
): { period?: Period; periodType?: ParsedSlots["periodType"]; label?: string } {
  const clean = cleanText(text);

  const monthsMap: Record<string, { month: number; days: number }> = {
    enero: { month: 1, days: 31 },
    febrero: { month: 2, days: 28 }, // 2026 is not leap
    marzo: { month: 3, days: 31 },
    abril: { month: 4, days: 30 },
    mayo: { month: 5, days: 31 },
    junio: { month: 6, days: 30 },
    julio: { month: 7, days: 31 },
    agosto: { month: 8, days: 31 },
    septiembre: { month: 9, days: 30 },
    setiembre: { month: 9, days: 30 },
    octubre: { month: 10, days: 31 },
    noviembre: { month: 11, days: 30 },
    diciembre: { month: 12, days: 31 },
  };

  // Specific named month: "septiembre", "octubre 2026", etc.
  for (const [name, info] of Object.entries(monthsMap)) {
    if (new RegExp(`\\b${name}\\b`).test(clean)) {
      // Check for explicit year (e.g. 2025, 2026)
      const yearMatch = clean.match(/\b(202\d)\b/);
      const year = yearMatch ? Number(yearMatch[1]) : referenceDate.getUTCFullYear();
      const monthStr = String(info.month).padStart(2, "0");
      const from = `${year}-${monthStr}-01`;
      const to = `${year}-${monthStr}-${String(info.days).padStart(2, "0")}`;
      const capitalized = name.charAt(0).toUpperCase() + name.slice(1);
      return {
        period: buildPeriod(from, to),
        periodType: "named_month",
        label: `${capitalized} ${year}`,
      };
    }
  }

  // "hoy"
  if (/\bhoy\b/.test(clean)) {
    const todayStr = toDateString(referenceDate);
    return {
      period: buildPeriod(todayStr, todayStr),
      periodType: "today",
      label: "Hoy",
    };
  }

  // "ayer"
  if (/\bayer\b/.test(clean)) {
    const yesterday = new Date(referenceDate.getTime() - 86_400_000);
    const yesterdayStr = toDateString(yesterday);
    return {
      period: buildPeriod(yesterdayStr, yesterdayStr),
      periodType: "yesterday",
      label: "Ayer",
    };
  }

  // "mes pasado" / "mes anterior"
  if (/\b(mes pasado|el mes anterior)\b/.test(clean)) {
    const currentMonth = referenceDate.getUTCMonth(); // 0-indexed (9 for Oct)
    const currentYear = referenceDate.getUTCFullYear();
    const prevMonthDate = new Date(Date.UTC(currentYear, currentMonth - 1, 1));
    const prevYear = prevMonthDate.getUTCFullYear();
    const prevMonth = prevMonthDate.getUTCMonth() + 1;
    const lastDay = new Date(Date.UTC(prevYear, prevMonth, 0)).getUTCDate();

    const from = `${prevYear}-${String(prevMonth).padStart(2, "0")}-01`;
    const to = `${prevYear}-${String(prevMonth).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
    return {
      period: buildPeriod(from, to),
      periodType: "last_month",
      label: "Mes pasado",
    };
  }

  // "esta semana" / "ultima semana"
  if (/\b(esta semana|ultima semana|semana actual)\b/.test(clean)) {
    // Start of week (Monday)
    const dayOfWeek = referenceDate.getUTCDay() || 7; // 1: Mon, 7: Sun
    const monday = new Date(referenceDate.getTime() - (dayOfWeek - 1) * 86_400_000);
    const from = toDateString(monday);
    const to = toDateString(referenceDate);
    return {
      period: buildPeriod(from, to),
      periodType: "this_week",
      label: "Esta semana",
    };
  }

  // "este mes" (por defecto si se menciona mes)
  if (/\b(este mes|mes actual|en el mes)\b/.test(clean)) {
    const year = referenceDate.getUTCFullYear();
    const month = String(referenceDate.getUTCMonth() + 1).padStart(2, "0");
    const from = `${year}-${month}-01`;
    const to = toDateString(referenceDate);
    return {
      period: buildPeriod(from, to),
      periodType: "this_month",
      label: "Este mes",
    };
  }

  // Default period when summarizing: current month up to today
  const year = referenceDate.getUTCFullYear();
  const month = String(referenceDate.getUTCMonth() + 1).padStart(2, "0");
  return {
    period: buildPeriod(`${year}-${month}-01`, toDateString(referenceDate)),
    periodType: "this_month",
    label: "Este mes",
  };
}

/**
 * Extracts branch target from text.
 */
export function extractBranch(text: string): { target: BranchTarget; branchId?: number } {
  const clean = cleanText(text);

  if (/\b(deposito|depo|almacen|central)\b/.test(clean)) {
    return { target: "DEPOSITO", branchId: 1 };
  }
  if (/\b(centro|sucursal centro|local centro|pv1)\b/.test(clean)) {
    return { target: "CENTRO", branchId: 2 };
  }
  if (/\b(jardin|sucursal jardin|local jardin|pv2)\b/.test(clean)) {
    return { target: "JARDIN", branchId: 3 };
  }

  return { target: "ALL" };
}

/**
 * Extracts order number (e.g. #3, pedido 3, orden 3).
 */
export function extractOrderNumber(text: string): number | undefined {
  const match = text.match(/(?:#|pedido\s*(?:n[°ºo]\s*|numero\s*|número\s*)?|orden\s*(?:n[°ºo]\s*|numero\s*|número\s*)?)\s*(\d+)/i);
  if (match && match[1]) {
    return Number(match[1]);
  }
  return undefined;
}

/**
 * Extracts article ID or product search term.
 */
export function extractProductSearch(
  text: string,
  stopWords: string[] = []
): { articleId?: number; productSearch?: string } {
  // Clean text and remove accents for reliable matching
  let cleaned = cleanText(text);

  // Check for explicit article ID: "articulo 1052", "art 1052", "codigo 1052", "id 1052"
  const idMatch = cleaned.match(/\b(?:articulo|art|codigo|id)\s*[:#]?\s*(\d+)\b/);
  if (idMatch && idMatch[1]) {
    return { articleId: Number(idMatch[1]) };
  }

  // If text has "stock 1052"
  const stockNumberMatch = cleaned.match(/\bstock\s+(?:del\s+|de\s+)?(\d+)\b/);
  if (stockNumberMatch && stockNumberMatch[1]) {
    return { articleId: Number(stockNumberMatch[1]) };
  }

  // Remove common question prefixes
  const prefixes = [
    /^cuanto stock (?:hay|tenemos|queda|de|del)?\s*/,
    /^stock (?:de|del|hay|en)?\s*/,
    /^tenes (?:stock de|stock del|stock)?\s*/,
    /^queda (?:stock de|stock del|stock)?\s*/,
    /^hay (?:stock de|stock del|stock)?\s*/,
    /^buscar producto\s*/,
    /^buscar\s*/,
    /^precio de\s*/,
    /^proveedor de\s*/,
    /^de que proveedor es\s*/,
    /^que proveedor tiene\s*/,
    /^este producto\s*/,
    /^este articulo\s*/,
  ];

  for (const prefix of prefixes) {
    cleaned = cleaned.replace(prefix, "");
  }

  // Remove branch mentions: "en centro", "en jardin", "en deposito"
  cleaned = cleaned.replace(/\b(?:en|para|del?)\s+(?:centro|jardin|deposito|el deposito)\b/g, " ");

  // Remove common filler verbs
  cleaned = cleaned.replace(/\b(?:hay|queda|quedan|tenemos|este|articulo|producto)\b/g, " ");

  // Remove user-specified stopwords
  for (const stop of stopWords) {
    cleaned = cleaned.replace(new RegExp(`\\b${cleanText(stop)}\\b`, "g"), " ");
  }

  cleaned = cleaned.replace(/\s+/g, " ").trim();

  // Guard against non-product system/command keywords being treated as product searches
  const blacklistedKeywords = new Set([
    "pedido",
    "pedidos",
    "orden",
    "ordenes",
    "reposicion",
    "reponer",
    "stock",
    "stock bajo",
    "bajo",
    "centro",
    "jardin",
    "deposito",
    "deposito central",
    "central",
    "resumen",
    "movimientos",
    "ventas",
    "ayuda",
    "menu",
    "hola",
    "buenas",
    "cuando llega",
    "proximo pedido",
  ]);

  if (blacklistedKeywords.has(cleaned)) {
    return {};
  }

  // Return non-empty cleaned query
  if (cleaned.length >= 2) {
    return { productSearch: cleaned };
  }

  return {};
}

/**
 * Main intent router. Classifies user text into an intent with extracted slots.
 * Strict priority order:
 * 1. Numeric shortcuts (1, 2, 3, 4)
 * 2. Greetings and Help
 * 3. Specific arrival / future delivery questions
 * 4. Purchase queries
 * 5. Ambiguous pending queries ("¿Qué tengo pendiente?")
 * 6. Specific order detail (#3)
 * 7. Orders pending / by status
 * 8. Orders list / recent ("¿Qué pedidos hay?", "Pedidos registrados")
 * 9. Reposición semanal ("¿Qué productos hay que reponer?")
 * 10. Stock bajo ("¿Qué productos tienen stock bajo en el Depósito Central?")
 * 11. Stock alerts (sin stock, quiebres, negativo)
 * 12. General branch stock overview
 * 13. Metrics / comparison / summary
 * 14. System health
 * 15. Suppliers
 * 16. Specific product stock search ("Stock alfajor")
 * 17. Implicit product name search
 * 18. Unknown fallback
 */
export function parseUserMessage(text: string, referenceDate?: Date): ParsedIntent {
  const clean = cleanText(text);
  const branchInfo = extractBranch(text);
  const orderNumber = extractOrderNumber(text);
  const periodInfo = resolvePeriodFromText(text, referenceDate);

  const slots: ParsedSlots = {
    branchTarget: branchInfo.target,
    branchId: branchInfo.branchId,
    orderNumber,
    period: periodInfo.period,
    periodType: periodInfo.periodType,
    periodLabel: periodInfo.label,
  };

  // 1. MENU NUMERIC SHORTCUTS (1, 2, 3, 4)
  if (/^1$/.test(clean)) {
    return {
      type: "STOCK_PRODUCT",
      rawText: text,
      slots: {
        ...slots,
        needsClarification: true,
        clarificationType: "PRODUCT",
        clarificationMessage:
          "¿De qué producto querés consultar el stock? Podés escribir el nombre (ej. *Stock alfajor marplatense*) o el código (ej. *Stock artículo 1052*).",
      },
      confidence: 1.0,
    };
  }
  if (/^2$/.test(clean)) {
    return { type: "ORDERS_RECENT", rawText: text, slots, confidence: 1.0 };
  }
  if (/^3$/.test(clean)) {
    return {
      type: "REPLENISHMENT",
      rawText: text,
      slots: {
        ...slots,
        needsClarification: true,
        clarificationType: "BRANCH",
        clarificationMessage:
          "Para consultar la reposición semanal sugerida, por favor indicame para qué sucursal querés verla: *Centro* o *Jardín*.",
      },
      confidence: 1.0,
    };
  }
  if (/^4$/.test(clean)) {
    return { type: "METRICS_SUMMARY", rawText: text, slots, confidence: 1.0 };
  }

  // 2. GREETINGS & HELP
  if (/^(hola|buenas|buen dia|buenas tardes|buenas noches|che|que tal|hola monica)\b/.test(clean) && clean.split(" ").length <= 4) {
    return { type: "GREETING", rawText: text, slots, confidence: 1.0 };
  }
  if (/\b(ayuda|comandos|que podes hacer|opciones|menu|ejemplos|como funciona|que consultas)\b/.test(clean)) {
    return { type: "HELP", rawText: text, slots, confidence: 1.0 };
  }

  // 3. PRÓXIMOS PEDIDOS / FECHAS DE ENTREGA (Honest response)
  if (/\b(cuando llega el proximo pedido|cuando llega el pedido|proximo pedido|cuando llega|fecha de llegada|proxima entrega|cuando entran|cuando llega la mercaderia)\b/.test(clean)) {
    return { type: "NEXT_DELIVERY", rawText: text, slots, confidence: 0.95 };
  }

  // 4. CONSULTAS DE COMPRA (Explicar alcance)
  if (/\b(cuanto tengo que comprar|que tengo que comprar|cuanto compro)\b/.test(clean)) {
    return { type: "PURCHASE_QUERY", rawText: text, slots, confidence: 0.95 };
  }

  // 5. CONSULTAS AMBIGUAS ("¿Qué tengo pendiente?")
  if (
    /^(que tengo pendiente|que hay pendiente|cosas pendientes|pendientes)$/.test(clean) ||
    /^(que esta pendiente|que tenemos pendiente)$/.test(clean)
  ) {
    return {
      type: "AMBIGUOUS_PENDING",
      rawText: text,
      slots: {
        ...slots,
        needsClarification: true,
        clarificationType: "AMBIGUOUS_PENDING",
        clarificationMessage: "¿Querés consultar *pedidos pendientes* o productos que necesitan *reposición semanal*?",
      },
      confidence: 0.95,
    };
  }

  // 6. PEDIDO ESPECÍFICO (por número visible #3, etc.)
  if (orderNumber !== undefined) {
    return { type: "ORDER_DETAIL", rawText: text, slots, confidence: 0.95 };
  }

  // 7. PEDIDOS PENDIENTES / POR ESTADO
  if (
    /\b(pedidos pendientes|siguen pendientes|que pedidos faltan|pendientes de preparacion|por preparar|por despachar|por recibir|pedidos despachados|se despacharon|despachados|unidades se despacharon)\b/.test(clean)
  ) {
    return { type: "ORDERS_PENDING", rawText: text, slots, confidence: 0.95 };
  }

  // 8. LISTA DE PEDIDOS / ÚLTIMOS PEDIDOS (Resolves problem with "¿Qué pedidos hay?" / "Pedidos registrados")
  if (
    /\b(que pedidos hay|pedidos registrados|pedidos hay|cuales son los ultimos pedidos|ultimos pedidos|ultimo pedido|pedidos de|ver pedidos|estado de pedidos|ordenes|lista de pedidos|mostrame los pedidos|que pedidos)\b/.test(clean) ||
    clean === "pedidos"
  ) {
    return { type: "ORDERS_RECENT", rawText: text, slots, confidence: 0.95 };
  }

  // 9. REPOSICIÓN SEMANAL
  if (
    /\b(reposicion semanal|que productos hay que reponer|que hay que reponer|que tengo que reponer|necesitan reposicion|sugerencias de reposicion|sugerencia|a reponer|reponer|reposicion)\b/.test(clean)
  ) {
    // If no branch was specified or user asked for Depósito, request clarification for Centro or Jardín
    if (branchInfo.target === "ALL" || branchInfo.target === "DEPOSITO") {
      const msg =
        branchInfo.target === "DEPOSITO"
          ? "La reposición semanal se calcula para abastecer a las sucursales *Centro* o *Jardín* desde el Depósito Central. ¿Cuál querés consultar?"
          : "Para consultar la reposición semanal sugerida, por favor indicame para qué sucursal querés verla: *Centro* o *Jardín*.";
      return {
        type: "REPLENISHMENT",
        rawText: text,
        slots: {
          ...slots,
          needsClarification: true,
          clarificationType: "BRANCH",
          clarificationMessage: msg,
        },
        confidence: 0.95,
      };
    }
    return { type: "REPLENISHMENT", rawText: text, slots, confidence: 0.95 };
  }

  // 10. STOCK BAJO / MENOR STOCK (Problem 1)
  if (
    /\b(stock bajo|bajo stock|poco stock|stock critico|critico de stock|menor stock|productos con bajo stock|productos tienen stock bajo|tienen stock bajo|escaso stock|stock escaso|productos con menor stock|articulos con stock bajo)\b/.test(clean)
  ) {
    if (branchInfo.target === "ALL") {
      return {
        type: "STOCK_LOW",
        rawText: text,
        slots: {
          ...slots,
          needsClarification: true,
          clarificationType: "BRANCH",
          clarificationMessage:
            "¿Para qué sucursal querés consultar los productos con stock bajo? Podés indicar *Depósito Central*, *Centro* o *Jardín*.",
        },
        confidence: 0.95,
      };
    }
    return { type: "STOCK_LOW", rawText: text, slots, confidence: 0.95 };
  }

  // 11. ALERTAS DE STOCK (Sin stock / Quiebres / Negativo)
  if (
    /\b(sin stock|faltantes|quiebre|quiebres|stock negativo|negativo|articulos en cero|productos sin stock)\b/.test(clean)
  ) {
    return { type: "STOCK_OUT_ALERT", rawText: text, slots, confidence: 0.95 };
  }

  // 12. STOCK GENERAL POR SUCURSAL (sin producto específico)
  if (
    /\b(que stock hay en|como estamos de stock en|como estamos de stock)\b/.test(clean)
  ) {
    return { type: "STOCK_LOW", rawText: text, slots, confidence: 0.9 };
  }

  // 13. COMPARACIÓN DE PERÍODOS
  if (
    /\b(compara|comparame|comparacion|comparar|versus|vs|respecto al mes anterior)\b/.test(clean)
  ) {
    return { type: "METRICS_COMPARISON", rawText: text, slots, confidence: 0.95 };
  }

  // 14. MÁS VENDIDOS / TOP PRODUCTOS
  if (
    /\b(mas vendidos|top productos|top ventas|mas vendido|lo que mas sale|lo que mas se vende|ranking)\b/.test(clean)
  ) {
    return { type: "METRICS_TOP_PRODUCTS", rawText: text, slots, confidence: 0.95 };
  }

  // 15. RESUMEN / MÉTRICAS GENERALES
  if (
    /\b(resumen|balance|metricas|movimientos del mes|como venimos|que paso durante|ventas de|evolucion)\b/.test(clean)
  ) {
    return { type: "METRICS_SUMMARY", rawText: text, slots, confidence: 0.9 };
  }

  // 16. ESTADO DEL SISTEMA / SALUD DE DATOS
  if (
    /\b(sincronizacion|estado del sistema|salud de datos|actualizacion|freshness|cuando se actualizo)\b/.test(clean)
  ) {
    return { type: "SYSTEM_HEALTH", rawText: text, slots, confidence: 0.95 };
  }

  // 17. PROVEEDORES
  if (
    /\b(de que proveedor es|proveedor de|que proveedor tiene|quien nos vende)\b/.test(clean)
  ) {
    const productExtraction = extractProductSearch(text, ["proveedor", "de", "es", "que"]);
    return {
      type: "PRODUCT_SUPPLIER",
      rawText: text,
      slots: { ...slots, ...productExtraction },
      confidence: 0.9,
    };
  }
  if (
    /\b(productos del proveedor|articulos del proveedor|proveedor|que le compramos a)\b/.test(clean)
  ) {
    let supplierName = clean
      .replace(/.*?(?:productos del proveedor|articulos del proveedor|proveedor|que le compramos a)\s*/, "")
      .trim();
    return {
      type: "SUPPLIER_PRODUCTS",
      rawText: text,
      slots: { ...slots, supplierSearch: supplierName || undefined },
      confidence: 0.85,
    };
  }

  // 18. CONSULTA DIRECTA DE STOCK POR PRODUCTO O CÓDIGO
  if (
    /\b(stock|cuanto hay|cuanto stock|tenes|queda|quedan|hay stock|busca|buscar)\b/.test(clean) ||
    /\b(articulo|art|codigo)\s*\d+/.test(clean)
  ) {
    const productExtraction = extractProductSearch(text);
    if (!productExtraction.articleId && !productExtraction.productSearch) {
      return {
        type: "STOCK_PRODUCT",
        rawText: text,
        slots: {
          ...slots,
          needsClarification: true,
          clarificationType: "PRODUCT",
          clarificationMessage:
            "¿De qué producto querés consultar el stock? Podés escribir el nombre (ej. *Stock alfajor marplatense*) o el código (ej. *Stock artículo 1052*).",
        },
        confidence: 0.8,
      };
    }
    return {
      type: "STOCK_PRODUCT",
      rawText: text,
      slots: { ...slots, ...productExtraction },
      confidence: 0.9,
    };
  }

  // 19. SI EL USUARIO ESCRIBIÓ SOLO UN NOMBRE O CÓDIGO (Búsqueda implícita de stock)
  const implicitExtraction = extractProductSearch(text);
  if (implicitExtraction.articleId || (implicitExtraction.productSearch && implicitExtraction.productSearch.length >= 3)) {
    return {
      type: "STOCK_PRODUCT",
      rawText: text,
      slots: { ...slots, ...implicitExtraction },
      confidence: 0.7,
    };
  }

  // 20. DESCONOCIDO
  return {
    type: "UNKNOWN",
    rawText: text,
    slots,
    confidence: 0.0,
  };
}
