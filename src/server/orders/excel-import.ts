import * as xlsx from "xlsx";
import crypto from "node:crypto";
import { query, withTransaction } from "@/server/db/client";
import type { Scope } from "@/server/analytics/types";
import { RequestValidationError } from "@/server/validation/request";
import { resolveRubroName } from "@/server/catalog/rubros";
import { resolveProductPresentation } from "@/server/catalog/presentations";
import { DEPOT_BRANCH_ID } from "@/server/analytics/weekly-replenishment";

export type ParsedExcelRow = {
  rowNumber: number;
  rawCode: string | null;
  rawDescription: string | null;
  rawQuantity: string | number | null;
  parsedQuantity: number | null;
  articleId: number | null;
  isCategoryHeader?: boolean;
  error?: string;
};

export type ValidatedImportItem = {
  rowNumber: number;
  articleId: number;
  detectedCode: string | null;
  detectedDescription: string | null;
  catalogDescription: string;
  rubro: string;
  supplierCode: string | null;
  presentationDisplay: string | null;
  requestedQuantity: number;
  stockCurrent: number;
  stockDepot: number | null;
  supplyMode: string;
  status:
    | "VALID"
    | "WARNING_MATCHED_BY_NAME"
    | "WARNING_DUPLICATE"
    | "WARNING_DIRECT_SUPPLIER"
    | "ERROR_NOT_FOUND"
    | "ERROR_INVALID_QTY"
    | "ERROR_AMBIGUOUS";
  message?: string;
  isExcluded?: boolean;
};

export type ImportPreviewResult = {
  success: boolean;
  filename: string;
  fileHash: string;
  sheetName: string;
  columnsDetected: {
    codeColumn: string | null;
    descriptionColumn: string | null;
    quantityColumn: string | null;
  };
  summary: {
    totalRows: number;
    validRows: number;
    warningRows: number;
    errorRows: number;
    totalUnits: number;
  };
  items: ValidatedImportItem[];
  unmatchedRows: Array<{
    rowNumber: number;
    rawCode: string | null;
    rawDescription: string | null;
    rawQuantity: string | number | null;
    error: string;
  }>;
};

/**
 * Normaliza cantidades numéricas a partir de strings como "12 UNID", "24 u", "5.5", "10,5" o números.
 */
export function parseQuantityValue(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    // Extraer prefijo numérico (permitiendo coma o punto decimal)
    // Ejemplo: "12 UNID" -> "12", "24.5 u" -> "24.5", "10,5 UNIDADES" -> "10.5"
    const match = trimmed.match(/^([+-]?\d+(?:[.,]\d+)?)/);
    if (match) {
      const numStr = match[1].replace(",", ".");
      const parsed = parseFloat(numStr);
      return !isNaN(parsed) && parsed > 0 ? parsed : null;
    }
  }
  return null;
}

/**
 * Detecta si una fila corresponde a un encabezado separador de categoría/rubro (ej. ['ALMACEN'], ['CHOCOLATES']).
 */
export function isCategorySeparatorRow(row: any[]): boolean {
  if (!row || row.length === 0) return false;
  const nonEmpties = row.filter((c) => c !== null && c !== undefined && String(c).trim() !== "");
  if (nonEmpties.length === 1 && typeof nonEmpties[0] === "string") {
    const text = nonEmpties[0].trim().toUpperCase();
    // Si contiene sólo letras y espacios y no es numérico
    if (isNaN(Number(text)) && text.length > 2 && text.length < 35) {
      return true;
    }
  }
  return false;
}

/**
 * Lee y analiza un archivo Excel o CSV para pedidos.
 */
