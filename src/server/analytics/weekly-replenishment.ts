import { query } from "@/server/db/client";
import type { Scope } from "@/server/analytics/types";
import {
  depotStockState,
  type DepotStockState,
  type WeeklyReplenishmentStatus,
  REPLENISHMENT_COVERAGE_DAYS,
  DAYS_IN_WEEK,
} from "./weekly-replenishment-rules";
import type { SupplyMode } from "@/server/supply/branch-supply-rules";
import { SQL_RUBRO_EXPRESSION } from "@/server/catalog/rubros";
import { resolveProductPresentation } from "@/server/catalog/presentations";
import { isUndefinedRelationError } from "@/server/catalog/history-cutoffs";

export const WEEKLY_REPLENISHMENT_WEEKS = 6;

export const DEPOT_BRANCH_ID = 1;

export type WeeklyReplenishmentItem = {
  article_id: number;
  description: string | null;
  supplier_code: string | null;
  classification_code: string | null;
  rubro?: string | null;
  unit_measure: string | null;
  package_units?: number | null;
  presentation?: string | null;
  presentation_display?: string | null;
  is_active?: boolean;
  stock_current: number;
  stock_depot: number | null;
  depot_stock_state: DepotStockState;
  weekly_demand: number | null;
  weekly_average: number | null;
  weekly_max: number | null;
  weekly_min: number | null;
  active_weeks: number;
  base_stock?: number | null;
  pending_order_quantity?: number;
  depot_committed_quantity?: number;
  history_cutoff_date?: string | null;
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
  | "SUPPLY_UNDEFINED"
  | "TO_REPLENISH"
  | "INACTIVE";
export type WeeklyReplenishmentSort =
  | "SUGGESTED_DESC"
  | "DEMAND_DESC"
  | "STOCK_ASC"
  | "DEPOT_GAP_DESC"
  | "RUBRO_ASC";

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
  TO_REPLENISH:
    "status IN ('SUGGESTION_AVAILABLE', 'NEGATIVE_STOCK') AND supply_mode IN ('DEPOT', 'UNDEFINED')",
  INACTIVE: "is_active = false",
};
const orderBy: Record<WeeklyReplenishmentSort, string> = {
  SUGGESTED_DESC: "suggested_quantity DESC NULLS LAST, description ASC",
  DEMAND_DESC: "weekly_demand DESC NULLS LAST, description ASC",
  STOCK_ASC: "stock_current ASC, description ASC",
  DEPOT_GAP_DESC:
    "(suggested_quantity - COALESCE(depot_stock, 0)) DESC NULLS LAST, description ASC",
  RUBRO_ASC:
    "CASE WHEN rubro IS NULL OR btrim(rubro) = '' OR UPPER(btrim(rubro)) IN ('SIN RUBRO', '__SIN_RUBRO__') THEN 1 ELSE 0 END ASC, LOWER(rubro) ASC, LOWER(description) ASC, article_id ASC",
};

type WeeklyReplenishmentSqlRow = {
  article_id: number;
  description: string | null;
  supplier_code: string | null;
  classification_code: string | null;
  rubro: string | null;
  unit_measure: string | null;
  bulto_raw: string | null;
  is_active: boolean;
  stock_current: string;
  depot_stock: string | null;
  weekly_demand: string;
  weekly_average: string;
  weekly_max: string;
  weekly_min: string;
  active_weeks: string;
  base_stock: string | null;
  pending_order_quantity: string;
  depot_committed_quantity: string;
  history_cutoff_date: string | null;
  target_stock: string | null;
  suggested_quantity: string | null;
  status: WeeklyReplenishmentStatus;
  supply_mode: SupplyMode;
  total_rows: string;
};

