import { describe, expect, it } from "vitest";
import { canAccessBranch, canConfirmReplenishment, canDispatchOrder, canPrepareOrder, canReceiveOrder, canViewOrder } from "./policies";
import type { AuthorizationContext } from "./context";

const order = { organizationId: 1, originBranchId: 2, destinationBranchId: 1 };
const pv1: AuthorizationContext = { userId: 1, organizationId: 1, userActive: true, memberships: [{ branchId: 2, role: "PV_OPERATOR", active: true }] };
const pv2: AuthorizationContext = { userId: 2, organizationId: 1, userActive: true, memberships: [{ branchId: 3, role: "PV_OPERATOR", active: true }] };
const warehouse: AuthorizationContext = { userId: 3, organizationId: 1, userActive: true, memberships: [{ branchId: 1, role: "WAREHOUSE_OPERATOR", active: true }] };

describe("authorization policies", () => {
  it("limits PV1 to branch 2 and its replenishment order", () => { expect(canAccessBranch(pv1, 2)).toBe(true); expect(canAccessBranch(pv1, 3)).toBe(false); expect(canAccessBranch(pv1, 1)).toBe(false); expect(canConfirmReplenishment(pv1, 2)).toBe(true); expect(canViewOrder(pv1, order)).toBe(true); expect(canPrepareOrder(pv1, order)).toBe(false); expect(canDispatchOrder(pv1, order)).toBe(false); expect(canReceiveOrder(pv1, order)).toBe(true); });
  it("limits PV2 to branch 3 and rejects PV1 orders", () => { expect(canAccessBranch(pv2, 3)).toBe(true); expect(canAccessBranch(pv2, 2)).toBe(false); expect(canAccessBranch(pv2, 1)).toBe(false); expect(canViewOrder(pv2, order)).toBe(false); expect(canConfirmReplenishment(pv2, 2)).toBe(false); });
  it("allows warehouse preparation and dispatch but not reception", () => { expect(canAccessBranch(warehouse, 1)).toBe(true); expect(canPrepareOrder(warehouse, order)).toBe(true); expect(canDispatchOrder(warehouse, order)).toBe(true); expect(canReceiveOrder(warehouse, order)).toBe(false); });
  it("rejects a different organization, inactive memberships, and inactive users", () => { expect(canViewOrder(pv1, { ...order, organizationId: 2 })).toBe(false); expect(canAccessBranch({ ...pv1, memberships: [{ branchId: 2, role: "PV_OPERATOR", active: false }] }, 2)).toBe(false); expect(canAccessBranch({ ...pv1, userActive: false }, 2)).toBe(false); });
});