export function parseOrderExcel(buffer: Buffer, filename: string): {
  sheetName: string;
  columnsDetected: {
    codeColumn: string | null;
    descriptionColumn: string | null;
    quantityColumn: string | null;
  };
  rows: ParsedExcelRow[];
  fileHash: string;
} {
  // Limitar tamaño máximo: 10 MB
  if (buffer.length > 10 * 1024 * 1024) {
    throw new RequestValidationError("El archivo excede el tamaño máximo permitido de 10 MB.");
  }

  const ext = filename.split(".").pop()?.toLowerCase();
  if (ext === "xlsx" || ext === "xls") {
    const isZip = buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4B;
    const isCfb = buffer.length >= 8 && buffer[0] === 0xD0 && buffer[1] === 0xCF && buffer[2] === 0x11 && buffer[3] === 0xE0;
    if (ext === "xlsx" && !isZip) {
      throw new RequestValidationError("El archivo .xlsx no tiene un formato válido o está dañado.");
    }
    if (ext === "xls" && !isCfb && !isZip) {
      throw new RequestValidationError("El archivo .xls no tiene un formato binario válido o está dañado.");
    }
  }

  const fileHash = crypto.createHash("sha256").update(buffer).digest("hex");

  let wb: xlsx.WorkBook;
  try {
    wb = xlsx.read(buffer, {
      type: "buffer",
      cellFormula: false,
      cellHTML: false,
    });
  } catch (err: any) {
    throw new RequestValidationError(`No se pudo leer el archivo Excel: ${err?.message || "formato inválido"}`);
  }

  if (!wb.SheetNames || wb.SheetNames.length === 0) {
    throw new RequestValidationError("El archivo Excel no contiene hojas de cálculo.");
  }

  // Buscar la primera hoja que contenga datos
  let activeSheetName = wb.SheetNames[0];
  let ws = wb.Sheets[activeSheetName];
  let rawAoa = xlsx.utils.sheet_to_json<any[]>(ws, { header: 1 });

  for (const sheet of wb.SheetNames) {
    const candidateWs = wb.Sheets[sheet];
    const candidateData = xlsx.utils.sheet_to_json<any[]>(candidateWs, { header: 1 });
    if (candidateData.length > rawAoa.length) {
      activeSheetName = sheet;
      ws = candidateWs;
      rawAoa = candidateData;
    }
  }

  if (!rawAoa || rawAoa.length === 0) {
    throw new RequestValidationError("La hoja de cálculo está vacía.");
  }

  // Limitar filas para evitar sobrecarga (máx. 5000 filas de datos)
  if (rawAoa.length > 5000) {
    throw new RequestValidationError("El archivo contiene más de 5000 filas. Por favor dividí el archivo para importar.");
  }

  // Detección de encabezados de columnas
  let headerRowIndex = -1;
  let codeCol = -1;
  let descCol = -1;
  let qtyCol = -1;

  const codePatterns = [/^(?:art[ií]culo|art|c[oó]d(?:igo)?|cod_articulo|id|item|sku)$/i];
  const descPatterns = [/^(?:descri(?:pci[oó]n)?|producto|nombre|detalle|articulo)$/i];
  const qtyPatterns = [/^(?:pedido|cantidad|solicitada|cant|cant\.|unidades|a pedir|cant_pedida|ped)$/i];

  for (let r = 0; r < Math.min(rawAoa.length, 10); r++) {
    const row = rawAoa[r];
    if (!row || !Array.isArray(row)) continue;

    let cCandidate = -1;
    let dCandidate = -1;
    let qCandidate = -1;

    for (let c = 0; c < row.length; c++) {
      const cellVal = row[c] ? String(row[c]).trim().toLowerCase() : "";
      if (!cellVal) continue;

      if (codePatterns.some((p) => p.test(cellVal))) {
        cCandidate = c;
      } else if (descPatterns.some((p) => p.test(cellVal))) {
        dCandidate = c;
      } else if (qtyPatterns.some((p) => p.test(cellVal))) {
        qCandidate = c;
      }
    }

    // Si encontramos al menos 2 columnas reconocibles o la columna de cantidad y otra
    if ((cCandidate !== -1 && qCandidate !== -1) || (cCandidate !== -1 && dCandidate !== -1) || (dCandidate !== -1 && qCandidate !== -1)) {
      headerRowIndex = r;
      codeCol = cCandidate;
      descCol = dCandidate;
      qtyCol = qCandidate;
      break;
    }
  }

  // Si no se reconoció una fila de encabezados por texto, inferir por la estructura común de Kioskero
  // (Formato PEDIDO CENTRO: Col 0: articulo, Col 1: descri, Col 3: stock, Col 4: PEDIDO)
  if (headerRowIndex === -1) {
    // Si la primera fila tiene datos, revisar si la primera celda es encabezado o dato
    const firstRow = rawAoa[0] || [];
    if (firstRow.length >= 3) {
      codeCol = 0;
      descCol = 1;
      qtyCol = firstRow.length >= 5 ? 4 : firstRow.length - 1;
      headerRowIndex = 0;
    } else if (firstRow.length === 2) {
      codeCol = 0;
      qtyCol = 1;
      headerRowIndex = 0;
    }
  }

  // Fallback si descCol y codeCol coinciden o alguno falta
  if (codeCol === -1 && descCol !== -1) codeCol = 0;
  if (qtyCol === -1) {
    // Buscar la última columna numérica
    const sampleRow = rawAoa.find((r, i) => i > headerRowIndex && r && r.length > 1);
    if (sampleRow) {
      qtyCol = sampleRow.length - 1;
    } else {
      qtyCol = 2;
    }
  }

  const columnsDetected = {
    codeColumn: codeCol !== -1 && rawAoa[headerRowIndex]?.[codeCol] ? String(rawAoa[headerRowIndex][codeCol]) : "Código",
    descriptionColumn: descCol !== -1 && rawAoa[headerRowIndex]?.[descCol] ? String(rawAoa[headerRowIndex][descCol]) : "Descripción",
    quantityColumn: qtyCol !== -1 && rawAoa[headerRowIndex]?.[qtyCol] ? String(rawAoa[headerRowIndex][qtyCol]) : "Cantidad",
  };

  const parsedRows: ParsedExcelRow[] = [];

  for (let i = headerRowIndex + 1; i < rawAoa.length; i++) {
    const row = rawAoa[i];
    if (!row || !Array.isArray(row) || row.length === 0) continue;

    // Verificar si es fila totalmente vacía
    const hasData = row.some((c) => c !== null && c !== undefined && String(c).trim() !== "");
    if (!hasData) continue;

    // Detectar fila separadora de categoría (ej. "ALMACEN")
    if (isCategorySeparatorRow(row)) {
      continue;
    }

    const rawCodeVal = codeCol !== -1 && row[codeCol] !== undefined ? row[codeCol] : null;
    const rawDescVal = descCol !== -1 && row[descCol] !== undefined ? row[descCol] : null;
    const rawQtyVal = qtyCol !== -1 && row[qtyCol] !== undefined ? row[qtyCol] : null;

    const rawCodeStr = rawCodeVal !== null && rawCodeVal !== undefined ? String(rawCodeVal).trim() : "";
    const rawDescStr = rawDescVal !== null && rawDescVal !== undefined ? String(rawDescVal).trim() : "";

    const numId = parseInt(rawCodeStr, 10);
    const articleId = !isNaN(numId) && numId > 0 ? numId : null;
    const parsedQty = parseQuantityValue(rawQtyVal);

    parsedRows.push({
      rowNumber: i + 1,
      rawCode: rawCodeStr || null,
      rawDescription: rawDescStr || null,
      rawQuantity: rawQtyVal,
      parsedQuantity: parsedQty,
      articleId,
      error: !articleId && !rawDescStr
        ? "Fila sin código ni descripción de producto"
        : parsedQty === null
        ? "Cantidad inválida o vacía"
        : undefined,
    });
  }

  return {
    sheetName: activeSheetName,
    columnsDetected,
    rows: parsedRows,
    fileHash,
  };
}

