import { NextRequest } from "next/server";
import { getAuthorizedContext, getAuthorizedScope } from "@/server/auth/scope";
import { canConfirmReplenishment } from "@/server/auth/policies";
import { ForbiddenError } from "@/server/auth/errors";
import {
  RequestValidationError,
  parseOptionalCalendarDate,
  parseOptionalPositiveInteger,
} from "@/server/validation/request";
import { confirmOrderFromExcel } from "@/server/orders/excel-import";
import { apiResponse } from "@/app/api/dashboard/_shared";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  return apiResponse(async () => {
    const context = await getAuthorizedContext();
    const body: unknown = await request.json().catch(() => null);

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new RequestValidationError("Cuerpo de solicitud inválido.");
    }

    const input = body as {
      branch_id?: unknown;
      planning_date?: unknown;
      items?: unknown;
      notes?: unknown;
      file_hash?: unknown;
      idempotency_token?: unknown;
    };

    const branchId = parseOptionalPositiveInteger(String(input.branch_id ?? ""), "branch_id");
    const planningDate = parseOptionalCalendarDate(
      typeof input.planning_date === "string" ? input.planning_date : null,
      "planning_date"
    );
    const idempotencyToken =
      typeof input.idempotency_token === "string" ? input.idempotency_token : null;

    if (!branchId || !planningDate || !idempotencyToken || !Array.isArray(input.items)) {
      throw new RequestValidationError(
        "branch_id, planning_date, idempotency_token e items son requeridos."
      );
    }

    const { scope } = await getAuthorizedScope(new URLSearchParams({ branch_id: String(branchId) }));

    if (branchId !== scope.branchId || !canConfirmReplenishment(context, scope.branchId)) {
      throw new ForbiddenError();
    }

    const items = input.items.map((item) => {
      if (!item || typeof item !== "object") {
        throw new RequestValidationError("Cada producto debe ser un objeto.");
      }
      const row = item as { article_id?: unknown; requested_quantity?: unknown };
      if (
        !Number.isSafeInteger(row.article_id) ||
        typeof row.requested_quantity !== "number" ||
        !Number.isFinite(row.requested_quantity) ||
        row.requested_quantity <= 0
      ) {
        throw new RequestValidationError("Cada ítem requiere un article_id válido y requested_quantity > 0.");
      }
      return {
        article_id: Number(row.article_id),
        requested_quantity: row.requested_quantity,
      };
    });

    const result = await confirmOrderFromExcel({
      scope,
      branchId,
      planningDate,
      items,
      notes: typeof input.notes === "string" ? input.notes : undefined,
      fileHash: typeof input.file_hash === "string" ? input.file_hash : undefined,
      idempotencyToken,
      actorId: String(context.userId),
    });

    return result;
  });
}
