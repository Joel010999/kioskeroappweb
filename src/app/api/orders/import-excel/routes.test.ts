import { describe, expect, it, vi, beforeEach } from "vitest";
import { POST as previewHandler } from "./preview/route";
import { POST as confirmHandler } from "./confirm/route";
import { GET as templateHandler } from "./template/route";
import { NextRequest } from "next/server";
import { ForbiddenError, UnauthenticatedError } from "@/server/auth/errors";

vi.mock("@/server/auth/scope", () => ({
  getAuthorizedContext: vi.fn(),
  getAuthorizedScope: vi.fn(),
}));

vi.mock("@/server/auth/policies", () => ({
  canConfirmReplenishment: vi.fn(),
}));

vi.mock("@/server/orders/excel-import", () => ({
  parseOrderExcel: vi.fn(),
  validateExcelAgainstCatalog: vi.fn(),
  confirmOrderFromExcel: vi.fn(),
  generateOrderTemplateWorkbook: vi.fn().mockReturnValue(Buffer.from("mock excel template")),
}));

import { getAuthorizedContext, getAuthorizedScope } from "@/server/auth/scope";
import { canConfirmReplenishment } from "@/server/auth/policies";
import {
  parseOrderExcel,
  validateExcelAgainstCatalog,
  confirmOrderFromExcel,
} from "@/server/orders/excel-import";

describe("API Routes: /api/orders/import-excel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("POST /api/orders/import-excel/preview", () => {
    it("rechaza si el usuario no tiene permisos", async () => {
      (getAuthorizedContext as any).mockResolvedValueOnce({
        userId: 99,
        organizationId: 1,
        memberships: [],
      });
      (getAuthorizedScope as any).mockResolvedValueOnce({
        scope: { organizationId: 1, sourceId: "pv", branchId: 2 },
      });
      (canConfirmReplenishment as any).mockReturnValueOnce(false);

      const req = new NextRequest("http://localhost:3000/api/orders/import-excel/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fileBase64: Buffer.from("data").toString("base64") }),
      });

      const res = await previewHandler(req);
      expect(res.status).toBe(403);
    });

    it("procesa preview correctamente cuando está autorizado", async () => {
      (getAuthorizedContext as any).mockResolvedValueOnce({
        userId: 1,
        organizationId: 1,
        memberships: [{ role: "PV_OPERATOR", branchId: 2 }],
      });
      (getAuthorizedScope as any).mockResolvedValueOnce({
        scope: { organizationId: 1, sourceId: "pv", branchId: 2 },
      });
      (canConfirmReplenishment as any).mockReturnValueOnce(true);

      (parseOrderExcel as any).mockReturnValueOnce({
        sheetName: "Hoja1",
        columnsDetected: { codeColumn: "articulo", descriptionColumn: "descri", quantityColumn: "PEDIDO" },
        rows: [{ rowNumber: 2, articleId: 2222, parsedQuantity: 12 }],
        fileHash: "hash-123",
      });

      (validateExcelAgainstCatalog as any).mockResolvedValueOnce({
        summary: { totalRows: 1, validRows: 1, errorRows: 0, warningRows: 0, totalUnits: 12 },
        items: [
          {
            rowNumber: 2,
            articleId: 2222,
            catalogDescription: "ACEITE",
            rubro: "ALMACEN",
            requestedQuantity: 12,
            status: "VALID",
          },
        ],
        unmatchedRows: [],
      });

      const req = new NextRequest("http://localhost:3000/api/orders/import-excel/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          filename: "pedido.xlsx",
          fileBase64: Buffer.from("fake-content").toString("base64"),
          branch_id: 2,
        }),
      });

      const res = await previewHandler(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.summary.validRows).toBe(1);
      expect(json.items[0].articleId).toBe(2222);
      expect(json.fileHash).toBe("hash-123");
    });
  });

  describe("POST /api/orders/import-excel/confirm", () => {
    it("crea el pedido confirmado llamando a confirmOrderFromExcel", async () => {
      (getAuthorizedContext as any).mockResolvedValueOnce({
        userId: 1,
        organizationId: 1,
        memberships: [{ role: "PV_OPERATOR", branchId: 2 }],
      });
      (getAuthorizedScope as any).mockResolvedValueOnce({
        scope: { organizationId: 1, sourceId: "pv", branchId: 2 },
      });
      (canConfirmReplenishment as any).mockReturnValueOnce(true);

      (confirmOrderFromExcel as any).mockResolvedValueOnce({
        id: 25,
        order_number: 3,
        total_units: 12,
        items_count: 1,
        created: true,
      });

      const req = new NextRequest("http://localhost:3000/api/orders/import-excel/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          branch_id: 2,
          planning_date: "2026-10-31",
          items: [{ article_id: 2222, requested_quantity: 12 }],
          idempotency_token: "token-abc",
        }),
      });

      const res = await confirmHandler(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.created).toBe(true);
      expect(json.order_number).toBe(3);
    });
  });

  describe("GET /api/orders/import-excel/template", () => {
    it("retorna el archivo Excel con encabezados correctos de descarga", async () => {
      const res = await templateHandler();
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("spreadsheetml");
      expect(res.headers.get("content-disposition")).toContain("plantilla_pedido_kioskero.xlsx");
    });
  });
});
