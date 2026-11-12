import { query } from "@/server/db/client";
import type { Scope } from "@/server/analytics/types";
import { SQL_RUBRO_EXPRESSION } from "@/server/catalog/rubros";
import { DEPOT_BRANCH_ID } from "@/server/analytics/weekly-replenishment";
import {
  detectOrderSnapshotMismatches,
  isUndefinedRelationError,
} from "@/server/catalog/history-cutoffs";
import { RequestValidationError } from "@/server/validation/request";

export const baseStockConfigStates = [
  "ALL",
  "CONFIGURED",
  "UNCONFIGURED",
  "ZERO",
] as const;

export type BaseStockConfigState = (typeof baseStockConfigStates)[number];

export type BranchBaseStockRow = {
  article_id: number;
  description: string | null;
  brand: string | null;
  supplier_code: string | null;
  classification_code: string | null;
  rubro: string;
  unit_measure: string | null;
  is_active: boolean;
  current_stock: number;
  depot_stock: number | null;
  erp_stopti: number | null;
  base_stock: number | null;
  is_configured: boolean;
  notes: string | null;
  updated_at: string | null;
  history_cutoff_date: string | null;
  snapshot_mismatch: {
    previous_description: string;
    order_id: number;
    order_created_at: string;
  } | null;
};

export type BranchBaseStockSummary = {
  total_active: number;
  configured_count: number;
  unconfigured_count: number;
  zero_count: number;
};

function branchDisplayName(branchId: number): string {
  if (branchId === 2) return "Centro";
  if (branchId === 3) return "Jardín";
  if (branchId === 1) return "Depósito";
  return `Sucursal ${branchId}`;
}

