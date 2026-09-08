import { DEPOT_BRANCH_ID, getWeeklyReplenishment, type WeeklyReplenishmentFilter, type WeeklyReplenishmentSort } from "@/server/analytics/weekly-replenishment";
import { weeklyReplenishmentStatuses, type WeeklyReplenishmentStatus } from "@/server/analytics/weekly-replenishment-rules";
import { RequestValidationError, parseOptionalCalendarDate, parseOptionalPositiveInteger, parseSearch } from "@/server/validation/request";
import { apiResponse } from "../../dashboard/_shared";
import { getAuthorizedScope } from "@/server/auth/scope";
import { getSourceForBranch } from "@/server/auth/sources";
import { ForbiddenError } from "@/server/auth/errors";
import { canConfirmReplenishment } from "@/server/auth/policies";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  return apiResponse(async () => {
    const planningDate = parseOptionalCalendarDate(params.get("planning_date"), "planning_date");
    const status = params.get("status");
    const filter = params.get("filter");
    const sort = params.get("sort");
    const page = parseOptionalPositiveInteger(params.get("page"), "page") ?? 1;
    const pageSize = parseOptionalPositiveInteger(params.get("page_size"), "page_size") ?? 25;
    const requestedBranchId = parseOptionalPositiveInteger(params.get("branch_id"), "branch_id");
    const { context, scope } = await getAuthorizedScope(new URLSearchParams());
    if (requestedBranchId !== undefined && requestedBranchId !== scope.branchId)
      throw new ForbiddenError();
    if (!canConfirmReplenishment(context, scope.branchId)) throw new ForbiddenError();
    if (!planningDate) throw new RequestValidationError("planning_date is required.");
    if (pageSize > 100) throw new RequestValidationError("page_size cannot exceed 100.");
    if (status && !(weeklyReplenishmentStatuses as readonly string[]).includes(status)) throw new RequestValidationError("status is not valid.");
    const filters = ["WITH_SUGGESTION", "NO_SUGGESTION", "REVIEW_REQUIRED", "NO_DEMAND", "INSUFFICIENT_HISTORY", "IRREGULAR_DEMAND", "ZERO_STOCK", "NEGATIVE_STOCK", "DEPOT_POSITIVE", "DEPOT_ZERO", "DEPOT_NEGATIVE", "DEPOT_NO_ROW", "DEPOT_NOT_POSITIVE", "SUGGESTION_EXCEEDS_DEPOT", "SUPPLY_DEPOT", "SUPPLY_DIRECT_SUPPLIER", "SUPPLY_UNDEFINED"] as const;
    const sorts = ["SUGGESTED_DESC", "DEMAND_DESC", "STOCK_ASC", "DEPOT_GAP_DESC"] as const;
    if (filter && !(filters as readonly string[]).includes(filter)) throw new RequestValidationError("filter is not valid.");
    if (sort && !(sorts as readonly string[]).includes(sort)) throw new RequestValidationError("sort is not valid.");
    const depotSourceId = await getSourceForBranch(scope.organizationId ?? context.organizationId, DEPOT_BRANCH_ID);
    const data = await getWeeklyReplenishment({ scope, depotSourceId, planningDate, search: parseSearch(params.get("search")), status: status as WeeklyReplenishmentStatus | undefined, filter: filter as WeeklyReplenishmentFilter | undefined, sort: sort as WeeklyReplenishmentSort | undefined, limit: pageSize, offset: (page - 1) * pageSize });
    return { ...data, page, page_size: pageSize };
  });
}
