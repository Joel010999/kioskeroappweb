import {
  deleteHistoryCutoff,
  detectOrderSnapshotMismatches,
  listHistoryCutoffs,
  upsertHistoryCutoff,
  type CutoffDetectionSource,
} from "@/server/catalog/history-cutoffs";
import { getAuthorizedScope } from "@/server/auth/scope";
import { canConfirmReplenishment } from "@/server/auth/policies";
import { ForbiddenError } from "@/server/auth/errors";
import { apiResponse } from "../dashboard/_shared";
import {
  parseOptionalCalendarDate,
  parseOptionalPositiveInteger,
  RequestValidationError,
} from "@/server/validation/request";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  return apiResponse(async () => {
    const { context, scope } = await getAuthorizedScope(params);
    if (!canConfirmReplenishment(context, scope.branchId)) {
      throw new ForbiddenError();
    }
    const [cutoffs, mismatches] = await Promise.all([
      listHistoryCutoffs(scope),
      detectOrderSnapshotMismatches(scope),
    ]);
    return {
      branch_id: scope.branchId,
      ...cutoffs,
      mismatches,
    };
  });
}

export async function PUT(request: Request) {
  return apiResponse(async () => {
    const body: unknown = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new RequestValidationError("Request body must be an object.");
    }
    const input = body as {
      branch_id?: unknown;
      article_id?: unknown;
      cutoff_date?: unknown;
      previous_description?: unknown;
      reason?: unknown;
      detection_source?: unknown;
    };

    const branchId = parseOptionalPositiveInteger(
      typeof input.branch_id === "number" || typeof input.branch_id === "string"
        ? String(input.branch_id)
        : null,
      "branch_id",
    );
    const articleId = Number(input.article_id);
    const cutoffDate = parseOptionalCalendarDate(
      typeof input.cutoff_date === "string" ? input.cutoff_date : null,
      "cutoff_date",
    );
    if (!branchId || !Number.isSafeInteger(articleId) || articleId <= 0 || !cutoffDate) {
      throw new RequestValidationError("branch_id, article_id y cutoff_date (YYYY-MM-DD) son obligatorios.");
    }

    const allowedSources: readonly CutoffDetectionSource[] = [
      "MANUAL",
      "ORDER_SNAPSHOT_DIFF",
      "GAP_REVIEW",
    ];
    const detectionSource: CutoffDetectionSource =
      typeof input.detection_source === "string" &&
      (allowedSources as readonly string[]).includes(input.detection_source)
        ? (input.detection_source as CutoffDetectionSource)
        : "MANUAL";

    const { context, scope } = await getAuthorizedScope(
      new URLSearchParams({ branch_id: String(branchId) }),
    );
    if (!canConfirmReplenishment(context, scope.branchId)) {
      throw new ForbiddenError();
    }

    return upsertHistoryCutoff(scope, {
      articleId,
      cutoffDate,
      previousDescription:
        typeof input.previous_description === "string"
          ? input.previous_description.trim().slice(0, 240) || null
          : null,
      reason:
        typeof input.reason === "string"
          ? input.reason.trim().slice(0, 300) || null
          : null,
      detectionSource,
      actorId: String(context.userId),
    });
  });
}

export async function DELETE(request: Request) {
  const params = new URL(request.url).searchParams;
  return apiResponse(async () => {
    const { context, scope } = await getAuthorizedScope(params);
    if (!canConfirmReplenishment(context, scope.branchId)) {
      throw new ForbiddenError();
    }
    const articleId = parseOptionalPositiveInteger(params.get("article_id"), "article_id");
    if (!articleId) {
      throw new RequestValidationError("article_id is required.");
    }
    return deleteHistoryCutoff(scope, articleId);
  });
}