export async function listBranchBaseStock(
  scope: Scope,
  depotSourceId: string,
  options: {
    search?: string;
    rubro?: string;
    supplier?: string;
    configState?: BaseStockConfigState;
    includeInactive?: boolean;
    limit: number;
    offset: number;
  },
) {
  const values: unknown[] = [
    scope.organizationId,
    scope.sourceId,
    scope.branchId,
    depotSourceId,
    options.search ? `%${options.search}%` : null,
    options.limit,
    options.offset,
  ];

  const configState = options.configState ?? "ALL";
  const includeInactive = Boolean(options.includeInactive);

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
    supplierClause =
      "AND (supplier_code IS NULL OR supplier_code = '' OR supplier_code = 'SIN PROVEEDOR')";
  } else if (options.supplier) {
    values.push(options.supplier);
    supplierClause = `AND supplier_code = $${values.length}`;
  }

  const configClause =
    configState === "CONFIGURED"
      ? "AND base_stock IS NOT NULL"
      : configState === "UNCONFIGURED"
        ? "AND base_stock IS NULL"
        : configState === "ZERO"
          ? "AND base_stock = 0"
          : "";

  const activeClause = includeInactive ? "" : "AND is_active = true";

  type RawRow = {
    article_id: number;
    description: string | null;
    brand: string | null;
    supplier_code: string | null;
    classification_code: string | null;
    rubro: string;
    unit_measure: string | null;
    is_active: boolean;
    current_stock: string;
    depot_stock: string | null;
    erp_stopti: string | null;
    base_stock: string | null;
    notes: string | null;
    updated_at: string | Date | null;
    history_cutoff_date: string | Date | null;
    total_rows: string;
  };

  let migrated = true;
  let cutoffsMigrated = true;
  let rows: RawRow[] = [];

  const buildQuery = (withBaseStockTable: boolean, withCutoffTable: boolean) => `
    WITH stock_pv AS (
      SELECT article_id, SUM(saldo) AS current_stock
      FROM stock_levels_raw
      WHERE organization_id = $1 AND source_id = $2 AND branch_id = $3
      GROUP BY article_id
    ), stock_depot AS (
      SELECT article_id, SUM(saldo) AS depot_stock
      FROM stock_levels_raw
      WHERE organization_id = $1 AND source_id = $4 AND branch_id = ${DEPOT_BRANCH_ID}
      GROUP BY article_id
    ), catalog AS (
      SELECT DISTINCT ON (p.article_id)
        p.article_id,
        p.payload->>'Descripcion' AS description,
        NULLIF(btrim(p.payload->>'Marca'), '') AS brand,
        NULLIF(btrim(p.payload->>'Proveedor'), '') AS supplier_code,
        p.payload->>'Clasificacion' AS classification_code,
        ${SQL_RUBRO_EXPRESSION} AS rubro,
        p.payload->>'UnidadMedida' AS unit_measure,
        (COALESCE(NULLIF(btrim(p.payload->>'Estado'), ''), '1') = '1') AS is_active,
        COALESCE(sp.current_stock, 0) AS current_stock,
        sd.depot_stock,
        CASE
          WHEN NULLIF(btrim(p.payload->>'Stopti'), '') ~ '^-?[0-9]+(\\.[0-9]+)?$'
          THEN (btrim(p.payload->>'Stopti'))::numeric
          ELSE NULL
        END AS erp_stopti,
        ${withBaseStockTable ? "bs.base_stock" : "NULL::numeric"} AS base_stock,
        ${withBaseStockTable ? "bs.notes" : "NULL::text"} AS notes,
        ${withBaseStockTable ? "bs.updated_at" : "NULL::timestamptz"} AS updated_at,
        ${withCutoffTable ? "hc.cutoff_date::text" : "NULL::text"} AS history_cutoff_date
      FROM products_raw p
      LEFT JOIN stock_pv sp ON sp.article_id = p.article_id
      LEFT JOIN stock_depot sd ON sd.article_id = p.article_id
      ${
        withBaseStockTable
          ? "LEFT JOIN branch_product_base_stock bs ON bs.organization_id = $1 AND bs.branch_id = $3 AND bs.article_id = p.article_id"
          : ""
      }
      ${
        withCutoffTable
          ? "LEFT JOIN branch_product_history_cutoffs hc ON hc.organization_id = $1 AND hc.branch_id = $3 AND hc.article_id = p.article_id"
          : ""
      }
      WHERE p.organization_id = $1 AND p.source_id = $2 AND p.branch_id = $3 AND p.is_present = true
      ORDER BY p.article_id
    )
    SELECT *, COUNT(*) OVER() AS total_rows
    FROM catalog
    WHERE ($5::text IS NULL OR description ILIKE $5 OR article_id::text ILIKE $5 OR brand ILIKE $5 OR supplier_code ILIKE $5 OR rubro ILIKE $5)
      ${activeClause}
      ${rubroClause}
      ${supplierClause}
      ${configClause}
    ORDER BY
      CASE WHEN base_stock IS NOT NULL THEN 0 ELSE 1 END ASC,
      is_active DESC,
      LOWER(COALESCE(description, '')) ASC,
      article_id ASC
    LIMIT $6 OFFSET $7
  `;

  try {
    const res = await query<RawRow>(buildQuery(true, true), values);
    rows = res.rows;
  } catch (error) {
    if (!isUndefinedRelationError(error)) throw error;
    try {
      const res = await query<RawRow>(buildQuery(true, false), values);
      rows = res.rows;
      cutoffsMigrated = false;
    } catch (error2) {
      if (!isUndefinedRelationError(error2)) throw error2;
      migrated = false;
      cutoffsMigrated = false;
      const res = await query<RawRow>(buildQuery(false, false), values);
      rows = res.rows;
    }
  }

  let summary: BranchBaseStockSummary = {
    total_active: 0,
    configured_count: 0,
    unconfigured_count: 0,
    zero_count: 0,
  };

  try {
    const summaryQuery = migrated
      ? `SELECT
           COUNT(*) FILTER (WHERE COALESCE(NULLIF(btrim(p.payload->>'Estado'), ''), '1') = '1') AS total_active,
           COUNT(*) FILTER (WHERE COALESCE(NULLIF(btrim(p.payload->>'Estado'), ''), '1') = '1' AND bs.base_stock IS NOT NULL) AS configured_count,
           COUNT(*) FILTER (WHERE COALESCE(NULLIF(btrim(p.payload->>'Estado'), ''), '1') = '1' AND bs.base_stock IS NULL) AS unconfigured_count,
           COUNT(*) FILTER (WHERE COALESCE(NULLIF(btrim(p.payload->>'Estado'), ''), '1') = '1' AND bs.base_stock = 0) AS zero_count
         FROM (
           SELECT DISTINCT ON (article_id) article_id, payload
           FROM products_raw
           WHERE organization_id = $1 AND source_id = $2 AND branch_id = $3 AND is_present = true
           ORDER BY article_id
         ) p
         LEFT JOIN branch_product_base_stock bs
           ON bs.organization_id = $1 AND bs.branch_id = $3 AND bs.article_id = p.article_id`
      : `SELECT
           COUNT(*) FILTER (WHERE COALESCE(NULLIF(btrim(p.payload->>'Estado'), ''), '1') = '1') AS total_active,
           0 AS configured_count,
           COUNT(*) FILTER (WHERE COALESCE(NULLIF(btrim(p.payload->>'Estado'), ''), '1') = '1') AS unconfigured_count,
           0 AS zero_count
         FROM (
           SELECT DISTINCT ON (article_id) article_id, payload
           FROM products_raw
           WHERE organization_id = $1 AND source_id = $2 AND branch_id = $3 AND is_present = true
           ORDER BY article_id
         ) p`;

    const summaryRes = await query<{
      total_active: string;
      configured_count: string;
      unconfigured_count: string;
      zero_count: string;
    }>(summaryQuery, [scope.organizationId, scope.sourceId, scope.branchId]);

    if (summaryRes.rows[0]) {
      summary = {
        total_active: Number(summaryRes.rows[0].total_active),
        configured_count: Number(summaryRes.rows[0].configured_count),
        unconfigured_count: Number(summaryRes.rows[0].unconfigured_count),
        zero_count: Number(summaryRes.rows[0].zero_count),
      };
    }
  } catch {
    // Graceful fallback in isolated test fixtures
  }

  let rubros: string[] = [];
  try {
    const rubrosRes = await query<{ rubro: string }>(
      `SELECT DISTINCT ${SQL_RUBRO_EXPRESSION} AS rubro
       FROM products_raw p
       WHERE p.organization_id = $1 AND p.source_id = $2 AND p.branch_id = $3 AND p.is_present = true
         AND COALESCE(NULLIF(btrim(p.payload->>'Estado'), ''), '1') = '1'
       ORDER BY rubro ASC`,
      [scope.organizationId, scope.sourceId, scope.branchId],
    );
    rubros = rubrosRes.rows.map((r) => r.rubro).filter(Boolean);
  } catch {
    // Graceful fallback
  }

  let suppliers: string[] = [];
  try {
    const supRes = await query<{ supplier: string }>(
      `SELECT DISTINCT btrim(p.payload->>'Proveedor') AS supplier
       FROM products_raw p
       WHERE p.organization_id = $1 AND p.source_id = $2 AND p.branch_id = $3 AND p.is_present = true
         AND COALESCE(NULLIF(btrim(p.payload->>'Estado'), ''), '1') = '1'
         AND NULLIF(btrim(p.payload->>'Proveedor'), '') IS NOT NULL
       ORDER BY supplier ASC`,
      [scope.organizationId, scope.sourceId, scope.branchId],
    );
    suppliers = supRes.rows.map((r) => r.supplier).filter(Boolean);
  } catch {
    // Graceful fallback
  }

  const pageArticleIds = rows.map((r) => Number(r.article_id));
  const mismatches =
    pageArticleIds.length > 0
      ? await detectOrderSnapshotMismatches(scope, pageArticleIds)
      : [];
  const mismatchMap = new Map(mismatches.map((m) => [m.article_id, m]));

  return {
    location: {
      branch_id: scope.branchId,
      label: branchDisplayName(scope.branchId),
    },
    migrated,
    cutoffs_migrated: cutoffsMigrated,
    total: rows[0] ? Number(rows[0].total_rows) : 0,
    summary,
    rubros,
    suppliers,
    rows: rows.map((r) => {
      const baseStockNum = r.base_stock === null ? null : Number(r.base_stock);
      const stoptiNum = r.erp_stopti === null ? null : Number(r.erp_stopti);
      const mismatch = mismatchMap.get(Number(r.article_id));
      return {
        article_id: Number(r.article_id),
        description: r.description,
        brand: r.brand,
        supplier_code: r.supplier_code,
        classification_code: r.classification_code,
        rubro: r.rubro,
        unit_measure: r.unit_measure,
        is_active: Boolean(r.is_active),
        current_stock: Number(r.current_stock),
        depot_stock: r.depot_stock === null ? null : Number(r.depot_stock),
        erp_stopti: stoptiNum,
        base_stock: baseStockNum,
        is_configured: baseStockNum !== null,
        notes: r.notes ?? null,
        updated_at:
          r.updated_at instanceof Date
            ? r.updated_at.toISOString()
            : r.updated_at,
        history_cutoff_date: r.history_cutoff_date
          ? String(r.history_cutoff_date).slice(0, 10)
          : null,
        snapshot_mismatch: mismatch
          ? {
              previous_description: mismatch.previous_description,
              order_id: mismatch.order_id,
              order_created_at: mismatch.order_created_at,
            }
          : null,
      } satisfies BranchBaseStockRow;
    }),
  };
}

