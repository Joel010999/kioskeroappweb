import { query } from "@/server/db/client";
import type { Scope } from "@/server/analytics/types";
import {
  depotStockState,
  type DepotStockState,
  type WeeklyReplenishmentStatus,
} from "./weekly-replenishment-rules";
import type { SupplyMode } from "@/server/supply/branch-supply-rules";

export const WEEKLY_REPLENISHMENT_WEEKS = 6;

export const DEPOT_BRANCH_ID = 1;

export type WeeklyReplenishmentItem = {
  article_id: number;
  description: string | null;
  supplier_code: string | null;
  classification_code: string | null;
  unit_measure: string | null;
  stock_current: number;
  stock_depot: number | null;
  depot_stock_state: DepotStockState;
  weekly_demand: number | null;
  weekly_average: number | null;
  weekly_max: number | null;
  weekly_min: number | null;
  active_weeks: number;
  target_stock: number | null;
  suggested_quantity: number | null;
  requested_quantity: number;
  status: WeeklyReplenishmentStatus;
  supply_mode: SupplyMode;
  warnings: string[];
  fulfillment_type:
    | "INTERNAL_REPLENISHMENT_CANDIDATE"
    | "DEPOT_REVIEW_REQUIRED"
    | "SUPPLIER_PURCHASE_CANDIDATE";
};

function numberOrNull(value: string | number | null): number | null {
  return value === null ? null : Number(value);
}

export type WeeklyReplenishmentFilter =
  | "WITH_SUGGESTION"
  | "NO_SUGGESTION"
  | "REVIEW_REQUIRED"
  | "NO_DEMAND"
  | "INSUFFICIENT_HISTORY"
  | "IRREGULAR_DEMAND"
  | "ZERO_STOCK"
  | "NEGATIVE_STOCK"
  | "DEPOT_POSITIVE"
  | "DEPOT_ZERO"
  | "DEPOT_NEGATIVE"
  | "DEPOT_NO_ROW"
  | "DEPOT_NOT_POSITIVE"
  | "SUGGESTION_EXCEEDS_DEPOT"
  | "SUPPLY_DEPOT"
  | "SUPPLY_DIRECT_SUPPLIER"
  | "SUPPLY_UNDEFINED";
export type WeeklyReplenishmentSort =
  "SUGGESTED_DESC" | "DEMAND_DESC" | "STOCK_ASC" | "DEPOT_GAP_DESC";

const filterConditions: Record<WeeklyReplenishmentFilter, string> = {
  WITH_SUGGESTION: "status = 'SUGGESTION_AVAILABLE'",
  NO_SUGGESTION: "status = 'NO_SUGGESTION'",
  REVIEW_REQUIRED: "status IN ('NEGATIVE_STOCK', 'IRREGULAR_DEMAND')",
  NO_DEMAND: "status = 'NO_DEMAND'",
  INSUFFICIENT_HISTORY: "status = 'INSUFFICIENT_HISTORY'",
  IRREGULAR_DEMAND: "status = 'IRREGULAR_DEMAND'",
  ZERO_STOCK: "stock_current = 0",
  NEGATIVE_STOCK: "stock_current < 0",
  DEPOT_POSITIVE: "depot_stock > 0",
  DEPOT_ZERO: "depot_stock = 0",
  DEPOT_NEGATIVE: "depot_stock < 0",
  DEPOT_NO_ROW: "depot_stock IS NULL",
  DEPOT_NOT_POSITIVE: "depot_stock IS NULL OR depot_stock <= 0",
  SUGGESTION_EXCEEDS_DEPOT:
    "suggested_quantity IS NOT NULL AND depot_stock IS NOT NULL AND suggested_quantity > depot_stock",
  SUPPLY_DEPOT: "supply_mode = 'DEPOT'",
  SUPPLY_DIRECT_SUPPLIER: "supply_mode = 'DIRECT_SUPPLIER'",
  SUPPLY_UNDEFINED: "supply_mode = 'UNDEFINED'",
};
const orderBy: Record<WeeklyReplenishmentSort, string> = {
  SUGGESTED_DESC: "suggested_quantity DESC NULLS LAST",
  DEMAND_DESC: "weekly_demand DESC NULLS LAST",
  STOCK_ASC: "stock_current ASC",
  DEPOT_GAP_DESC:
    "(suggested_quantity - COALESCE(depot_stock, 0)) DESC NULLS LAST",
};