/**
 * Valida los productos extraídos del Excel contra el catálogo de la sucursal en PostgreSQL.
 */
export async function validateExcelAgainstCatalog(
  parsedRows: ParsedExcelRow[],
  scope: Scope,
): Promise<{
  summary: {
    totalRows: number;
    validRows: number;
    warningRows: number;
    errorRows: number;
    totalUnits: number;
  };
  items: ValidatedImportItem[];
  unmatchedRows: Array<{
    rowNumber: number;
    rawCode: string | null;
    rawDescription: string | null;
    rawQuantity: string | number | null;
    error: string;
  }>;
}> {
  // 1. Obtener catálogo completo de la sucursal y reglas de suministro
  const catalogQuery = await query<{
    article_id: number;
    description: string;
    classification_code: string | null;
    supplier_code: string | null;
    unit_measure: string | null;
    bulto: string | null;
    stock_current: string | null;
    depot_stock: string | null;
    supply_mode: string | null;
  }>(
    `SELECT p.article_id,
            btrim(p.payload->>'Descripcion') AS description,
            btrim(p.payload->>'Clasificacion') AS classification_code,
            btrim(p.payload->>'Proveedor') AS supplier_code,
            btrim(p.payload->>'UnidadMedida') AS unit_measure,
            btrim(p.payload->>'Bulto') AS bulto,
            COALESCE((SELECT SUM(sl.saldo) FROM stock_levels_raw sl WHERE sl.organization_id = p.organization_id AND sl.branch_id = p.branch_id AND sl.article_id = p.article_id), 0) AS stock_current,
            (SELECT SUM(sd.saldo) FROM stock_levels_raw sd WHERE sd.organization_id = p.organization_id AND sd.branch_id = ${DEPOT_BRANCH_ID} AND sd.article_id = p.article_id) AS depot_stock,
            COALESCE(sr.supply_mode, 'UNDEFINED') AS supply_mode
     FROM products_raw p
     LEFT JOIN branch_product_supply_rules sr ON sr.organization_id = p.organization_id AND sr.branch_id = p.branch_id AND sr.article_id = p.article_id
     WHERE p.organization_id = $1 AND p.branch_id = $2 AND p.is_present`,
    [scope.organizationId ?? 1, scope.branchId]
  );

  const byId = new Map<number, (typeof catalogQuery.rows)[0]>();
  const byCleanDesc = new Map<string, (typeof catalogQuery.rows)[0][]>();

  for (const prod of catalogQuery.rows) {
    byId.set(prod.article_id, prod);
    const cleanDesc = (prod.description || "").trim().toLowerCase();
    if (cleanDesc) {
      const list = byCleanDesc.get(cleanDesc) || [];
      list.push(prod);
      byCleanDesc.set(cleanDesc, list);
    }
  }

  const items: ValidatedImportItem[] = [];
  const unmatchedRows: Array<{
    rowNumber: number;
    rawCode: string | null;
    rawDescription: string | null;
    rawQuantity: string | number | null;
    error: string;
  }> = [];

  const seenArticleIds = new Set<number>();
  let totalUnits = 0;
  let validCount = 0;
  let warningCount = 0;
  let errorCount = 0;

  for (const row of parsedRows) {
    if (row.error && !row.articleId && !row.rawDescription) {
      errorCount++;
      unmatchedRows.push({
        rowNumber: row.rowNumber,
        rawCode: row.rawCode,
        rawDescription: row.rawDescription,
        rawQuantity: row.rawQuantity,
        error: row.error,
      });
      continue;
    }

    let matchedProd: (typeof catalogQuery.rows)[0] | undefined;
    let matchType: "ID" | "NAME" = "ID";
    let isAmbiguous = false;

    if (row.articleId && byId.has(row.articleId)) {
      matchedProd = byId.get(row.articleId);
      matchType = "ID";
    } else if (row.rawDescription) {
      const cleanDesc = row.rawDescription.trim().toLowerCase();
      const candidates = byCleanDesc.get(cleanDesc) || [];
      if (candidates.length === 1) {
        matchedProd = candidates[0];
        matchType = "NAME";
      } else if (candidates.length > 1) {
        isAmbiguous = true;
      }
    }

    if (!matchedProd) {
      errorCount++;
      const errMsg = isAmbiguous
        ? `Coincidencia ambigua: existen varios productos con el nombre "${row.rawDescription}"`
        : row.articleId
        ? `Producto con código ${row.articleId} no encontrado en el catálogo de la sucursal`
        : `Producto "${row.rawDescription}" no encontrado en el catálogo`;

      unmatchedRows.push({
        rowNumber: row.rowNumber,
        rawCode: row.rawCode,
        rawDescription: row.rawDescription,
        rawQuantity: row.rawQuantity,
        error: errMsg,
      });
      continue;
    }

    const qty = row.parsedQuantity;
    if (qty === null || qty <= 0) {
      errorCount++;
      unmatchedRows.push({
        rowNumber: row.rowNumber,
        rawCode: row.rawCode,
        rawDescription: row.rawDescription,
        rawQuantity: row.rawQuantity,
        error: "Cantidad inválida (debe ser mayor a 0)",
      });
      continue;
    }

    const isDuplicate = seenArticleIds.has(matchedProd.article_id);
    seenArticleIds.add(matchedProd.article_id);

    const pres = resolveProductPresentation({
      bulto: matchedProd.bulto,
      unitMeasure: matchedProd.unit_measure,
    });

    const rubro = resolveRubroName(matchedProd.classification_code);
    const stockCurrent = matchedProd.stock_current ? parseFloat(matchedProd.stock_current) : 0;
    const stockDepot = matchedProd.depot_stock !== null ? parseFloat(matchedProd.depot_stock) : null;

    let status: ValidatedImportItem["status"] = "VALID";
    let message: string | undefined;

    if (isDuplicate) {
      status = "WARNING_DUPLICATE";
      message = "Código duplicado en el archivo Excel";
      warningCount++;
    } else if (matchType === "NAME") {
      status = "WARNING_MATCHED_BY_NAME";
      message = `Asociado por coincidencia exacta de nombre: "${matchedProd.description}"`;
      warningCount++;
    } else if (matchedProd.supply_mode === "DIRECT_SUPPLIER") {
      status = "WARNING_DIRECT_SUPPLIER";
      message = "Suministrado habitualmente por PROVEEDOR DIRECTO";
      warningCount++;
    } else {
      validCount++;
    }

    if (isDuplicate && matchedProd.supply_mode === "DIRECT_SUPPLIER") {
      message = (message ? message + " · " : "") + "Suministrado habitualmente por PROVEEDOR DIRECTO";
    }

    totalUnits += qty;

    items.push({
      rowNumber: row.rowNumber,
      articleId: matchedProd.article_id,
      detectedCode: row.rawCode,
      detectedDescription: row.rawDescription,
      catalogDescription: matchedProd.description,
      rubro,
      supplierCode: matchedProd.supplier_code,
      presentationDisplay: pres.displayText,
      requestedQuantity: qty,
      stockCurrent,
      stockDepot,
      supplyMode: matchedProd.supply_mode || "UNDEFINED",
      status,
      message,
    });
  }

  return {
    summary: {
      totalRows: parsedRows.length,
      validRows: validCount + warningCount,
      warningRows: warningCount,
      errorRows: errorCount,
      totalUnits,
    },
    items,
    unmatchedRows,
  };
}

