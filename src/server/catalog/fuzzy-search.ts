/**
 * Motor de búsqueda aproximada y tolerancia a errores ortográficos para el catálogo
 * de productos y entidades de La Casa del Kioskero.
 */

/**
 * Normaliza una cadena de texto para comparación:
 * - Convierte a minúsculas
 * - Remueve acentos y diacríticos (á -> a, é -> e, etc.), preserva 'ñ'
 * - Elimina signos de puntuación y caracteres especiales no alfanuméricos
 * - Normaliza espacios en blanco
 */
export function normalizeFuzzyText(input: string): string {
  if (!input) return "";
  return input
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // remueve acentos
    .replace(/[^a-z0-9ñ\s]/gi, " ") // mantiene letras, números, ñ y espacios
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Diccionario de variantes conocidas, marcas y alias comunes del kiosco.
 * Permite reconocer productos aunque se escriban con nombres coloquiales o variantes.
 */
const CANONICAL_PRODUCT_ALIASES: Array<{
  canonical: string;
  aliases: string[];
}> = [
  {
    canonical: "bon o bon",
    aliases: ["bonobon", "bon o bon", "bonobom", "bon o bom", "bon-o-bon", "bonbon", "bombom"],
  },
  {
    canonical: "coca cola",
    aliases: ["coca cola", "cocacola", "coca", "coke", "coca-cola"],
  },
  {
    canonical: "pepitos",
    aliases: ["pepitos", "pepito", "pepito's", "galletitas pepitos"],
  },
  {
    canonical: "lays",
    aliases: ["lays", "lay's", "papas lays", "papas lay"],
  },
  {
    canonical: "marlboro",
    aliases: ["marlboro", "malboro", "marboro", "marlboro box", "marvolo", "marlb", "marlb."],
  },
  {
    canonical: "marlboro crafted red",
    aliases: [
      "marlboro crafted red",
      "marlb crafted red",
      "crafted red",
      "marlb crafted red ks",
      "marlboro crafted red ks",
      "marlb crafted red box",
      "marlboro crafted red box",
      "marlb. crafted red ks.",
      "marlb. crafted red box",
    ],
  },
  {
    canonical: "philip morris",
    aliases: ["philip morris", "philip", "phillip morris", "phillip", "filip morris", "philip moris"],
  },
  {
    canonical: "lucky strike",
    aliases: ["lucky strike", "lucky", "laki", "luckystrike"],
  },
  {
    canonical: "camel",
    aliases: ["camel", "kamel"],
  },
  {
    canonical: "oreo",
    aliases: ["oreo", "oreos", "galletitas oreo"],
  },
  {
    canonical: "milka",
    aliases: ["milka", "chocolate milka"],
  },
  {
    canonical: "beldent",
    aliases: ["beldent", "belden", "beldente", "chicle beldent"],
  },
  {
    canonical: "kit kat",
    aliases: ["kit kat", "kitkat", "kit-kat"],
  },
  {
    canonical: "chocolinas",
    aliases: ["chocolinas", "chocolina", "chocolinas galletitas", "chocotorta"],
  },
  {
    canonical: "tita",
    aliases: ["tita", "titas", "galletita tita"],
  },
  {
    canonical: "rhodesia",
    aliases: ["rhodesia", "rodesia", "rodeshia"],
  },
  {
    canonical: "alfajor havanna",
    aliases: ["havanna", "havana", "alfajor havanna", "alfajor havana"],
  },
  {
    canonical: "alfajor guaymallen",
    aliases: ["guaymallen", "guaimallen", "guaymayen", "alfajor guaymallen"],
  },
  {
    canonical: "alfajor jorgito",
    aliases: ["jorgito", "alfajor jorgito", "jorgelin"],
  },
  {
    canonical: "alfajor capitan del espacio",
    aliases: ["capitan del espacio", "capitan", "alfajor capitan"],
  },
  {
    canonical: "energizer",
    aliases: ["energizer", "energiser", "pilas energizer"],
  },
  {
    canonical: "eveready",
    aliases: ["eveready", "everedy", "everedi", "pilas eveready"],
  },
  {
    canonical: "baggio",
    aliases: ["baggio", "bagio", "jugo baggio", "jugos baggio"],
  },
  {
    canonical: "arcor",
    aliases: ["arcor", "alcor"],
  },
  {
    canonical: "felfort",
    aliases: ["felfort", "fel fort", "marroc", "dos corazones"],
  },
  {
    canonical: "quento",
    aliases: ["quento", "cuento", "papas quento"],
  },
];

/**
 * Resuelve alias canónico de un término si coincide con alguna variante conocida.
 */
export function resolveKnownAlias(term: string): string | null {
  const norm = normalizeFuzzyText(term);
  if (!norm) return null;

  for (const item of CANONICAL_PRODUCT_ALIASES) {
    for (const alias of item.aliases) {
      if (normalizeFuzzyText(alias) === norm) {
        return item.canonical;
      }
    }
  }
  return null;
}

/**
 * Canonicalizes a commercial brand or product nickname to its standard name.
 */
export function canonicalizeCommercialBrand(term: string): string {
  const norm = normalizeFuzzyText(term);
  if (!norm) return "";
  const resolved = resolveKnownAlias(norm);
  if (resolved) return resolved;
  return norm;
}

const CATALOG_ABBREVIATIONS: Record<string, string[]> = {
  marlb: ["marlboro", "marlb"],
  marlboro: ["marlboro", "marlb"],
  chest: ["chesterfield", "chest"],
  chesterfield: ["chesterfield", "chest"],
  philip: ["philip morris", "philip"],
  bagg: ["baggio", "bagg"],
  baggio: ["baggio", "bagg"],
  coca: ["coca cola", "coca", "cocacola"],
  "coca-cola": ["coca cola", "coca", "cocacola"],
  cocacola: ["coca cola", "coca", "cocacola"],
  red: ["red"],
  crafted: ["crafted"],
  point: ["point"],
  master: ["master"],
};

export function expandSearchToken(token: string): string[] {
  const clean = normalizeFuzzyText(token);
  if (!clean) return [];
  if (CATALOG_ABBREVIATIONS[clean]) {
    return CATALOG_ABBREVIATIONS[clean];
  }
  return [clean];
}

/**
 * Calcula la distancia de Damerau-Levenshtein (con soporte de transposiciones de caracteres adyacentes)
 * entre dos cadenas de texto normalizadas.
 */
export function damerauLevenshteinDistance(source: string, target: string): number {
  const s = source;
  const t = target;
  const sLen = s.length;
  const tLen = t.length;

  if (sLen === 0) return tLen;
  if (tLen === 0) return sLen;

  // Matriz de distancias
  const d: number[][] = [];
  for (let i = 0; i <= sLen; i++) {
    d[i] = [];
    d[i][0] = i;
  }
  for (let j = 0; j <= tLen; j++) {
    d[0][j] = j;
  }

  for (let i = 1; i <= sLen; i++) {
    for (let j = 1; j <= tLen; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1, // Eliminación
        d[i][j - 1] + 1, // Inserción
        d[i - 1][j - 1] + cost // Sustitución
      );

      // Transposición (Damerau)
      if (i > 1 && j > 1 && s[i - 1] === t[j - 2] && s[i - 2] === t[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }

  return d[sLen][tLen];
}

/**
 * Calcula el coeficiente de similitud de Dice basado en bigramas (n-gramas de 2 caracteres)
 * entre dos cadenas. Rango: 0.0 (totalmente distintas) a 1.0 (idénticas).
 */
export function ngramSimilarity(a: string, b: string): number {
  const s1 = a;
  const s2 = b;

  if (s1 === s2) return 1.0;
  if (s1.length < 2 || s2.length < 2) return 0.0;

  const ngramsA = new Set<string>();
  for (let i = 0; i < s1.length - 1; i++) {
    ngramsA.add(s1.slice(i, i + 2));
  }

  const ngramsB = new Set<string>();
  for (let i = 0; i < s2.length - 1; i++) {
    ngramsB.add(s2.slice(i, i + 2));
  }

  let intersection = 0;
  for (const gram of ngramsA) {
    if (ngramsB.has(gram)) intersection++;
  }

  const total = ngramsA.size + ngramsB.size;
  if (total === 0) return 0.0;
  return (2.0 * intersection) / total;
}

export type FuzzyMatchScore = {
  score: number; // 0.0 a 1.0
  isExact: boolean;
  isPrefix: boolean;
  isContained: boolean;
  editDistance: number;
  confidence: "HIGH" | "MEDIUM" | "LOW";
};

/**
 * Evalúa la similitud integral entre una consulta de búsqueda y el nombre/descripción de un producto.
 * Combina:
 * 1. Coincidencia exacta o normalizada
 * 2. Inclusión completa de la consulta en el texto
 * 3. Coincidencia de tokens individuales (todas las palabras de la consulta están en el producto)
 * 4. Similitud de Damerau-Levenshtein y trigramas para tolerar errores ortográficos
 */
export function calculateProductSimilarity(
  query: string,
  candidateText: string,
  candidateBrand?: string | null
): FuzzyMatchScore {
  const normQuery = normalizeFuzzyText(query);
  const normCandidate = normalizeFuzzyText(candidateText);
  const normBrand = candidateBrand ? normalizeFuzzyText(candidateBrand) : "";

  const createResult = (
    score: number,
    isExact: boolean,
    isPrefix: boolean,
    isContained: boolean,
    editDistance: number
  ): FuzzyMatchScore => ({
    score,
    isExact,
    isPrefix,
    isContained,
    editDistance,
    confidence: score >= 0.75 ? "HIGH" : score >= 0.5 ? "MEDIUM" : "LOW",
  });

  if (!normQuery || !normCandidate) {
    return createResult(0, false, false, false, 999);
  }

  // 1. Coincidencia exacta
  if (normQuery === normCandidate) {
    return createResult(1.0, true, true, true, 0);
  }

  // 2. Coincidencia con alias canónico
  const aliasOfQuery = resolveKnownAlias(normQuery);
  if (aliasOfQuery) {
    if (normCandidate.includes(aliasOfQuery)) {
      return createResult(0.98, false, normCandidate.startsWith(aliasOfQuery), true, 0);
    }
  }

  // Comprobar canonicalización de tokens: ej. "bonobon leche" -> "bon o bon leche"
  const canonicalQuery = normQuery
    .split(" ")
    .map((w) => canonicalizeCommercialBrand(w))
    .join(" ");
  if (canonicalQuery !== normQuery && normCandidate.includes(canonicalQuery)) {
    return createResult(0.95, false, normCandidate.startsWith(canonicalQuery), true, 0);
  }

  // 3. Contención directa de la frase completa
  if (normCandidate.includes(normQuery)) {
    const isPrefix = normCandidate.startsWith(normQuery);
    const score = isPrefix ? 0.92 : 0.88;
    return createResult(score, false, isPrefix, true, 0);
  }

  // También comprobar si la consulta está en la marca
  if (normBrand && normBrand.includes(normQuery)) {
    return createResult(0.9, normBrand === normQuery, normBrand.startsWith(normQuery), true, 0);
  }

  // 4. Coincidencia por tokens / palabras individuales
  const queryTokens = normQuery.split(" ").filter((t) => t.length > 1);
  const candidateWords = new Set(normCandidate.split(" ").concat(normBrand.split(" ")));

  let matchedTokens = 0;
  for (const token of queryTokens) {
    const canonToken = canonicalizeCommercialBrand(token);
    let tokenFound = false;
    if (candidateWords.has(token) || candidateWords.has(canonToken)) {
      tokenFound = true;
    } else {
      for (const word of candidateWords) {
        if (
          word.startsWith(token) ||
          word.startsWith(canonToken) ||
          (token.length >= 4 && damerauLevenshteinDistance(token, word) <= 1)
        ) {
          tokenFound = true;
          break;
        }
      }
    }
    if (tokenFound) matchedTokens++;
  }

  const tokenCoverage = queryTokens.length > 0 ? matchedTokens / queryTokens.length : 0;

  // Si todas las palabras coinciden
  if (tokenCoverage === 1.0 && queryTokens.length > 0) {
    return createResult(0.85, false, false, true, 0);
  }

  // 5. Comparación aproximada fonética/distancia en palabras clave
  let bestWordSim = 0;
  let minWordDistance = 999;

  for (const word of candidateWords) {
    if (!word || word.length < 3) continue;
    const dist = damerauLevenshteinDistance(normQuery, word);
    if (dist < minWordDistance) minWordDistance = dist;

    // Si la palabra tiene longitud similar y distancia <= 2 (error de tipeo)
    if (dist <= 1 && normQuery.length >= 4) {
      bestWordSim = Math.max(bestWordSim, 0.82);
    } else if (dist <= 2 && normQuery.length >= 6) {
      bestWordSim = Math.max(bestWordSim, 0.75);
    }
  }

  // Trigramas
  const trigramSim = ngramSimilarity(normQuery, normCandidate);
  const brandTrigramSim = normBrand ? ngramSimilarity(normQuery, normBrand) : 0;

  const maxSim = Math.max(
    bestWordSim,
    trigramSim * 0.8,
    brandTrigramSim * 0.85,
    tokenCoverage * 0.7
  );

  const finalScore = Math.min(0.9, Number(maxSim.toFixed(2)));
  return createResult(finalScore, false, false, false, minWordDistance);
}
