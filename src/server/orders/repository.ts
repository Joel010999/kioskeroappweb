import type { PoolClient } from "pg";
import { getSuggestions, type Suggestion } from "@/server/analytics/demand";
import type { Scope } from "@/server/analytics/types";
import { query, withTransaction } from "@/server/db/client";
import { RequestValidationError } from "@/server/validation/request";
import { canEditOrder, isOperationalQuantityValid, transitionEvent, type OrderEventType, type OrderStatus } from "./rules";

type OrderRow = { id: string; organization_id: number | null; source_id: string; branch_id: number; status: OrderStatus; created_by: string | null; created_at: string; updated_at: string; confirmed_by: string | null; confirmed_at: string | null; completed_at: string | null; notes: string; order_type: string; origin_branch_id: number | null; destination_branch_id: number | null; planning_date: string | null; item_count: string; requested_units: string; approved_units: string; prepared_units: string; dispatched_units: string; received_units: string };
type ItemRow = { id: string; order_id: string; article_id: number; product_name_snapshot: string; suggested_quantity: string | null; requested_quantity: string; stock_at_creation: string; stock_target_at_creation: string | null; confidence_at_creation: string; status_at_creation: string; weekly_demand_at_creation: string | null; planning_date_at_creation: string | null; supplier_code_snapshot: string | null; classification_code_snapshot: string | null; unit_measure_snapshot: string | null; approved_quantity: string | null; prepared_quantity: string | null; dispatched_quantity: string | null; received_quantity: string | null; created_at: string; updated_at: string };
type EventRow = { id: string; order_id: string; event_type: OrderEventType; user_id: string | null; actor_name: string | null; actor_email: string | null; metadata: Record<string, unknown>; created_at: string };

export type OrderItem = Omit<ItemRow, "id" | "order_id" | "suggested_quantity" | "requested_quantity" | "stock_at_creation" | "stock_target_at_creation" | "weekly_demand_at_creation" | "approved_quantity" | "prepared_quantity" | "dispatched_quantity" | "received_quantity"> & { id: number; order_id: number; suggested_quantity: number | null; requested_quantity: number; stock_at_creation: number; stock_target_at_creation: number | null; weekly_demand_at_creation: number | null; approved_quantity: number | null; prepared_quantity: number | null; dispatched_quantity: number | null; received_quantity: number | null };
export type Order = Omit<OrderRow, "id" | "item_count" | "requested_units" | "approved_units" | "prepared_units" | "dispatched_units" | "received_units"> & { id: number; item_count: number; requested_units: number; approved_units: number; prepared_units: number; dispatched_units: number; received_units: number };
export type OrderEvent = Omit<EventRow, "id" | "order_id"> & { id: number; order_id: number };

const scopeWhere = "o.source_id = $1 AND o.branch_id = $2 AND ($3::integer IS NULL OR o.organization_id = $3)";
const warehouseOrScopeWhere = `(${scopeWhere} OR (o.organization_id=1 AND o.order_type='INTERNAL_REPLENISHMENT' AND o.destination_branch_id=1))`;
const scopeValues = (scope: Scope): [string, number, number | null] => [scope.sourceId, scope.branchId, scope.organizationId ?? null];
const numberOrNull = (value: string | null) => value === null ? null : Number(value);
const orderSelect = `SELECT o.*, COUNT(i.id) AS item_count, COALESCE(SUM(i.requested_quantity), 0) AS requested_units, COALESCE(SUM(i.approved_quantity), 0) AS approved_units, COALESCE(SUM(i.prepared_quantity), 0) AS prepared_units, COALESCE(SUM(i.dispatched_quantity), 0) AS dispatched_units, COALESCE(SUM(i.received_quantity), 0) AS received_units FROM orders o LEFT JOIN order_items i ON i.order_id=o.id`;

