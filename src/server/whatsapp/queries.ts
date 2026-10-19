import { query } from "@/server/db/client";
import type { Period, Scope } from "@/server/analytics/types";
import { getAttention, getDataHealth, getOverview, getStock, getTopProducts } from "@/server/analytics/dashboard";
import { getOrder, listOrders, listWarehouseOrders } from "@/server/orders/repository";
import { DEPOT_BRANCH_ID, getWeeklyReplenishment } from "@/server/analytics/weekly-replenishment";
import { getSourceForBranch } from "@/server/auth/sources";
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
  const targetBranch = branchId ?? (branchTarget === "CENTRO" ? 2 : branchTarget === "JARDIN" ? 3 : 2);
  const scope = await resolveScope(targetBranch);
  const branchName = targetBranch === 2 ? "Centro" : targetBranch === 3 ? "Jardín" : "Depósito";

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
  branchId: number
): Promise<{
  branchName: string;
  planningDate: string;
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
    filter: "TO_REPLENISH",
    limit: 10,
    offset: 0,
  });

  const branchName = branchId === 2 ? "Centro" : branchId === 3 ? "Jardín" : `Sucursal ${branchId}`;

  return {
    branchName,
    planningDate,
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
