import { NextRequest } from "next/server";
import { getAuthorizedScope } from "@/server/auth/scope";
import { getWorkspace, saveWorkspaceItems } from "@/server/workspaces/repository";
import { generatePedidoExcel, OrderExportRow } from "@/server/workspaces/excel";
import { apiResponse } from "@/app/api/dashboard/_shared";
import { RequestValidationError } from "@/server/validation/request";
import { query } from "@/server/db/client";

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  return apiResponse(async () => {
    const { searchParams } = new URL(request.url);
    const branchId = searchParams.get("branch_id");
    if (!branchId) throw new RequestValidationError("branch_id is required");

    const { scope } = await getAuthorizedScope(new URLSearchParams({ branch_id: branchId }));
    
    const { id } = await context.params;
    const workspace = await getWorkspace(Number(id), scope.branchId);
    if (!workspace) throw new Error("Workspace not found");
    
    return workspace;
  });
}

export async function PUT(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  return apiResponse(async () => {
    const input = await request.json();
    const branchId = String(input.branch_id);
    if (!branchId) throw new RequestValidationError("branch_id is required");

    const { scope } = await getAuthorizedScope(new URLSearchParams({ branch_id: branchId }));
    
    const { id } = await context.params;
    const workspace = await getWorkspace(Number(id), scope.branchId);
    if (!workspace) throw new Error("Workspace not found");
    
    await saveWorkspaceItems({
      workspaceId: Number(id),
      items: input.items
    });
    
    return { success: true };
  });
}

// Para descargar el excel
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { searchParams } = new URL(request.url);
  const branchId = searchParams.get("branch_id");
  if (!branchId) return new Response("branch_id required", { status: 400 });

  try {
    const { scope } = await getAuthorizedScope(new URLSearchParams({ branch_id: branchId }));
    const { id } = await context.params;
    const workspace = await getWorkspace(Number(id), scope.branchId);
    if (!workspace) return new Response("Not found", { status: 404 });
    
    // Buscamos las descripciones de los artículos en la BD real
    const items = (workspace as any).items || [];
    const articleIds = items.map((i: any) => i.article_id);
    
    const articlesRes = await query(
      `SELECT article_id, btrim(payload->>'ArticuloDesc') as descri 
       FROM products_raw 
       WHERE organization_id = $1 AND article_id = ANY($2::integer[])`,
      [scope.organizationId, articleIds]
    );
    const descriptions = new Map(articlesRes.rows.map((r: any) => [r.article_id, r.descri]));

    const exportRows: OrderExportRow[] = items.map((item: any) => ({
      articleId: item.article_id,
      description: descriptions.get(item.article_id) || `Artículo ${item.article_id}`,
      stockPv: Number(item.stock_real_at_creation || 0),
      requestedQty: Number(item.requested_quantity || 0),
      category: item.category || 'GENERAL'
    }));

    const buffer = generatePedidoExcel(exportRows);

    await query("UPDATE order_workspaces SET status = 'DOWNLOADED', downloaded_at = now() WHERE id = $1", [(workspace as any).id]);

    return new Response(buffer, {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="PEDIDO_CENTRO_PV${scope.branchId}.xlsx"`
      }
    });
  } catch (error) {
    console.error(error);
    return new Response("Error generating excel", { status: 500 });
  }
}
