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
  type NegativeStockExportItem,
} from "@/features/excel/order-export";
import { resolveRubroName } from "@/server/catalog/rubros";
import { calculateProductSimilarity, expandSearchToken, resolveKnownAlias } from "@/server/catalog/fuzzy-search";
import { resolveSupplier } from "@/server/catalog/suppliers";
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
 * or for a specific location. Employs exact, alias, and fuzzy error-tolerant matching.
 */
export async function queryProductStock(
  search: { articleId?: number; productSearch?: string },
  branchTarget: BranchTarget = "ALL",
  branchId?: number
): Promise<{ items: ProductStockItem[]; totalFound: number }> {
  const orgId = Number(process.env.DASHBOARD_ORGANIZATION_ID || DEFAULT_ORG_ID);

  // 1. Find matching products in products_raw
  let productsRes: {
    rows: Array<{
      article_id: number;
      description: string;
      brand: string | null;
      rubro: string | null;
      bulto: string | null;
    }>;
  } = { rows: [] };

  if (search.articleId !== undefined) {
    productsRes = await query<{
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
       WHERE p.organization_id = $1 AND p.is_present = true AND p.article_id = $2
       ORDER BY p.article_id, p.branch_id
       LIMIT 5`,
      [orgId, search.articleId]
    );
  } else if (search.productSearch) {
    const rawSearch = search.productSearch.trim();
    const cleanSearch = rawSearch.replace(/[¿?¡!,;:"'.]/g, " ").replace(/\s+/g, " ").trim();
    const alias = resolveKnownAlias(rawSearch) || resolveKnownAlias(cleanSearch);

    // 1.1 First try: Multi-token combined matching across Marca + Descripcion
    const tokens = cleanSearch.split(/\s+/).filter((t) => t.length >= 2);
    if (tokens.length > 0 && !/[;]|--|\/\*/.test(cleanSearch)) {
      const tokenValues: unknown[] = [orgId];
      const andClauses: string[] = [];

      for (const token of tokens) {
        const expansions = expandSearchToken(token);
        const subOr: string[] = [];
        for (const exp of expansions) {
          tokenValues.push(`%${exp}%`);
          subOr.push(
            `(COALESCE(p.payload->>'Marca', '') || ' ' || COALESCE(p.payload->>'Descripcion', '')) ILIKE $${tokenValues.length}`
          );
        }
        andClauses.push(`(${subOr.join(" OR ")})`);
      }

      const multiRes = await query<{
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
         WHERE p.organization_id = $1 AND p.is_present = true
           AND ${andClauses.join(" AND ")}
         ORDER BY p.article_id, p.branch_id
         LIMIT 5`,
        tokenValues
      );

      if (multiRes.rows.length > 0) {
        productsRes = multiRes;
      }
    }

    // 1.2 Try canonical alias if available and still 0 results
    if (productsRes.rows.length === 0 && alias) {
      const aliasTokens = alias.split(/\s+/).filter((t) => t.length >= 2);
      const aliasValues: unknown[] = [orgId];
      const andAliasClauses: string[] = [];

      for (const aToken of aliasTokens) {
        aliasValues.push(`%${aToken}%`);
        andAliasClauses.push(
          `(COALESCE(p.payload->>'Marca', '') || ' ' || COALESCE(p.payload->>'Descripcion', '')) ILIKE $${aliasValues.length}`
        );
      }

      const aliasRes = await query<{
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
         WHERE p.organization_id = $1 AND p.is_present = true
           AND ${andAliasClauses.join(" AND ")}
         ORDER BY p.article_id, p.branch_id
         LIMIT 5`,
        aliasValues
      );

      if (aliasRes.rows.length > 0) {
        productsRes = aliasRes;
      }
    }

    // 1.3 Direct single substring fallback if still 0
    if (productsRes.rows.length === 0) {
      const directRes = await query<{
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
         WHERE p.organization_id = $1 AND p.is_present = true
           AND ((COALESCE(p.payload->>'Marca', '') || ' ' || COALESCE(p.payload->>'Descripcion', '')) ILIKE $2
                OR p.article_id::text ILIKE $2)
         ORDER BY p.article_id, p.branch_id
         LIMIT 5`,
        [orgId, `%${rawSearch}%`]
      );
      if (directRes.rows.length > 0) {
        productsRes = directRes;
      }
    }

    // 1.4 If still 0, try token-based candidate search with fuzzy scoring
    if (productsRes.rows.length === 0 && !/[;]|--|\/\*/.test(rawSearch) && cleanSearch.length >= 3) {
      const broadTokens = cleanSearch.split(/\s+/).filter((t) => t.length >= 3);
      const orClauses: string[] = [];
      const tokenValues: unknown[] = [orgId];

      for (const token of broadTokens) {
        tokenValues.push(`%${token}%`);
        orClauses.push(
          `p.payload->>'Descripcion' ILIKE $${tokenValues.length} OR p.payload->>'Marca' ILIKE $${tokenValues.length}`
        );
        if (token.length >= 4) {
          tokenValues.push(`%${token.slice(0, 3)}%`);
          orClauses.push(
            `p.payload->>'Descripcion' ILIKE $${tokenValues.length} OR p.payload->>'Marca' ILIKE $${tokenValues.length}`
          );
        }
      }

      if (orClauses.length > 0) {
        const broadRes = await query<{
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
           WHERE p.organization_id = $1 AND p.is_present = true
             AND (${orClauses.join(" OR ")})
           LIMIT 50`,
          tokenValues
        );

        if (broadRes.rows.length > 0) {
          const scored = broadRes.rows
            .map((p) => ({
              product: p,
              match: calculateProductSimilarity(cleanSearch, p.description, p.brand),
            }))
            .filter((item) => item.match.score >= 0.6)
            .sort((a, b) => b.match.score - a.match.score);

          if (scored.length > 0) {
            productsRes = { rows: scored.slice(0, 5).map((s) => s.product) };
          }
        }
      }
    }
  }

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
 * Supports filtering by rubro or supplier when specified.
 * Falls back to latest processed depot snapshot if Depósito Central has no rows in stock_levels_raw.
 */
export async function queryLowStock(
  branchTarget: BranchTarget = "ALL",
  branchId?: number,
  limit = 10,
  targetRubro?: string,
  targetSupplierCode?: string
): Promise<{
  branchName: string;
  branchId: number;
  rubro?: string;
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
  const orgId = Number(process.env.DASHBOARD_ORGANIZATION_ID || DEFAULT_ORG_ID);

  try {
    // 1. If rubro or supplier filter is requested, query stock_levels_raw with products_raw directly
    if (targetRubro || targetSupplierCode) {
      const filters: string[] = ["sl.organization_id = $1", "sl.branch_id = $2"];
      const qValues: unknown[] = [orgId, targetBranch];

      if (targetRubro) {
        qValues.push(`%${targetRubro}%`);
        filters.push(
          `(p.payload->>'Rubro' ILIKE $${qValues.length} OR p.payload->>'Clasificacion' ILIKE $${qValues.length} OR p.payload->>'Descripcion' ILIKE $${qValues.length} OR p.payload->>'Marca' ILIKE $${qValues.length})`
        );
      }
      if (targetSupplierCode) {
        qValues.push(targetSupplierCode);
        filters.push(`p.payload->>'Proveedor' = $${qValues.length}`);
      }

      qValues.push(limit);

      const rubroStockRes = await query<{
        article_id: number;
        description: string;
        saldo: string;
      }>(
        `SELECT DISTINCT ON (sl.article_id)
           sl.article_id,
           COALESCE(p.payload->>'Descripcion', 'Artículo ' || sl.article_id) AS description,
           sl.saldo
         FROM stock_levels_raw sl
         JOIN products_raw p ON p.organization_id = sl.organization_id AND p.article_id = sl.article_id AND p.branch_id = sl.branch_id
         WHERE ${filters.join(" AND ")}
         ORDER BY sl.article_id, sl.saldo ASC
         LIMIT $${qValues.length}`,
        qValues
      );

      const sortedRows = rubroStockRes.rows.sort((a, b) => Number(a.saldo) - Number(b.saldo));
      return {
        branchName,
        branchId: targetBranch,
        rubro: targetRubro,
        total: sortedRows.length,
        items: sortedRows.map((r) => ({
          articleId: r.article_id,
          description: r.description,
          saldo: Number(r.saldo),
          stockStatus: Number(r.saldo) <= 0 ? "OUT_OF_STOCK" : "AVAILABLE",
        })),
      };
    }

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
 * Queries items available in Depósito Central that are out of stock or low in a retail branch.
 */
export async function queryDepositAvailability(
  branchId: number = 2,
  rubro?: string,
  limit = 10
): Promise<{
  branchName: string;
  branchId: number;
  rubro?: string;
  total: number;
  items: Array<{
    articleId: number;
    description: string;
    branchStock: number;
    depotStock: number;
    rubro?: string;
  }>;
}> {
  const orgId = Number(process.env.DASHBOARD_ORGANIZATION_ID || DEFAULT_ORG_ID);
  const targetBranch = branchId === 3 ? 3 : 2;
  const branchName = targetBranch === 2 ? "Centro" : "Jardín";

  try {
    const qValues: unknown[] = [orgId, targetBranch];
    let rubroFilter = "";
    if (rubro) {
      qValues.push(`%${rubro}%`);
      rubroFilter = `AND (p.payload->>'Rubro' ILIKE $${qValues.length} OR p.payload->>'Clasificacion' ILIKE $${qValues.length} OR p.payload->>'Descripcion' ILIKE $${qValues.length})`;
    }
    qValues.push(limit);

    const res = await query<{
      article_id: number;
      description: string;
      rubro: string | null;
      branch_stock: string;
      depot_stock: string;
    }>(
      `WITH latest_snapshot AS (
         SELECT id FROM stock_snapshots WHERE organization_id = $1 AND status = 'PROCESSED' ORDER BY uploaded_at DESC LIMIT 1
       ),
       depot_stock AS (
         SELECT i.article_id, i.stock_quantity::numeric AS depot_saldo
         FROM stock_snapshot_items i
         JOIN latest_snapshot ls ON ls.id = i.snapshot_id
         WHERE i.stock_quantity::numeric > 0
       ),
       branch_stock AS (
         SELECT sl.article_id, SUM(sl.saldo) AS branch_saldo
         FROM stock_levels_raw sl
         WHERE sl.organization_id = $1 AND sl.branch_id = $2
         GROUP BY sl.article_id
       )
       SELECT DISTINCT ON (p.article_id)
         p.article_id,
         COALESCE(p.payload->>'Descripcion', 'Artículo ' || p.article_id) AS description,
         p.payload->>'Rubro' AS rubro,
         COALESCE(bs.branch_saldo, 0) AS branch_stock,
         ds.depot_saldo AS depot_stock
       FROM depot_stock ds
       JOIN products_raw p ON p.organization_id = $1 AND p.article_id = ds.article_id AND p.is_present = true
       LEFT JOIN branch_stock bs ON bs.article_id = ds.article_id
       WHERE COALESCE(bs.branch_saldo, 0) <= 0
         ${rubroFilter}
       ORDER BY p.article_id, ds.depot_saldo DESC
       LIMIT $${qValues.length}`,
      qValues
    );

    const sorted = res.rows.sort((a, b) => Number(b.depot_stock) - Number(a.depot_stock));

    return {
      branchName,
      branchId: targetBranch,
      rubro,
      total: sorted.length,
      items: sorted.map((r) => ({
        articleId: r.article_id,
        description: r.description,
        branchStock: Number(r.branch_stock),
        depotStock: Number(r.depot_stock),
        rubro: r.rubro || undefined,
      })),
    };
  } catch {
    return {
      branchName,
      branchId: targetBranch,
      rubro,
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
 * Supports filtering by targetRubro and/or targetSupplierCode.
 */
export async function queryReplenishment(
  branchId: number,
  targetRubro?: string,
  targetSupplierCode?: string,
  targetSupplierName?: string
): Promise<{
  branchName: string;
  planningDate: string;
  rubro?: string;
  supplierCode?: string;
  supplierName?: string;
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
    supplier: targetSupplierCode,
    filter: "TO_REPLENISH",
    limit: 10,
    offset: 0,
  });

  const branchName = branchId === 2 ? "Centro" : branchId === 3 ? "Jardín" : `Sucursal ${branchId}`;

  return {
    branchName,
    planningDate,
    rubro: targetRubro,
    supplierCode: targetSupplierCode,
    supplierName: targetSupplierName,
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

export type ReplenishmentExcelQueryInput = {
  branchId: number;
  rubro?: string;
  supplierCode?: string;
  supplierName?: string;
};

export type ReplenishmentExcelQueryResult = {
  branchName: string;
  branchId: number;
  planningDate: string;
  rubro?: string;
  supplierCode?: string;
  supplierName?: string;
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
 * Queries all replenishment items for a rubro, supplier, and/or branch without truncation (limit: 5000),
 * separates items with negative stock requiring manual review, applies mandatory export
 * eligibility rules, and generates the .xlsx binary buffer using existing export logic.
 */
export async function queryReplenishmentExcelData(
  branchIdOrOptions: number | ReplenishmentExcelQueryInput,
  rubroOrOptions?: string | { supplierCode?: string; supplierName?: string; rubro?: string },
  maybeSupplierCode?: string,
  maybeSupplierName?: string
): Promise<ReplenishmentExcelQueryResult> {
  let branchId: number;
  let rubro: string | undefined;
  let supplierCode: string | undefined;
  let supplierName: string | undefined;

  if (typeof branchIdOrOptions === "object") {
    branchId = branchIdOrOptions.branchId;
    rubro = branchIdOrOptions.rubro;
    supplierCode = branchIdOrOptions.supplierCode;
    supplierName = branchIdOrOptions.supplierName;
  } else {
    branchId = branchIdOrOptions;
    if (typeof rubroOrOptions === "string") {
      rubro = rubroOrOptions;
      supplierCode = maybeSupplierCode;
      supplierName = maybeSupplierName;
    } else if (rubroOrOptions && typeof rubroOrOptions === "object") {
      rubro = rubroOrOptions.rubro;
      supplierCode = rubroOrOptions.supplierCode;
      supplierName = rubroOrOptions.supplierName;
    }
  }

  const scope = await resolveScope(branchId);
  const depotScope = await resolveScope(DEPOT_BRANCH_ID);
  const planningDate = "2026-10-24";
  const branchName = branchId === 2 ? "Centro" : branchId === 3 ? "Jardín" : `Sucursal ${branchId}`;

  // Query all items for this rubro/supplier across all pages without silent truncation
  const replenishment = await getWeeklyReplenishment({
    scope,
    depotSourceId: depotScope.sourceId,
    planningDate,
    rubro: rubro ? rubro : undefined,
    supplier: supplierCode ? supplierCode : undefined,
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
  const negativeStockExportItems: NegativeStockExportItem[] = [];
  const eligibleExportItems: ReplenishmentExportItem[] = [];
  const seen = new Set<number>();

  for (const item of replenishment.items) {
    if (seen.has(item.article_id)) continue;
    seen.add(item.article_id);

    const resolvedRubro = resolveRubroName(item.classification_code, item.rubro) || rubro || "Sin rubro";

    // Negative stock tracking: do NOT fabricate quantities for negative stock products
    if (item.stock_current < 0 || item.status === "NEGATIVE_STOCK") {
      negativeStockCount++;
      negativeStockProducts.push({
        articleId: item.article_id,
        description: item.description,
        currentStock: item.stock_current,
      });
      negativeStockExportItems.push({
        article_id: item.article_id,
        description: item.description,
        current_stock: item.stock_current,
        rubro: resolvedRubro,
        supplier_code: item.supplier_code,
        stock_depot: item.stock_depot,
        weekly_demand: item.weekly_demand,
      });
    }

    // Differentiate clearly: requested_quantity is the intended order quantity,
    // which for initial suggestion equals suggested_quantity (or 0 if negative/null)
    const requested = item.requested_quantity > 0 ? item.requested_quantity : (item.suggested_quantity ?? 0);

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
  if (eligibleExportItems.length > 0 || negativeStockExportItems.length > 0) {
    let title = "Reposición Semanal";
    if (rubro && supplierCode) {
      const dispRubro = rubro === "__SIN_RUBRO__" ? "Sin rubro" : rubro;
      title = `Pedido a Depósito - ${dispRubro} (${supplierName || supplierCode})`;
    } else if (supplierCode) {
      title = `Pedido a Depósito - Proveedor ${supplierName || supplierCode}`;
    } else if (rubro) {
      title = `Pedido a Depósito - ${rubro === "__SIN_RUBRO__" ? "Sin rubro" : rubro}`;
    }

    excelBuffer = generateReplenishmentExcelBuffer({
      items: eligibleExportItems,
      branchLabel: branchName,
      planningDate,
      title,
      negativeStockItems: negativeStockExportItems,
    });
  }

  return {
    branchName,
    branchId,
    planningDate,
    rubro: rubro ? (rubro === "__SIN_RUBRO__" ? "Sin rubro" : rubro) : undefined,
    supplierCode,
    supplierName,
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
 * Leverages resolveSupplier to map brand names (e.g. Arcor, Baggio, Marlboro)
 * to numeric supplier codes and query real product catalog data.
 */
export async function querySupplierProducts(supplierSearch: string) {
  const orgId = Number(process.env.DASHBOARD_ORGANIZATION_ID || DEFAULT_ORG_ID);
  const resolved = resolveSupplier(supplierSearch);

  let targetCode: string | null = null;
  let targetName: string = supplierSearch;

  if (resolved.status === "EXACT") {
    targetCode = resolved.supplier.code;
    targetName = resolved.supplier.name;
  } else if (/^\d+$/.test(supplierSearch.trim())) {
    targetCode = supplierSearch.trim();
  }

  const values: unknown[] = [orgId];
  let whereSupplier = "";

  if (targetCode) {
    values.push(targetCode);
    const codeIdx = values.length;
    values.push(`%${targetName}%`);
    const nameIdx = values.length;
    whereSupplier = `(p.payload->>'Proveedor' = $${codeIdx} OR s.external_code = $${codeIdx} OR s.name ILIKE $${nameIdx} OR p.payload->>'Marca' ILIKE $${nameIdx})`;
  } else {
    values.push(`%${supplierSearch}%`);
    const searchIdx = values.length;
    whereSupplier = `(s.name ILIKE $${searchIdx} OR s.external_code ILIKE $${searchIdx} OR p.payload->>'Proveedor' ILIKE $${searchIdx} OR p.payload->>'Marca' ILIKE $${searchIdx})`;
  }

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
       COALESCE(s.name, $2) AS supplier_name,
       p.payload->>'Marca' AS brand
     FROM products_raw p
     LEFT JOIN suppliers s ON s.external_code = btrim(p.payload->>'Proveedor') AND s.organization_id = p.organization_id
     WHERE p.organization_id = $1 AND p.is_present = true
       AND ${whereSupplier}
     LIMIT 10`,
    values
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
