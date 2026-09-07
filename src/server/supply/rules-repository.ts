import { query } from "@/server/db/client";
import type { Scope } from "@/server/analytics/types";
import { supplyModes, type SupplyMode } from "./branch-supply-rules";
import { RequestValidationError } from "@/server/validation/request";

export async function listSupplyRules(
  scope: Scope,
  options: {
    search?: string;
    mode?: SupplyMode;
    limit: number;
    offset: number;
  },
) {
  const values: unknown[] = [
    scope.organizationId,
    scope.sourceId,
    scope.branchId,
    options.search ? `%${options.search}%` : null,
    options.mode ?? null,
    options.limit,
    options.offset,
  ];
  const rows = await query<{
    article_id: number;
    description: string | null;
    brand: string | null;
    supply_mode: SupplyMode;
    total_rows: string;
  }>(
    `
    SELECT p.article_id, p.payload->>'Descripcion' AS description, p.payload->>'Marca' AS brand, r.supply_mode, COUNT(*) OVER() AS total_rows
    FROM products_raw p
    JOIN branch_product_supply_rules r ON r.organization_id=p.organization_id AND r.branch_id=p.branch_id AND r.article_id=p.article_id
    WHERE p.organization_id=$1 AND p.source_id=$2 AND p.branch_id=$3 AND p.is_present
      AND ($4::text IS NULL OR p.article_id::text ILIKE $4 OR p.payload->>'Descripcion' ILIKE $4 OR p.payload->>'Marca' ILIKE $4)
      AND ($5::text IS NULL OR r.supply_mode=$5)
    ORDER BY p.payload->>'Descripcion' NULLS LAST, p.article_id
    LIMIT $6 OFFSET $7`,
    values,
  );
  const counts = await query<{ supply_mode: SupplyMode; count: string }>(
    `SELECT r.supply_mode, COUNT(*) AS count FROM branch_product_supply_rules r WHERE r.organization_id=$1 AND r.branch_id=$2 GROUP BY r.supply_mode`,
    [scope.organizationId, scope.branchId],
  );
  return {
    total: Number(rows.rows[0]?.total_rows ?? 0),
    rows: rows.rows.map(({ total_rows: _totalRows, ...row }) => row),
    counts: Object.fromEntries(
      supplyModes.map((mode) => [
        mode,
        Number(counts.rows.find((row) => row.supply_mode === mode)?.count ?? 0),
      ]),
    ) as Record<SupplyMode, number>,
  };
}

export async function updateSupplyRule(
  scope: Scope,
  articleId: number,
  supplyMode: SupplyMode,
) {
  if (!(supplyModes as readonly string[]).includes(supplyMode))
    throw new RequestValidationError("supply_mode is not valid.");
  const product = await query<{ article_id: number }>(
    "SELECT article_id FROM products_raw WHERE organization_id=$1 AND source_id=$2 AND branch_id=$3 AND article_id=$4 AND is_present",
    [scope.organizationId, scope.sourceId, scope.branchId, articleId],
  );
  if (!product.rows[0])
    throw new RequestValidationError(
      "Product not found in the authorized branch.",
    );
  const result = await query<{ supply_mode: SupplyMode }>(
    `INSERT INTO branch_product_supply_rules (organization_id,branch_id,article_id,supply_mode) VALUES ($1,$2,$3,$4) ON CONFLICT (organization_id,branch_id,article_id) DO UPDATE SET supply_mode=EXCLUDED.supply_mode,updated_at=now() RETURNING supply_mode`,
    [scope.organizationId, scope.branchId, articleId, supplyMode],
  );
  return { article_id: articleId, supply_mode: result.rows[0].supply_mode };
}
