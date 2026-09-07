import { query } from "@/server/db/client";
import type { Scope } from "@/server/analytics/types";
import { supplyModes, type SupplyMode } from "./branch-supply-rules";
import { RequestValidationError } from "@/server/validation/request";
import {
  classifySupplyEvidence,
  type SupplyEvidence,
} from "./supply-evidence";

export async function listSupplyRules(
  scope: Scope,
  options: {
    search?: string;
    mode?: SupplyMode;
    evidence?: SupplyEvidence;
    limit: number;
    offset: number;
  },
  depotSourceId: string,
) {
  const values: unknown[] = [
    scope.organizationId,
    scope.sourceId,
    scope.branchId,
    depotSourceId,
    options.search ? `%${options.search}%` : null,
    options.mode ?? null,
    options.evidence ?? null,
    options.limit,
    options.offset,
  ];
  const rows = await query<{
    article_id: number;
    description: string | null;
    brand: string | null;
    supply_mode: SupplyMode;
    historical_documents: string;
    depot_stock: string | null;
    reviewed: boolean;
    total_rows: string;
  }>(
    `
    WITH historical_entries AS (
      SELECT btrim(m.idarti)::integer AS article_id, COUNT(DISTINCT NULLIF(btrim(m.numero), '')) AS historical_documents
      FROM stock_movements_raw m
      WHERE m.organization_id=$1 AND m.source_id=$2 AND m.branch_id=$3
        AND TRIM(m.tipomov)='IN' AND TRIM(m.codcom)='HOJD'
      GROUP BY 1
    ), depot_stock AS (
      SELECT article_id, SUM(saldo) AS depot_stock
      FROM stock_levels_raw
      WHERE organization_id=$1 AND source_id=$4 AND branch_id=1
      GROUP BY article_id
    ), classified AS (
      SELECT p.article_id, p.payload->>'Descripcion' AS description, p.payload->>'Marca' AS brand, r.supply_mode,
        COALESCE(h.historical_documents, 0) AS historical_documents, d.depot_stock,
        r.updated_at > r.created_at AS reviewed,
        CASE
          WHEN COALESCE(h.historical_documents, 0) < 3 THEN 'NO_EVIDENCE'
          WHEN COALESCE(d.depot_stock, 0) > 0 THEN 'POSSIBLE_DEPOT'
          ELSE 'POSSIBLE_DIRECT_SUPPLIER'
        END AS evidence
      FROM products_raw p
      JOIN branch_product_supply_rules r ON r.organization_id=p.organization_id AND r.branch_id=p.branch_id AND r.article_id=p.article_id
      LEFT JOIN historical_entries h ON h.article_id=p.article_id
      LEFT JOIN depot_stock d ON d.article_id=p.article_id
      WHERE p.organization_id=$1 AND p.source_id=$2 AND p.branch_id=$3 AND p.is_present
    )
    SELECT article_id, description, brand, supply_mode, historical_documents, depot_stock, reviewed, COUNT(*) OVER() AS total_rows
    FROM classified
    WHERE ($5::text IS NULL OR article_id::text ILIKE $5 OR description ILIKE $5 OR brand ILIKE $5)
      AND ($6::text IS NULL OR supply_mode=$6)
      AND ($7::text IS NULL OR evidence=$7)
      AND ($7::text IS NULL OR $7::text = 'NO_EVIDENCE' OR NOT reviewed)
    ORDER BY CASE WHEN $7::text IS NULL THEN NULL ELSE historical_documents END DESC NULLS LAST, description NULLS LAST, article_id
    LIMIT $8 OFFSET $9`,
    values,
  );
  const counts = await query<{
    supply_mode: SupplyMode;
    count: string;
  }>(
    `SELECT r.supply_mode, COUNT(*) AS count FROM branch_product_supply_rules r WHERE r.organization_id=$1 AND r.branch_id=$2 GROUP BY r.supply_mode`,
    [scope.organizationId, scope.branchId],
  );
  const evidenceCounts = await query<{
    evidence: SupplyEvidence;
    count: string;
  }>(
    `
    WITH historical_entries AS (
      SELECT btrim(m.idarti)::integer AS article_id, COUNT(DISTINCT NULLIF(btrim(m.numero), '')) AS historical_documents
      FROM stock_movements_raw m
      WHERE m.organization_id=$1 AND m.source_id=$2 AND m.branch_id=$3
        AND TRIM(m.tipomov)='IN' AND TRIM(m.codcom)='HOJD'
      GROUP BY 1
    ), depot_stock AS (
      SELECT article_id, SUM(saldo) AS depot_stock
      FROM stock_levels_raw
      WHERE organization_id=$1 AND source_id=$4 AND branch_id=1
      GROUP BY article_id
    )
    SELECT CASE
      WHEN COALESCE(h.historical_documents, 0) < 3 THEN 'NO_EVIDENCE'
      WHEN COALESCE(d.depot_stock, 0) > 0 THEN 'POSSIBLE_DEPOT'
      ELSE 'POSSIBLE_DIRECT_SUPPLIER'
    END AS evidence, COUNT(*) AS count
    FROM products_raw p
    JOIN branch_product_supply_rules r ON r.organization_id=p.organization_id AND r.branch_id=p.branch_id AND r.article_id=p.article_id
    LEFT JOIN historical_entries h ON h.article_id=p.article_id
    LEFT JOIN depot_stock d ON d.article_id=p.article_id
    WHERE p.organization_id=$1 AND p.source_id=$2 AND p.branch_id=$3 AND p.is_present
      AND (r.updated_at = r.created_at OR COALESCE(h.historical_documents, 0) < 3)
    GROUP BY 1`,
    [scope.organizationId, scope.sourceId, scope.branchId, depotSourceId],
  );
  return {
    total: Number(rows.rows[0]?.total_rows ?? 0),
    rows: rows.rows.map(({ total_rows: _totalRows, historical_documents, depot_stock, ...row }) => ({
      ...row,
      historical_documents: Number(historical_documents),
      depot_stock: depot_stock === null ? null : Number(depot_stock),
      evidence: classifySupplyEvidence({
        historicalDocuments: Number(historical_documents),
        depotStock: depot_stock === null ? null : Number(depot_stock),
      }),
    })),
    counts: Object.fromEntries(
      supplyModes.map((mode) => [
        mode,
        Number(counts.rows.find((row) => row.supply_mode === mode)?.count ?? 0),
      ]),
    ) as Record<SupplyMode, number>,
    evidence_counts: Object.fromEntries(
      ["POSSIBLE_DEPOT", "POSSIBLE_DIRECT_SUPPLIER", "NO_EVIDENCE"].map((evidence) => [
        evidence,
        Number(evidenceCounts.rows.find((row) => row.evidence === evidence)?.count ?? 0),
      ]),
    ) as Record<SupplyEvidence, number>,
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