function mapOrder(row: OrderRow): Order { return { ...row, id: Number(row.id), item_count: Number(row.item_count), requested_units: Number(row.requested_units), approved_units: Number(row.approved_units), prepared_units: Number(row.prepared_units), dispatched_units: Number(row.dispatched_units), received_units: Number(row.received_units) }; }
function mapItem(row: ItemRow): OrderItem { return { ...row, id: Number(row.id), order_id: Number(row.order_id), suggested_quantity: numberOrNull(row.suggested_quantity), requested_quantity: Number(row.requested_quantity), stock_at_creation: Number(row.stock_at_creation), stock_target_at_creation: numberOrNull(row.stock_target_at_creation), weekly_demand_at_creation: numberOrNull(row.weekly_demand_at_creation), approved_quantity: numberOrNull(row.approved_quantity), prepared_quantity: numberOrNull(row.prepared_quantity), dispatched_quantity: numberOrNull(row.dispatched_quantity), received_quantity: numberOrNull(row.received_quantity) }; }
function mapEvent(row: EventRow): OrderEvent { return { ...row, id: Number(row.id), order_id: Number(row.order_id) }; }

async function addEvent(client: PoolClient, orderId: number, eventType: OrderEventType, metadata: Record<string, unknown> = {}, actorId?: string) {
  await client.query("INSERT INTO order_events (order_id, event_type, metadata, user_id) VALUES ($1, $2, $3::jsonb, $4)", [orderId, eventType, JSON.stringify(metadata), actorId ?? null]);
}

async function scopedOrder(client: PoolClient, scope: Scope, orderId: number): Promise<OrderRow> {
  const result = await client.query<OrderRow>(`${orderSelect} WHERE ${warehouseOrScopeWhere} AND o.id=$4 GROUP BY o.id`, [...scopeValues(scope), orderId]);
  if (!result.rows[0]) throw new RequestValidationError("Order not found in the configured scope.");
  return result.rows[0];
}

async function lockScopedOrder(client: PoolClient, scope: Scope, orderId: number): Promise<Pick<OrderRow, "status">> {
  const result = await client.query<Pick<OrderRow, "status">>(`SELECT o.status FROM orders o WHERE ${warehouseOrScopeWhere} AND o.id=$4 FOR UPDATE`, [...scopeValues(scope), orderId]);
  if (!result.rows[0]) throw new RequestValidationError("Order not found in the configured scope.");
  return result.rows[0];
}

async function requireDraft(client: PoolClient, scope: Scope, orderId: number) {
  const order = await lockScopedOrder(client, scope, orderId);
  if (!canEditOrder(order.status)) throw new RequestValidationError("Only DRAFT orders can be edited.");
  return order;
}

async function suggestionsById(scope: Scope, articleIds: number[]) {
  const result = await getSuggestions(scope, { articleIds, limit: articleIds.length, offset: 0 });
  const suggestions = new Map(result.rows.map((item) => [item.article_id, item]));
  if (suggestions.size !== articleIds.length) throw new RequestValidationError("One or more products are outside the configured scope.");
  return suggestions;
}

function automaticSuggestion(item: Suggestion) {
  return item.suggested_quantity !== null && item.status !== "MANUAL_REVIEW" && item.status !== "INSUFFICIENT_HISTORY";
}

export async function listOrders(scope: Scope, options: { status?: OrderStatus; search?: string; from?: string; to?: string; limit: number; offset: number }) {
  const values: unknown[] = [...scopeValues(scope), options.status ?? null, options.search ? `%${options.search}%` : null, options.from ?? null, options.to ?? null, options.limit, options.offset];
  const where = `${scopeWhere} AND ($4::text IS NULL OR o.status=$4) AND ($5::text IS NULL OR o.id::text ILIKE $5 OR EXISTS (SELECT 1 FROM order_items si WHERE si.order_id=o.id AND si.product_name_snapshot ILIKE $5)) AND ($6::date IS NULL OR o.created_at >= $6::date) AND ($7::date IS NULL OR o.created_at < $7::date + interval '1 day')`;
  const result = await query<OrderRow>(`${orderSelect} WHERE ${where} GROUP BY o.id ORDER BY o.created_at DESC LIMIT $8 OFFSET $9`, values);
  const total = await query<{ count: string }>(`SELECT COUNT(*) AS count FROM orders o WHERE ${where}`, values.slice(0, 7));
  return { total: Number(total.rows[0].count), rows: result.rows.map(mapOrder) };
}

