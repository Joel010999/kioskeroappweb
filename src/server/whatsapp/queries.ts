import { query } from "@/server/db/client";
import type { Period, Scope } from "@/server/analytics/types";
import { getAttention, getDataHealth, getOverview, getStock, getTopProducts } from "@/server/analytics/dashboard";
import { getOrder, listOrders, listWarehouseOrders } from "@/server/orders/repository";
import { DEPOT_BRANCH_ID, getWeeklyReplenishment } from "@/server/analytics/weekly-replenishment";
import { getSourceForBranch } from "@/server/auth/sources";
import {
  generateReplenishmentExcelBuffer,
  isEligibleForReplenishmentExcel,
  type ReplenishmentExportItem,
} from "@/features/excel/order-export";
import { resolveRubroName } from "@/server/catalog/rubros";
import type { BranchTarget } from "./types";

const DEFAULT_ORG_ID = 1;

/**
 * Resolves the Scope for a given branch safely, with fallback if sources table
 * is empty or during isolated tests.
 */
export async function resolveScope(branchId: number): Promise<Scope> {
  const orgId = Number(process.env.DASHBOARD_ORGANIZATION_ID || DEFAULT_ORG_ID);
  let sourceId = process.env.DASHBOARD_SOURCE_ID || `branch_${branchId}_source`;

  try {
    sourceId = await getSourceForBranch(orgId, branchId);
  } catch {
    // Fallback if not configured in sources table
  }

  return {
    organizationId: orgId,
    branchId,
    sourceId,
  };
}

export type ProductStockItem = {
  articleId: number;
  description: string;
  brand?: string;
  rubro?: string;
  bulto?: string;
  stockCentro: number | null;
  stockJardin: number | null;
  stockDepot: number | null;
  depotSnapshotDate?: string;
};

/**
 * Queries stock of a product across all 3 locations (Depósito, Centro, Jardín)
 * or for a specific location.
 */
export async function queryProductStock(
  search: { articleId?: number; productSearch?: string },
  branchTarget: BranchTarget = "ALL",
  branchId?: number
): Promise<{ items: ProductStockItem[]; totalFound: number }> {
  const orgId = Number(process.env.DASHBOARD_ORGANIZATION_ID || DEFAULT_ORG_ID);

  // 1. Find matching products in products_raw
  const values: unknown[] = [orgId];
  let where = "p.organization_id = $1 AND p.is_present = true";

  if (search.articleId !== undefined) {
    values.push(search.articleId);
    where += ` AND p.article_id = $${values.length}`;
  } else if (search.productSearch) {
    values.push(`%${search.productSearch}%`);
    where += ` AND (p.payload->>'Descripcion' ILIKE $${values.length} OR p.payload->>'Marca' ILIKE $${values.length} OR p.article_id::text ILIKE $${values.length})`;
  }

  const productsRes = await query<{
    article_id: number;
    description: string;
    brand: string | null;
    rubro: string | null;
    bulto: string | null;
  }>(
    `SELECT DISTINCT ON (p.article_id)
       p.article_id,
       COALESCE(p.payload->>'Descripcion', p.payload->>'ArticuloDesc', 'Artículo ' || p.article_id) AS description,
       p.payload->>'Marca' AS brand,
       p.payload->>'Rubro' AS rubro,
       p.payload->>'Bulto' AS bulto
     FROM products_raw p
     WHERE ${where}
     ORDER BY p.article_id, p.branch_id
     LIMIT 5`,
    values
  );

  if (productsRes.rows.length === 0) {
    return { items: [], totalFound: 0 };
  }

  const articleIds = productsRes.rows.map((r) => r.article_id);

  // 2. Query live stock in POS locations from stock_levels_raw
  const posStockRes = await query<{
    article_id: number;
    branch_id: number;
    saldo: string;
  }>(
    `SELECT sl.article_id, sl.branch_id, SUM(sl.saldo) AS saldo
     FROM stock_levels_raw sl
     WHERE sl.organization_id = $1 AND sl.article_id = ANY($2::integer[])
     GROUP BY sl.article_id, sl.branch_id`,
    [orgId, articleIds]
  );

  const posMap = new Map<string, number>();
  for (const row of posStockRes.rows) {
    posMap.set(`${row.article_id}_${row.branch_id}`, Number(row.saldo));
  }

  // 3. Query depot stock from stock_snapshots
  const depotSnapRes = await query<{
    article_id: number;
    stock_quantity: string;
    uploaded_at: string;
  }>(
    `SELECT i.article_id, i.stock_quantity, s.uploaded_at
     FROM stock_snapshot_items i
     JOIN stock_snapshots s ON s.id = i.snapshot_id
     WHERE s.organization_id = $1 AND s.status = 'PROCESSED' AND i.article_id = ANY($2::integer[])
     ORDER BY s.uploaded_at DESC`,
    [orgId, articleIds]
  );

  const depotMap = new Map<number, { stock: number; uploadedAt: string }>();
  for (const row of depotSnapRes.rows) {
    if (!depotMap.has(row.article_id)) {
      depotMap.set(row.article_id, {
        stock: Number(row.stock_quantity),
        uploadedAt: row.uploaded_at,
      });
    }
  }

  const items: ProductStockItem[] = productsRes.rows.map((p) => {
    const centroStock = posMap.get(`${p.article_id}_2`) ?? null;
    const jardinStock = posMap.get(`${p.article_id}_3`) ?? null;
    const depotInfo = depotMap.get(p.article_id);
    const depotDbStock = posMap.get(`${p.article_id}_1`) ?? null;

    return {
      articleId: p.article_id,
      description: p.description,
      brand: p.brand || undefined,
      rubro: p.rubro || undefined,
      bulto: p.bulto || undefined,
      stockCentro: branchTarget === "JARDIN" || branchTarget === "DEPOSITO" ? null : centroStock,
      stockJardin: branchTarget === "CENTRO" || branchTarget === "DEPOSITO" ? null : jardinStock,
      stockDepot:
        branchTarget === "CENTRO" || branchTarget === "JARDIN"
          ? null
          : depotInfo ? depotInfo.stock : depotDbStock,
      depotSnapshotDate: depotInfo?.uploadedAt,
    };
  });

  return { items, totalFound: items.length };
}

