import { query } from "@/server/db/client";
import { signedQuantitySql } from "@/server/analytics/signed-quantity";
import type { FreshnessStatus, Granularity, Period, Scope } from "@/server/analytics/types";

const scopeWhere = "source_id = $1 AND branch_id = $2 AND ($3::integer IS NULL OR organization_id = $3)";
const movementScopeWhere = `m.source_id = $1 AND m.branch_id = $2 AND ($3::integer IS NULL OR m.organization_id = $3)`;

function scopeValues(scope: Scope): [string, number, number | null] {
  return [scope.sourceId, scope.branchId, scope.organizationId ?? null];
}

function numeric(value: string | number | null): number {
  return value === null ? 0 : Number(value);
}

export async function getOverview(scope: Scope, period: Period) {
  const result = await query<{
    net_units: string;
    movements: string;
    previous_net_units: string;
    stock_total: string;
    products_without_stock: string;
    active_products: string;
    last_updated_at: string | null;
  }>(`
    WITH current_period AS (
      SELECT COALESCE(SUM(${signedQuantitySql}), 0) AS net_units, COUNT(*) AS movements
      FROM stock_movements_raw m
      WHERE ${movementScopeWhere}
        AND m.fedepo::timestamp >= $4::date
        AND m.fedepo::timestamp < $5::date
    ), previous_period AS (
      SELECT COALESCE(SUM(${signedQuantitySql}), 0) AS net_units
      FROM stock_movements_raw m
      WHERE ${movementScopeWhere}
        AND m.fedepo::timestamp >= $6::date
        AND m.fedepo::timestamp < $7::date
    ), stock_by_product AS (
      SELECT article_id, SUM(saldo) AS saldo
      FROM stock_levels_raw
      WHERE ${scopeWhere}
      GROUP BY article_id
    )
    SELECT
      current_period.net_units,
      current_period.movements,
      previous_period.net_units AS previous_net_units,
      COALESCE((SELECT SUM(saldo) FROM stock_by_product), 0) AS stock_total,
      COALESCE((SELECT COUNT(*) FROM stock_by_product WHERE saldo <= 0), 0) AS products_without_stock,
      (SELECT COUNT(*) FROM products_raw WHERE ${scopeWhere} AND is_present) AS active_products,
      GREATEST(
        (SELECT MAX(received_at) FROM stock_movements_raw WHERE ${scopeWhere}),
        (SELECT MAX(source_seen_at) FROM stock_levels_raw WHERE ${scopeWhere}),
        (SELECT MAX(source_seen_at) FROM products_raw WHERE ${scopeWhere})
      ) AS last_updated_at
    FROM current_period CROSS JOIN previous_period
  `, [...scopeValues(scope), period.from, period.toExclusive, period.previousFrom, period.previousToExclusive]);

  const row = result.rows[0];
  const netUnits = numeric(row.net_units);
  const previousNetUnits = numeric(row.previous_net_units);
  const variationPercent = previousNetUnits === 0 ? null : ((netUnits - previousNetUnits) / Math.abs(previousNetUnits)) * 100;

  return {
    period: { from: period.from, to: period.to },
    net_units: netUnits,
    movements: Number(row.movements),
    variation_vs_previous_percent: variationPercent,
    previous_net_units: previousNetUnits,
    stock_total: numeric(row.stock_total),
    products_without_stock: Number(row.products_without_stock),
    active_products: Number(row.active_products),
    last_updated_at: row.last_updated_at,
  };
}

export async function getTimeseries(scope: Scope, period: Period, granularity: Granularity) {
  const truncation = { day: "day", week: "week", month: "month" }[granularity];
  const result = await query<{ date: string; net_units: string; movements: string }>(`
    SELECT
      to_char(date_trunc('${truncation}', m.fedepo::timestamp), 'YYYY-MM-DD') AS date,
      COALESCE(SUM(${signedQuantitySql}), 0) AS net_units,
      COUNT(*) AS movements
    FROM stock_movements_raw m
    WHERE ${movementScopeWhere}
      AND m.fedepo::timestamp >= $4::date
      AND m.fedepo::timestamp < $5::date
    GROUP BY 1
    ORDER BY 1
  `, [...scopeValues(scope), period.from, period.toExclusive]);

  return result.rows.map((row) => ({
    date: row.date,
    net_units: numeric(row.net_units),
    movements: Number(row.movements),
  }));
}

