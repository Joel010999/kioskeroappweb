/**
 * Catálogo Canónico de Rubros comerciales de La Casa del Kioskero.
 * Mapea los códigos internos de Clasificación del sistema POS/ERP a los rubros reales
 * utilizados por la dueña (Mónica) en las planillas de depósito y pedidos.
 */

export const CANONICAL_RUBROS = [
  "ALMACEN",
  "BEBIDAS",
  "CARAMELOS",
  "CIGARRILLOS",
  "COPETIN",
  "CHOCOLATES",
  "DESCARTABLES",
  "ENCENDIDOS",
  "GALLETITAS",
  "INSECTICIDA",
  "LIMPIEZA",
  "NAIPES",
  "NAVIDEÑOS",
  "PEGAMENTOS",
  "PERFUMERIA",
  "PILAS",
  "TABACO Y AFINES",
  "VARIOS",
] as const;

export type CanonicalRubro = (typeof CANONICAL_RUBROS)[number];

/**
 * Mapeo por prefijo (3 dígitos) de clasificación a rubro canónico.
 */
const PREFIX_MAP: Record<string, CanonicalRubro> = {
  "001": "CIGARRILLOS",
  "004": "PILAS",
  "005": "COPETIN",
  "006": "CHOCOLATES",
  "007": "PILAS",
  "009": "GALLETITAS",
  "011": "ALMACEN",
  "013": "CARAMELOS",
  "014": "BEBIDAS",
  "015": "PERFUMERIA",
  "016": "INSECTICIDA",
  "017": "VARIOS",
  "018": "LIMPIEZA",
  "019": "PEGAMENTOS",
  "020": "BEBIDAS",
  "021": "ALMACEN",
  "022": "TABACO Y AFINES",
  "023": "PILAS",
  "024": "VARIOS",
  "026": "TABACO Y AFINES",
  "027": "DESCARTABLES",
  "028": "CHOCOLATES",
  "029": "NAVIDEÑOS",
  "031": "NAIPES",
  "032": "VARIOS",
  "034": "ENCENDIDOS",
  "035": "NAVIDEÑOS",
  "036": "ALMACEN",
  "039": "VARIOS",
  "040": "DESCARTABLES",
  "041": "PERFUMERIA",
  "042": "DESCARTABLES",
  "043": "CIGARRILLOS",
  "044": "VARIOS",
};

/**
 * Mapeos específicos por código completo si difieren del prefijo.
 */
const EXACT_CODE_MAP: Record<string, CanonicalRubro> = {
  "0014343": "CIGARRILLOS",
  "0010133": "CIGARRILLOS",
  "0010113": "CIGARRILLOS",
  "0014342": "CIGARRILLOS",
};

/**
 * Resuelve el nombre descriptivo de un rubro a partir de su código de clasificación
 * o un valor crudo preexistente.
 */
export function resolveRubroName(
  classificationCode?: string | null,
  rawRubro?: string | null,
): string {
  // Si rawRubro ya es un nombre descriptivo en texto (no numérico), preservarlo
  if (rawRubro && typeof rawRubro === "string") {
    const trimmed = rawRubro.trim();
    if (trimmed && isNaN(Number(trimmed))) {
      return trimmed.toUpperCase();
    }
  }

  if (!classificationCode) {
    if (rawRubro && typeof rawRubro === "string" && rawRubro.trim()) {
      return rawRubro.trim();
    }
    return "Sin rubro";
  }

  const code = classificationCode.trim();
  const digitsOnly = code.replace(/\s+/g, "");
  // Si classificationCode ya es una etiqueta de texto descriptiva (ej. "CARAMELOS", "GOLOSINAS")
  if (isNaN(Number(digitsOnly))) {
    if (code.toLowerCase() === "sin rubro") return "Sin rubro";
    return code.toUpperCase();
  }

  if (EXACT_CODE_MAP[digitsOnly]) {
    return EXACT_CODE_MAP[digitsOnly];
  }

  const prefix = digitsOnly.slice(0, 3);
  if (PREFIX_MAP[prefix]) {
    return PREFIX_MAP[prefix];
  }

  // Si tiene un código numérico desconocido pero no vacío, clasificar en VARIOS
  if (digitsOnly.length > 0) {
    return "VARIOS";
  }

  return "Sin rubro";
}