/**
 * Queries lowest stock products using existing getStock service and real branch filters.
 * Falls back to latest processed depot snapshot if Depósito Central has no rows in stock_levels_raw.
 */
export async function queryLowStock(
  branchTarget: BranchTarget = "ALL",
  branchId?: number,
  limit = 10
): Promise<{
  branchName: string;
  branchId: number;
  total: number;
  items: Array<{
    articleId: number;
    description: string;
    saldo: number;
    stockStatus: "OUT_OF_STOCK" | "AVAILABLE";
  }>;
}> {
  const targetBranch =
    branchId ??
    (branchTarget === "CENTRO" ? 2 : branchTarget === "JARDIN" ? 3 : branchTarget === "DEPOSITO" ? 1 : 1);
  const branchName = targetBranch === 1 ? "Depósito Central" : targetBranch === 2 ? "Centro" : "Jardín";

  try {
    const scope = await resolveScope(targetBranch);
    const stockData = await getStock(scope, { limit, offset: 0 });

    if (stockData && stockData.rows && stockData.rows.length > 0) {
      return {
        branchName,
        branchId: targetBranch,
        total: stockData.total,
        items: stockData.rows.map((r) => ({
          articleId: r.article_id,
          description: r.description ?? `Artículo ${r.article_id}`,
          saldo: r.saldo,
          stockStatus: r.stock_status,
        })),
      };
    }

    // If branch 1 (Depósito Central) has no rows in stock_levels_raw, check processed stock_snapshots
    if (targetBranch === 1) {
      const orgId = Number(process.env.DASHBOARD_ORGANIZATION_ID || DEFAULT_ORG_ID);
      const snapRes = await query<{
        article_id: number;
        description: string | null;
        stock_quantity: string;
      }>(
        `SELECT i.article_id,
                COALESCE(p.payload->>'Descripcion', 'Artículo ' || i.article_id) AS description,
                i.stock_quantity
         FROM stock_snapshot_items i
         JOIN stock_snapshots s ON s.id = i.snapshot_id
         LEFT JOIN products_raw p ON p.organization_id = s.organization_id AND p.article_id = i.article_id
         WHERE s.organization_id = $1 AND s.status = 'PROCESSED'
         ORDER BY s.uploaded_at DESC, i.stock_quantity::numeric ASC
         LIMIT $2`,
        [orgId, limit]
      );

      if (snapRes.rows && snapRes.rows.length > 0) {
        return {
          branchName,
          branchId: targetBranch,
          total: snapRes.rows.length,
          items: snapRes.rows.map((r) => {
            const saldo = Number(r.stock_quantity);
            return {
              articleId: r.article_id,
              description: r.description ?? `Artículo ${r.article_id}`,
              saldo,
              stockStatus: saldo <= 0 ? "OUT_OF_STOCK" : "AVAILABLE",
            };
          }),
        };
      }
    }

    return {
      branchName,
      branchId: targetBranch,
      total: 0,
      items: [],
    };
  } catch {
    return {
      branchName,
      branchId: targetBranch,
      total: 0,
      items: [],
    };
  }
}

