import { NextRequest, NextResponse } from "next/server";
import { getAuthorizedContext, getAuthorizedScope } from "@/server/auth/scope";
import { canConfirmReplenishment } from "@/server/auth/policies";
import { ForbiddenError, UnauthenticatedError } from "@/server/auth/errors";
import { RequestValidationError, parseOptionalPositiveInteger } from "@/server/validation/request";
import { parseOrderExcel, validateExcelAgainstCatalog } from "@/server/orders/excel-import";
import { apiResponse } from "@/app/api/dashboard/_shared";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  return apiResponse(async () => {
    const context = await getAuthorizedContext();
    const contentType = request.headers.get("content-type") || "";

    let buffer: Buffer;
    let filename = "pedido.xlsx";
    let requestedBranchId: number | undefined;

    if (contentType.includes("multipart/form-data")) {
      const formData = await request.formData();
      const file = formData.get("file") as File | null;
      if (!file) {
        throw new RequestValidationError("Debe seleccionar un archivo para importar.");
      }
      filename = file.name || "pedido.xlsx";
      const branchField = formData.get("branch_id");
      if (branchField) {
        requestedBranchId = parseOptionalPositiveInteger(String(branchField), "branch_id");
      }
      const arrayBuffer = await file.arrayBuffer();
      buffer = Buffer.from(arrayBuffer);
    } else {
      const body = await request.json().catch(() => null);
      if (!body || typeof body !== "object") {
        throw new RequestValidationError("Cuerpo de solicitud inválido.");
      }
      if (!body.fileBase64 || typeof body.fileBase64 !== "string") {
        throw new RequestValidationError("Falta el contenido del archivo (fileBase64).");
      }
      filename = body.filename || "pedido.xlsx";
      if (body.branch_id) {
        requestedBranchId = parseOptionalPositiveInteger(String(body.branch_id), "branch_id");
      }
      buffer = Buffer.from(body.fileBase64, "base64");
    }

    const branchParam = requestedBranchId ? new URLSearchParams({ branch_id: String(requestedBranchId) }) : new URLSearchParams();
    const { scope } = await getAuthorizedScope(branchParam);

    if (!canConfirmReplenishment(context, scope.branchId)) {
      throw new ForbiddenError();
    }

    // 1. Parsear el archivo Excel
    const parsed = parseOrderExcel(buffer, filename);

    // 2. Validar contra el catálogo de la sucursal
    const validated = await validateExcelAgainstCatalog(parsed.rows, scope);

    return {
      filename,
      fileHash: parsed.fileHash,
      sheetName: parsed.sheetName,
      columnsDetected: parsed.columnsDetected,
      summary: validated.summary,
      items: validated.items,
      unmatchedRows: validated.unmatchedRows,
      branchId: scope.branchId,
    };
  });
}
