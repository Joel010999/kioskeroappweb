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

  // Return non-empty cleaned query
  if (cleaned.length >= 2) {
    return { productSearch: cleaned };
  }

  return {};
}

/**
 * Main intent router. Classifies user text into an intent with extracted slots.
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

  // 1. GREETINGS & HELP
  if (/^(hola|buenas|buen dia|buenas tardes|buenas noches|che|que tal|hola monica)\b/.test(clean) && clean.split(" ").length <= 4) {
    return { type: "GREETING", rawText: text, slots, confidence: 1.0 };
  }
  if (/\b(ayuda|comandos|que podes hacer|opciones|menu|ejemplos|como funciona|que consultas)\b/.test(clean)) {
    return { type: "HELP", rawText: text, slots, confidence: 1.0 };
  }

  // 2. PEDIDO ESPECÍFICO (por número visible #3, etc.)
  if (orderNumber !== undefined) {
    return { type: "ORDER_DETAIL", rawText: text, slots, confidence: 0.95 };
  }

  // 3. PEDIDOS PENDIENTES
  if (
    /\b(pedidos pendientes|siguen pendientes|que pedidos faltan|pendientes de preparacion|por preparar|por despachar|por recibir)\b/.test(clean)
  ) {
    return { type: "ORDERS_PENDING", rawText: text, slots, confidence: 0.95 };
  }

  // 4. ÚLTIMOS PEDIDOS / LISTA DE PEDIDOS
  if (/\b(ultimos pedidos|ultimo pedido|pedidos de|ver pedidos|estado de pedidos|ordenes)\b/.test(clean)) {
    return { type: "ORDERS_RECENT", rawText: text, slots, confidence: 0.9 };
  }

  // 5. REPOSICIÓN
  if (/\b(reposicion|reponer|necesitan reposicion|sugerencias de reposicion|sugerencia|a reponer)\b/.test(clean)) {
    // If no branch was specified, prompt for Centro or Jardín
    if (branchInfo.target === "ALL" || branchInfo.target === "DEPOSITO") {
      return {
        type: "REPLENISHMENT",
        rawText: text,
        slots: {
          ...slots,
          needsClarification: true,
          clarificationMessage:
            "Para consultar la reposición semanal sugerida, por favor indicame para qué sucursal querés verla: *Centro* o *Jardín*.",
        },
        confidence: 0.9,
      };
    }
    return { type: "REPLENISHMENT", rawText: text, slots, confidence: 0.95 };
  }

  // 6. ALERTAS DE STOCK (Sin stock / Quiebres / Negativo)
  if (
    /\b(sin stock|faltantes|quiebre|quiebres|stock negativo|negativo|articulos en cero|productos sin stock)\b/.test(clean)
  ) {
    return { type: "STOCK_OUT_ALERT", rawText: text, slots, confidence: 0.95 };
  }

  // 7. COMPARACIÓN DE PERÍODOS
  if (
    /\b(compara|comparame|comparacion|comparar|versus|vs|respecto al mes anterior)\b/.test(clean)
  ) {
    return { type: "METRICS_COMPARISON", rawText: text, slots, confidence: 0.95 };
  }

  // 8. MÁS VENDIDOS / TOP PRODUCTOS
  if (
    /\b(mas vendidos|top productos|top ventas|mas vendido|lo que mas sale|lo que mas se vende|ranking)\b/.test(clean)
  ) {
    return { type: "METRICS_TOP_PRODUCTS", rawText: text, slots, confidence: 0.95 };
  }

  // 9. RESUMEN / MÉTRICAS GENERALES
  if (
    /\b(resumen|balance|metricas|movimientos del mes|como venimos|que paso durante|ventas de|evolucion)\b/.test(clean)
  ) {
    return { type: "METRICS_SUMMARY", rawText: text, slots, confidence: 0.9 };
  }

  // 10. ESTADO DEL SISTEMA / SALUD DE DATOS
  if (
    /\b(sincronizacion|estado del sistema|salud de datos|actualizacion|freshness|cuando se actualizo)\b/.test(clean)
  ) {
    return { type: "SYSTEM_HEALTH", rawText: text, slots, confidence: 0.95 };
  }

  // 11. PROVEEDOR DE UN PRODUCTO O PRODUCTOS DE UN PROVEEDOR
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

  // 12. CONSULTA DIRECTA DE STOCK POR PRODUCTO O CÓDIGO
  if (
    /\b(stock|cuanto hay|cuanto stock|tenes|queda|quedan|hay stock)\b/.test(clean) ||
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

  // 13. SI EL USUARIO ESCRIBIÓ SOLO UN NOMBRE O CÓDIGO (Búsqueda implícita de stock)
  const implicitExtraction = extractProductSearch(text);
  if (implicitExtraction.articleId || (implicitExtraction.productSearch && implicitExtraction.productSearch.length >= 3)) {
    return {
      type: "STOCK_PRODUCT",
      rawText: text,
      slots: { ...slots, ...implicitExtraction },
      confidence: 0.7,
    };
  }

  // 14. DESCONOCIDO
  return {
    type: "UNKNOWN",
    rawText: text,
    slots,
    confidence: 0.0,
  };
}
