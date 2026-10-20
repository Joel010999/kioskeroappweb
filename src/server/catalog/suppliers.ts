/**
 * Módulo de resolución y catálogo de proveedores para La Casa del Kioskero.
 * Mapea códigos numéricos externos de proveedores y marcas comerciales asociadas.
 */

import { normalizeFuzzyText, damerauLevenshteinDistance } from "./fuzzy-search";

export type SupplierEntry = {
  code: string;
  name: string;
  aliases: string[];
  brands: string[];
};

/**
 * Catálogo canónico de proveedores identificados en el sistema de La Casa del Kioskero.
 * Los códigos corresponden a los valores reales de `external_code` en la tabla `suppliers`
 * y `p.payload->>'Proveedor'` en PostgreSQL.
 */
export const CANONICAL_SUPPLIERS: SupplierEntry[] = [
  {
    code: "50350",
    name: "Arcor",
    aliases: ["arcor", "alcor", "bagley", "la campagnola", "campagnola"],
    brands: ["ARCOR", "BAGLEY", "LA CAMPAGNOLA", "BON O BON", "COFLER", "TOPLINE"],
  },
  {
    code: "600036",
    name: "Baggio",
    aliases: ["baggio", "bagio", "rpb", "jugos baggio", "leche baggio"],
    brands: ["BAGGIO", "RPB", "MOCORETA"],
  },
  {
    code: "50166",
    name: "Energizer",
    aliases: ["energizer", "energiser", "eveready", "everedy", "rayovac"],
    brands: ["ENERGIZER", "EVEREADY", "RAYOVAC"],
  },
  {
    code: "50001",
    name: "Massalin Particulares",
    aliases: ["marlboro", "malboro", "massalin", "massalin particulares", "philip morris", "philip", "chesterfield", "l&m"],
    brands: ["MARLBORO", "PHILIP MORRIS", "CHESTERFIELD", "L&M", "HARMONY"],
  },
  {
    code: "50002",
    name: "Mondelez (Milka)",
    aliases: ["milka", "mondelez", "terrabusi", "terabusi", "beldent", "tang", "clight", "club social", "oreo"],
    brands: ["MILKA", "TERRABUSI", "BELDENT", "TANG", "CLIGHT", "CLUB SOCIAL", "OREO", "BAZOOKA"],
  },
  {
    code: "50024",
    name: "Felfort",
    aliases: ["felfort", "fel fort", "fort", "marroc", "dos corazones"],
    brands: ["FELFORT", "MARROC", "DOS CORAZONES", "JACK"],
  },
  {
    code: "50070",
    name: "Georgalos",
    aliases: ["georgalos", "georgalo", "mantecol", "flynn paff"],
    brands: ["GEORGALOS", "MANTECOL", "FLYNN PAFF", "TOKKE"],
  },
  {
    code: "60642",
    name: "La Virginia",
    aliases: ["la virginia", "virginia", "cafe la virginia", "te la virginia"],
    brands: ["LA VIRGINIA", "ALICANTE"],
  },
  {
    code: "50215",
    name: "Fun Pop",
    aliases: ["fun pop", "funpop", "pop"],
    brands: ["FUN POP"],
  },
  {
    code: "50703",
    name: "Nevares",
    aliases: ["nevares", "alfajor nevares", "galletitas nevares"],
    brands: ["NEVARES", "SMACK"],
  },
  {
    code: "600364",
    name: "Julicroc",
    aliases: ["julicroc", "juli croc", "papas julicroc"],
    brands: ["JULICROC"],
  },
  {
    code: "600188",
    name: "Las Marías (Taragüí)",
    aliases: ["taragui", "taragüi", "las marias", "las marías", "union", "mañanita"],
    brands: ["TARAGUI", "UNION", "LA MERCED", "MAÑANITA"],
  },
  {
    code: "50642",
    name: "Misky / Noel",
    aliases: ["misky", "noel", "dulces noel"],
    brands: ["MISKY", "NOEL"],
  },
  {
    code: "50431",
    name: "Cromeros",
    aliases: ["cromeros", "cromero"],
    brands: ["CROMEROS"],
  },
  {
    code: "50481",
    name: "Colibrí",
    aliases: ["colibri", "colibrí"],
    brands: ["COLIBRI"],
  },
  {
    code: "600171",
    name: "Oblita",
    aliases: ["oblita", "oblea oblita"],
    brands: ["OBLITA"],
  },
  {
    code: "600207",
    name: "Quento",
    aliases: ["quento", "cuento", "papas quento"],
    brands: ["QUENTO"],
  },
  {
    code: "50830",
    name: "Hojalmar",
    aliases: ["hojalmar", "palmitas hojalmar"],
    brands: ["HOJALMAR"],
  },
  {
    code: "51933",
    name: "Party Store",
    aliases: ["party store", "partystore", "cotillon"],
    brands: ["PARTY STORE"],
  },
  {
    code: "50028",
    name: "Smoking",
    aliases: ["smoking", "smokling", "papel smoking"],
    brands: ["SMOKING", "SMOKLING"],
  },
  {
    code: "600058",
    name: "Coca-Cola / Andina",
    aliases: ["coca cola", "cocacola", "coca", "andina", "fanta", "sprite"],
    brands: ["COCA COLA", "FANTA", "SPRITE", "POWERADE", "CEPITA"],
  },
];

