export const orderStatuses = ["DRAFT", "CONFIRMED", "RECEIVED_BY_WAREHOUSE", "IN_PREPARATION", "PARTIALLY_PREPARED", "PREPARED", "DISPATCHED", "PARTIALLY_RECEIVED", "COMPLETED", "CANCELLED"] as const;
export const orderEventTypes = ["ORDER_CREATED", "ITEM_ADDED", "ITEM_REMOVED", "ITEM_QUANTITY_CHANGED", "ORDER_CONFIRMED", "ORDER_CANCELLED", "ORDER_IN_PREPARATION", "ORDER_DISPATCHED", "ORDER_COMPLETED", "ORDER_RECEIVED_BY_WAREHOUSE", "PREPARATION_STARTED", "ITEM_APPROVED_QUANTITY_CHANGED", "ITEM_PREPARED_QUANTITY_CHANGED", "ORDER_PARTIALLY_PREPARED", "ORDER_PREPARED", "ITEM_DISPATCHED_QUANTITY_CHANGED", "ITEM_RECEIVED_QUANTITY_CHANGED", "ORDER_PARTIALLY_RECEIVED"] as const;

export type OrderStatus = (typeof orderStatuses)[number];
export type OrderEventType = (typeof orderEventTypes)[number];

const transitions: Record<OrderStatus, Partial<Record<OrderStatus, OrderEventType>>> = {
  DRAFT: { CONFIRMED: "ORDER_CONFIRMED", CANCELLED: "ORDER_CANCELLED" },
  CONFIRMED: { IN_PREPARATION: "ORDER_IN_PREPARATION", CANCELLED: "ORDER_CANCELLED" },
  RECEIVED_BY_WAREHOUSE: {},
  IN_PREPARATION: { DISPATCHED: "ORDER_DISPATCHED" },
  PARTIALLY_PREPARED: {},
  PREPARED: {},
  DISPATCHED: { COMPLETED: "ORDER_COMPLETED" },
  PARTIALLY_RECEIVED: { COMPLETED: "ORDER_COMPLETED" },
  COMPLETED: {},
  CANCELLED: {},
};

export function transitionEvent(from: OrderStatus, to: OrderStatus): OrderEventType | null {
  return transitions[from][to] ?? null;
}

export function canEditOrder(status: OrderStatus) { return status === "DRAFT"; }

export function isValidQuantity(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function isOperationalQuantityValid(value: number, maximum: number) {
  return isValidQuantity(value) && value <= maximum;
}