function buildWeeklyReplenishmentQuery(params: {
  filterClause: string;
  activeClause: string;
  rubroClause: string;
  supplierClause: string;
  sortClause: string;
  includeBaseStockTable: boolean;
  includeCutoffsTable: boolean;
  includeOrdersTables: boolean;
}): string {
  const cutoffJoin = params.includeCutoffsTable
    ? `LEFT JOIN branch_product_history_cutoffs hc
         ON hc.organization_id = $2
        AND hc.branch_id = $4
        AND hc.article_id = (CASE WHEN btrim(m.idarti) ~ '^[0-9]+$' THEN btrim(m.idarti)::integer ELSE NULL END)`
    : "";
  const cutoffSalesFilter = params.includeCutoffsTable
    ? `AND (hc.cutoff_date IS NULL OR m.fedepo::date >= hc.cutoff_date)`
    : "";

  const baseStockCte = params.includeBaseStockTable
    ? `, base_stock_cfg AS (
      SELECT article_id, base_stock
      FROM branch_product_base_stock
      WHERE organization_id = $2 AND branch_id = $4
    )`
    : `, base_stock_cfg AS (
      SELECT NULL::integer AS article_id, NULL::numeric AS base_stock WHERE false
    )`;

  const cutoffsCte = params.includeCutoffsTable
    ? `, cutoffs_cfg AS (
      SELECT article_id, cutoff_date
      FROM branch_product_history_cutoffs
      WHERE organization_id = $2 AND branch_id = $4
    )`
    : `, cutoffs_cfg AS (
      SELECT NULL::integer AS article_id, NULL::date AS cutoff_date WHERE false
    )`;

  const ordersCtes = params.includeOrdersTables
    ? `, pending_orders AS (
      SELECT oi.article_id,
        SUM(
          CASE
            WHEN o.status IN ('DISPATCHED', 'PARTIALLY_RECEIVED') THEN
              GREATEST(
                0,
                COALESCE(oi.dispatched_quantity, oi.prepared_quantity, oi.approved_quantity, oi.requested_quantity) - COALESCE(oi.received_quantity, 0)
              )
            ELSE
              GREATEST(0, COALESCE(oi.approved_quantity, oi.requested_quantity))
          END
        ) AS pending_qty
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      WHERE o.organization_id = $2
        AND COALESCE(o.origin_branch_id, o.branch_id) = $4
        AND (
          o.status IN ('CONFIRMED', 'RECEIVED_BY_WAREHOUSE', 'IN_PREPARATION', 'PARTIALLY_PREPARED', 'PREPARED')
          OR (
            o.status IN ('DISPATCHED', 'PARTIALLY_RECEIVED')
            AND COALESCE(o.updated_at, o.created_at)::date >= ($1::date - interval '14 days')
            AND COALESCE(o.updated_at, o.created_at)::date <= ($1::date + interval '2 days')
          )
        )
      GROUP BY oi.article_id
    ), depot_committed AS (
      SELECT oi.article_id,
        SUM(GREATEST(0, COALESCE(oi.approved_quantity, oi.requested_quantity))) AS committed_qty
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      WHERE o.organization_id = $2
        AND o.destination_branch_id = ${DEPOT_BRANCH_ID}
        AND o.status IN ('CONFIRMED', 'RECEIVED_BY_WAREHOUSE', 'IN_PREPARATION', 'PARTIALLY_PREPARED', 'PREPARED')
      GROUP BY oi.article_id
    )`
    : `, pending_orders AS (
      SELECT NULL::integer AS article_id, 0::numeric AS pending_qty WHERE false
    ), depot_committed AS (
      SELECT NULL::integer AS article_id, 0::numeric AS committed_qty WHERE false
    )`;

  return `
    WITH analysis_window AS (
      SELECT date_trunc('week', $1::date)::date - interval '${WEEKLY_REPLENISHMENT_WEEKS} weeks' AS from_date,
        date_trunc('week', $1::date)::date AS to_date,
        date_trunc('week', $1::date - interval '1 year')::date - interval '${WEEKLY_REPLENISHMENT_WEEKS} weeks' AS yoy_from_date,
        date_trunc('week', $1::date - interval '1 year')::date AS yoy_to_date
    ), sales AS (
      SELECT btrim(m.idarti)::integer AS article_id, date_trunc('week', m.fedepo::timestamp)::date AS week_start, SUM(m.cantidad) AS quantity
      FROM stock_movements_raw m
      CROSS JOIN analysis_window w
      ${cutoffJoin}
      WHERE m.organization_id = $2 AND m.source_id = $3 AND m.branch_id = $4
        AND TRIM(m.tipomov) = 'VT' AND TRIM(m.codcom) IN ('TICK', 'PRES', 'FACV')
        AND ((m.fedepo::timestamp >= w.from_date AND m.fedepo::timestamp < w.to_date) OR (m.fedepo::timestamp >= w.yoy_from_date AND m.fedepo::timestamp < w.yoy_to_date))
        ${cutoffSalesFilter}
      GROUP BY 1, 2
    ), active_articles AS (
      SELECT DISTINCT btrim(m.idarti)::integer AS article_id
      FROM stock_movements_raw m
      CROSS JOIN analysis_window w
      ${cutoffJoin}
      WHERE m.organization_id = $2 AND m.source_id = $3 AND m.branch_id = $4
        AND TRIM(m.tipomov) = 'VT' AND TRIM(m.codcom) IN ('TICK', 'PRES', 'FACV') AND m.fedepo::timestamp < w.to_date
        ${cutoffSalesFilter}
    ), weeks AS (
      SELECT generate_series(w.from_date, w.to_date - interval '1 week', interval '1 week')::date AS week_start FROM analysis_window w
    ), yoy_weeks AS (
      SELECT generate_series(w.yoy_from_date, w.yoy_to_date - interval '1 week', interval '1 week')::date AS week_start FROM analysis_window w
    ), stock_pv AS (
      SELECT article_id, SUM(saldo) AS current_stock FROM stock_levels_raw
      WHERE organization_id = $2 AND source_id = $3 AND branch_id = $4 GROUP BY article_id
    ), stock_depot AS (
      SELECT article_id, SUM(saldo) AS depot_stock FROM stock_levels_raw
      WHERE organization_id = $2 AND source_id = $5 AND branch_id = ${DEPOT_BRANCH_ID} GROUP BY article_id
    )${baseStockCte}${cutoffsCte}${ordersCtes}, current_metrics AS (
      SELECT a.article_id, COUNT(*) FILTER (WHERE COALESCE(s.quantity, 0) > 0) AS active_weeks,
        percentile_cont(.5) WITHIN GROUP (ORDER BY COALESCE(s.quantity, 0)) AS weekly_demand,
        AVG(COALESCE(s.quantity, 0)) AS weekly_average, MAX(COALESCE(s.quantity, 0)) AS weekly_max, MIN(COALESCE(s.quantity, 0)) AS weekly_min
      FROM active_articles a CROSS JOIN weeks w LEFT JOIN sales s ON s.article_id = a.article_id AND s.week_start = w.week_start
      GROUP BY a.article_id
    ), yoy_metrics AS (
      SELECT a.article_id, percentile_cont(.5) WITHIN GROUP (ORDER BY COALESCE(s.quantity, 0)) AS weekly_demand_yoy
      FROM active_articles a CROSS JOIN yoy_weeks w LEFT JOIN sales s ON s.article_id = a.article_id AND s.week_start = w.week_start
      GROUP BY a.article_id
    ), metrics AS (
      SELECT cm.article_id, cm.active_weeks, GREATEST(cm.weekly_demand, COALESCE(ym.weekly_demand_yoy, 0)) AS weekly_demand, cm.weekly_average, cm.weekly_max, cm.weekly_min
      FROM current_metrics cm LEFT JOIN yoy_metrics ym ON ym.article_id = cm.article_id
    ), catalog_products AS (
      SELECT DISTINCT ON (p.article_id)
        p.article_id,
        p.payload->>'Descripcion' AS description,
        NULLIF(btrim(p.payload->>'Proveedor'), '') AS supplier_code,
        p.payload->>'Clasificacion' AS classification_code,
        ${SQL_RUBRO_EXPRESSION} AS rubro,
        p.payload->>'UnidadMedida' AS unit_measure,
        p.payload->>'Bulto' AS bulto_raw,
        COALESCE(NULLIF(btrim(p.payload->>'Estado'), ''), '1') = '1' AS is_active
      FROM products_raw p
      WHERE p.organization_id = $2 AND p.source_id = $3 AND p.branch_id = $4 AND p.is_present
      ORDER BY p.article_id, p.is_present DESC
    ), items_base AS (
      SELECT
        p.article_id,
        p.description,
        p.supplier_code,
        p.classification_code,
        p.rubro,
        p.unit_measure,
        p.bulto_raw,
        p.is_active,
        COALESCE(sp.current_stock, 0) AS stock_current,
        sd.depot_stock,
        COALESCE(m.weekly_demand, 0) AS weekly_demand,
        COALESCE(m.weekly_average, 0) AS weekly_average,
        COALESCE(m.weekly_max, 0) AS weekly_max,
        COALESCE(m.weekly_min, 0) AS weekly_min,
        COALESCE(m.active_weeks, 0) AS active_weeks,
        bs.base_stock,
        COALESCE(po.pending_qty, 0) AS pending_order_quantity,
        COALESCE(dc.committed_qty, 0) AS depot_committed_quantity,
        cc.cutoff_date::text AS history_cutoff_date,
        COALESCE(sr.supply_mode, 'UNDEFINED') AS supply_mode,
        CASE WHEN UPPER(p.unit_measure) IN ('KG', 'KILO', 'KILOS', 'L', 'LITRO', 'LITROS') THEN false ELSE true END AS is_discrete
      FROM catalog_products p
      LEFT JOIN metrics m ON m.article_id = p.article_id
      LEFT JOIN stock_pv sp ON sp.article_id = p.article_id
      LEFT JOIN stock_depot sd ON sd.article_id = p.article_id
      LEFT JOIN branch_product_supply_rules sr ON sr.organization_id = $2 AND sr.branch_id = $4 AND sr.article_id = p.article_id
      LEFT JOIN base_stock_cfg bs ON bs.article_id = p.article_id
      LEFT JOIN cutoffs_cfg cc ON cc.article_id = p.article_id
      LEFT JOIN pending_orders po ON po.article_id = p.article_id
      LEFT JOIN depot_committed dc ON dc.article_id = p.article_id
    ), target_calc AS (
      SELECT *,
        (weekly_demand * ${REPLENISHMENT_COVERAGE_DAYS}::numeric / ${DAYS_IN_WEEK}::numeric) AS demand_10d,
        (
          active_weeks >= 3
          AND weekly_max - (CASE WHEN is_discrete THEN CEIL(weekly_demand) ELSE weekly_demand END) >= 20
          AND (
            (CASE WHEN is_discrete THEN CEIL(weekly_demand) ELSE weekly_demand END) = 0
            OR weekly_max >= (CASE WHEN is_discrete THEN CEIL(weekly_demand) ELSE weekly_demand END) * 3
          )
        ) AS irregular_demand
      FROM items_base
    ), target_resolved AS (
      SELECT *,
        CASE WHEN is_discrete THEN CEIL(demand_10d) ELSE demand_10d END AS demand_target_calc,
        CASE
          WHEN base_stock IS NOT NULL THEN
            GREATEST(
              CASE WHEN active_weeks >= 3 AND NOT irregular_demand
                THEN (CASE WHEN is_discrete THEN CEIL(demand_10d) ELSE demand_10d END)
                ELSE 0
              END,
              base_stock
            )
          WHEN active_weeks = 0 THEN 0
          ELSE (CASE WHEN is_discrete THEN CEIL(demand_10d) ELSE demand_10d END)
        END AS effective_target
      FROM target_calc
    ), items AS (
      SELECT article_id, description, supplier_code, classification_code, rubro, unit_measure, bulto_raw, is_active,
        stock_current, depot_stock, weekly_demand,
        effective_target AS target_stock_calc,
        weekly_average, weekly_max, weekly_min, active_weeks, base_stock,
        pending_order_quantity, depot_committed_quantity, history_cutoff_date,
        supply_mode, is_discrete,
        CASE
          WHEN stock_current < 0 THEN 'NEGATIVE_STOCK'
          WHEN base_stock IS NOT NULL THEN
            CASE
              WHEN active_weeks = 0 AND base_stock = 0 THEN 'NO_DEMAND'
              WHEN irregular_demand AND (stock_current + pending_order_quantity) >= base_stock THEN 'IRREGULAR_DEMAND'
              WHEN (
                CASE WHEN is_discrete
                  THEN CEIL(GREATEST(0, effective_target - (stock_current + pending_order_quantity)))
                  ELSE GREATEST(0, effective_target - (stock_current + pending_order_quantity))
                END
              ) > 0 THEN 'SUGGESTION_AVAILABLE'
              ELSE 'NO_SUGGESTION'
            END
          WHEN active_weeks = 0 THEN 'NO_DEMAND'
          WHEN active_weeks < 3 THEN 'INSUFFICIENT_HISTORY'
          WHEN irregular_demand THEN 'IRREGULAR_DEMAND'
          WHEN (
            CASE WHEN is_discrete
              THEN CEIL(GREATEST(0, effective_target - (stock_current + pending_order_quantity)))
              ELSE GREATEST(0, effective_target - (stock_current + pending_order_quantity))
            END
          ) > 0 THEN 'SUGGESTION_AVAILABLE'
          ELSE 'NO_SUGGESTION'
        END AS status
      FROM target_resolved
    )
    SELECT *, COUNT(*) OVER() AS total_rows FROM (
      SELECT article_id, description, supplier_code, classification_code, rubro, unit_measure, bulto_raw, is_active,
        stock_current, depot_stock, weekly_demand, weekly_average, weekly_max, weekly_min,
        active_weeks, base_stock, pending_order_quantity, depot_committed_quantity, history_cutoff_date,
        supply_mode, status,
        CASE WHEN status IN ('NEGATIVE_STOCK', 'INSUFFICIENT_HISTORY', 'IRREGULAR_DEMAND') THEN NULL
        ELSE target_stock_calc END AS target_stock,
        CASE WHEN status IN ('NEGATIVE_STOCK', 'INSUFFICIENT_HISTORY', 'IRREGULAR_DEMAND') THEN NULL
        WHEN is_discrete THEN CEIL(GREATEST(0, target_stock_calc - (stock_current + pending_order_quantity)))
        ELSE GREATEST(0, target_stock_calc - (stock_current + pending_order_quantity)) END AS suggested_quantity
      FROM items
    ) decisions
    WHERE ($6::text IS NULL OR description ILIKE $6 OR article_id::text ILIKE $6 OR supplier_code ILIKE $6 OR classification_code ILIKE $6 OR rubro ILIKE $6)
      AND ($7::text IS NULL OR status = $7)
      ${params.activeClause} ${params.filterClause} ${params.rubroClause} ${params.supplierClause}
    ORDER BY ${params.sortClause}, article_id ASC
    LIMIT $8 OFFSET $9
  `;
}