export type ResolveSupplierResult =
  | {
      status: "EXACT";
      supplier: {
        code: string;
        name: string;
      };
    }
  | {
      status: "AMBIGUOUS";
      candidates: Array<{
        code: string;
        name: string;
      }>;
    }
  | {
      status: "NOT_FOUND";
      query: string;
    };

/**
 * Busca un proveedor en el catálogo canónico por su código exacto.
 */
export function findSupplierByCode(code: string): SupplierEntry | null {
  const trimmed = code.trim();
  return CANONICAL_SUPPLIERS.find((s) => s.code === trimmed) || null;
}

/**
 * Resuelve un proveedor por código numérico o nombre/marca.
 */
export function resolveSupplier(rawInput: string): ResolveSupplierResult {
  if (!rawInput || !rawInput.trim()) {
    return { status: "NOT_FOUND", query: rawInput };
  }

  const trimmed = rawInput.trim();
  const normalized = normalizeFuzzyText(trimmed);

  // 1. Si es un código numérico directo o con prefijo "proveedor 123"
  const codeMatch = trimmed.match(/^(?:proveedor|prov)?\s*[:#]?\s*(\d+)$/i);
  if (codeMatch && codeMatch[1]) {
    const code = codeMatch[1];
    const found = CANONICAL_SUPPLIERS.find((s) => s.code === code);
    if (found) {
      return {
        status: "EXACT",
        supplier: { code: found.code, name: found.name },
      };
    }
    // Si no está en el catálogo canónico conocido pero es un número válido,
    // se acepta como código de proveedor directo
    return {
      status: "EXACT",
      supplier: { code, name: `Proveedor ${code}` },
    };
  }

  // 2. Coincidencia exacta o alias en el catálogo canónico
  const exactMatches: SupplierEntry[] = [];
  for (const s of CANONICAL_SUPPLIERS) {
    const normName = normalizeFuzzyText(s.name);
    if (normName === normalized) {
      exactMatches.push(s);
      continue;
    }
    for (const alias of s.aliases) {
      if (normalizeFuzzyText(alias) === normalized) {
        exactMatches.push(s);
        break;
      }
    }
  }

  if (exactMatches.length === 1) {
    return {
      status: "EXACT",
      supplier: { code: exactMatches[0].code, name: exactMatches[0].name },
    };
  }
  if (exactMatches.length > 1) {
    return {
      status: "AMBIGUOUS",
      candidates: exactMatches.map((s) => ({ code: s.code, name: s.name })),
    };
  }

  // 3. Contención parcial de tokens o alias
  const partialMatches: SupplierEntry[] = [];
  for (const s of CANONICAL_SUPPLIERS) {
    const normName = normalizeFuzzyText(s.name);
    if (normName.includes(normalized) || normalized.includes(normName)) {
      partialMatches.push(s);
      continue;
    }
    for (const alias of s.aliases) {
      const normAlias = normalizeFuzzyText(alias);
      if (normAlias.includes(normalized) || normalized.includes(normAlias)) {
        partialMatches.push(s);
        break;
      }
    }
  }

  if (partialMatches.length === 1) {
    return {
      status: "EXACT",
      supplier: { code: partialMatches[0].code, name: partialMatches[0].name },
    };
  }
  if (partialMatches.length > 1) {
    return {
      status: "AMBIGUOUS",
      candidates: partialMatches.map((s) => ({ code: s.code, name: s.name })),
    };
  }

  // 4. Comparación aproximada (error de tipeo de 1 o 2 letras)
  const fuzzyMatches: Array<{ supplier: SupplierEntry; distance: number }> = [];
  for (const s of CANONICAL_SUPPLIERS) {
    for (const alias of s.aliases) {
      const normAlias = normalizeFuzzyText(alias);
      const dist = damerauLevenshteinDistance(normalized, normAlias);
      if (dist <= 1 && normalized.length >= 4) {
        fuzzyMatches.push({ supplier: s, distance: dist });
        break;
      } else if (dist <= 2 && normalized.length >= 6) {
        fuzzyMatches.push({ supplier: s, distance: dist });
        break;
      }
    }
  }

  if (fuzzyMatches.length === 1) {
    return {
      status: "EXACT",
      supplier: {
        code: fuzzyMatches[0].supplier.code,
        name: fuzzyMatches[0].supplier.name,
      },
    };
  }
  if (fuzzyMatches.length > 1) {
    // Si hay varias con la misma distancia mínima
    const sorted = fuzzyMatches.sort((a, b) => a.distance - b.distance);
    if (sorted[0].distance < sorted[1].distance) {
      return {
        status: "EXACT",
        supplier: { code: sorted[0].supplier.code, name: sorted[0].supplier.name },
      };
    }
    return {
      status: "AMBIGUOUS",
      candidates: sorted.map((m) => ({
        code: m.supplier.code,
        name: m.supplier.name,
      })),
    };
  }

  return { status: "NOT_FOUND", query: rawInput };
}
