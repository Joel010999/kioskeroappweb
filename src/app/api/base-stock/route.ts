import {
  baseStockConfigStates,
  listBranchBaseStock,
  upsertBranchBaseStock,
  type BaseStockConfigState,
} from "@/server/base-stock/repository";
import { DEPOT_BRANCH_ID } from "@/server/analytics/weekly-replenishment";
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

function resolveAuthorizedPvBranches(
  memberships: Array<{ branchId: number | null; role: string; active: boolean }>,
  currentBranchId: number,
) {
  const labelFor = (branchId: number) =>
    branchId === 2 ? "Centro" : branchId === 3 ? "Jardín" : `Sucursal ${branchId}`;

  const allowedIds = [
    ...new Set(
      memberships
        .filter(
          (m) => m.active && m.role === "PV_OPERATOR" && typeof m.branchId === "number",
        )
        .map((m) => m.branchId as number),
    ),
  ].sort((a, b) => a - b);

  if (allowedIds.length > 0) {
    return allowedIds.map((branch_id) => ({
      branch_id,
      label: labelFor(branch_id),
    }));
  }

  return [
    {
      branch_id: currentBranchId,
      label: labelFor(currentBranchId),
    },
  ];
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  return apiResponse(async () => {
    const { context, scope } = await getAuthorizedScope(params);
    if (!canConfirmReplenishment(context, scope.branchId)) {
      throw new ForbiddenError();
    }

    const { limit, page, offset } = parsePagination(params);
    const configStateParam = params.get("config_state");
    if (
      configStateParam &&
      !(baseStockConfigStates as readonly string[]).includes(configStateParam)
    ) {
      throw new RequestValidationError("config_state is not valid.");
    }

    const rubro = params.get("rubro")?.trim() || undefined;
    const supplier = params.get("supplier")?.trim() || undefined;
    const includeInactive = params.get("include_inactive") === "true";

    const depotSourceId = await getSourceForBranch(
      scope.organizationId ?? context.organizationId,
      DEPOT_BRANCH_ID,
    );

    const data = await listBranchBaseStock(scope, depotSourceId, {
      search: parseSearch(params.get("search")),
      rubro,
      supplier,
      configState: (configStateParam as BaseStockConfigState | null) ?? "ALL",
      includeInactive,
      limit,
      offset,
    });

    return {
      ...data,
      available_branches: resolveAuthorizedPvBranches(context.memberships, scope.branchId),
      page,
      limit,
    };
  });
}

async function handleUpsert(request: Request) {
  return apiResponse(async () => {
    const body: unknown = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new RequestValidationError("Request body must be an object.");
    }

    const input = body as {
      branch_id?: unknown;
      article_id?: unknown;
      base_stock?: unknown;
      notes?: unknown;
    };

    const branchId = parseOptionalPositiveInteger(
      typeof input.branch_id === "number" || typeof input.branch_id === "string"
        ? String(input.branch_id)
        : null,
      "branch_id",
    );

    const articleId = Number(input.article_id);
    if (!branchId || !Number.isSafeInteger(articleId) || articleId <= 0) {
      throw new RequestValidationError("branch_id and article_id are required.");
    }

    let parsedBaseStock: number | null;
    if (input.base_stock === null || input.base_stock === "") {
      parsedBaseStock = null;
    } else if (typeof input.base_stock === "number") {
      parsedBaseStock = input.base_stock;
    } else if (typeof input.base_stock === "string") {
      const normalized = input.base_stock.trim().replace(",", ".");
      parsedBaseStock = normalized === "" ? null : Number(normalized);
    } else {
      throw new RequestValidationError("base_stock debe ser numérico (>= 0) o null.");
    }

    if (
      parsedBaseStock !== null &&
      (!Number.isFinite(parsedBaseStock) || parsedBaseStock < 0)
    ) {
      throw new RequestValidationError("base_stock debe ser mayor o igual a 0.");
    }

    const { context, scope } = await getAuthorizedScope(
      new URLSearchParams({ branch_id: String(branchId) }),
    );
    if (!canConfirmReplenishment(context, scope.branchId)) {
      throw new ForbiddenError();
    }

    const notes =
      input.notes === undefined
        ? undefined
        : typeof input.notes === "string"
          ? input.notes.trim().slice(0, 240) || null
          : null;

    return upsertBranchBaseStock(scope, {
      articleId,
      baseStock: parsedBaseStock,
      ...(notes !== undefined ? { notes } : {}),
      actorId: String(context.userId),
    });
  });
}

export async function PUT(request: Request) {
  return handleUpsert(request);
}

export async function PATCH(request: Request) {
  return handleUpsert(request);
}