export async function getWeeklyReplenishment(options: {
  scope: Scope;
  depotSourceId: string;
  planningDate: string;
  search?: string;
  status?: WeeklyReplenishmentStatus;
  filter?: WeeklyReplenishmentFilter;
  sort?: WeeklyReplenishmentSort;
  rubro?: string;
  supplier?: string;
  includeInactive?: boolean;
  limit: number;
  offset: number;
}) {
  const filterClause = options.filter
    ? `AND (${filterConditions[options.filter]})`
    : "";
  const activeClause =
    options.filter === "INACTIVE" || options.includeInactive
      ? ""
      : "AND is_active = true";
  const sortClause = orderBy[options.sort ?? "SUGGESTED_DESC"];

  const values: unknown[] = [
    options.planningDate,
    options.scope.organizationId,
    options.scope.sourceId,
    options.scope.branchId,
    options.depotSourceId,
    options.search ? `%${options.search}%` : null,
    options.status ?? null,
    options.limit,
    options.offset,
  ];

  let rubroClause = "";
  if (
    options.rubro === "__SIN_RUBRO__" ||
    options.rubro === "SIN_RUBRO" ||
    options.rubro === "SIN RUBRO"
  ) {
    rubroClause = "AND (rubro IS NULL OR rubro = '' OR rubro = 'SIN RUBRO')";
  } else if (options.rubro) {
    values.push(options.rubro);
    rubroClause = `AND rubro = $${values.length}`;
  }

  let supplierClause = "";
  if (
    options.supplier === "__SIN_PROVEEDOR__" ||
    options.supplier === "SIN_PROVEEDOR" ||
    options.supplier === "SIN PROVEEDOR"
  ) {
    supplierClause = "AND (supplier_code IS NULL OR supplier_code = '' OR supplier_code = 'SIN PROVEEDOR')";
  } else if (options.supplier) {
    values.push(options.supplier);
    supplierClause = `AND supplier_code = $${values.length}`;
  }

  let includeBaseStockTable = true;
  let includeCutoffsTable = true;
  let includeOrdersTables = true;

  let result;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const sql = buildWeeklyReplenishmentQuery({
        filterClause,
        activeClause,
        rubroClause,
        supplierClause,
        sortClause,
        includeBaseStockTable,
        includeCutoffsTable,
        includeOrdersTables,
      });
      result = await query<WeeklyReplenishmentSqlRow>(sql, values);
      break;
    } catch (error) {
      if (!isUndefinedRelationError(error)) {
        throw error;
      }
      const message = (error as Error).message ?? "";
      let changed = false;
      if (includeBaseStockTable && message.includes("branch_product_base_stock")) {
        includeBaseStockTable = false;
        changed = true;
      }
      if (includeCutoffsTable && message.includes("branch_product_history_cutoffs")) {
        includeCutoffsTable = false;
        changed = true;
      }
      if (
        includeOrdersTables &&
        (message.includes("order_items") || message.includes("orders"))
      ) {
        includeOrdersTables = false;
        changed = true;
      }
      if (!changed) {
        includeBaseStockTable = false;
        includeCutoffsTable = false;
        includeOrdersTables = false;
      }
    }
  }

  if (!result) {
    throw new Error("No se pudo calcular la reposición semanal.");
  }

  let rubros: string[] = [];
  try {
    const rubrosResult = await query<{ rubro: string }>(
      `SELECT DISTINCT ${SQL_RUBRO_EXPRESSION} AS rubro
       FROM products_raw p
       WHERE p.organization_id = $1 AND p.source_id = $2 AND p.branch_id = $3 AND p.is_present
       ORDER BY rubro ASC`,
      [options.scope.organizationId, options.scope.sourceId, options.scope.branchId]
    );
    rubros = rubrosResult.rows.map((r) => r.rubro).filter(Boolean);
  } catch {
    // Graceful fallback if distinct query fails in isolated test fixtures
  }

  let suppliers: string[] = [];
  try {
    const suppliersResult = await query<{ supplier: string }>(
      `SELECT DISTINCT btrim(p.payload->>'Proveedor') AS supplier
       FROM products_raw p
       WHERE p.organization_id = $1 AND p.source_id = $2 AND p.branch_id = $3 AND p.is_present
         AND NULLIF(btrim(p.payload->>'Proveedor'), '') IS NOT NULL
       ORDER BY supplier ASC`,
      [options.scope.organizationId, options.scope.sourceId, options.scope.branchId]
    );
    suppliers = suppliersResult.rows.map((r) => r.supplier).filter(Boolean);
  } catch {
    // Graceful fallback if distinct query fails in isolated test fixtures
  }

  const branchLabel =
    options.scope.branchId === 2
      ? "Centro"
      : options.scope.branchId === 3
        ? "Jardín"
        : options.scope.branchId === 1
          ? "Depósito"
          : `Sucursal ${options.scope.branchId}`;

  return {
    planning_date: options.planningDate,
    location: {
      branch_id: options.scope.branchId,
      label: branchLabel,
    },
    window_weeks: WEEKLY_REPLENISHMENT_WEEKS,
    coverage_days: REPLENISHMENT_COVERAGE_DAYS,
    total: result.rows[0] ? Number(result.rows[0].total_rows) : 0,
    rubros,
    suppliers,
    items: result.rows.map((row): WeeklyReplenishmentItem => {
      const stockDepot = numberOrNull(row.depot_stock);
      const depotState = depotStockState(stockDepot);
      const activeWeeks = Number(row.active_weeks);
      const stockCurrent = Number(row.stock_current);
      const presentation = resolveProductPresentation({
        bulto: row.bulto_raw,
        unitMeasure: row.unit_measure,
      });
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
        rubro: row.rubro ?? null,
        unit_measure: row.unit_measure,
        package_units: presentation.packageUnits,
        presentation: presentation.presentation,
        presentation_display: presentation.displayText,
        is_active: row.is_active,
        stock_current: stockCurrent,
        stock_depot: stockDepot,
        depot_stock_state: depotState,
        weekly_demand: Number(row.weekly_demand),
        weekly_average: Number(row.weekly_average),
        weekly_max: Number(row.weekly_max),
        weekly_min: Number(row.weekly_min),
        active_weeks: activeWeeks,
        base_stock: numberOrNull(row.base_stock),
        pending_order_quantity: Number(row.pending_order_quantity ?? 0),
        depot_committed_quantity: Number(row.depot_committed_quantity ?? 0),
        history_cutoff_date: row.history_cutoff_date ?? null,
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
      };
    }),
  };
}
