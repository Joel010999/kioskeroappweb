import * as xlsx from "xlsx";
import { resolveRubroName, compareByRubroAndProduct, isSinRubro } from "@/server/catalog/rubros";
import { resolveProductPresentation } from "@/server/catalog/presentations";

export type ReplenishmentExportItem = {
  article_id: number;
  description: string | null;
  rubro?: string | null;
  classification_code?: string | null;
  stock_current: number;
  stock_depot: number | null;
  suggested_quantity: number | null;
  requested_quantity: number;
  supply_mode: string;
  supplier_code?: string | null;
  unit_measure?: string | null;
  package_units?: number | null;
  presentation?: string | null;
  presentation_display?: string | null;
  selected?: boolean;
};

export type RawReplenishmentItem = {
  article_id: number;
  description: string | null;
  rubro?: string | null;
  classification_code?: string | null;
  stock_current: number;
  stock_depot: number | null;
  suggested_quantity: number | null;
  requested_quantity: number;
  supply_mode: string;
  supplier_code?: string | null;
  unit_measure?: string | null;
  package_units?: number | null;
  presentation?: string | null;
  presentation_display?: string | null;
  selected?: boolean;
};

/**
 * Regla central de exportación a Excel de reposición semanal:
 * Un producto se exporta exclusivamente cuando se cumplen ambas condiciones:
 * 1. El producto está seleccionado mediante su checkbox (seleccionado === true).
 * 2. La cantidad solicitada es mayor que cero (cantidadSolicitada > 0).
 *
 * incluirEnExcel = seleccionado && cantidadSolicitada > 0
 */
export function isEligibleForReplenishmentExcel(params: {
  selected?: boolean;
  requestedQuantity: number;
}): boolean {
  return Boolean(params.selected) && params.requestedQuantity > 0;
}

export type CollectRubroExportItemsParams = {
  items: RawReplenishmentItem[];
  branchId: string;
  planningDate: string;
  targetRubro?: string | null;
  requestedMap?: Record<string, number>;
  selectedMap?: Record<string, boolean>;
};

export function collectRubroExportItems(
  params: CollectRubroExportItemsParams,
): ReplenishmentExportItem[] {
  const {
    items,
    branchId,
    planningDate,
    targetRubro,
    requestedMap = {},
    selectedMap = {},
  } = params;

  const seen = new Set<number>();
  const result: ReplenishmentExportItem[] = [];

  for (const item of items) {
    // 1. Deduplicate by article_id across multiple pages
    if (seen.has(item.article_id)) continue;
    seen.add(item.article_id);

    // 2. Supply mode eligibility: only DEPOT or UNDEFINED (exclude DIRECT_SUPPLIER)
    if (item.supply_mode === "DIRECT_SUPPLIER") continue;

    // 3. Rubro filter if specified
    const resolvedRubro = resolveRubroName(item.classification_code, item.rubro);
    if (targetRubro) {
      if (targetRubro === "__SIN_RUBRO__") {
        if (!isSinRubro(resolvedRubro)) continue;
      } else {
        if (resolvedRubro.trim().toLowerCase() !== targetRubro.trim().toLowerCase()) {
          continue;
        }
      }
    }

    // 4. Requested quantity (respecting manual edits)
    const key = `${branchId}:${planningDate}:${item.article_id}`;
    const reqVal =
      requestedMap[key] !== undefined
        ? requestedMap[key]
        : item.requested_quantity;

    // 5. Selección de producto:
    // Si se indicó explícitamente en selectedMap, se respeta ese valor booleano.
    // Si no fue interactuado aún (por ejemplo artículos en páginas posteriores),
    // el valor por defecto sigue el estado del checkbox de reposición: seleccionado si reqVal > 0.
    const isSelected =
      selectedMap[key] !== undefined ? Boolean(selectedMap[key]) : reqVal > 0;

    // 6. Regla obligatoria: incluirEnExcel = seleccionado && cantidadSolicitada > 0
    if (
      !isEligibleForReplenishmentExcel({
        selected: isSelected,
        requestedQuantity: reqVal,
      })
    ) {
      continue;
    }

    result.push({
      article_id: item.article_id,
      description: item.description,
      rubro: resolvedRubro,
      classification_code: item.classification_code,
      stock_current: item.stock_current,
      stock_depot: item.stock_depot,
      suggested_quantity: item.suggested_quantity,
      requested_quantity: reqVal,
      supply_mode: item.supply_mode,
      supplier_code: item.supplier_code,
      unit_measure: item.unit_measure,
      package_units: item.package_units,
      presentation: item.presentation,
      presentation_display: item.presentation_display,
      selected: isSelected,
    });
  }

  return result;
}

