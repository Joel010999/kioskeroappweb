import {
  DEPOT_BRANCH_ID,
  getWeeklyReplenishment,
} from "@/server/analytics/weekly-replenishment";
import { withTransaction } from "@/server/db/client";
import type { Scope } from "@/server/analytics/types";
import { RequestValidationError } from "@/server/validation/request";
import {
  depotArticleIds,
  type SupplyMode,
} from "@/server/supply/branch-supply-rules";

type RequestItem = { article_id: number; requested_quantity: number };

export async function confirmInternalReplenishment(input: {
  scope: Scope;
  depotSourceId: string;
  planningDate: string;
  items: RequestItem[];
  actorId: string;
}) {
  const requested = new Map(
    input.items
      .filter((item) => item.requested_quantity > 0)
      .map((item) => [item.article_id, item.requested_quantity]),
  );
  if (!requested.size)
    throw new RequestValidationError(
      "Select at least one quantity greater than zero.",
    );
  const projection = await getWeeklyReplenishment({
    scope: input.scope,
    depotSourceId: input.depotSourceId,
    planningDate: input.planningDate,
    limit: 10_000,
    offset: 0,
  });
  const items = [...requested].map(([articleId, requestedQuantity]) => {
    const row = projection.items.find(
      (candidate) => candidate.article_id === articleId,
    );
    if (!row)
      throw new RequestValidationError(
        `Article ${articleId} is not part of the weekly projection.`,
      );
    return { ...row, requestedQuantity };
  });
  return withTransaction(async (client) => {
    const rules = await client.query<{
      article_id: number;
      supply_mode: SupplyMode;
    }>(
      "SELECT article_id, supply_mode FROM branch_product_supply_rules WHERE organization_id=$1 AND branch_id=$2 AND supply_mode='DEPOT' AND article_id = ANY($3::integer[])",
      [
        input.scope.organizationId,
        input.scope.branchId,
        items.map((item) => item.article_id),
      ],
    );
    const depotItems = depotArticleIds(
      items,
      new Map(rules.rows.map((rule) => [rule.article_id, rule.supply_mode])),
    );
    if (!depotItems.length)
      throw new RequestValidationError(
        "No hay artículos habilitados para generar un pedido al depósito.",
      );
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM orders WHERE order_type='INTERNAL_REPLENISHMENT' AND COALESCE(organization_id,-1)=$1 AND origin_branch_id=$2 AND destination_branch_id=$3 AND planning_date=$4 AND status <> 'CANCELLED'`,
      [
        input.scope.organizationId,
        input.scope.branchId,
        DEPOT_BRANCH_ID,
        input.planningDate,
      ],
    );
    if (existing.rows[0])
      return { id: Number(existing.rows[0].id), created: false };
    const idempotencyKey = `internal-replenishment:${input.scope.organizationId}:${input.scope.branchId}:${DEPOT_BRANCH_ID}:${input.planningDate}`;
    const created = await client.query<{ id: string }>(
      `INSERT INTO orders (organization_id,source_id,branch_id,status,order_type,origin_branch_id,destination_branch_id,planning_date,idempotency_key,confirmed_at,notes,created_by,confirmed_by) VALUES ($1,$2,$3,'CONFIRMED','INTERNAL_REPLENISHMENT',$3,$4,$5,$6,now(),'Solicitud semanal PV a depósito',$7,$7) RETURNING id`,
      [
        input.scope.organizationId,
        input.scope.sourceId,
        input.scope.branchId,
        DEPOT_BRANCH_ID,
        input.planningDate,
        idempotencyKey,
        input.actorId,
      ],
    );
    const orderId = Number(created.rows[0].id);
    await client.query(
      "INSERT INTO order_events (order_id,event_type,metadata,user_id) VALUES ($1,'ORDER_CREATED',$2::jsonb,$4),($1,'ORDER_CONFIRMED',$3::jsonb,$4)",
      [
        orderId,
        JSON.stringify({
          order_type: "INTERNAL_REPLENISHMENT",
          planning_date: input.planningDate,
        }),
        JSON.stringify({
          origin_branch_id: input.scope.branchId,
          destination_branch_id: DEPOT_BRANCH_ID,
        }),
        input.actorId,
      ],
    );
    for (const item of depotItems) {
      await client.query(
        `INSERT INTO order_items (order_id,article_id,product_name_snapshot,suggested_quantity,requested_quantity,stock_at_creation,stock_target_at_creation,confidence_at_creation,status_at_creation,weekly_demand_at_creation,planning_date_at_creation,supplier_code_snapshot,classification_code_snapshot,unit_measure_snapshot) VALUES ($1,$2,$3,$4,$5,$6,$7,'SEMANAL',$8,$9,$10,$11,$12,$13)`,
        [
          orderId,
          item.article_id,
          item.description ?? `Artículo ${item.article_id}`,
          item.suggested_quantity,
          item.requestedQuantity,
          item.stock_current,
          item.target_stock,
          item.status,
          item.weekly_demand,
          input.planningDate,
          item.supplier_code,
          item.classification_code,
          item.unit_measure,
        ],
      );
    }
    return { id: orderId, created: true };
  });
}