export async function getTopProducts(scope: Scope, period: Period, limit: number, search?: string) {
  const values: unknown[] = [...scopeValues(scope), period.from, period.toExclusive];
  const searchClause = search
    ? `AND (COALESCE(p.payload->>'Descripcion', '') ILIKE $6 OR COALESCE(p.payload->>'Marca', '') ILIKE $6)`
    : "";
  if (search) values.push(`%${search}%`);
  values.push(limit);
  const limitParameter = search ? "$7" : "$6";

  const result = await query<{
    article_id: number;
    description: string | null;
    brand: string | null;
    bulto: string | null;
    unit_measure: string | null;
    net_units: string;
    movements: string;
  }>(`
    SELECT
      p.article_id,
      p.payload->>'Descripcion' AS description,
      p.payload->>'Marca' AS brand,
      p.payload->>'Bulto' AS bulto,
      p.payload->>'UnidadMedida' AS unit_measure,
      COALESCE(SUM(${signedQuantitySql}), 0) AS net_units,
      COUNT(*) AS movements
    FROM stock_movements_raw m
    JOIN products_raw p
      ON p.source_id = m.source_id
      AND p.article_id = btrim(m.idarti)::integer
    WHERE ${movementScopeWhere}
      AND m.fedepo::timestamp >= $4::date
      AND m.fedepo::timestamp < $5::date
      ${searchClause}
    GROUP BY p.article_id, p.payload
    ORDER BY net_units DESC, p.article_id ASC
    LIMIT ${limitParameter}
  `, values);

  return result.rows.map((row) => ({ ...row, net_units: numeric(row.net_units), movements: Number(row.movements) }));
}

export async function getStock(
  scope: Scope,
  options: { search?: string; depo?: number; limit: number; offset: number; lowStockThreshold?: number },
) {
  const values: unknown[] = [...scopeValues(scope)];
  const filters: string[] = [];
  if (options.depo !== undefined) {
    values.push(options.depo);
    filters.push(`AND sl.depo = $${values.length}`);
  }
  if (options.search) {
    values.push(`%${options.search}%`);
    filters.push(`AND (COALESCE(p.payload->>'Descripcion', '') ILIKE $${values.length} OR CAST(sl.article_id AS text) ILIKE $${values.length})`);
  }
  const thresholdParameter = options.lowStockThreshold === undefined ? "NULL::numeric" : `$${values.push(options.lowStockThreshold)}`;
  const limitParameter = `$${values.push(options.limit)}`;
  const offsetParameter = `$${values.push(options.offset)}`;

  const result = await query<{
    article_id: number; description: string | null; depo: number; bulto: string; saldo: string; piezas: string;
    last_updated_at: string; total_rows: string; stock_status: "OUT_OF_STOCK" | "AVAILABLE"; is_low_stock: boolean | null;
  }>(`
    SELECT
      sl.article_id,
      p.payload->>'Descripcion' AS description,
      sl.depo,
      sl.bulto,
      sl.saldo,
      sl.piezas,
      sl.source_seen_at AS last_updated_at,
      COUNT(*) OVER() AS total_rows,
      CASE WHEN sl.saldo <= 0 THEN 'OUT_OF_STOCK' ELSE 'AVAILABLE' END AS stock_status,
      CASE WHEN ${thresholdParameter} IS NULL THEN NULL ELSE sl.saldo <= ${thresholdParameter} END AS is_low_stock
    FROM stock_levels_raw sl
    JOIN products_raw p ON p.source_id = sl.source_id AND p.article_id = sl.article_id
    WHERE ${scopeWhere.replaceAll("source_id", "sl.source_id").replaceAll("branch_id", "sl.branch_id").replaceAll("organization_id", "sl.organization_id")}
      ${filters.join("\n")}
    ORDER BY sl.saldo ASC, sl.article_id ASC
    LIMIT ${limitParameter} OFFSET ${offsetParameter}
  `, values);

  const total = result.rows[0] ? Number(result.rows[0].total_rows) : 0;
  return {
    total,
    rows: result.rows.map(({ total_rows: _totalRows, saldo, piezas, ...row }) => ({ ...row, saldo: numeric(saldo), piezas: numeric(piezas) })),
  };
}