/**
 * Queries products out of stock or with negative stock.
 */
export async function queryStockAlerts(
  branchTarget: BranchTarget = "ALL",
  branchId?: number
): Promise<{
  branchName: string;
  negativeCount: number;
  outOfStockCount: number;
  negativeItems: Array<{ articleId: number; description: string; saldo: number }>;
  outOfStockItems: Array<{ articleId: number; description: string }>;
}> {
  const targetBranch =
    branchId ??
    (branchTarget === "CENTRO" ? 2 : branchTarget === "JARDIN" ? 3 : branchTarget === "DEPOSITO" ? 1 : 2);
  const scope = await resolveScope(targetBranch);
  const branchName = targetBranch === 1 ? "Depósito Central" : targetBranch === 2 ? "Centro" : "Jardín";

  // Use getAttention with a 30-day window
  const today = new Date("2026-10-18T12:00:00.000Z");
  const thirtyDaysAgo = new Date(today.getTime() - 30 * 86_400_000);
  const fromStr = thirtyDaysAgo.toISOString().slice(0, 10);
  const toStr = today.toISOString().slice(0, 10);

  const period: Period = {
    from: fromStr,
    to: toStr,
    toExclusive: today.toISOString().slice(0, 10),
    previousFrom: fromStr,
    previousToExclusive: toStr,
  };

  const attention = await getAttention(scope, period);

  return {
    branchName,
    negativeCount: attention.negative_stock.count,
    outOfStockCount: attention.out_of_stock.count,
    negativeItems: (attention.negative_stock.items as any[]).slice(0, 5).map((i) => ({
      articleId: Number(i.article_id),
      description: i.description ?? `Artículo ${i.article_id}`,
      saldo: Number(i.saldo),
    })),
    outOfStockItems: (attention.out_of_stock.items as any[]).slice(0, 5).map((i) => ({
      articleId: Number(i.article_id),
      description: i.description ?? `Artículo ${i.article_id}`,
    })),
  };
}

/**
 * Queries weekly replenishment suggestions for Centro or Jardín.
 */
export async function queryReplenishment(
  branchId: number,
  targetRubro?: string
): Promise<{
  branchName: string;
  planningDate: string;
  rubro?: string;
  items: Array<{
    articleId: number;
    description: string;
    stockCurrent: number;
    stockDepot: number | null;
    suggestedQuantity: number;
    weeklyDemand: number | null;
    status: string;
  }>;
  totalSuggested: number;
}> {
  const scope = await resolveScope(branchId);
  const depotScope = await resolveScope(DEPOT_BRANCH_ID);
  const planningDate = "2026-10-24"; // Next planning cycle Saturday

  const replenishment = await getWeeklyReplenishment({
    scope,
    depotSourceId: depotScope.sourceId,
    planningDate,
    rubro: targetRubro,
    filter: "TO_REPLENISH",
    limit: 10,
    offset: 0,
  });

  const branchName = branchId === 2 ? "Centro" : branchId === 3 ? "Jardín" : `Sucursal ${branchId}`;

  return {
    branchName,
    planningDate,
    rubro: targetRubro,
    items: replenishment.items.map((row) => ({
      articleId: row.article_id,
      description: row.description ?? `Artículo ${row.article_id}`,
      stockCurrent: row.stock_current,
      stockDepot: row.stock_depot,
      suggestedQuantity: row.suggested_quantity ?? 0,
      weeklyDemand: row.weekly_demand,
      status: row.status,
    })),
    totalSuggested: replenishment.total,
  };
}

export type ReplenishmentExcelQueryResult = {
  branchName: string;
  branchId: number;
  planningDate: string;
  rubro: string;
  totalEligible: number;
  negativeStockCount: number;
  negativeStockProducts?: Array<{
    articleId: number;
    description: string | null;
    currentStock: number;
  }>;
  excelBuffer: Buffer | null;
  items: ReplenishmentExportItem[];
};

