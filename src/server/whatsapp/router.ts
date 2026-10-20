import type { Period } from "@/server/analytics/types";
import { CANONICAL_SUPPLIERS, resolveSupplier } from "@/server/catalog/suppliers";
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
 * Extracts branch target from text, respecting explicit negations (e.g. "no el de Centro")
 * and tolerant to common typos (e.g. "cetro", "jardi", "depo").
 */
export function extractBranch(text: string): { target: BranchTarget; branchId?: number } {
  const clean = cleanText(text);

  // 1. Check for explicit branch negation: e.g. "no el de centro", "no centro", "en vez de centro", "no el de jardin"
  const negatedBranches = new Set<string>();
  const negationMatches = clean.matchAll(
    /\b(?:no(?:\s+(?:el\s+de|la\s+de|de|en|para))?|en\s+vez\s+de)\s+(centro|cetro|cnetro|jardin|jardi|deposito|depo|central)\b/gi
  );
  for (const m of negationMatches) {
    const rawNeg = m[1].toLowerCase();
    if (/^(centro|cetro|cnetro)$/.test(rawNeg)) negatedBranches.add("CENTRO");
    if (/^(jardin|jardi)$/.test(rawNeg)) negatedBranches.add("JARDIN");
    if (/^(deposito|depo|central)$/.test(rawNeg)) negatedBranches.add("DEPOSITO");
  }

  // Remove negated phrases from consideration for positive target match
  const positiveText = clean.replace(
    /\b(?:no(?:\s+(?:el\s+de|la\s+de|de|en|para))?|en\s+vez\s+de)\s+(centro|cetro|cnetro|jardin|jardi|deposito|depo|central)\b/gi,
    " "
  );

  // 2. Check for positive matches (including common typos)
  const hasCentro =
    !negatedBranches.has("CENTRO") &&
    /\b(centro|sucursal centro|local centro|pv1|cetro|cnetro|centr|centroo|cemtro)\b/.test(positiveText);
  const hasJardin =
    !negatedBranches.has("JARDIN") &&
    /\b(jardin|sucursal jardin|local jardin|pv2|jardi|jardim|jradin|jadring|jardn)\b/.test(positiveText);
  const hasDeposito =
    !negatedBranches.has("DEPOSITO") &&
    /\b(deposito central|almacen central|deposito|depo|desposito|depsito|central)\b/.test(positiveText);

  // If a retail branch (Centro or Jardín) is mentioned, prioritize it over Depósito
  // (e.g. "faltan en Centro pero hay en el depósito" -> Centro is the target branch to replenish)
  if (hasCentro && !hasJardin) {
    return { target: "CENTRO", branchId: 2 };
  }
  if (hasJardin && !hasCentro) {
    return { target: "JARDIN", branchId: 3 };
  }
  if (hasDeposito && !hasCentro && !hasJardin) {
    return { target: "DEPOSITO", branchId: 1 };
  }

  return { target: "ALL" };
}

/**
 * Extracts candidate invalid branch if specified using "para <branch>", "en <branch>", etc.
 */
export function extractInvalidBranch(text: string): string | undefined {
  const match = text.match(/\b(?:para|en|sucursal|local)\s+([A-Za-zÁÉÍÓÚáéíóúÑñ]+)\b/i);
  if (match && match[1]) {
    const rawCandidate = match[1].trim();
    const candidateClean = cleanText(rawCandidate);
    const validTokens = new Set([
      "centro", "cetro", "cnetro", "centr", "centroo", "cemtro",
      "jardin", "jardi", "jardim", "jradin", "jadring", "jardn",
      "deposito", "depo", "desposito", "depsito", "central",
      "el", "la", "los", "las", "un", "una", "mi", "este", "esta",
      "excel", "planilla", "archivo", "reposicion", "reponer", "stock",
      "chocolates", "caramelos", "galletitas", "bebidas", "almacen",
      "cigarrillos", "pilas", "copetin", "descartables", "limpieza",
      "perfumeria", "golosinas", "gaseosas", "snacks", "que", "de",
      "todo", "todos", "todas"
    ]);
    if (!validTokens.has(candidateClean) && candidateClean.length >= 3) {
      return rawCandidate.charAt(0).toUpperCase() + rawCandidate.slice(1);
    }
  }
  return undefined;
}

/**
 * Known commercial rubros and their common synonyms for natural language matching.
 */