export async function getAttention(scope: Scope, period: Period) {
  const result = await query<{
    negative_stock: { count: number; items: unknown[] };
    out_of_stock: { count: number; with_activity_count: number; items: unknown[] };
    no_movement: { count: number; items: unknown[] };
  }>(`
    WITH period_activity AS (
      SELECT btrim(m.idarti)::integer AS article_id, COUNT(*) AS movements, COALESCE(SUM(${signedQuantitySql}), 0) AS net_units
      FROM stock_movements_raw m
      WHERE ${movementScopeWhere} AND m.fedepo::timestamp >= $4::date AND m.fedepo::timestamp < $5::date
      GROUP BY 1
    ), stock AS (
      SELECT sl.article_id, sl.depo, sl.bulto, sl.saldo, p.payload->>'Descripcion' AS description, COALESCE(a.movements, 0) AS movements, COALESCE(a.net_units, 0) AS net_units
      FROM stock_levels_raw sl
      JOIN products_raw p ON p.source_id = sl.source_id AND p.article_id = sl.article_id
      LEFT JOIN period_activity a ON a.article_id = sl.article_id
      WHERE ${scopeWhere.replaceAll("source_id", "sl.source_id").replaceAll("branch_id", "sl.branch_id").replaceAll("organization_id", "sl.organization_id")}
    ), active_products AS (
      SELECT p.article_id, p.payload->>'Descripcion' AS description
      FROM products_raw p
      WHERE ${scopeWhere.replaceAll("source_id", "p.source_id").replaceAll("branch_id", "p.branch_id").replaceAll("organization_id", "p.organization_id")} AND p.is_present
    )
    SELECT
      jsonb_build_object('count', (SELECT COUNT(*) FROM stock WHERE saldo < 0), 'items', COALESCE((SELECT jsonb_agg(item) FROM (SELECT article_id, description, depo, bulto, saldo, movements, net_units FROM stock WHERE saldo < 0 ORDER BY saldo ASC, article_id ASC LIMIT 3) item), '[]'::jsonb)) AS negative_stock,
      jsonb_build_object('count', (SELECT COUNT(*) FROM stock WHERE saldo = 0), 'with_activity_count', (SELECT COUNT(*) FROM stock WHERE saldo = 0 AND movements > 0), 'items', COALESCE((SELECT jsonb_agg(item) FROM (SELECT article_id, description, depo, bulto, saldo, movements, net_units FROM stock WHERE saldo = 0 ORDER BY (movements > 0) DESC, movements DESC, article_id ASC LIMIT 3) item), '[]'::jsonb)) AS out_of_stock,
      jsonb_build_object('count', (SELECT COUNT(*) FROM active_products p LEFT JOIN period_activity a USING (article_id) WHERE a.article_id IS NULL), 'items', COALESCE((SELECT jsonb_agg(item) FROM (SELECT p.article_id, p.description FROM active_products p LEFT JOIN period_activity a USING (article_id) WHERE a.article_id IS NULL ORDER BY p.article_id ASC LIMIT 3) item), '[]'::jsonb)) AS no_movement
  `, [...scopeValues(scope), period.from, period.toExclusive]);

  return result.rows[0];
}

function resolveFreshnessStatus(lastReceivedAt: string | null): { status: FreshnessStatus; age_minutes: number | null } {
  if (!lastReceivedAt) return { status: "ERROR", age_minutes: null };
  const ageMinutes = Math.max(0, Math.floor((Date.now() - new Date(lastReceivedAt).getTime()) / 60_000));
  const warning = Number(process.env.FRESHNESS_WARNING_MINUTES);
  const error = Number(process.env.FRESHNESS_ERROR_MINUTES);
  if (!Number.isFinite(warning) || !Number.isFinite(error) || warning < 0 || error < warning) {
    return { status: "UNCONFIGURED", age_minutes: ageMinutes };
  }
  if (ageMinutes >= error) return { status: "ERROR", age_minutes: ageMinutes };
  if (ageMinutes >= warning) return { status: "WARNING", age_minutes: ageMinutes };
  return { status: "OK", age_minutes: ageMinutes };
}

export async function getDataHealth(scope: Scope) {
  const result = await query<{
    first_movement: string | null; last_movement: string | null; total_movements: string; last_received_at: string | null; ajus: string;
  }>(`
    SELECT
      -- fedepo is validated ISO text without an offset; preserve its business time verbatim.
      MIN(fedepo) AS first_movement,
      MAX(fedepo) AS last_movement,
      COUNT(*) AS total_movements,
      MAX(received_at) AS last_received_at,
      COUNT(*) FILTER (WHERE TRIM(tipomov) = 'AJUS') AS ajus
    FROM stock_movements_raw
    WHERE ${scopeWhere}
  `, scopeValues(scope));
  const row = result.rows[0];
  return { ...row, total_movements: Number(row.total_movements), ajus: Number(row.ajus), freshness: resolveFreshnessStatus(row.last_received_at) };
}
