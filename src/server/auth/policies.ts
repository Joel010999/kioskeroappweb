import type { AuthorizationContext, AuthorizationMembership } from "./context";

export type AuthorizedOrder = { organizationId: number | null; originBranchId: number | null; destinationBranchId: number | null };

function membership(context: AuthorizationContext, branchId: number, role?: AuthorizationMembership["role"]) {
  return context.userActive && context.memberships.some((item) => item.active && item.branchId === branchId && (!role || item.role === role));
}

function belongsToOrganization(context: AuthorizationContext, order: AuthorizedOrder) { return order.organizationId === context.organizationId; }

export function canAccessBranch(context: AuthorizationContext, branchId: number) { return membership(context, branchId); }
export function canOperateBranch(context: AuthorizationContext, branchId: number) { return membership(context, branchId); }
export function canViewOrder(context: AuthorizationContext, order: AuthorizedOrder) {
  if (!belongsToOrganization(context, order)) return false;
  return (order.originBranchId !== null && membership(context, order.originBranchId, "PV_OPERATOR")) || (order.destinationBranchId !== null && membership(context, order.destinationBranchId, "WAREHOUSE_OPERATOR"));
}
export function canModifyOrder(context: AuthorizationContext, order: AuthorizedOrder) { return canViewOrder(context, order); }
export function canConfirmReplenishment(context: AuthorizationContext, originBranchId: number) { return membership(context, originBranchId, "PV_OPERATOR"); }
export function canPrepareOrder(context: AuthorizationContext, order: AuthorizedOrder) { return belongsToOrganization(context, order) && order.destinationBranchId !== null && membership(context, order.destinationBranchId, "WAREHOUSE_OPERATOR"); }
export function canDispatchOrder(context: AuthorizationContext, order: AuthorizedOrder) { return canPrepareOrder(context, order); }
export function canReceiveOrder(context: AuthorizationContext, order: AuthorizedOrder) { return belongsToOrganization(context, order) && order.originBranchId !== null && membership(context, order.originBranchId, "PV_OPERATOR"); }