export type OrderExportItem = {
  id: number;
  article_id: number;
  product_name_snapshot: string;
  classification_code_snapshot?: string | null;
  rubro?: string | null;
  supplier_code_snapshot?: string | null;
  package_units?: number | null;
  presentation?: string | null;
  presentation_display?: string | null;
  stock_current?: number | null;
  stock_at_creation?: number | null;
  stock_depot?: number | null;
  requested_quantity: number;
  approved_quantity: number | null;
  prepared_quantity: number | null;
  dispatched_quantity: number | null;
  received_quantity: number | null;
  unit_measure_snapshot?: string | null;
};

export function resolveBranchStockHeader(branchLabel?: string): string {
  if (!branchLabel) return "Stock Central";
  const cleaned = branchLabel.replace(/\s*\(.*?\)\s*/g, "").trim();
  const lower = cleaned.toLowerCase();
  if (lower === "centro" || lower === "central" || lower.includes("centro") || lower.includes("central")) {
    return "Stock Central";
  }
  if (lower === "jardín" || lower === "jardin" || lower.includes("jardín") || lower.includes("jardin")) {
    return "Stock Jardín";
  }
  if (lower) {
    return `Stock ${cleaned}`;
  }
  return "Stock Central";
}

export function buildReplenishmentWorkbook(params: {
  items: ReplenishmentExportItem[];
  branchLabel: string;
  planningDate: string;
  title?: string;
}): xlsx.WorkBook {
  const { items, branchLabel, planningDate, title = "Reposición Semanal" } = params;

  // Filtrar exclusivamente los productos que cumplen la regla:
  // incluirEnExcel = seleccionado && cantidadSolicitada > 0
  const eligibleItems = items.filter((item) =>
    isEligibleForReplenishmentExcel({
      selected: item.selected !== false,
      requestedQuantity: item.requested_quantity ?? 0,
    }),
  );

  // Ordenar items por Rubro (A a Z, "Sin rubro" al final) y luego por Producto (A a Z)
  const sortedItems = [...eligibleItems].sort((a, b) =>
    compareByRubroAndProduct(
      {
        rubro: resolveRubroName(a.classification_code, a.rubro),
        description: a.description,
        article_id: a.article_id,
      },
      {
        rubro: resolveRubroName(b.classification_code, b.rubro),
        description: b.description,
        article_id: b.article_id,
      },
    ),
  );

  const aoa: any[][] = [];

  // Metadata headers
  aoa.push([`LA CASA DEL KIOSKERO - ${title.toUpperCase()}`]);
  aoa.push([
    `Punto de Venta: ${branchLabel}`,
    `Planificación: ${planningDate}`,
    `Generado: ${new Date().toLocaleDateString("es-AR")}`,
  ]);
  aoa.push([]); // blank line

  const branchStockHeader = resolveBranchStockHeader(branchLabel);

  // Column table headers
  aoa.push([
    "Código",
    "Descripción",
    "Rubro",
    "Proveedor",
    "Presentación",
    branchStockHeader,
    "Stock Depósito",
    "Sugerida",
    "Solicitada",
  ]);

  let totalSugerida = 0;
  let totalSolicitada = 0;

  for (const item of sortedItems) {
    const sug = item.suggested_quantity ?? 0;
    const req = item.requested_quantity ?? 0;
    totalSugerida += sug;
    totalSolicitada += req;

    const pres =
      item.presentation && item.presentation_display
        ? {
            presentation: item.presentation,
            displayText: item.presentation_display,
            packageUnits: item.package_units ?? null,
          }
        : resolveProductPresentation({
            bulto: item.package_units,
            unitMeasure: item.unit_measure,
          });

    aoa.push([
      item.article_id,
      item.description || `Artículo ${item.article_id}`,
      resolveRubroName(item.classification_code, item.rubro),
      item.supplier_code || "-",
      pres.displayText,
      item.stock_current,
      item.stock_depot !== null ? item.stock_depot : "-",
      sug,
      req,
    ]);
  }

  // Summary row
  aoa.push([]);
  aoa.push([
    "TOTALES",
    `${sortedItems.length} productos`,
    null,
    null,
    null,
    null,
    null,
    totalSugerida,
    totalSolicitada,
  ]);

  const ws = xlsx.utils.aoa_to_sheet(aoa);
  ws["!cols"] = [
    { wch: 10 }, // Código
    { wch: 42 }, // Descripción
    { wch: 22 }, // Rubro
    { wch: 14 }, // Proveedor
    { wch: 18 }, // Presentación
    { wch: 16 }, // Stock Central (o sucursal)
    { wch: 16 }, // Stock Depósito
    { wch: 12 }, // Sugerida
    { wch: 12 }, // Solicitada
  ];

  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, ws, "Reposición");
  return wb;
}