/**
 * Crea el pedido interno confirmado en PostgreSQL a partir de los artículos validados del Excel.
 */
export async function confirmOrderFromExcel(input: {
  scope: Scope;
  branchId: number;
  planningDate: string;
  items: Array<{ article_id: number; requested_quantity: number }>;
  notes?: string;
  fileHash?: string;
  idempotencyToken: string;
  actorId: string;
}): Promise<{
  id: number;
  order_number: number;
  total_units: number;
  items_count: number;
  created: boolean;
}> {
  const { scope, branchId, planningDate, items, notes, idempotencyToken, actorId } = input;

  const validItems = items.filter((i) => i.article_id > 0 && i.requested_quantity > 0);
  if (!validItems.length) {
    throw new RequestValidationError("Debe incluir al menos un producto con cantidad mayor a cero.");
  }

  return withTransaction(async (client) => {
    const idempotencyKey = `excel-import:${idempotencyToken}`;

    // 1. Verificar idempotencia para evitar duplicaciones
    const existingByIdempotency = await client.query<{ id: string; order_number?: string }>(
      `SELECT id, order_number FROM orders WHERE idempotency_key = $1`,
      [idempotencyKey]
    );

    if (existingByIdempotency.rows[0]) {
      const orderId = Number(existingByIdempotency.rows[0].id);
      const orderNumber = Number(existingByIdempotency.rows[0].order_number ?? orderId);
      return {
        id: orderId,
        order_number: orderNumber,
        total_units: 0,
        items_count: 0,
        created: false,
      };
    }

    // 2. Obtener datos del catálogo para los artículos solicitados
    const articleIds = validItems.map((i) => i.article_id);
    const catalogRes = await client.query<{
      article_id: number;
      description: string;
      classification_code: string | null;
      supplier_code: string | null;
      unit_measure: string | null;
      bulto: string | null;
      stock_current: string | null;
    }>(
      `SELECT p.article_id,
              btrim(p.payload->>'Descripcion') AS description,
              btrim(p.payload->>'Clasificacion') AS classification_code,
              btrim(p.payload->>'Proveedor') AS supplier_code,
              btrim(p.payload->>'UnidadMedida') AS unit_measure,
              btrim(p.payload->>'Bulto') AS bulto,
              COALESCE((SELECT SUM(sl.saldo) FROM stock_levels_raw sl WHERE sl.organization_id = p.organization_id AND sl.branch_id = p.branch_id AND sl.article_id = p.article_id), 0) AS stock_current
       FROM products_raw p
       WHERE p.organization_id = $1 AND p.branch_id = $2 AND p.is_present AND p.article_id = ANY($3::integer[])`,
      [scope.organizationId ?? 1, branchId, articleIds]
    );

    const catalogMap = new Map(catalogRes.rows.map((r) => [r.article_id, r]));

    // 3. Insertar orden con tipo INTERNAL_REPLENISHMENT y estado CONFIRMED
    const orderNotes = notes ? `Importado desde Excel: ${notes}` : "Pedido importado desde Excel";

    const insertOrderRes = await client.query<{ id: string; order_number?: string }>(
      `INSERT INTO orders (
        organization_id, source_id, branch_id, status, order_type,
        origin_branch_id, destination_branch_id, planning_date,
        idempotency_key, confirmed_at, notes, created_by, confirmed_by
      ) VALUES ($1, $2, $3, 'CONFIRMED', 'INTERNAL_REPLENISHMENT', $3, ${DEPOT_BRANCH_ID}, $4, $5, now(), $6, $7, $7)
      ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
      RETURNING id, order_number`,
      [
        scope.organizationId ?? 1,
        scope.sourceId,
        branchId,
        planningDate,
        idempotencyKey,
        orderNotes,
        actorId,
      ]
    );

    if (!insertOrderRes.rows[0]) {
      const won = await client.query<{ id: string; order_number?: string }>(
        `SELECT id, order_number FROM orders WHERE idempotency_key = $1`,
        [idempotencyKey]
      );
      const orderId = Number(won.rows[0].id);
      return {
        id: orderId,
        order_number: Number(won.rows[0].order_number ?? orderId),
        total_units: 0,
        items_count: 0,
        created: false,
      };
    }

    const orderId = Number(insertOrderRes.rows[0].id);
    const orderNumber = Number(insertOrderRes.rows[0].order_number ?? orderId);

    // 4. Registrar eventos de la orden
    await client.query(
      `INSERT INTO order_events (order_id, event_type, metadata, user_id)
       VALUES ($1, 'ORDER_CREATED', $2::jsonb, $4),
              ($1, 'ORDER_CONFIRMED', $3::jsonb, $4)`,
      [
        orderId,
        JSON.stringify({
          source: "EXCEL_IMPORT",
          order_type: "INTERNAL_REPLENISHMENT",
          planning_date: planningDate,
          items_count: validItems.length,
        }),
        JSON.stringify({
          origin_branch_id: branchId,
          destination_branch_id: DEPOT_BRANCH_ID,
          confirmed_via: "EXCEL_IMPORT",
        }),
        actorId,
      ]
    );

    // 5. Insertar cada ítem del pedido en order_items
    let totalUnits = 0;
    for (const item of validItems) {
      const meta = catalogMap.get(item.article_id);
      const description = meta?.description ?? `Artículo ${item.article_id}`;
      const stockCurrent = meta?.stock_current ? parseFloat(meta.stock_current) : 0;
      totalUnits += item.requested_quantity;

      await client.query(
        `INSERT INTO order_items (
          order_id, article_id, product_name_snapshot, suggested_quantity,
          requested_quantity, stock_at_creation, stock_target_at_creation,
          confidence_at_creation, status_at_creation, weekly_demand_at_creation,
          planning_date_at_creation, supplier_code_snapshot,
          classification_code_snapshot, unit_measure_snapshot, package_units_snapshot
        ) VALUES ($1, $2, $3, NULL, $4, $5, NULL, 'EXCEL', 'IMPORTADO_EXCEL', NULL, $6, $7, $8, $9, $10)`,
        [
          orderId,
          item.article_id,
          description,
          item.requested_quantity,
          stockCurrent,
          planningDate,
          meta?.supplier_code ?? null,
          meta?.classification_code ?? null,
          meta?.unit_measure ?? null,
          meta?.bulto ?? null,
        ]
      );
    }

    return {
      id: orderId,
      order_number: orderNumber,
      total_units: totalUnits,
      items_count: validItems.length,
      created: true,
    };
  });
}

