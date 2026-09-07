import { OrderDetailClient } from "@/features/orders/orders-client";
import { getAuthorizedContext } from "@/server/auth/scope";
import { canAccessBranch } from "@/server/auth/policies";
import { ForbiddenError } from "@/server/auth/errors";

export default async function WarehouseOrderPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const context = await getAuthorizedContext();
  if (!canAccessBranch(context, 1)) throw new ForbiddenError();
  const id = Number((await params).id);
  return (
    <OrderDetailClient
      orderId={Number.isSafeInteger(id) && id > 0 ? id : 0}
      surface="warehouse"
      branchId={1}
    />
  );
}