export type WarehouseSummary = { pending: number; inPreparation: number; readyToDispatch: number; dispatched: number; completed: number };

export async function listWarehouseOrders(options: { status?: OrderStatus; originBranchId?: number; planningDate?: string; search?: string; readyToDispatch?: boolean; limit: number; offset: number }) {
  const values: unknown[] = [options.status ?? null, options.originBranchId ?? null, options.planningDate ?? null, options.search ? `%${options.search}%` : null, options.readyToDispatch ?? false, options.limit, options.offset];
  const baseWhere = "o.organization_id=1 AND o.order_type='INTERNAL_REPLENISHMENT' AND o.destination_branch_id=1 AND ($1::text IS NULL OR o.status=$1) AND ($2::integer IS NULL OR o.origin_branch_id=$2) AND ($3::date IS NULL OR o.planning_date=$3::date) AND ($4::text IS NULL OR o.id::text ILIKE $4 OR EXISTS (SELECT 1 FROM order_items si WHERE si.order_id=o.id AND (si.article_id::text ILIKE $4 OR si.product_name_snapshot ILIKE $4)))";
  const readyWhere = "(NOT $5::boolean OR (o.status='IN_PREPARATION' AND NOT EXISTS (SELECT 1 FROM order_items ri WHERE ri.order_id=o.id AND COALESCE(ri.prepared_quantity, 0) < COALESCE(ri.approved_quantity, 0))))";
  const where = `${baseWhere} AND ${readyWhere}`;
  const result = await query<OrderRow>(`${orderSelect} WHERE ${where} GROUP BY o.id ORDER BY CASE o.status WHEN 'CONFIRMED' THEN 1 WHEN 'IN_PREPARATION' THEN 2 WHEN 'DISPATCHED' THEN 3 WHEN 'COMPLETED' THEN 4 WHEN 'CANCELLED' THEN 5 ELSE 6 END, o.planning_date ASC NULLS LAST, o.created_at ASC LIMIT $6 OFFSET $7`, values);
  const total = await query<{ count: string }>(`SELECT COUNT(*) AS count FROM orders o WHERE ${where}`, values.slice(0, 5));
  const summary = await query<{ pending: string; in_preparation: string; ready_to_dispatch: string; dispatched: string; completed: string }>("SELECT COUNT(*) FILTER (WHERE o.status='CONFIRMED') AS pending, COUNT(*) FILTER (WHERE o.status='IN_PREPARATION') AS in_preparation, COUNT(*) FILTER (WHERE o.status='IN_PREPARATION' AND NOT EXISTS (SELECT 1 FROM order_items ri WHERE ri.order_id=o.id AND COALESCE(ri.prepared_quantity, 0) < COALESCE(ri.approved_quantity, 0))) AS ready_to_dispatch, COUNT(*) FILTER (WHERE o.status='DISPATCHED') AS dispatched, COUNT(*) FILTER (WHERE o.status='COMPLETED') AS completed FROM orders o WHERE o.organization_id=1 AND o.order_type='INTERNAL_REPLENISHMENT' AND o.destination_branch_id=1", []);
  const counts = summary.rows[0];
  return { total: Number(total.rows[0].count), rows: result.rows.map(mapOrder), summary: { pending: Number(counts.pending), inPreparation: Number(counts.in_preparation), readyToDispatch: Number(counts.ready_to_dispatch), dispatched: Number(counts.dispatched), completed: Number(counts.completed) } satisfies WarehouseSummary };
}