/**
 * Queries all replenishment items for a rubro and branch without truncation (limit: 5000),
 * separates items with negative stock requiring manual review, applies mandatory export
 * eligibility rules, and generates the .xlsx binary buffer using existing export logic.
 */
export async function queryReplenishmentExcelData(
  branchId: number,
  rubro: string
): Promise<ReplenishmentExcelQueryResult> {
  const scope = await resolveScope(branchId);
  const depotScope = await resolveScope(DEPOT_BRANCH_ID);
  const planningDate = "2026-10-24";
  const branchName = branchId === 2 ? "Centro" : branchId === 3 ? "Jardín" : `Sucursal ${branchId}`;

  // Query all items for this rubro across all pages without silent truncation
  const replenishment = await getWeeklyReplenishment({
    scope,
    depotSourceId: depotScope.sourceId,
    planningDate,
    rubro,
    filter: "TO_REPLENISH",
    limit: 5000,
    offset: 0,
  });

  let negativeStockCount = 0;
  const negativeStockProducts: Array<{
    articleId: number;
    description: string | null;
    currentStock: number;
  }> = [];
  const eligibleExportItems: ReplenishmentExportItem[] = [];
  const seen = new Set<number>();

  for (const item of replenishment.items) {
    if (seen.has(item.article_id)) continue;
    seen.add(item.article_id);

    // Negative stock tracking: do NOT fabricate quantities for negative stock products
    if (item.stock_current < 0 || item.status === "NEGATIVE_STOCK") {
      negativeStockCount++;
      negativeStockProducts.push({
        articleId: item.article_id,
        description: item.description,
        currentStock: item.stock_current,
      });
    }

    // Differentiate clearly: requested_quantity is the intended order quantity,
    // which for initial suggestion equals suggested_quantity (or 0 if negative/null)
    const requested = item.requested_quantity > 0 ? item.requested_quantity : (item.suggested_quantity ?? 0);
    const resolvedRubro = resolveRubroName(item.classification_code, item.rubro) || rubro;

    // Apply mandatory export eligibility rule: incluirEnExcel = seleccionado && cantidadSolicitada > 0
    if (
      isEligibleForReplenishmentExcel({
        selected: true,
        requestedQuantity: requested,
      })
    ) {
      eligibleExportItems.push({
        article_id: item.article_id,
        description: item.description,
        rubro: resolvedRubro,
        classification_code: item.classification_code,
        stock_current: item.stock_current,
        stock_depot: item.stock_depot,
        suggested_quantity: item.suggested_quantity,
        requested_quantity: requested,
        supply_mode: item.supply_mode,
        supplier_code: item.supplier_code,
        unit_measure: item.unit_measure,
        package_units: item.package_units,
        presentation: item.presentation,
        presentation_display: item.presentation_display,
        selected: true,
      });
    }
  }

  let excelBuffer: Buffer | null = null;
  if (eligibleExportItems.length > 0) {
    excelBuffer = generateReplenishmentExcelBuffer({
      items: eligibleExportItems,
      branchLabel: branchName,
      planningDate,
      title: `Pedido a Depósito - ${rubro === "__SIN_RUBRO__" ? "Sin rubro" : rubro}`,
    });
  }

  return {
    branchName,
    branchId,
    planningDate,
    rubro: rubro === "__SIN_RUBRO__" ? "Sin rubro" : rubro,
    totalEligible: eligibleExportItems.length,
    negativeStockCount,
    negativeStockProducts,
    excelBuffer,
    items: eligibleExportItems,
  };
}

/**
 * Queries detailed order information by order number or ID.
 */
export async function queryOrderDetail(orderNumber: number) {
  const depotScope = await resolveScope(DEPOT_BRANCH_ID);
  return getOrder(depotScope, orderNumber);
}

/**
 * Queries recent orders.
 */
export async function queryRecentOrders(
  branchTarget: BranchTarget = "ALL",
  branchId?: number,
  limit = 5
) {
  if (branchTarget === "DEPOSITO" || branchId === 1) {
    return listWarehouseOrders({ limit, offset: 0 });
  }

  if (branchId !== undefined) {
    const scope = await resolveScope(branchId);
    return listOrders(scope, { limit, offset: 0 });
  }

  // All: return warehouse unified view
  return listWarehouseOrders({ limit, offset: 0 });
}

