import { getOrder, type Order } from "@/server/orders/repository";
import { NotFoundError } from "./errors";
import { canViewOrder } from "./policies";
import type { AuthorizationContext } from "./context";
import type { Scope } from "@/server/analytics/types";

function policyOrder(order: Order) { return { organizationId: order.organization_id, originBranchId: order.origin_branch_id, destinationBranchId: order.destination_branch_id }; }

export async function getAuthorizedOrder(context: AuthorizationContext, scope: Scope, orderId: number) {
  const order = await getOrder(scope, orderId);
  if (!canViewOrder(context, policyOrder(order))) throw new NotFoundError();
  return order;
}

export function toPolicyOrder(order: Order) { return policyOrder(order); }