/**
 * Fragmento SQL que resuelve el rubro descriptivo en las consultas Postgres.
 */
export const SQL_RUBRO_EXPRESSION = `
CASE
  WHEN p.payload->>'Rubro' IS NOT NULL AND btrim(p.payload->>'Rubro') <> '' AND UPPER(btrim(p.payload->>'Rubro')) IN ('ALMACEN', 'BEBIDAS', 'CARAMELOS', 'CIGARRILLOS', 'COPETIN', 'CHOCOLATES', 'DESCARTABLES', 'ENCENDIDOS', 'GALLETITAS', 'INSECTICIDA', 'LIMPIEZA', 'NAIPES', 'NAVIDEÑOS', 'PEGAMENTOS', 'PERFUMERIA', 'PILAS', 'TABACO Y AFINES', 'VARIOS')
    THEN UPPER(btrim(p.payload->>'Rubro'))
  WHEN p.payload->>'Clasificacion' LIKE '001%' OR p.payload->>'Clasificacion' LIKE '043%' THEN 'CIGARRILLOS'
  WHEN p.payload->>'Clasificacion' LIKE '004%' OR p.payload->>'Clasificacion' LIKE '007%' OR p.payload->>'Clasificacion' LIKE '023%' THEN 'PILAS'
  WHEN p.payload->>'Clasificacion' LIKE '005%' THEN 'COPETIN'
  WHEN p.payload->>'Clasificacion' LIKE '006%' OR p.payload->>'Clasificacion' LIKE '028%' THEN 'CHOCOLATES'
  WHEN p.payload->>'Clasificacion' LIKE '009%' THEN 'GALLETITAS'
  WHEN p.payload->>'Clasificacion' LIKE '011%' OR p.payload->>'Clasificacion' LIKE '021%' OR p.payload->>'Clasificacion' LIKE '036%' THEN 'ALMACEN'
  WHEN p.payload->>'Clasificacion' LIKE '013%' THEN 'CARAMELOS'
  WHEN p.payload->>'Clasificacion' LIKE '014%' OR p.payload->>'Clasificacion' LIKE '020%' THEN 'BEBIDAS'
  WHEN p.payload->>'Clasificacion' LIKE '015%' OR p.payload->>'Clasificacion' LIKE '041%' THEN 'PERFUMERIA'
  WHEN p.payload->>'Clasificacion' LIKE '016%' THEN 'INSECTICIDA'
  WHEN p.payload->>'Clasificacion' LIKE '018%' THEN 'LIMPIEZA'
  WHEN p.payload->>'Clasificacion' LIKE '019%' THEN 'PEGAMENTOS'
  WHEN p.payload->>'Clasificacion' LIKE '022%' OR p.payload->>'Clasificacion' LIKE '026%' THEN 'TABACO Y AFINES'
  WHEN p.payload->>'Clasificacion' LIKE '027%' OR p.payload->>'Clasificacion' LIKE '040%' OR p.payload->>'Clasificacion' LIKE '042%' THEN 'DESCARTABLES'
  WHEN p.payload->>'Clasificacion' LIKE '029%' OR p.payload->>'Clasificacion' LIKE '035%' THEN 'NAVIDEÑOS'
  WHEN p.payload->>'Clasificacion' LIKE '031%' THEN 'NAIPES'
  WHEN p.payload->>'Clasificacion' LIKE '034%' THEN 'ENCENDIDOS'
  WHEN p.payload->>'Clasificacion' IS NOT NULL AND btrim(p.payload->>'Clasificacion') <> '' THEN 'VARIOS'
  ELSE 'SIN RUBRO'
END
`.trim();