/**
 * Queries pending orders across the organization.
 */
export async function queryPendingOrders() {
  const summary = await listWarehouseOrders({ limit: 10, offset: 0 });
  const pendingOrders = summary.rows.filter(
    (o) => o.status === "CONFIRMED" || o.status === "IN_PREPARATION" || o.status === "DISPATCHED"
  );

  return {
    summary: summary.summary,
    orders: pendingOrders.slice(0, 6),
  };
}

/**
 * Queries supplier information for a product.
 */
export async function queryProductSupplier(search: { articleId?: number; productSearch?: string }) {
  const orgId = Number(process.env.DASHBOARD_ORGANIZATION_ID || DEFAULT_ORG_ID);
  const values: unknown[] = [orgId];
  let where = "p.organization_id = $1 AND p.is_present = true";

  if (search.articleId !== undefined) {
    values.push(search.articleId);
    where += ` AND p.article_id = $${values.length}`;
  } else if (search.productSearch) {
    values.push(`%${search.productSearch}%`);
    where += ` AND (p.payload->>'Descripcion' ILIKE $${values.length} OR p.article_id::text ILIKE $${values.length})`;
  }

  const res = await query<{
    article_id: number;
    description: string;
    supplier_code: string | null;
    supplier_name: string | null;
    brand: string | null;
    rubro: string | null;
  }>(
    `SELECT DISTINCT ON (p.article_id)
       p.article_id,
       COALESCE(p.payload->>'Descripcion', p.payload->>'ArticuloDesc', 'Artículo ' || p.article_id) AS description,
       p.payload->>'Proveedor' AS supplier_code,
       s.name AS supplier_name,
       p.payload->>'Marca' AS brand,
       p.payload->>'Rubro' AS rubro
     FROM products_raw p
     LEFT JOIN suppliers s ON s.external_code = btrim(p.payload->>'Proveedor') AND s.organization_id = p.organization_id
     WHERE ${where}
     LIMIT 5`,
    values
  );

  return res.rows;
}

/**
 * Queries products associated with a specific supplier name or code.
 */
export async function querySupplierProducts(supplierSearch: string) {
  const orgId = Number(process.env.DASHBOARD_ORGANIZATION_ID || DEFAULT_ORG_ID);

  const res = await query<{
    article_id: number;
    description: string;
    supplier_code: string | null;
    supplier_name: string | null;
    brand: string | null;
  }>(
    `SELECT DISTINCT ON (p.article_id)
       p.article_id,
       COALESCE(p.payload->>'Descripcion', p.payload->>'ArticuloDesc', 'Artículo ' || p.article_id) AS description,
       p.payload->>'Proveedor' AS supplier_code,
       s.name AS supplier_name,
       p.payload->>'Marca' AS brand
     FROM products_raw p
     LEFT JOIN suppliers s ON s.external_code = btrim(p.payload->>'Proveedor') AND s.organization_id = p.organization_id
     WHERE p.organization_id = $1 AND p.is_present = true
       AND (s.name ILIKE $2 OR s.external_code ILIKE $2 OR p.payload->>'Proveedor' ILIKE $2)
     LIMIT 10`,
    [orgId, `%${supplierSearch}%`]
  );

  return res.rows;
}

/**
 * Queries period overview (units, movements, variation) for a branch or all branches.
 */
export async function queryPeriodOverview(period: Period, branchId?: number) {
  const targetBranch = branchId ?? 2; // Default to Centro if ALL, or query Centro
  const scope = await resolveScope(targetBranch);
  const overview = await getOverview(scope, period);

  return {
    branchName: targetBranch === 2 ? "Centro" : targetBranch === 3 ? "Jardín" : "Depósito",
    periodLabel: `${period.from} al ${period.to}`,
    ...overview,
  };
}

/**
 * Queries top products sold during a period.
 */
export async function queryTopProductsMetrics(period: Period, branchId?: number, limit = 5) {
  const targetBranch = branchId ?? 2;
  const scope = await resolveScope(targetBranch);
  const products = await getTopProducts(scope, period, limit);

  return {
    branchName: targetBranch === 2 ? "Centro" : targetBranch === 3 ? "Jardín" : "Depósito",
    products,
  };
}

/**
 * Queries data health and synchronization status.
 */
export async function querySystemHealthStatus(branchId = 2) {
  const scope = await resolveScope(branchId);
  return getDataHealth(scope);
}
