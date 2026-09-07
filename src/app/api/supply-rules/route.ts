import {
  listSupplyRules,
  updateSupplyRule,
} from "@/server/supply/rules-repository";
import {
  supplyModes,
  type SupplyMode,
} from "@/server/supply/branch-supply-rules";
import {
  supplyEvidenceFilters,
  type SupplyEvidence,
} from "@/server/supply/supply-evidence";
import { getAuthorizedScope } from "@/server/auth/scope";
import { getSourceForBranch } from "@/server/auth/sources";
import { canConfirmReplenishment } from "@/server/auth/policies";
import { ForbiddenError } from "@/server/auth/errors";
import { apiResponse } from "../dashboard/_shared";
import {
  parseOptionalPositiveInteger,
  parsePagination,
  parseSearch,
  RequestValidationError,
} from "@/server/validation/request";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  return apiResponse(async () => {
    const { context, scope } = await getAuthorizedScope(params);
    if (!canConfirmReplenishment(context, scope.branchId))
      throw new ForbiddenError();
    const { limit, page, offset } = parsePagination(params);
    const mode = params.get("supply_mode");
    const evidence = params.get("evidence");
    if (mode && !(supplyModes as readonly string[]).includes(mode))
      throw new RequestValidationError("supply_mode is not valid.");
    if (evidence && !(supplyEvidenceFilters as readonly string[]).includes(evidence))
      throw new RequestValidationError("evidence is not valid.");
    return {
      ...(await listSupplyRules(scope, {
        search: parseSearch(params.get("search")),
        mode: mode as SupplyMode | undefined,
        evidence: evidence as SupplyEvidence | undefined,
        limit,
        offset,
      }, await getSourceForBranch(scope.organizationId ?? context.organizationId, 1))),
      page,
      limit,
    };
  });
}

export async function PATCH(request: Request) {
  return apiResponse(async () => {
    const body: unknown = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new RequestValidationError("Request body must be an object.");
    const input = body as {
      branch_id?: unknown;
      article_id?: unknown;
      supply_mode?: unknown;
    };
    const branchId = parseOptionalPositiveInteger(
      typeof input.branch_id === "number" ? String(input.branch_id) : null,
      "branch_id",
    );
    if (
      !branchId ||
      !Number.isSafeInteger(input.article_id) ||
      !(supplyModes as readonly unknown[]).includes(input.supply_mode)
    )
      throw new RequestValidationError(
        "branch_id, article_id, and supply_mode are required.",
      );
    const { context, scope } = await getAuthorizedScope(
      new URLSearchParams({ branch_id: String(branchId) }),
    );
    if (!canConfirmReplenishment(context, scope.branchId))
      throw new ForbiddenError();
    return updateSupplyRule(
      scope,
      Number(input.article_id),
      input.supply_mode as SupplyMode,
    );
  });
}
