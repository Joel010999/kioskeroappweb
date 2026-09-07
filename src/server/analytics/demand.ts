import { query } from "@/server/db/client";
import type { Scope } from "@/server/analytics/types";
import type { SuggestionConfidence, SuggestionStatus } from "./demand-rules";

export { suggestionConfidences, suggestionStatuses } from "./demand-rules";
export type { SuggestionConfidence, SuggestionStatus } from "./demand-rules";
export type Suggestion = {
  article_id: number; product_name: string | null; monthly_demand: number | null; monthly_history: Array<number | null>;
  stock_target: number | null; current_stock: number; suggested_quantity: number | null;
  confidence: SuggestionConfidence; status: SuggestionStatus; history_months: number; max_monthly_demand: number | null;
};

const scopeWhere = "source_id = $1 AND branch_id = $2 AND ($3::integer IS NULL OR organization_id = $3)";

function scopeValues(scope: Scope): [string, number, number | null] {
  return [scope.sourceId, scope.branchId, scope.organizationId ?? null];
}

function numeric(value: string | number | null): number | null {
  return value === null ? null : Number(value);
}

export async function getSuggestions(
  scope: Scope,
  options: { search?: string; status?: SuggestionStatus; confidence?: SuggestionConfidence; articleIds?: number[]; limit: number; offset: number },
) {
  const values: unknown[] = [...scopeValues(scope), options.search ? `%${options.search}%` : null, options.status ?? null, options.confidence ?? null, options.articleIds?.length ? options.articleIds : null];
  const limitParameter = `$${values.push(options.limit)}`;
  const offsetParameter = `$${values.push(options.offset)}`;
  const result = await query<{
    article_id: number; product_name: string | null; monthly_demand: string | null; monthly_history: Array<number | string | null>;
    stock_target: string | null; current_stock: string; suggested_quantity: string | null; confidence: SuggestionConfidence;
    status: SuggestionStatus; history_months: string; max_monthly_demand: string | null; total_rows: string;
  }>(`
    WITH reference_month AS (
      SELECT (date_trunc('month', MAX(m.fedepo::timestamp)) - interval '1 month')::date AS end_month
      FROM stock_movements_raw m WHERE ${scopeWhere.replaceAll("source_id", "m.source_id").replaceAll("branch_id", "m.branch_id").replaceAll("organization_id", "m.organization_id")}
    ), operational_demand AS (
      SELECT btrim(m.idarti)::integer AS article_id, date_trunc('month', m.fedepo::timestamp)::date AS month_start, SUM(m.cantidad) AS demand
      FROM stock_movements_raw m
      WHERE ${scopeWhere.replaceAll("source_id", "m.source_id").replaceAll("branch_id", "m.branch_id").replaceAll("organization_id", "m.organization_id")}
        AND TRIM(m.tipomov) = 'VT' AND TRIM(m.codcom) IN ('TICK', 'PRES', 'FACV')
      GROUP BY 1, 2
    ), first_demand AS (
      SELECT article_id, MIN(month_start) AS first_month FROM operational_demand GROUP BY 1
    ), stock AS (
      SELECT sl.article_id, SUM(sl.saldo) AS current_stock
      FROM stock_levels_raw sl
      WHERE ${scopeWhere.replaceAll("source_id", "sl.source_id").replaceAll("branch_id", "sl.branch_id").replaceAll("organization_id", "sl.organization_id")}
      GROUP BY sl.article_id
    ), product_scope AS (
      SELECT p.article_id, p.payload->>'Descripcion' AS product_name, COALESCE(s.current_stock, 0) AS current_stock, fd.first_month, r.end_month
      FROM products_raw p LEFT JOIN stock s ON s.article_id = p.article_id
      CROSS JOIN reference_month r LEFT JOIN first_demand fd ON fd.article_id = p.article_id
      WHERE ${scopeWhere.replaceAll("source_id", "p.source_id").replaceAll("branch_id", "p.branch_id").replaceAll("organization_id", "p.organization_id")}
    ), six_months AS (
      SELECT ps.article_id, ps.product_name, ps.current_stock, ps.first_month, ps.end_month, months.month_start,
        CASE WHEN ps.first_month IS NULL OR months.month_start < ps.first_month THEN NULL ELSE COALESCE(od.demand, 0) END AS demand
      FROM product_scope ps
      CROSS JOIN LATERAL generate_series(ps.end_month - interval '5 months', ps.end_month, interval '1 month') AS months(month_start)
      LEFT JOIN operational_demand od ON od.article_id = ps.article_id AND od.month_start = months.month_start
    ), metrics AS (
      SELECT article_id, MAX(product_name) AS product_name, MAX(current_stock) AS current_stock,
        CASE WHEN MAX(first_month) IS NULL THEN 0 ELSE ((EXTRACT(YEAR FROM MAX(end_month)) - EXTRACT(YEAR FROM MAX(first_month))) * 12 + EXTRACT(MONTH FROM MAX(end_month)) - EXTRACT(MONTH FROM MAX(first_month)) + 1)::integer END AS history_months,
        jsonb_agg(demand ORDER BY month_start) AS monthly_history, percentile_cont(.5) WITHIN GROUP (ORDER BY demand) AS stock_target,
        MAX(demand) AS max_monthly_demand
      FROM six_months GROUP BY article_id
    ), decisions AS (
      SELECT *, CASE WHEN history_months >= 12 THEN 'ALTA' WHEN history_months >= 6 THEN 'MEDIA' WHEN history_months >= 3 THEN 'BAJA' ELSE 'INSUFICIENTE' END AS confidence,
        CASE WHEN current_stock < 0 THEN 'MANUAL_REVIEW'
          WHEN history_months < 3 OR stock_target IS NULL THEN 'INSUFFICIENT_HISTORY'
          WHEN max_monthly_demand - stock_target >= 20 AND (stock_target = 0 OR max_monthly_demand >= stock_target * 3) THEN 'IRREGULAR_DEMAND'
          WHEN GREATEST(0, stock_target - current_stock) > 0 THEN 'SUGGESTION_AVAILABLE' ELSE 'NO_SUGGESTION' END AS status
      FROM metrics
    )
    SELECT article_id, product_name,
      CASE WHEN history_months < 3 THEN NULL ELSE stock_target END AS monthly_demand,
      monthly_history,
      CASE WHEN history_months < 3 THEN NULL ELSE stock_target END AS stock_target,
      current_stock,
      CASE WHEN current_stock < 0 OR history_months < 3 OR stock_target IS NULL THEN NULL ELSE GREATEST(0, stock_target - current_stock) END AS suggested_quantity,
      confidence, status, history_months, max_monthly_demand, COUNT(*) OVER() AS total_rows
    FROM decisions
    WHERE ($4::text IS NULL OR product_name ILIKE $4 OR article_id::text ILIKE $4)
      AND ($5::text IS NULL OR status = $5) AND ($6::text IS NULL OR confidence = $6)
      AND ($7::integer[] IS NULL OR article_id = ANY($7))
    ORDER BY CASE status WHEN 'SUGGESTION_AVAILABLE' THEN 0 WHEN 'IRREGULAR_DEMAND' THEN 1 WHEN 'MANUAL_REVIEW' THEN 2 WHEN 'NO_SUGGESTION' THEN 3 ELSE 4 END, suggested_quantity DESC NULLS LAST, article_id ASC
    LIMIT ${limitParameter} OFFSET ${offsetParameter}
  `, values);

  return {
    total: result.rows[0] ? Number(result.rows[0].total_rows) : 0,
    rows: result.rows.map(({ total_rows: _totalRows, monthly_history, ...row }) => ({
      ...row, monthly_demand: numeric(row.monthly_demand), stock_target: numeric(row.stock_target), current_stock: Number(row.current_stock),
      suggested_quantity: numeric(row.suggested_quantity), max_monthly_demand: numeric(row.max_monthly_demand), history_months: Number(row.history_months),
      monthly_history: monthly_history.map((value) => numeric(value)),
    })),
  };
}
