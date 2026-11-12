import { query } from "@/server/db/client";
import type { Scope } from "@/server/analytics/types";
import { RequestValidationError } from "@/server/validation/request";

export type CutoffDetectionSource = "MANUAL" | "ORDER_SNAPSHOT_DIFF" | "GAP_REVIEW";

export type HistoryCutoffRecord = {
  article_id: number;
  cutoff_date: string;
  previous_description: string | null;
  reason: string | null;
  detection_source: CutoffDetectionSource;
  updated_at: string;
};

export type OrderSnapshotMismatch = {
  article_id: number;
  previous_description: string;
  current_description: string;
  order_id: number;
  order_created_at: string;
};

export function isUndefinedRelationError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String((error as { code?: unknown }).code) : "";
  const message =
    "message" in error ? String((error as { message?: unknown }).message) : "";
  return (
    code === "42P01" ||
    (message.includes("does not exist") && message.includes("relation"))
  );
}

/**
 * Normalizes product descriptions for comparison, ignoring trailing punctuation,
 * capitalization, accents, and redundant whitespace.
 */
export function normalizeDescriptionForComparison(
  value: string | null | undefined,
): string {
  if (!value) return "";
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/(\d+)([a-z]+)/g, "$1 $2")
    .replace(/([a-z]+)(\d+)/g, "$1 $2")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Determines whether a historical order snapshot description represents
 * a genuinely different product (reused code) rather than minor typo/punctuation fixes.
 */
export function isSignificantDescriptionChange(
  previousDescription: string | null | undefined,
  currentDescription: string | null | undefined,
): boolean {
  const prev = normalizeDescriptionForComparison(previousDescription);
  const curr = normalizeDescriptionForComparison(currentDescription);
  if (!prev || !curr) return false;
  if (prev === curr) return false;
  if (prev.includes(curr) || curr.includes(prev)) return false;

  const prevTokens = new Set(prev.split(" ").filter((t) => t.length >= 2));
  const currTokens = new Set(curr.split(" ").filter((t) => t.length >= 2));
  if (prevTokens.size === 0 || currTokens.size === 0) return false;

  let intersection = 0;
  for (const token of prevTokens) {
    if (currTokens.has(token)) intersection++;
  }
  const union = new Set([...prevTokens, ...currTokens]).size;
  const jaccard = union > 0 ? intersection / union : 0;

  return jaccard < 0.45;
}

export async function listHistoryCutoffs(scope: Scope): Promise<{
  migrated: boolean;
  rows: HistoryCutoffRecord[];
}> {
  try {
    const res = await query<{
      article_id: number;
      cutoff_date: string | Date;
      previous_description: string | null;
      reason: string | null;
      detection_source: CutoffDetectionSource;
      updated_at: string | Date;
    }>(
      `SELECT article_id, cutoff_date::text AS cutoff_date, previous_description, reason, detection_source, updated_at
       FROM branch_product_history_cutoffs
       WHERE organization_id = $1 AND branch_id = $2
       ORDER BY cutoff_date DESC, article_id ASC`,
      [scope.organizationId, scope.branchId],
    );

    return {
      migrated: true,
      rows: res.rows.map((r) => ({
        article_id: Number(r.article_id),
        cutoff_date:
          r.cutoff_date instanceof Date
            ? r.cutoff_date.toISOString().slice(0, 10)
            : String(r.cutoff_date).slice(0, 10),
        previous_description: r.previous_description,
        reason: r.reason,
        detection_source: r.detection_source,
        updated_at:
          r.updated_at instanceof Date
            ? r.updated_at.toISOString()
            : String(r.updated_at),
      })),
    };
  } catch (error) {
    if (isUndefinedRelationError(error)) {
      return { migrated: false, rows: [] };
    }
    throw error;
  }
}

