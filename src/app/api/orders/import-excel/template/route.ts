import { NextResponse } from "next/server";
import { generateOrderTemplateWorkbook } from "@/server/orders/excel-import";

export const runtime = "nodejs";

export async function GET() {
  const buffer = generateOrderTemplateWorkbook();

  return new NextResponse(buffer, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": 'attachment; filename="plantilla_pedido_kioskero.xlsx"',
      "Cache-Control": "no-cache",
    },
  });
}
