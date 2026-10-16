/**
 * Módulo de resolución y normalización de Presentaciones y Bultos comerciales
 * de La Casa del Kioskero.
 *
 * Determina si un producto se comercializa por Bulto (con su equivalencia en unidades),
 * por Unidad individual, o por otra unidad de medida real registrada en el sistema.
 */

export type ProductPresentation = {
  /** Tipo de presentación comercial ("Bulto", "Unidad", "Kg", "Litro", etc.) */
  presentation: string;
  /** Cantidad de unidades individuales que componen el bulto/paquete (null si es por unidad o no aplica) */
  packageUnits: number | null;
  /** Texto descriptivo legible para mostrar en listados y tablas (ej: "Bulto (18 u.)", "Unidad") */
  displayText: string;
  /** Texto compacto para etiquetas/badges visuales (ej: "Bulto x18", "Unidad") */
  badgeText: string;
};

export function resolveProductPresentation(input?: {
  bulto?: string | number | null;
  unitMeasure?: string | null;
}): ProductPresentation {
  if (!input) {
    return {
      presentation: "No especificada",
      packageUnits: null,
      displayText: "-",
      badgeText: "-",
    };
  }

  // 1. Analizar el campo Bulto del catálogo real
  const bultoRaw = input.bulto;
  let bultoNum: number | null = null;

  if (typeof bultoRaw === "number" && Number.isFinite(bultoRaw) && bultoRaw > 0) {
    bultoNum = bultoRaw;
  } else if (typeof bultoRaw === "string" && bultoRaw.trim() !== "") {
    const parsed = Number(bultoRaw.trim());
    if (Number.isFinite(parsed) && parsed > 0) {
      bultoNum = parsed;
    }
  }

  // Si bulto es mayor a 1, el producto se comercializa en Bulto con su equivalencia en unidades
  if (bultoNum !== null && bultoNum > 1) {
    return {
      presentation: "Bulto",
      packageUnits: bultoNum,
      displayText: `Bulto (${bultoNum} u.)`,
      badgeText: `Bulto x${bultoNum}`,
    };
  }

  // Si bulto es exactamente 1, es una Unidad individual
  if (bultoNum === 1) {
    return {
      presentation: "Unidad",
      packageUnits: 1,
      displayText: "Unidad",
      badgeText: "Unidad",
    };
  }

  // 2. Si no hay bulto numérico válido, inspeccionar unidad de medida
  const uMed = (input.unitMeasure ?? "").trim().toUpperCase();

  if (uMed) {
    if (uMed === "1 UN" || uMed === "UN" || uMed === "UNIDAD" || uMed === "UNIDADES") {
      return {
        presentation: "Unidad",
        packageUnits: 1,
        displayText: "Unidad",
        badgeText: "Unidad",
      };
    }

    if (uMed.includes("KG") || uMed.includes("KILO")) {
      return {
        presentation: "Kg",
        packageUnits: null,
        displayText: "Kg",
        badgeText: "Kg",
      };
    }

    if (uMed.includes("LITRO") || uMed === "L" || uMed === "LT") {
      return {
        presentation: "Litro",
        packageUnits: null,
        displayText: "Litro",
        badgeText: "Litro",
      };
    }

    // Si tiene un formato como "20 UN", "12 UN", etc.
    const matchUnits = uMed.match(/^(\d+)\s*UN/);
    if (matchUnits) {
      const units = Number(matchUnits[1]);
      if (units > 1) {
        return {
          presentation: "Bulto",
          packageUnits: units,
          displayText: `Bulto (${units} u.)`,
          badgeText: `Bulto x${units}`,
        };
      }
      return {
        presentation: "Unidad",
        packageUnits: 1,
        displayText: "Unidad",
        badgeText: "Unidad",
      };
    }

    // Cualquier otra unidad de medida real registrada
    return {
      presentation: input.unitMeasure!.trim(),
      packageUnits: null,
      displayText: input.unitMeasure!.trim(),
      badgeText: input.unitMeasure!.trim(),
    };
  }

  // 3. Sin datos de presentación registrados
  return {
    presentation: "No especificada",
    packageUnits: null,
    displayText: "-",
    badgeText: "-",
  };
}
