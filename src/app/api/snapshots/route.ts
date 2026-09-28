import { NextRequest } from "next/server";
import { getAuthorizedScope } from "@/server/auth/scope";
import { parseDepotStockExcel } from "@/server/workspaces/excel";
import { apiResponse } from "@/app/api/dashboard/_shared";
import { withTransaction, query } from "@/server/db/client";

export async function POST(request: NextRequest) {
  return apiResponse(async () => {
    const { context, scope } = await getAuthorizedScope(new URLSearchParams());
    
    // Solo DEPÓSITO o ADMIN pueden subir stock.
    // Asumimos validación por rol aquí. Si es un PV regular, rechazar.
    // (A implementar chequeo específico de permisos de usuario si corresponde).

    const formData = await request.formData();
    const file = formData.get("file") as File;
    if (!file) throw new Error("File missing");
    
    const buffer = Buffer.from(await file.arrayBuffer());
    const items = parseDepotStockExcel(buffer);
    
    const snapshotId = await withTransaction(async (client) => {
      const res = await client.query<{ id: string }>(
        `INSERT INTO stock_snapshots (organization_id, uploaded_by, original_filename, total_items, status)
         VALUES ($1, $2, $3, $4, 'PROCESSED') RETURNING id`,
        [scope.organizationId, context.userId, file.name, items.length]
      );
      
      const sid = Number(res.rows[0].id);
      
      for (const item of items) {
         await client.query(
           `INSERT INTO stock_snapshot_items (snapshot_id, article_id, description, stock_quantity)
            VALUES ($1, $2, $3, $4)`,
           [sid, item.articleId, item.description, item.stock]
         );
      }
      return sid;
    });
    
    return { success: true, snapshotId, itemsProcessed: items.length };
  });
}

export async function GET(request: NextRequest) {
  return apiResponse(async () => {
    const { scope } = await getAuthorizedScope(new URLSearchParams());
    
    const res = await query(
      `SELECT * FROM stock_snapshots WHERE organization_id = $1 ORDER BY uploaded_at DESC LIMIT 1`,
      [scope.organizationId]
    );
    
    if (!res.rows[0]) return { snapshot: null };
    
    const itemsRes = await query(
      `SELECT * FROM stock_snapshot_items WHERE snapshot_id = $1`,
      [res.rows[0].id]
    );
    
    return { snapshot: { ...res.rows[0], items: itemsRes.rows } };
  });
}
