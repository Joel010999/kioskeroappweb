import { confirmInternalReplenishment } from "@/server/orders/internal-replenishment";
import { RequestValidationError, parseOptionalCalendarDate, parseOptionalPositiveInteger } from "@/server/validation/request";
import { apiResponse } from "../../../dashboard/_shared";
import { getAuthorizedScope } from "@/server/auth/scope";
import { getSourceForBranch } from "@/server/auth/sources";
import { DEPOT_BRANCH_ID } from "@/server/analytics/weekly-replenishment";
import { ForbiddenError } from "@/server/auth/errors";
import { canConfirmReplenishment } from "@/server/auth/policies";

export const runtime = "nodejs";
export async function POST(request: Request) { return apiResponse(async () => {
  const body: unknown = await request.json(); if (!body || typeof body !== "object" || Array.isArray(body)) throw new RequestValidationError("Request body must be an object.");
  const input = body as { branch_id?: unknown; planning_date?: unknown; items?: unknown };
  const branchId = parseOptionalPositiveInteger(String(input.branch_id ?? ""), "branch_id"); const planningDate = parseOptionalCalendarDate(typeof input.planning_date === "string" ? input.planning_date : null, "planning_date");
  if (!branchId || !planningDate || !Array.isArray(input.items)) throw new RequestValidationError("branch_id, planning_date and items are required.");
  const { context, scope } = await getAuthorizedScope(new URLSearchParams({ branch_id: String(branchId) }));
  if (!canConfirmReplenishment(context, scope.branchId)) throw new ForbiddenError();
  const items = input.items.map((item) => { if (!item || typeof item !== "object") throw new RequestValidationError("Each item must be an object."); const row=item as { article_id?: unknown; requested_quantity?: unknown }; if (!Number.isSafeInteger(row.article_id) || typeof row.requested_quantity !== "number" || !Number.isFinite(row.requested_quantity) || row.requested_quantity < 0) throw new RequestValidationError("Each item needs a valid article_id and requested_quantity."); return { article_id: Number(row.article_id), requested_quantity: row.requested_quantity }; });
  return confirmInternalReplenishment({ scope, depotSourceId: await getSourceForBranch(scope.organizationId ?? context.organizationId, DEPOT_BRANCH_ID), planningDate, items, actorId: String(context.userId) });
}); }
