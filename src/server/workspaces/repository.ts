import { query, withTransaction } from "@/server/db/client";
import { type Scope } from "@/server/analytics/types";

export type WorkspaceStatus = 'DRAFT' | 'READY_TO_DOWNLOAD' | 'DOWNLOADED' | 'FINALIZED';

export type CreateWorkspaceInput = {
  scope: Scope;
  stockSnapshotId?: number;
  actorId: string;
};

export type SaveWorkspaceItemsInput = {
  workspaceId: number;
  items: Array<{
    articleId: number;
    requestedQuantity: number;
    stockDepositoSnapshot?: number;
    stockRealAtCreation?: number;
    category?: string;
  }>;
};

export async function createWorkspace(input: CreateWorkspaceInput) {
  const { scope, stockSnapshotId, actorId } = input;
  return withTransaction(async (client) => {
    const result = await client.query<{ id: string }>(
      `INSERT INTO order_workspaces (organization_id, branch_id, stock_snapshot_id, created_by, status)
       VALUES ($1, $2, $3, $4, 'DRAFT') RETURNING id`,
      [scope.organizationId, scope.branchId, stockSnapshotId ?? null, actorId]
    );
    return Number(result.rows[0].id);
  });
}

export async function saveWorkspaceItems(input: SaveWorkspaceItemsInput) {
  return withTransaction(async (client) => {
    // Basic replace strategy for draft workspaces
    await client.query("DELETE FROM order_workspace_items WHERE workspace_id = $1", [input.workspaceId]);
    
    if (input.items.length === 0) return;

    for (const item of input.items) {
      await client.query(
        `INSERT INTO order_workspace_items 
        (workspace_id, article_id, requested_quantity, stock_deposito_snapshot, stock_real_at_creation, category)
        VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          input.workspaceId, 
          item.articleId, 
          item.requestedQuantity, 
          item.stockDepositoSnapshot ?? null, 
          item.stockRealAtCreation ?? null,
          item.category ?? null
        ]
      );
    }
  });
}

export async function getWorkspaces(branchId: number) {
  const result = await query(
    `SELECT * FROM order_workspaces WHERE branch_id = $1 ORDER BY created_at DESC`,
    [branchId]
  );
  return result.rows;
}

export async function getWorkspace(id: number, branchId: number) {
  const result = await query(
    `SELECT * FROM order_workspaces WHERE id = $1 AND branch_id = $2`,
    [id, branchId]
  );
  if (!result.rows[0]) return null;
  
  const items = await query(
    `SELECT * FROM order_workspace_items WHERE workspace_id = $1`,
    [id]
  );
  
  return { ...result.rows[0], items: items.rows };
}