export function generateReplenishmentExcelBuffer(params: {
  items: ReplenishmentExportItem[];
  branchLabel: string;
  planningDate: string;
  title?: string;
}): Buffer {
  const wb = buildReplenishmentWorkbook(params);
  return xlsx.write(wb, { type: "buffer", bookType: "xlsx" });
}

export function downloadReplenishmentExcel(params: {
  items: ReplenishmentExportItem[];
  branchLabel: string;
  planningDate: string;
  filename?: string;
  title?: string;
}) {
  const wb = buildReplenishmentWorkbook(params);
  const defaultFilename = `REPOSICION_${params.branchLabel.replace(/\s+/g, "_")}_${params.planningDate}.xlsx`;
  const name = params.filename || defaultFilename;
  xlsx.writeFile(wb, name);
}

export function buildOrderWorkbook(params: {
  orderId: number;
  status: string;
  branchLabel: string;
  planningDate?: string | null;
  items: OrderExportItem[];
}): xlsx.WorkBook {
  const { orderId, status, branchLabel, planningDate, items } = params;

  // Ordenar items por Rubro (A a Z, "Sin rubro" al final) y luego por Producto (A a Z)
  const sortedItems = [...items].sort((a, b) =>
    compareByRubroAndProduct(
      {
        rubro: a.rubro ?? resolveRubroName(a.classification_code_snapshot),
        description: a.product_name_snapshot,
        article_id: a.article_id,
      },
      {
        rubro: b.rubro ?? resolveRubroName(b.classification_code_snapshot),
        description: b.product_name_snapshot,
        article_id: b.article_id,
      },
    ),
  );

  const aoa: any[][] = [];

  aoa.push([`LA CASA DEL KIOSKERO - SOLICITUD DE PEDIDO #${orderId}`]);
  aoa.push([
    `Punto de Venta: ${branchLabel}`,
    `Estado: ${status}`,
    `Planificación: ${planningDate || "-"}`,
    `Generado: ${new Date().toLocaleDateString("es-AR")}`,
  ]);
  aoa.push([]);

  const branchStockHeader = resolveBranchStockHeader(branchLabel);

  aoa.push([
    "Código",
    "Descripción",
    "Rubro",
    "Proveedor",
    "Presentación",
    "Bulto (Equiv.)",
    branchStockHeader,
    "Stock Depósito",
    "Solicitado",
    "Aprobado",
    "Preparado",
    "Despachado",
    "Recibido",
    "Unidad",
  ]);

  let totalSolicitado = 0;
  let totalAprobado = 0;
  let totalPreparado = 0;
  let totalDespachado = 0;
  let totalRecibido = 0;

  for (const item of sortedItems) {
    totalSolicitado += item.requested_quantity;
    totalAprobado += item.approved_quantity ?? 0;
    totalPreparado += item.prepared_quantity ?? 0;
    totalDespachado += item.dispatched_quantity ?? 0;
    totalRecibido += item.received_quantity ?? 0;

    const pres =
      item.presentation && item.presentation_display
        ? {
            presentation: item.presentation,
            displayText: item.presentation_display,
            packageUnits: item.package_units ?? null,
          }
        : resolveProductPresentation({
            bulto: item.package_units,
            unitMeasure: item.unit_measure_snapshot,
          });

    const equivText =
      pres.packageUnits && pres.packageUnits > 1 ? `${pres.packageUnits} u.` : "-";

    const branchStock =
      item.stock_current !== undefined && item.stock_current !== null
        ? item.stock_current
        : item.stock_at_creation !== undefined && item.stock_at_creation !== null
          ? item.stock_at_creation
          : null;

    aoa.push([
      item.article_id,
      item.product_name_snapshot,
      item.rubro ?? resolveRubroName(item.classification_code_snapshot),
      item.supplier_code_snapshot || "-",
      pres.displayText,
      equivText,
      branchStock !== null ? branchStock : "-",
      item.stock_depot !== undefined && item.stock_depot !== null ? item.stock_depot : "-",
      item.requested_quantity,
      item.approved_quantity !== null ? item.approved_quantity : "-",
      item.prepared_quantity !== null ? item.prepared_quantity : "-",
      item.dispatched_quantity !== null ? item.dispatched_quantity : "-",
      item.received_quantity !== null ? item.received_quantity : "-",
      item.unit_measure_snapshot || "UN",
    ]);
  }

  aoa.push([]);
  aoa.push([
    "TOTALES",
    `${sortedItems.length} productos`,
    null,
    null,
    null,
    null,
    null,
    null,
    totalSolicitado,
    totalAprobado,
    totalPreparado,
    totalDespachado,
    totalRecibido,
    null,
  ]);

  const ws = xlsx.utils.aoa_to_sheet(aoa);
  ws["!cols"] = [
    { wch: 10 }, // Código
    { wch: 42 }, // Descripción
    { wch: 22 }, // Rubro
    { wch: 14 }, // Proveedor
    { wch: 18 }, // Presentación
    { wch: 14 }, // Bulto (Equiv.)
    { wch: 16 }, // Stock Central (o sucursal)
    { wch: 16 }, // Stock Depósito
    { wch: 12 }, // Solicitado
    { wch: 12 }, // Aprobado
    { wch: 12 }, // Preparado
    { wch: 12 }, // Despachado
    { wch: 12 }, // Recibido
    { wch: 10 }, // Unidad
  ];

  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, ws, `Pedido_${orderId}`);
  return wb;
}

export function generateOrderExcelBuffer(params: {
  orderId: number;
  status: string;
  branchLabel: string;
  planningDate?: string | null;
  items: OrderExportItem[];
}): Buffer {
  const wb = buildOrderWorkbook(params);
  return xlsx.write(wb, { type: "buffer", bookType: "xlsx" });
}

export function downloadOrderExcel(params: {
  orderId: number;
  status: string;
  branchLabel: string;
  planningDate?: string | null;
  items: OrderExportItem[];
  filename?: string;
}) {
  const wb = buildOrderWorkbook(params);
  const defaultFilename = `PEDIDO_#${params.orderId}_${params.branchLabel.replace(/\s+/g, "_")}.xlsx`;
  const name = params.filename || defaultFilename;
  xlsx.writeFile(wb, name);
}