export async function detectOrderSnapshotMismatches(
  scope: Scope,
  articleIds?: number[],
): Promise<OrderSnapshotMismatch[]> {
  const buildSql = (withCutoffsTable: boolean, articleClause: string) => `
      SELECT DISTINCT ON (oi.article_id)
         oi.article_id,
         oi.product_name_snapshot AS previous_description,
         p.payload->>'Descripcion' AS current_description,
         o.id AS order_id,
         o.created_at AS order_created_at
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       JOIN products_raw p
         ON p.organization_id = o.organization_id
        AND p.source_id = $2
        AND p.branch_id = $3
        AND p.article_id = oi.article_id
       ${
         withCutoffsTable
           ? `LEFT JOIN branch_product_history_cutoffs hc
                ON hc.organization_id = o.organization_id
               AND hc.branch_id = $3
               AND hc.article_id = oi.article_id`
           : ""
       }
       WHERE o.organization_id = $1
         AND COALESCE(o.origin_branch_id, o.branch_id) = $3
         AND p.is_present = true
         AND NULLIF(btrim(oi.product_name_snapshot), '') IS NOT NULL
         AND NULLIF(btrim(p.payload->>'Descripcion'), '') IS NOT NULL
         ${withCutoffsTable ? "AND (hc.cutoff_date IS NULL OR o.created_at::date >= hc.cutoff_date)" : ""}
         ${articleClause}
       ORDER BY oi.article_id, o.created_at DESC`;

  try {
    const values: unknown[] = [scope.organizationId, scope.sourceId, scope.branchId];
    let articleClause = "";
    if (articleIds && articleIds.length > 0) {
      values.push(articleIds);
      articleClause = `AND p.article_id = ANY($${values.length}::integer[])`;
    }

    let res: {
      rows: Array<{
        article_id: number;
        previous_description: string;
        current_description: string;
        order_id: string | number;
        order_created_at: string | Date;
      }>;
    };

    try {
      res = await query(buildSql(true, articleClause), values);
    } catch (innerError) {
      if (!isUndefinedRelationError(innerError)) throw innerError;
      res = await query(buildSql(false, articleClause), values);
    }

    return res.rows
      .filter((r) =>
        isSignificantDescriptionChange(r.previous_description, r.current_description),
      )
      .map((r) => ({
        article_id: Number(r.article_id),
        previous_description: r.previous_description,
        current_description: r.current_description,
        order_id: Number(r.order_id),
        order_created_at:
          r.order_created_at instanceof Date
            ? r.order_created_at.toISOString()
            : String(r.order_created_at),
      }));
  } catch (error) {
    if (isUndefinedRelationError(error)) {
      return [];
    }
    throw error;
  }
}

export async function upsertHistoryCutoff(
  scope: Scope,
  input: {
    articleId: number;
    cutoffDate: string;
    previousDescription?: string | null;
    reason?: string | null;
    detectionSource?: CutoffDetectionSource;
    actorId: string;
  },
): Promise<HistoryCutoffRecord> {
  if (!Number.isSafeInteger(input.articleId) || input.articleId <= 0) {
    throw new RequestValidationError("article_id must be a positive integer.");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.cutoffDate)) {
    throw new RequestValidationError("cutoff_date must be YYYY-MM-DD.");
  }

  const detectionSource: CutoffDetectionSource =
    input.detectionSource ?? "MANUAL";

  try {
    const res = await query<{
      article_id: number;
      cutoff_date: string | Date;
      previous_description: string | null;
      reason: string | null;
      detection_source: CutoffDetectionSource;
      updated_at: string | Date;
    }>(
      `INSERT INTO branch_product_history_cutoffs (
         organization_id, branch_id, article_id, cutoff_date,
         previous_description, reason, detection_source, created_by_user_id, updated_at
       ) VALUES ($1, $2, $3, $4::date, $5, $6, $7, $8, now())
       ON CONFLICT (organization_id, branch_id, article_id)
       DO UPDATE SET
         cutoff_date = EXCLUDED.cutoff_date,
         previous_description = COALESCE(EXCLUDED.previous_description, branch_product_history_cutoffs.previous_description),
         reason = EXCLUDED.reason,
         detection_source = EXCLUDED.detection_source,
         created_by_user_id = EXCLUDED.created_by_user_id,
         updated_at = now()
       RETURNING article_id, cutoff_date::text AS cutoff_date, previous_description, reason, detection_source, updated_at`,
      [
        scope.organizationId,
        scope.branchId,
        input.articleId,
        input.cutoffDate,
        input.previousDescription ?? null,
        input.reason ?? null,
        detectionSource,
        input.actorId,
      ],
    );

    const row = res.rows[0];
    return {
      article_id: Number(row.article_id),
      cutoff_date: String(row.cutoff_date).slice(0, 10),
      previous_description: row.previous_description,
      reason: row.reason,
      detection_source: row.detection_source,
      updated_at:
        row.updated_at instanceof Date
          ? row.updated_at.toISOString()
          : String(row.updated_at),
    };
  } catch (error) {
    if (isUndefinedRelationError(error)) {
      throw new RequestValidationError(
        "La tabla branch_product_history_cutoffs aún no está migrada en la base de datos.",
      );
    }
    throw error;
  }
}

export async function deleteHistoryCutoff(
  scope: Scope,
  articleId: number,
): Promise<{ deleted: boolean; article_id: number }> {
  if (!Number.isSafeInteger(articleId) || articleId <= 0) {
    throw new RequestValidationError("article_id must be a positive integer.");
  }

  try {
    const res = await query<{ article_id: number }>(
      `DELETE FROM branch_product_history_cutoffs
       WHERE organization_id = $1 AND branch_id = $2 AND article_id = $3
       RETURNING article_id`,
      [scope.organizationId, scope.branchId, articleId],
    );
    return { deleted: res.rows.length > 0, article_id: articleId };
  } catch (error) {
    if (isUndefinedRelationError(error)) {
      throw new RequestValidationError(
        "La tabla branch_product_history_cutoffs aún no está migrada en la base de datos.",
      );
    }
    throw error;
  }
}