export async function getWeeklyReplenishment(options: {
  scope: Scope;
  depotSourceId: string;
  planningDate: string;
  search?: string;
  status?: WeeklyReplenishmentStatus;
  filter?: WeeklyReplenishmentFilter;
  sort?: WeeklyReplenishmentSort;
  limit: number;
  offset: number;
}) {
  const filterClause = options.filter
    ? `AND (${filterConditions[options.filter]})`
    : "";
  const sortClause = orderBy[options.sort ?? "SUGGESTED_DESC"];
  const result = await query<{
    article_id: number;
    description: string | null;
    supplier_code: string | null;
    classification_code: string | null;
    unit_measure: string | null;
    stock_current: string;
    depot_stock: string | null;
    weekly_demand: string;
    weekly_average: string;
    weekly_max: string;
    weekly_min: string;
    active_weeks: string;
    target_stock: string | null;
    suggested_quantity: string | null;
    status: WeeklyReplenishmentStatus;
    supply_mode: SupplyMode;
    total_rows: string;
  }>(
    `
    WITH analysis_window AS (
      SELECT date_trunc('week', $1::date)::date - interval '${WEEKLY_REPLENISHMENT_WEEKS} weeks' AS from_date,
        date_trunc('week', $1::date)::date AS to_date
    ), sales AS (
      SELECT btrim(m.idarti)::integer AS article_id, date_trunc('week', m.fedepo::timestamp)::date AS week_start, SUM(m.cantidad) AS quantity
      FROM stock_movements_raw m CROSS JOIN analysis_window w
      WHERE m.organization_id = $2 AND m.source_id = $3 AND m.branch_id = $4
        AND TRIM(m.tipomov) = 'VT' AND TRIM(m.codcom) IN ('TICK', 'PRES', 'FACV')
        AND m.fedepo::timestamp >= w.from_date AND m.fedepo::timestamp < w.to_date
      GROUP BY 1, 2
    ), active_articles AS (
      SELECT DISTINCT btrim(m.idarti)::integer AS article_id
      FROM stock_movements_raw m CROSS JOIN analysis_window w
      WHERE m.organization_id = $2 AND m.source_id = $3 AND m.branch_id = $4
        AND TRIM(m.tipomov) = 'VT' AND TRIM(m.codcom) IN ('TICK', 'PRES', 'FACV') AND m.fedepo::timestamp < w.to_date
    ), weeks AS (
      SELECT generate_series(w.from_date, w.to_date - interval '1 week', interval '1 week')::date AS week_start FROM analysis_window w
    ), stock_pv AS (
      SELECT article_id, SUM(saldo) AS current_stock FROM stock_levels_raw
      WHERE organization_id = $2 AND source_id = $3 AND branch_id = $4 GROUP BY article_id
    ), stock_depot AS (
      SELECT article_id, SUM(saldo) AS depot_stock FROM stock_levels_raw
      WHERE organization_id = $2 AND source_id = $5 AND branch_id = ${DEPOT_BRANCH_ID} GROUP BY article_id
    ), metrics AS (
      SELECT a.article_id, COUNT(*) FILTER (WHERE COALESCE(s.quantity, 0) > 0) AS active_weeks,
        percentile_cont(.5) WITHIN GROUP (ORDER BY COALESCE(s.quantity, 0)) AS weekly_demand,
        AVG(COALESCE(s.quantity, 0)) AS weekly_average, MAX(COALESCE(s.quantity, 0)) AS weekly_max, MIN(COALESCE(s.quantity, 0)) AS weekly_min
      FROM active_articles a CROSS JOIN weeks w LEFT JOIN sales s ON s.article_id = a.article_id AND s.week_start = w.week_start
      GROUP BY a.article_id
    ), items AS (
      SELECT p.article_id, p.payload->>'Descripcion' AS description, p.payload->>'Proveedor' AS supplier_code,
        p.payload->>'Clasificacion' AS classification_code, p.payload->>'UnidadMedida' AS unit_measure,
        COALESCE(sp.current_stock, 0) AS stock_current, sd.depot_stock, m.weekly_demand, m.weekly_average, m.weekly_max, m.weekly_min, m.active_weeks,
        COALESCE(sr.supply_mode, 'UNDEFINED') AS supply_mode,
        CASE WHEN COALESCE(sp.current_stock, 0) < 0 THEN 'NEGATIVE_STOCK'
          WHEN m.active_weeks = 0 THEN 'NO_DEMAND'
          WHEN m.active_weeks < 3 THEN 'INSUFFICIENT_HISTORY'
          WHEN m.weekly_max - m.weekly_demand >= 20 AND (m.weekly_demand = 0 OR m.weekly_max >= m.weekly_demand * 3) THEN 'IRREGULAR_DEMAND'
          WHEN GREATEST(0, m.weekly_demand - COALESCE(sp.current_stock, 0)) > 0 THEN 'SUGGESTION_AVAILABLE' ELSE 'NO_SUGGESTION' END AS status
      FROM metrics m JOIN products_raw p ON p.article_id = m.article_id AND p.organization_id = $2 AND p.source_id = $3 AND p.branch_id = $4
      LEFT JOIN stock_pv sp ON sp.article_id = m.article_id LEFT JOIN stock_depot sd ON sd.article_id = m.article_id
      LEFT JOIN branch_product_supply_rules sr ON sr.organization_id = $2 AND sr.branch_id = $4 AND sr.article_id = m.article_id
      WHERE p.is_present
    )
    SELECT *, COUNT(*) OVER() AS total_rows FROM (
      SELECT *, CASE WHEN status IN ('NEGATIVE_STOCK', 'INSUFFICIENT_HISTORY', 'IRREGULAR_DEMAND') THEN NULL
        ELSE weekly_demand END AS target_stock,
        CASE WHEN status IN ('NEGATIVE_STOCK', 'INSUFFICIENT_HISTORY', 'IRREGULAR_DEMAND') THEN NULL
        ELSE GREATEST(0, weekly_demand - stock_current) END AS suggested_quantity
      FROM items
    ) decisions
    WHERE ($6::text IS NULL OR description ILIKE $6 OR article_id::text ILIKE $6 OR supplier_code ILIKE $6 OR classification_code ILIKE $6)
      AND ($7::text IS NULL OR status = $7) ${filterClause}
    ORDER BY ${sortClause}, article_id ASC
    LIMIT $8 OFFSET $9
  `,
    [
      options.planningDate,
      options.scope.organizationId,
      options.scope.sourceId,
      options.scope.branchId,
      options.depotSourceId,
      options.search ? `%${options.search}%` : null,
      options.status ?? null,
      options.limit,
      options.offset,
    ],
  );

  return {
    planning_date: options.planningDate,
    location: {
      branch_id: options.scope.branchId,
      label: `Sucursal ${options.scope.branchId}`,
    },
    window_weeks: WEEKLY_REPLENISHMENT_WEEKS,
    total: result.rows[0] ? Number(result.rows[0].total_rows) : 0,
    items: result.rows.map((row) => {
      const stockDepot = numberOrNull(row.depot_stock);
      const depotState = depotStockState(stockDepot);
      const activeWeeks = Number(row.active_weeks);
      const stockCurrent = Number(row.stock_current);
      const warnings = [
        ...(stockCurrent < 0 ? ["NEGATIVE_STOCK"] : []),
        ...(activeWeeks < 3 ? ["INSUFFICIENT_HISTORY"] : []),
        ...(row.status === "IRREGULAR_DEMAND" ? ["IRREGULAR_DEMAND"] : []),
        depotState,
      ];
      return {
        article_id: row.article_id,
        description: row.description,
        supplier_code: row.supplier_code,
        classification_code: row.classification_code,
        unit_measure: row.unit_measure,
        stock_current: stockCurrent,
        stock_depot: stockDepot,
        depot_stock_state: depotState,
        weekly_demand: Number(row.weekly_demand),
        weekly_average: Number(row.weekly_average),
        weekly_max: Number(row.weekly_max),
        weekly_min: Number(row.weekly_min),
        active_weeks: activeWeeks,
        target_stock: numberOrNull(row.target_stock),
        suggested_quantity: numberOrNull(row.suggested_quantity),
        requested_quantity: numberOrNull(row.suggested_quantity) ?? 0,
        status: row.status,
        supply_mode: row.supply_mode,
        warnings,
        fulfillment_type:
          depotState === "DEPOT_NO_ROW"
            ? "SUPPLIER_PURCHASE_CANDIDATE"
            : depotState === "DEPOT_STOCK_POSITIVE"
              ? "INTERNAL_REPLENISHMENT_CANDIDATE"
              : "DEPOT_REVIEW_REQUIRED",
      } satisfies WeeklyReplenishmentItem;
    }),
  };
}
