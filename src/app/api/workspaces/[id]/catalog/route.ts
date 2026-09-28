import { NextRequest } from "next/server";
import { getAuthorizedScope } from "@/server/auth/scope";
import { getWorkspace } from "@/server/workspaces/repository";
import { apiResponse } from "@/app/api/dashboard/_shared";
import { query } from "@/server/db/client";

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  return apiResponse(async () => {
    const { searchParams } = new URL(request.url);
    const branchId = searchParams.get("branch_id");
    if (!branchId) throw new Error("branch_id is required");

    const { scope } = await getAuthorizedScope(new URLSearchParams({ branch_id: branchId }));
    const { id } = await context.params;
    const workspace = await getWorkspace(Number(id), scope.branchId);
    if (!workspace) throw new Error("Workspace not found");

    // 1. Obtener Stock Vivo (BD)
    const dbStockRes = await query(
      `SELECT article_id, stock_current, btrim(payload->>'ArticuloDesc') as descri, btrim(payload->>'Rubro') as rubro
       FROM products_raw 
       WHERE organization_id = $1 AND is_present = true AND branch_id = $2`,
      [scope.organizationId, scope.branchId]
    );

    // 2. Obtener Stock Depósito (Snapshot)
    let depoStockMap = new Map();
    if (workspace && (workspace as any).stock_snapshot_id) {
      const snapRes = await query(
        `SELECT article_id, stock_quantity, description, category FROM stock_snapshot_items WHERE snapshot_id = $1`,
        [(workspace as any).stock_snapshot_id]
      );
      snapRes.rows.forEach(r => depoStockMap.set(r.article_id, r));
    }

    // 3. Obtener lo ya pedido en este workspace
    const workspaceItemsMap = new Map();
    workspace.items.forEach((i: any) => workspaceItemsMap.set(i.article_id, i));

    // 4. Merge Lógico (BD + Excel)
    const finalCatalog = [];
    const allArticleIds = new Set([
      ...dbStockRes.rows.map(r => r.article_id),
      ...Array.from(depoStockMap.keys()),
      ...Array.from(workspaceItemsMap.keys())
    ]);

    const dbMap = new Map(dbStockRes.rows.map(r => [r.article_id, r]));

    for (const artId of allArticleIds) {
      const dbItem = dbMap.get(artId);
      const depoItem = depoStockMap.get(artId);
      const wItem = workspaceItemsMap.get(artId);

      finalCatalog.push({
        article_id: artId,
        description: dbItem?.descri || depoItem?.description || `Artículo ${artId}`,
        category: dbItem?.rubro || depoItem?.category || 'GENERAL',
        stock_db: dbItem ? Number(dbItem.stock_current) : null,
        stock_depo: depoItem ? Number(depoItem.stock_quantity) : null,
        requested_qty: wItem ? Number(wItem.requested_quantity) : 0,
      });
    }

    // Ordenar por categoría y descripción
    finalCatalog.sort((a, b) => {
      if (a.category < b.category) return -1;
      if (a.category > b.category) return 1;
      return a.description.localeCompare(b.description);
    });

    return { catalog: finalCatalog, workspace };
  });
}