export async function listBranchReplenishmentOrders(originBranchId: number, options: { status?: OrderStatus; planningDate?: string; activeOnly?: boolean; limit: number; offset: number }) {
  const values: unknown[] = [originBranchId, options.status ?? null, options.planningDate ?? null, options.activeOnly ?? false, options.limit, options.offset];
  const where = "o.organization_id=1 AND o.order_type='INTERNAL_REPLENISHMENT' AND o.origin_branch_id=$1 AND ($2::text IS NULL OR o.status=$2) AND ($3::date IS NULL OR o.planning_date=$3::date) AND (NOT $4::boolean OR o.status <> 'CANCELLED')";
  const result = await query<OrderRow>(`${orderSelect} WHERE ${where} GROUP BY o.id ORDER BY o.planning_date DESC, o.created_at DESC LIMIT $5 OFFSET $6`, values);
  const total = await query<{ count: string }>(`SELECT COUNT(*) AS count FROM orders o WHERE ${where}`, values.slice(0, 4));
  return { total: Number(total.rows[0].count), rows: result.rows.map(mapOrder) };
}

export async function getOrder(scope: Scope, orderId: number) {
  const orderResult = await query<OrderRow>(`${orderSelect} WHERE ${warehouseOrScopeWhere} AND o.id=$4 GROUP BY o.id`, [...scopeValues(scope), orderId]);
  if (!orderResult.rows[0]) throw new RequestValidationError("Order not found in the configured scope.");
  const [items, events] = await Promise.all([
    query<ItemRow>("SELECT * FROM order_items WHERE order_id=$1 ORDER BY id", [orderId]),
    query<EventRow>("SELECT e.*, u.name AS actor_name, u.email AS actor_email FROM order_events e LEFT JOIN users u ON u.id::text=e.user_id WHERE e.order_id=$1 ORDER BY e.created_at, e.id", [orderId]),
  ]);
  return { ...mapOrder(orderResult.rows[0]), items: items.rows.map(mapItem), events: events.rows.map(mapEvent) };
}

export async function createOrder(scope: Scope, articleIds: number[], notes = "", actorId?: string) {
  if (!articleIds.length) throw new RequestValidationError("Select at least one suggested product.");
  const distinct = [...new Set(articleIds)];
  const suggestions = await suggestionsById(scope, distinct);
  const unavailable = distinct.filter((id) => !automaticSuggestion(suggestions.get(id)!));
  if (unavailable.length) throw new RequestValidationError("Manual review and insufficient-history products cannot be added automatically.");
  return withTransaction(async (client) => {
    const created = await client.query<{ id: string }>("INSERT INTO orders (organization_id,source_id,branch_id,status,notes,created_by) VALUES ($1,$2,$3,'DRAFT',$4,$5) RETURNING id", [scope.organizationId ?? null, scope.sourceId, scope.branchId, notes, actorId ?? null]);
    const orderId = Number(created.rows[0].id);
    await addEvent(client, orderId, "ORDER_CREATED", {}, actorId);
    for (const articleId of distinct) {
      const item = suggestions.get(articleId)!;
      await client.query("INSERT INTO order_items (order_id,article_id,product_name_snapshot,suggested_quantity,requested_quantity,stock_at_creation,stock_target_at_creation,confidence_at_creation,status_at_creation) VALUES ($1,$2,$3,$4,$4,$5,$6,$7,$8)", [orderId, item.article_id, item.product_name ?? `Artículo ${item.article_id}`, item.suggested_quantity, item.current_stock, item.stock_target, item.confidence, item.status]);
      await addEvent(client, orderId, "ITEM_ADDED", { article_id: item.article_id, requested_quantity: item.suggested_quantity }, actorId);
    }
    return orderId;
  });
}

export async function updateOrder(scope: Scope, orderId: number, notes: string) {
  return withTransaction(async (client) => { await requireDraft(client, scope, orderId); await client.query("UPDATE orders SET notes=$1,updated_at=now() WHERE id=$2", [notes, orderId]); });
}