export async function upsertBranchBaseStock(
  scope: Scope,
  input: {
    articleId: number;
    baseStock: number | null;
    notes?: string | null;
    actorId: string;
  },
): Promise<{
  branch_id: number;
  article_id: number;
  base_stock: number | null;
  is_configured: boolean;
  notes: string | null;
}> {
  if (!Number.isSafeInteger(input.articleId) || input.articleId <= 0) {
    throw new RequestValidationError("article_id must be a positive integer.");
  }

  try {
    if (input.baseStock === null) {
      await query(
        `DELETE FROM branch_product_base_stock
         WHERE organization_id = $1 AND branch_id = $2 AND article_id = $3`,
        [scope.organizationId, scope.branchId, input.articleId],
      );
      return {
        branch_id: scope.branchId,
        article_id: input.articleId,
        base_stock: null,
        is_configured: false,
        notes: null,
      };
    }

    if (!Number.isFinite(input.baseStock) || input.baseStock < 0) {
      throw new RequestValidationError(
        "base_stock must be a non-negative number or null.",
      );
    }

    const updateNotes = input.notes !== undefined;
    const normalizedNotes = updateNotes ? input.notes?.trim() || null : null;

    const res = await query<{
      base_stock: string;
      notes: string | null;
    }>(
      `INSERT INTO branch_product_base_stock (
         organization_id, branch_id, article_id, base_stock, notes, updated_by_user_id, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (organization_id, branch_id, article_id)
       DO UPDATE SET
         base_stock = EXCLUDED.base_stock,
         notes = CASE WHEN $7::boolean THEN EXCLUDED.notes ELSE branch_product_base_stock.notes END,
         updated_by_user_id = EXCLUDED.updated_by_user_id,
         updated_at = now()
       RETURNING base_stock, notes`,
      [
        scope.organizationId,
        scope.branchId,
        input.articleId,
        input.baseStock,
        normalizedNotes,
        input.actorId,
        updateNotes,
      ],
    );

    return {
      branch_id: scope.branchId,
      article_id: input.articleId,
      base_stock: Number(res.rows[0].base_stock),
      is_configured: true,
      notes: res.rows[0].notes,
    };
  } catch (error) {
    if (isUndefinedRelationError(error)) {
      throw new RequestValidationError(
        "La tabla branch_product_base_stock aún no fue migrada en la base de datos.",
      );
    }
    throw error;
  }
}