const RUBRO_ALIASES: Array<{ canonical: string; patterns: RegExp[] }> = [
  { canonical: "CHOCOLATES", patterns: [/\bchocolates?\b/, /\bchocola\w*/, /\bchocolatines?\b/] },
  { canonical: "CARAMELOS", patterns: [/\bcaramelos?\b/, /\bgolosinas?\b/, /\bgomitas?\b/, /\bconfites?\b/] },
  { canonical: "GALLETITAS", patterns: [/\bgalletitas?\b/, /\bgalletas?\b/, /\bmasitas?\b/] },
  { canonical: "BEBIDAS", patterns: [/\bbebidas?\b/, /\bgaseosas?\b/, /\bjugos?\b/, /\baguas?\b/] },
  { canonical: "ALMACEN", patterns: [/\balmacen\b/, /\balmacenes\b/] },
  { canonical: "CIGARRILLOS", patterns: [/\bcigarrillos?\b/, /\bcigarros?\b/, /\bpuchos?\b/, /\bpucho\b/] },
  { canonical: "PILAS", patterns: [/\bpilas?\b/, /\bbaterias?\b/] },
  { canonical: "COPETIN", patterns: [/\bcopetin\b/, /\bsnacks?\b/, /\bpapas fritas\b/] },
  { canonical: "DESCARTABLES", patterns: [/\bdescartables?\b/] },
  { canonical: "ENCENDIDOS", patterns: [/\bencendidos?\b/, /\bencendedores?\b/, /\bencendedor\b/, /\bfosforos?\b/] },
  { canonical: "INSECTICIDA", patterns: [/\binsecticidas?\b/, /\brepelentes?\b/] },
  { canonical: "LIMPIEZA", patterns: [/\blimpieza\b/] },
  { canonical: "NAIPES", patterns: [/\bnaipes?\b/, /\bcartas?\b/] },
  { canonical: "NAVIDEÑOS", patterns: [/\bnavidenos?\b/, /\bnavidad\b/] },
  { canonical: "PEGAMENTOS", patterns: [/\bpegamentos?\b/, /\bcolas?\b/] },
  { canonical: "PERFUMERIA", patterns: [/\bperfumeria\b/, /\bperfumes?\b/] },
  { canonical: "TABACO Y AFINES", patterns: [/\btabaco y afines\b/, /\btabacos?\b/] },
  { canonical: "VARIOS", patterns: [/\bvarios\b/] },
  { canonical: "__SIN_RUBRO__", patterns: [/\bsin rubro\b/] },
];

/**
 * Extracts candidate supplier mention from text.
 */
