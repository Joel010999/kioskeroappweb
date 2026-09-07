import { OrderDetailClient } from "@/features/orders/orders-client";
import { getAuthorizedContext } from "@/server/auth/scope";
import { canConfirmReplenishment } from "@/server/auth/policies";
import { ForbiddenError } from "@/server/auth/errors";

export default async function OrderPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const context = await getAuthorizedContext();
  const pvMembership = context.memberships.find(
    (membership) => membership.active && membership.role === "PV_OPERATOR",
  );
  if (!pvMembership || !canConfirmReplenishment(context, pvMembership.branchId))
    throw new ForbiddenError();
  const id = Number((await params).id);
  return (
    <OrderDetailClient
      orderId={Number.isSafeInteger(id) && id > 0 ? id : 0}
      surface="pv"
      branchId={pvMembership.branchId}
    />
  );
}