export async function addItem(scope: Scope, orderId: number, articleId: number, requestedQuantity?: number, actorId?: string) {
  const suggestions = await suggestionsById(scope, [articleId]); const suggestion = suggestions.get(articleId)!;
  const quantity = requestedQuantity ?? suggestion.suggested_quantity;
  if (quantity === null || !Number.isFinite(quantity) || quantity < 0) throw new RequestValidationError("A valid requested quantity is required.");
  return withTransaction(async (client) => { await requireDraft(client, scope, orderId); await client.query("INSERT INTO order_items (order_id,article_id,product_name_snapshot,suggested_quantity,requested_quantity,stock_at_creation,stock_target_at_creation,confidence_at_creation,status_at_creation) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)", [orderId, articleId, suggestion.product_name ?? `Artículo ${articleId}`, suggestion.suggested_quantity, quantity, suggestion.current_stock, suggestion.stock_target, suggestion.confidence, suggestion.status]); await addEvent(client, orderId, "ITEM_ADDED", { article_id: articleId, requested_quantity: quantity, manual_review: suggestion.status === "MANUAL_REVIEW" }, actorId); });
}

export async function updateItemQuantity(scope: Scope, orderId: number, itemId: number, quantity: number, actorId?: string) {
  return withTransaction(async (client) => { await requireDraft(client, scope, orderId); const old = await client.query<{ requested_quantity: string }>("SELECT requested_quantity FROM order_items WHERE id=$1 AND order_id=$2 FOR UPDATE", [itemId, orderId]); if (!old.rows[0]) throw new RequestValidationError("Order item not found."); await client.query("UPDATE order_items SET requested_quantity=$1,updated_at=now() WHERE id=$2", [quantity, itemId]); await addEvent(client, orderId, "ITEM_QUANTITY_CHANGED", { item_id: itemId, old_quantity: Number(old.rows[0].requested_quantity), new_quantity: quantity }, actorId); });
}

export async function removeItem(scope: Scope, orderId: number, itemId: number, actorId?: string) {
  return withTransaction(async (client) => { await requireDraft(client, scope, orderId); const deleted = await client.query<{ article_id: number }>("DELETE FROM order_items WHERE id=$1 AND order_id=$2 RETURNING article_id", [itemId, orderId]); if (!deleted.rows[0]) throw new RequestValidationError("Order item not found."); await addEvent(client, orderId, "ITEM_REMOVED", { item_id: itemId, article_id: deleted.rows[0].article_id }, actorId); });
}

export async function changeStatus(scope: Scope, orderId: number, next: OrderStatus, actorId?: string) {
  return withTransaction(async (client) => { const current = await lockScopedOrder(client, scope, orderId); const event = transitionEvent(current.status, next); if (!event) throw new RequestValidationError(`Transition from ${current.status} to ${next} is not allowed.`); if (next === "CONFIRMED") { const count = await client.query<{ count: string }>("SELECT COUNT(*) AS count FROM order_items WHERE order_id=$1", [orderId]); if (Number(count.rows[0].count) === 0) throw new RequestValidationError("An order needs at least one item before confirmation."); }
    await client.query("UPDATE orders SET status=$1,updated_at=now(),confirmed_at=CASE WHEN $1='CONFIRMED' THEN now() ELSE confirmed_at END,confirmed_by=CASE WHEN $1='CONFIRMED' THEN $3 ELSE confirmed_by END,completed_at=CASE WHEN $1='COMPLETED' THEN now() ELSE completed_at END WHERE id=$2", [next, orderId, actorId ?? null]); await addEvent(client, orderId, event, {}, actorId); });
}

type OperationalField = "approved_quantity" | "prepared_quantity";
const operationalEvent: Record<OperationalField, OrderEventType> = { approved_quantity: "ITEM_APPROVED_QUANTITY_CHANGED", prepared_quantity: "ITEM_PREPARED_QUANTITY_CHANGED" };