export function extractSupplierCandidate(text: string): {
  candidate?: string;
  isExplicitSupplierKeyword?: boolean;
  isGenericSupplierReference?: boolean;
} {
  const clean = cleanText(text);

  // 1. Explicit numeric supplier code: "proveedor 50350", "prov 50350", "proveedor nro 123", "proveedor: 123"
  const explicitNumMatch = clean.match(
    /\b(?:proveedor|prov|proveedores)\s*(?:n[°ºo]\s*|numero\s*|número\s*|id\s*|code\s*|codigo\s*|código\s*)?[:#]?\s*(\d+)\b/i
  );
  if (explicitNumMatch && explicitNumMatch[1]) {
    return { candidate: explicitNumMatch[1], isExplicitSupplierKeyword: true };
  }

  // 2. Generic supplier references without specific identifier: "este proveedor", "al proveedor", "de este proveedor"
  if (/\b(?:este\s+proveedor|del\s+proveedor|al\s+proveedor|a\s+este\s+proveedor)\b/i.test(clean)) {
    // Check if a specific name follows: e.g. "proveedor Arcor"
    const namedAfterMatch = text.match(
      /\b(?:proveedor|prov)\s+([A-Za-zÁÉÍÓÚáéíóúÑñ0-9\s&-]+?)(?:\s+(?:en|para|sucursal|local|rubro|de|del)\b|$)/i
    );
    if (namedAfterMatch && namedAfterMatch[1]) {
      const candidateRaw = namedAfterMatch[1].trim();
      const cleanCand = cleanText(candidateRaw);
      const stopWords = new Set(["este", "esta", "estos", "de", "del", "para", "en", "el", "la", "los", "las", "un", "una"]);
      if (!stopWords.has(cleanCand) && cleanCand.length >= 2) {
        return { candidate: candidateRaw, isExplicitSupplierKeyword: true };
      }
    }
    return { isGenericSupplierReference: true, isExplicitSupplierKeyword: true };
  }

  // 3. Named supplier with preposition: "le compramos a X", "pedirle a X", "reponer lo de X", "lo de X", "faltan pedirle a X"
  const actionMatch = text.match(
    /\b(?:pedirle\s+a|pedir\s+a|reponer\s+lo\s+de|pedir\s+lo\s+de|lo\s+de|le\s+compramos\s+a|comprar\s+a|faltan\s+pedirle\s+a)\s+([A-Za-zÁÉÍÓÚáéíóúÑñ0-9\s&-]+?)(?:\s+(?:en|para|sucursal|local|rubro)\b|$)/i
  );
  if (actionMatch && actionMatch[1]) {
    const candidateRaw = actionMatch[1].trim();
    const cleanCand = cleanText(candidateRaw);
    const stopWords = new Set(["este", "esta", "estos", "el", "la", "los", "las", "un", "una", "centro", "jardin", "deposito"]);
    if (!stopWords.has(cleanCand) && cleanCand.length >= 3) {
      return { candidate: candidateRaw, isExplicitSupplierKeyword: false };
    }
  }

  // 4. Check known canonical suppliers and aliases in text
  for (const supplier of CANONICAL_SUPPLIERS) {
    for (const alias of supplier.aliases) {
      const regex = new RegExp(`\\b${alias.replace(/\s+/g, "\\s+")}\\b`, "i");
      if (regex.test(clean)) {
        return { candidate: alias, isExplicitSupplierKeyword: false };
      }
    }
  }

  return {};
}

/**
 * Resolves canonical rubro from user text, or identifies unrecognized explicit rubro requests.
 */
export function resolveCanonicalRubroFromText(text: string): {
  canonical?: string;
  unknownRubro?: string;
} {
  const clean = cleanText(text);

  // 1. Check known aliases
  for (const item of RUBRO_ALIASES) {
    for (const pattern of item.patterns) {
      if (pattern.test(clean)) {
        return { canonical: item.canonical };
      }
    }
  }

  // 2. Check if user explicitly named an unknown rubro: "rubro X", "rubro de X", "excel de [reposicion de] X"
  const rawPatterns = [
    /\brubro\s+(?:de\s+)?([A-Za-zÁÉÍÓÚáéíóúÑñ]+)\b/i,
    /\b(?:excel|planilla|archivo|xlsx)(?:\s+(?:de|del)\s+(?:reposicion|reposición|reponer))?(?:\s+(?:de|del))?\s+([A-Za-zÁÉÍÓÚáéíóúÑñ]+)\b/i,
    /\b(?:reposicion|reposición|reponer|pedir|comprar)\s+(?:de|del)\s+([A-Za-zÁÉÍÓÚáéíóúÑñ]+)\b/i,
  ];

  for (const pattern of rawPatterns) {
    const m = text.match(pattern);
    if (m && m[1]) {
      const rawCandidate = m[1].trim();
      const cleanCandidate = cleanText(rawCandidate);
      const ignored = new Set([
        "de", "del", "para", "en", "excel", "planilla", "archivo", "xlsx",
        "centro", "jardin", "deposito", "depo", "central",
        "todos", "todas", "general", "reposicion", "reponer", "pedidos", "pedido", "stock",
        "los", "las", "la", "el", "rubro", "que", "un", "una", "por"
      ]);
      if (!ignored.has(cleanCandidate) && cleanCandidate.length >= 3) {
        // If candidate resolves to a recognized supplier, do NOT treat it as an unknown rubro
        if (resolveSupplier(cleanCandidate).status !== "NOT_FOUND") {
          return {};
        }
        const formatted = rawCandidate.charAt(0).toUpperCase() + rawCandidate.slice(1);
        return { unknownRubro: formatted };
      }
    }
  }

  return {};
}

const RUBRO_DISPLAY_NAMES: Record<string, string> = {
  ALMACEN: "Almacén",
  BEBIDAS: "Bebidas",
  CARAMELOS: "Caramelos",
  CIGARRILLOS: "Cigarrillos",
  COPETIN: "Copetín",
  CHOCOLATES: "Chocolates",
  DESCARTABLES: "Descartables",
  ENCENDIDOS: "Encendidos",
  GALLETITAS: "Galletitas",
  INSECTICIDA: "Insecticida",
  LIMPIEZA: "Limpieza",
  NAIPES: "Naipes",
  NAVIDEÑOS: "Navideños",
  PEGAMENTOS: "Pegamentos",
  PERFUMERIA: "Perfumería",
  PILAS: "Pilas",
  "TABACO Y AFINES": "Tabaco y afines",
  VARIOS: "Varios",
  __SIN_RUBRO__: "Sin rubro",
};

export function formatRubroLabel(canonical: string): string {
  if (RUBRO_DISPLAY_NAMES[canonical]) {
    return RUBRO_DISPLAY_NAMES[canonical];
  }
  return canonical.charAt(0).toUpperCase() + canonical.slice(1).toLowerCase();
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
    /^(?:busca(?:me)?(?:\s+(?:el|la|los|las|un|una|el\s+articulo|el\s+producto|articulo|producto))?)\s+/i,
    /^(?:buscar(?:\s+(?:el|la|los|las|un|una|el\s+articulo|el\s+producto|articulo|producto))?)\s+/i,
    /^(?:consultar?|fijate|ver|mostra(?:me)?|dame)\s+(?:el\s+stock\s+(?:de|del)?|stock\s+(?:de|del)?|el\s+articulo|articulo)?\s*/i,
    /^(?:cuanto\s+stock\s+(?:hay|tenemos|queda|de|del)?)\s*/i,
    /^(?:stock\s+(?:de|del|hay|en)?)\s*/i,
    /^(?:tenes\s+(?:stock\s+de|stock\s+del|stock)?)\s*/i,
    /^(?:queda\s+(?:stock\s+de|stock\s+del|stock)?)\s*/i,
    /^(?:hay\s+(?:stock\s+de|stock\s+del|stock)?)\s*/i,
    /^(?:precio\s+de)\s*/i,
    /^(?:proveedor\s+de)\s*/i,
    /^(?:de\s+que\s+proveedor\s+es)\s*/i,
    /^(?:que\s+proveedor\s+tiene)\s*/i,
    /^(?:este\s+producto|este\s+articulo)\s*/i,
  ];

  for (const prefix of prefixes) {
    cleaned = cleaned.replace(prefix, "");
  }

  // Remove branch mentions: "en centro", "en jardin", "en deposito"
  cleaned = cleaned.replace(/\b(?:en|para|del?)\s+(?:centro|jardin|deposito|el deposito|cetro|jardi)\b/g, " ");

  // Remove common filler verbs and particles
  cleaned = cleaned.replace(/\b(?:hay|queda|quedan|tenemos|este|articulo|producto)\b/g, " ");

  // Remove user-specified stopwords
  for (const stop of stopWords) {
    cleaned = cleaned.replace(new RegExp(`\\b${cleanText(stop)}\\b`, "g"), " ");
  }

  // Strip leading articles
  cleaned = cleaned.replace(/^(?:el|la|los|las|un|una|del|de)\s+/i, "");

  // Normalize punctuation and hyphens to spaces
  cleaned = cleaned.replace(/[-_/]/g, " ").replace(/\s+/g, " ").trim();

  // If bare number, treat as article ID
  if (/^\d+$/.test(cleaned)) {
    return { articleId: Number(cleaned) };
  }

  // Guard against conversational questions being extracted as bare product searches
  if (
    /\b(que|como|cuando|donde|por que|porque|cual|cuales|cuanto|cuanta|cuantos|cuantas|quien|quienes|falta|faltan|reponer|pedir)\b/i.test(
      cleaned
    )
  ) {
    return {};
  }

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
  const rubroInfo = resolveCanonicalRubroFromText(text);
  const supplierInfo = extractSupplierCandidate(text);

  let resolvedSupplier: ReturnType<typeof resolveSupplier> | null = null;
  if (supplierInfo.candidate) {
    resolvedSupplier = resolveSupplier(supplierInfo.candidate);
  }

  const resolvedSupplierCode =
    resolvedSupplier && resolvedSupplier.status === "EXACT"
      ? resolvedSupplier.supplier.code
      : supplierInfo.candidate && /^\d+$/.test(supplierInfo.candidate)
      ? supplierInfo.candidate
      : undefined;

  const resolvedSupplierName =
    resolvedSupplier && resolvedSupplier.status === "EXACT"
      ? resolvedSupplier.supplier.name
      : supplierInfo.candidate && /^\d+$/.test(supplierInfo.candidate)
      ? `Proveedor ${supplierInfo.candidate}`
      : undefined;

  const slots: ParsedSlots = {
    branchTarget: branchInfo.target,
    branchId: branchInfo.branchId,
    orderNumber,
    period: periodInfo.period,
    periodType: periodInfo.periodType,
    periodLabel: periodInfo.label,
    targetRubro: rubroInfo.canonical,
    supplierCode: resolvedSupplierCode,
    supplierName: resolvedSupplierName,
    supplierSearch: resolvedSupplierName || supplierInfo.candidate || undefined,
  };

  // 1. MENU NUMERIC SHORTCUTS (1, 2, 3, 4, 5)
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
  if (/^5$/.test(clean) || /^(opcion|opción)\s*5$/i.test(clean)) {
    return {
      type: "REPLENISHMENT_EXCEL",
      rawText: text,
      slots: {
        ...slots,
        wantsExcel: true,
        needsClarification: true,
        clarificationType: "RUBRO",
        clarificationMessage:
          "Para generar el Excel de reposición, podés indicarme el rubro (ej. *Chocolates*, *Galletitas*, *Bebidas*, *Cigarrillos*) o el proveedor (ej. *Arcor*, *Baggio*, *50350*) y la sucursal (*Centro* o *Jardín*).",
        pendingIntentType: "REPLENISHMENT_EXCEL",
      },
      confidence: 1.0,
    };
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
    /\b(excel de pedidos|planilla de pedidos|que pedidos hay|pedidos registrados|pedidos hay|cuales son los ultimos pedidos|ultimos pedidos|ultimo pedido|pedidos de|ver pedidos|estado de pedidos|ordenes|lista de pedidos|mostrame los pedidos|que pedidos)\b/.test(clean) ||
    clean === "pedidos"
  ) {
    return { type: "ORDERS_RECENT", rawText: text, slots, confidence: 0.95 };
  }

  // 8.5. REPOSICIÓN EN EXCEL (por rubro, por proveedor o general)
  const mentionsExcelOrSheet =
    /\b(excel|planilla|archivo|xlsx|sheet|reporte|descargar|descargame|exportar|exportame|bajar|bajame)\b/.test(clean);
  const mentionsReplenish =
    /\b(reponer|reposicion|reposición|que hay que reponer|que reponer|sugerencias de reposicion|faltan pedirle|lo que falta pedirle|falta pedirle|tengo que pedirle|que tengo que pedirle|que tengo que pedir|productos que faltan pedirle|que pedir|que pedirle|falta pedir|falta pedirle|faltan pedir|faltan pedirle)\b/.test(clean);
  const mentionsAction =
    /\b(pasame|mandame|enviame|generame|armame|descargame|descargar|exportar|exportame|bajar|quiero|necesito|haceme)\b/.test(clean);

  // Guard against queries that explicitly ask for other domains (sales, orders, stock) even if they mention excel
  const isExplicitNonReplenishmentExcel =
    /\b(ventas|movimientos|balance|cierre)\b/.test(clean) ||
    /\b(pedidos registrados|ultimos pedidos|pedidos pendientes|estado de pedidos)\b/.test(clean) ||
    /\b(stock|cuanto stock|stock bajo|sin stock)\b/.test(clean) ||
    /\b(cuando se actualizo|de que fecha|fecha del excel|sincronizacion)\b/.test(clean);

  const hasSupplierCandidate = Boolean(
    supplierInfo.candidate || supplierInfo.isGenericSupplierReference || (resolvedSupplier && resolvedSupplier.status !== "NOT_FOUND")
  );

  const mentionsPassReplenish =
    /\b(pasame|mandame|enviame|generame|armame|haceme)\b/.test(clean) &&
    /\breposicion\b/.test(clean);

  const isReplenishmentExcelIntent =
    !isExplicitNonReplenishmentExcel &&
    (
      (mentionsExcelOrSheet && (
        mentionsReplenish ||
        Boolean(rubroInfo.canonical || rubroInfo.unknownRubro) ||
        hasSupplierCandidate ||
        clean.includes("reposicion") ||
        mentionsAction
      )) ||
      (mentionsPassReplenish && (
        Boolean(rubroInfo.canonical || rubroInfo.unknownRubro) ||
        hasSupplierCandidate
      ))
    );

  if (isReplenishmentExcelIntent) {
    // 1. Generic supplier reference ("este proveedor")
    if (supplierInfo.isGenericSupplierReference && !resolvedSupplier) {
      return {
        type: "REPLENISHMENT_EXCEL",
        rawText: text,
        slots: {
          ...slots,
          wantsExcel: true,
          needsClarification: true,
          clarificationType: "SUPPLIER",
          clarificationMessage:
            "¿De qué proveedor querés generar la planilla de reposición? Podés indicarme el nombre (ej. *Arcor*, *Baggio*, *Coca-Cola*, *Marlboro*) o el código numérico (ej. *50350*).",
          pendingIntentType: "REPLENISHMENT_EXCEL",
        },
        confidence: 0.95,
      };
    }

    // 2. Ambiguous supplier candidate
    if (resolvedSupplier && resolvedSupplier.status === "AMBIGUOUS") {
      const optionsList = resolvedSupplier.candidates
        .map((c, i) => `*${i + 1}. ${c.name}* (cód. ${c.code})`)
        .join(", ");
      return {
        type: "REPLENISHMENT_EXCEL",
        rawText: text,
        slots: {
          ...slots,
          wantsExcel: true,
          needsClarification: true,
          clarificationType: "SUPPLIER",
          clarificationMessage: `Encontré varios proveedores posibles para *${supplierInfo.candidate}*: ${optionsList}. ¿Cuál querés consultar?`,
          disambiguationCandidates: resolvedSupplier.candidates.map((c) => ({ code: c.code, label: c.name })),
          pendingIntentType: "REPLENISHMENT_EXCEL",
        },
        confidence: 0.95,
      };
    }

    // 3. Explicitly named supplier that was not found
    if (resolvedSupplier && resolvedSupplier.status === "NOT_FOUND" && supplierInfo.isExplicitSupplierKeyword) {
      return {
        type: "REPLENISHMENT_EXCEL",
        rawText: text,
        slots: {
          ...slots,
          wantsExcel: true,
          needsClarification: true,
          clarificationType: "SUPPLIER",
          clarificationMessage: `No encontré ningún proveedor con el nombre o código *${supplierInfo.candidate}*. Podés ingresar el código numérico (ej. *50350*) o marcas reconocidas (ej. *Arcor*, *Baggio*, *Energizer*, *Marlboro*, *Milka*).`,
          pendingIntentType: "REPLENISHMENT_EXCEL",
        },
        confidence: 0.95,
      };
    }

    // 4. Unknown rubro specified (when no supplier was specified)
    if (rubroInfo.unknownRubro && !slots.supplierCode) {
      const capUnknown = rubroInfo.unknownRubro.charAt(0).toUpperCase() + rubroInfo.unknownRubro.slice(1);
      return {
        type: "REPLENISHMENT_EXCEL",
        rawText: text,
        slots: {
          ...slots,
          wantsExcel: true,
          needsClarification: true,
          clarificationType: "RUBRO",
          clarificationMessage: `No encontré el rubro *${capUnknown}*. Los rubros disponibles en el catálogo son: *Chocolates*, *Caramelos*, *Galletitas*, *Bebidas*, *Almacén*, *Cigarrillos*, *Copetín*, *Limpieza*, *Perfumería*, *Pilas*, entre otros. ¿Cuál querés consultar?`,
          pendingIntentType: "REPLENISHMENT_EXCEL",
        },
        confidence: 0.95,
      };
    }

    // 5. Check invalid branch if mentioned
    const invalidBranch = extractInvalidBranch(text);
    if (invalidBranch) {
      const targetDesc = slots.supplierName
        ? `del proveedor *${slots.supplierName}*`
        : rubroInfo.canonical
        ? `de *${formatRubroLabel(rubroInfo.canonical)}*`
        : "de reposición";
      return {
        type: "REPLENISHMENT_EXCEL",
        rawText: text,
        slots: {
          ...slots,
          targetRubro: rubroInfo.canonical,
          wantsExcel: true,
          needsClarification: true,
          clarificationType: "BRANCH",
          clarificationMessage: `No reconozco la sucursal *${invalidBranch}*. Las sucursales disponibles son *Centro* o *Jardín* (abastecidas por el *Depósito Central*). ¿Para cuál querés generar el Excel ${targetDesc}?`,
          pendingIntentType: "REPLENISHMENT_EXCEL",
        },
        confidence: 0.95,
      };
    }

    // 6. If neither rubro nor supplier is provided: ask clarification
    if (!rubroInfo.canonical && !slots.supplierCode) {
      const branchNotice =
        branchInfo.target === "CENTRO" ? " para *Centro*" :
        branchInfo.target === "JARDIN" ? " para *Jardín*" : "";
      return {
        type: "REPLENISHMENT_EXCEL",
        rawText: text,
        slots: {
          ...slots,
          wantsExcel: true,
          needsClarification: true,
          clarificationType: "RUBRO",
          clarificationMessage: `Para generar el Excel de reposición${branchNotice}, podés indicarme el rubro (ej. *Chocolates*, *Galletitas*, *Bebidas*, *Cigarrillos*) o el proveedor (ej. *Arcor*, *Baggio*, *50350*).`,
          pendingIntentType: "REPLENISHMENT_EXCEL",
        },
        confidence: 0.95,
      };
    }

    // 7. If branch is missing or DEPOSITO: ask clarification for branch
    if (branchInfo.target === "ALL" || branchInfo.target === "DEPOSITO") {
      const targetDesc =
        slots.supplierName && rubroInfo.canonical
          ? `de *${formatRubroLabel(rubroInfo.canonical)}* del proveedor *${slots.supplierName}*`
          : slots.supplierName
          ? `del proveedor *${slots.supplierName}*`
          : `de *${formatRubroLabel(rubroInfo.canonical!)}*`;

      const msg =
        branchInfo.target === "DEPOSITO"
          ? `La reposición semanal se calcula para las sucursales de venta (*Centro* o *Jardín*) que se abastecen desde el Depósito Central. ¿Para cuál querés generar el Excel ${targetDesc}?`
          : `Para generar el Excel de reposición ${targetDesc}, por favor indicame si lo necesitás para *Centro*, *Jardín* o *Depósito*.`;

      return {
        type: "REPLENISHMENT_EXCEL",
        rawText: text,
        slots: {
          ...slots,
          targetRubro: rubroInfo.canonical,
          wantsExcel: true,
          needsClarification: true,
          clarificationType: "BRANCH",
          clarificationMessage: msg,
          pendingIntentType: "REPLENISHMENT_EXCEL",
        },
        confidence: 0.95,
      };
    }

    // 8. Branch and target (rubro and/or supplier) are both valid
    return {
      type: "REPLENISHMENT_EXCEL",
      rawText: text,
      slots: {
        ...slots,
        targetRubro: rubroInfo.canonical,
        branchTarget: branchInfo.target,
        branchId: branchInfo.branchId,
        wantsExcel: true,
        needsClarification: false,
      },
      confidence: 0.95,
    };
  }

  // 8.8. DISPONIBILIDAD EN DEPÓSITO DE PRODUCTOS FALTANTES EN SUCURSAL
  const mentionsDepot = /\b(deposito|almacen central|depo)\b/.test(clean);
  const mentionsBranchFaltante =
    /\b(falta|faltan|hace falta|hacen falta|faltantes|quiebre|quiebres|estan faltando)\b/.test(clean);
  const mentionsDepotAvailable =
    /\b(hay en (?:el )?deposito|tengo en (?:el )?deposito|tenemos en (?:el )?deposito|disponible|disponibles|quedan en (?:el )?deposito|pero hay en (?:el )?deposito|y hay en (?:el )?deposito|que hay en (?:el )?deposito)\b/.test(clean) ||
    /\b(productos (?:que )?faltan en \w+ pero hay en (?:el )?deposito|productos tengo en el deposito y faltan en \w+)\b/.test(clean);

  if (mentionsDepot && mentionsBranchFaltante && mentionsDepotAvailable) {
    if (rubroInfo.canonical) {
      slots.targetRubro = rubroInfo.canonical;
    }

    if (branchInfo.target === "ALL" || branchInfo.target === "DEPOSITO") {
      return {
        type: "DEPOSIT_AVAILABILITY",
        rawText: text,
        slots: {
          ...slots,
          needsClarification: true,
          clarificationType: "BRANCH",
          clarificationMessage:
            "¿Para qué sucursal querés consultar los productos disponibles en depósito que faltan en el local? Podés indicar *Centro* o *Jardín*.",
          pendingIntentType: "DEPOSIT_AVAILABILITY",
        },
        confidence: 0.95,
      };
    }

    return {
      type: "DEPOSIT_AVAILABILITY",
      rawText: text,
      slots: {
        ...slots,
        branchTarget: branchInfo.target,
        branchId: branchInfo.branchId,
      },
      confidence: 0.95,
    };
  }

  // 9. REPOSICIÓN SEMANAL (en texto plano)
  const isReplenishmentText =
    /\b(reposicion semanal|que productos hay que reponer|que hay que reponer|que tengo que reponer|necesitan reposicion|sugerencias de reposicion|sugerencia|a reponer|reponer|reposicion|que tengo que pedir|que tengo que pedirle|que falta reponer|lo que falta reponer|que pedir|que pedirle|falta pedir|falta pedirle|faltan pedir|faltan pedirle|lo de)\b/.test(clean) ||
    /\b(me estan haciendo falta|haciendo falta|estan haciendo falta|hace falta|estan faltando|me estan faltando|nos esta faltando|que esta faltando|que productos estan faltando|que me esta faltando|que me falta|que nos falta|que falta|que faltan|productos que faltan|articulos que faltan|que productos me faltan|que productos necesito reponer|que articulos necesito reponer)\b/.test(clean) ||
    (mentionsReplenish && (hasSupplierCandidate || Boolean(rubroInfo.canonical)));

  if (isReplenishmentText) {
    if (rubroInfo.canonical) {
      slots.targetRubro = rubroInfo.canonical;
    }

    // If generic supplier reference (e.g. "Qué productos tengo que pedirle a este proveedor")
    if (supplierInfo.isGenericSupplierReference && !resolvedSupplier) {
      return {
        type: "REPLENISHMENT",
        rawText: text,
        slots: {
          ...slots,
          needsClarification: true,
          clarificationType: "SUPPLIER",
          clarificationMessage:
            "¿De qué proveedor querés consultar la reposición? Podés indicarme el nombre (ej. *Arcor*, *Baggio*, *Coca-Cola*) o el código numérico (ej. *50350*).",
        },
        confidence: 0.95,
      };
    }

    // If ambiguous supplier
    if (resolvedSupplier && resolvedSupplier.status === "AMBIGUOUS") {
      const optionsList = resolvedSupplier.candidates
        .map((c, i) => `*${i + 1}. ${c.name}* (cód. ${c.code})`)
        .join(", ");
      return {
        type: "REPLENISHMENT",
        rawText: text,
        slots: {
          ...slots,
          needsClarification: true,
          clarificationType: "SUPPLIER",
          clarificationMessage: `Encontré varios proveedores posibles para *${supplierInfo.candidate}*: ${optionsList}. ¿Cuál querés consultar?`,
          disambiguationCandidates: resolvedSupplier.candidates.map((c) => ({ code: c.code, label: c.name })),
        },
        confidence: 0.95,
      };
    }

    // If no branch was specified or user asked for Depósito, request clarification for Centro or Jardín
    if (branchInfo.target === "ALL" || branchInfo.target === "DEPOSITO") {
      const targetDesc =
        slots.supplierName && rubroInfo.canonical
          ? ` de *${formatRubroLabel(rubroInfo.canonical)}* del proveedor *${slots.supplierName}*`
          : slots.supplierName
          ? ` del proveedor *${slots.supplierName}*`
          : rubroInfo.canonical
          ? ` de *${formatRubroLabel(rubroInfo.canonical)}*`
          : "";

      const msg =
        branchInfo.target === "DEPOSITO"
          ? `La reposición semanal se calcula para abastecer a las sucursales *Centro* o *Jardín* desde el Depósito Central. ¿Cuál querés consultar${targetDesc}?`
          : `Para consultar la reposición semanal sugerida${targetDesc}, por favor indicame para qué sucursal querés verla: *Centro* o *Jardín*.`;

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
    /\b(stock bajo|bajo stock|bajos de stock|mas bajos de stock|estan bajos de stock|estan mas bajos de stock|poco stock|stock critico|critico de stock|menor stock|productos con bajo stock|productos tienen stock bajo|tienen stock bajo|escaso stock|stock escaso|productos con menor stock|articulos con stock bajo)\b/.test(clean)
  ) {
    if (rubroInfo.canonical) {
      slots.targetRubro = rubroInfo.canonical;
    }

    if (branchInfo.target === "ALL") {
      const rubroNotice = rubroInfo.canonical ? ` de *${formatRubroLabel(rubroInfo.canonical)}*` : "";
      return {
        type: "STOCK_LOW",
        rawText: text,
        slots: {
          ...slots,
          targetRubro: rubroInfo.canonical,
          needsClarification: true,
          clarificationType: "BRANCH",
          clarificationMessage:
            `¿Para qué sucursal querés consultar los productos con stock bajo${rubroNotice}? Podés indicar *Depósito Central*, *Centro* o *Jardín*.`,
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
    /\b(resumen|balance|metricas|movimientos del mes|como venimos|que paso durante|ventas|evolucion)\b/.test(clean)
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
    /\b(stock|cuanto hay|cuanto stock|tenes|queda|quedan|hay stock|busca|buscá|buscar|buscame)\b/.test(clean) ||
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
  // Guard: if it's a conversational sentence (e.g. contains question words or conversational verbs), DO NOT treat as bare product name
  const isConversationalQuestion = /\b(que|como|cuando|donde|por que|porque|cual|cuales|cuanto|cuanta|cuantos|cuantas|quien|quienes|de que|en que)\b/i.test(clean);
  const implicitExtraction = extractProductSearch(text);
  if (
    implicitExtraction.articleId ||
    (!isConversationalQuestion &&
      implicitExtraction.productSearch &&
      implicitExtraction.productSearch.length >= 3 &&
      implicitExtraction.productSearch.split(/\s+/).length <= 4)
  ) {
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