/**
 * Genera el libro Excel de plantilla descargable para importación de pedidos.
 */
export function generateOrderTemplateWorkbook(): Buffer {
  const wb = xlsx.utils.book_new();

  // Hoja 1: Pedido
  const orderHeaders = ["Código", "Descripción", "Cantidad", "Observaciones"];
  const sampleData = [
    orderHeaders,
    [2222, "ACEITE CANUELAS 900cc (12)", 12, "Aceite comestible"],
    [11109, "ALICANTE-BICARBONATO 50G (12)", 24, "Especias"],
    [5336, "ADRENALYN FIFA 2026 x12uni", 12, "Figuritas / Cartas"],
    [697, "FERRERO ROCHER T7 COLLECTION", 6, "Bombones"],
    ["", "", "", ""],
  ];

  const wsOrder = xlsx.utils.aoa_to_sheet(sampleData);
  // Ancho sugerido de columnas
  wsOrder["!cols"] = [
    { wch: 12 }, // Código
    { wch: 40 }, // Descripción
    { wch: 12 }, // Cantidad
    { wch: 30 }, // Observaciones
  ];

  xlsx.utils.book_append_sheet(wb, wsOrder, "Pedido");

  // Hoja 2: Instrucciones
  const instructions = [
    ["INSTRUCCIONES PARA LA IMPORTACIÓN DE PEDIDOS DESDE EXCEL"],
    [""],
    ["1. Columnas requeridas:"],
    ["   - 'Código': Código numérico único del artículo (ej. 2222, 11109). Es el identificador principal."],
    ["   - 'Descripción': Nombre o detalle del producto. Ayuda a verificar o asociar si el código no coincide."],
    ["   - 'Cantidad': Unidades solicitadas (ej. 12, '12 UNID', '24 u'). Debe ser mayor a 0."],
    [""],
    ["2. Consejos útiles:"],
    ["   - Podés usar este archivo, planillas existentes de pedidos (ej. PEDIDO CENTRO) o exportadas del sistema."],
    ["   - Las filas de rubros o categorías (ej. 'ALMACEN', 'CHOCOLATES') se omiten automáticamente."],
    ["   - Antes de crear el pedido, vas a ver una vista previa completa para validar y corregir."],
    ["   - Si hay algún producto no reconocido o con error, podrás corregirlo o excluirlo antes de confirmar."],
    [""],
    ["3. Formatos compatibles:"],
    ["   - Archivos Excel (.xlsx, .xls) y valores separados por coma (.csv)."],
  ];

  const wsInstructions = xlsx.utils.aoa_to_sheet(instructions);
  wsInstructions["!cols"] = [{ wch: 90 }];
  xlsx.utils.book_append_sheet(wb, wsInstructions, "Instrucciones");

  return xlsx.write(wb, { type: "buffer", bookType: "xlsx" });
}