export async function updateOperationalQuantity(scope: Scope, orderId: number, itemId: number, field: OperationalField, quantity: number, actorId?: string) {
  return withTransaction(async (client) => {
    const order = await lockScopedOrder(client, scope, orderId);
    if (order.status !== "IN_PREPARATION") throw new RequestValidationError("Operational quantities can only be updated during IN_PREPARATION.");
    const result = await client.query<{ requested_quantity: string; approved_quantity: string | null; prepared_quantity: string | null }>("SELECT requested_quantity, approved_quantity, prepared_quantity FROM order_items WHERE id=$1 AND order_id=$2 FOR UPDATE", [itemId, orderId]);
    const item = result.rows[0]; if (!item) throw new RequestValidationError("Order item not found.");
    const maximum = field === "approved_quantity" ? Number(item.requested_quantity) : Number(item.approved_quantity ?? 0);
    if (!isOperationalQuantityValid(quantity, maximum)) throw new RequestValidationError(`${field} must be between 0 and ${maximum}.`);
    if (field === "approved_quantity" && item.prepared_quantity !== null && Number(item.prepared_quantity) > quantity) throw new RequestValidationError("approved_quantity cannot be below the prepared quantity.");
    await client.query(`UPDATE order_items SET ${field}=$1,updated_at=now() WHERE id=$2`, [quantity, itemId]);
    await addEvent(client, orderId, operationalEvent[field], { item_id: itemId, [field]: quantity }, actorId);
  });
}

type FulfillmentField = "dispatched_quantity" | "received_quantity";
const fulfillmentEvent: Record<FulfillmentField, OrderEventType> = { dispatched_quantity: "ITEM_DISPATCHED_QUANTITY_CHANGED", received_quantity: "ITEM_RECEIVED_QUANTITY_CHANGED" };

export async function fulfillOrder(scope: Scope, orderId: number, field: FulfillmentField, quantities: Array<{ itemId: number; quantity: number }>, actorId?: string) {
  return withTransaction(async (client) => {
    const order = await lockScopedOrder(client, scope, orderId);
    const requiredStatus: OrderStatus = field === "dispatched_quantity" ? "IN_PREPARATION" : "DISPATCHED";
    const nextStatus: OrderStatus = field === "dispatched_quantity" ? "DISPATCHED" : "COMPLETED";
    if (order.status !== requiredStatus) throw new RequestValidationError(`${field} can only be registered from ${requiredStatus}.`);
    const items = await client.query<{ id: string; approved_quantity: string | null; prepared_quantity: string | null; dispatched_quantity: string | null }>("SELECT id, approved_quantity, prepared_quantity, dispatched_quantity FROM order_items WHERE order_id=$1 FOR UPDATE", [orderId]);
    if (quantities.length !== items.rows.length || new Set(quantities.map((item) => item.itemId)).size !== items.rows.length) throw new RequestValidationError("A quantity is required for every order item.");
    const byId = new Map(quantities.map((item) => [item.itemId, item.quantity]));
    for (const item of items.rows) {
      const quantity = byId.get(Number(item.id));
      const maximum = field === "dispatched_quantity" ? Number(item.prepared_quantity ?? 0) : Number(item.dispatched_quantity ?? 0);
      if (quantity === undefined || !isOperationalQuantityValid(quantity, maximum)) throw new RequestValidationError(`${field} must be between 0 and ${maximum}.`);
    }
    for (const item of items.rows) { const quantity = byId.get(Number(item.id))!; const dispatchedQuantity = Number(item.dispatched_quantity ?? 0); await client.query(`UPDATE order_items SET ${field}=$1,updated_at=now() WHERE id=$2`, [quantity, item.id]); await addEvent(client, orderId, fulfillmentEvent[field], field === "received_quantity" ? { item_id: Number(item.id), received_quantity: quantity, dispatched_quantity: dispatchedQuantity, difference: dispatchedQuantity - quantity } : { item_id: Number(item.id), [field]: quantity }, actorId); }
    const event = transitionEvent(order.status, nextStatus); if (!event) throw new RequestValidationError("Order transition is not allowed.");
    await client.query("UPDATE orders SET status=$1,updated_at=now(),completed_at=CASE WHEN $1='COMPLETED' THEN now() ELSE completed_at END WHERE id=$2", [nextStatus, orderId]);
    const completionDifference = field === "received_quantity" ? items.rows.reduce((sum, item) => sum + Number(item.dispatched_quantity ?? 0) - byId.get(Number(item.id))!, 0) : 0;
    await addEvent(client, orderId, event, field === "received_quantity" ? { received_with_difference: completionDifference > 0, total_difference: completionDifference } : {}, actorId);
  });
}
