import * as xlsx from "xlsx";

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
};

export type OrderExportItem = {
  id: number;
  article_id: number;
  product_name_snapshot: string;
  classification_code_snapshot?: string | null;
  requested_quantity: number;
  approved_quantity: number | null;
  prepared_quantity: number | null;
  dispatched_quantity: number | null;
  received_quantity: number | null;
  unit_measure_snapshot?: string | null;
};

export function buildReplenishmentWorkbook(params: {
  items: ReplenishmentExportItem[];
  branchLabel: string;
  planningDate: string;
  title?: string;
}): xlsx.WorkBook {
  const { items, branchLabel, planningDate, title = "Reposición Semanal" } = params;

  const aoa: any[][] = [];

  // Metadata headers
  aoa.push([`LA CASA DEL KIOSKERO - ${title.toUpperCase()}`]);
  aoa.push([`Punto de Venta: ${branchLabel}`, `Planificación: ${planningDate}`, `Generado: ${new Date().toLocaleDateString("es-AR")}`]);
  aoa.push([]); // blank line

  // Column table headers
  aoa.push([
    "Código",
    "Descripción",
    "Rubro",
    "Stock Sucursal",
    "Stock Depósito",
    "Sugerida",
    "Solicitada",
    "Abastecimiento",
    "Proveedor",
    "Unidad",
  ]);

  let totalSugerida = 0;
  let totalSolicitada = 0;

  for (const item of items) {
    const sug = item.suggested_quantity ?? 0;
    const req = item.requested_quantity ?? 0;
    totalSugerida += sug;
    totalSolicitada += req;

    aoa.push([
      item.article_id,
      item.description || `Artículo ${item.article_id}`,
      item.rubro || item.classification_code || "Sin rubro",
      item.stock_current,
      item.stock_depot !== null ? item.stock_depot : "-",
      sug,
      req,
      item.supply_mode === "DEPOT" ? "DEPÓSITO" : item.supply_mode === "DIRECT_SUPPLIER" ? "PROV. DIRECTO" : "SIN DEFINIR",
      item.supplier_code || "-",
      item.unit_measure || "UN",
    ]);
  }

  // Summary row
  aoa.push([]);
  aoa.push([
    "TOTALES",
    `${items.length} productos`,
    null,
    null,
    null,
    totalSugerida,
    totalSolicitada,
    null,
    null,
    null,
  ]);

  const ws = xlsx.utils.aoa_to_sheet(aoa);
  ws["!cols"] = [
    { wch: 10 }, // Código
    { wch: 42 }, // Descripción
    { wch: 22 }, // Rubro
    { wch: 14 }, // Stock Sucursal
    { wch: 14 }, // Stock Depósito
    { wch: 12 }, // Sugerida
    { wch: 12 }, // Solicitada
    { wch: 16 }, // Abastecimiento
    { wch: 14 }, // Proveedor
    { wch: 10 }, // Unidad
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

  const aoa: any[][] = [];

  aoa.push([`LA CASA DEL KIOSKERO - SOLICITUD DE PEDIDO #${orderId}`]);
  aoa.push([
    `Punto de Venta: ${branchLabel}`,
    `Estado: ${status}`,
    `Planificación: ${planningDate || "-"}`,
    `Generado: ${new Date().toLocaleDateString("es-AR")}`,
  ]);
  aoa.push([]);

  aoa.push([
    "Código",
    "Descripción",
    "Rubro",
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

  for (const item of items) {
    totalSolicitado += item.requested_quantity;
    totalAprobado += item.approved_quantity ?? 0;
    totalPreparado += item.prepared_quantity ?? 0;
    totalDespachado += item.dispatched_quantity ?? 0;
    totalRecibido += item.received_quantity ?? 0;

    aoa.push([
      item.article_id,
      item.product_name_snapshot,
      item.classification_code_snapshot || "Sin rubro",
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
    `${items.length} productos`,
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
    { wch: 10 },
    { wch: 42 },
    { wch: 22 },
    { wch: 12 },
    { wch: 12 },
    { wch: 12 },
    { wch: 12 },
    { wch: 12 },
    { wch: 10 },
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
