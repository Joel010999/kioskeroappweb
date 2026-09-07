import { OrdersClient } from "@/features/orders/orders-client";
import { getAuthorizedScope } from "@/server/auth/scope";
import { canAccessBranch } from "@/server/auth/policies";
import { ForbiddenError } from "@/server/auth/errors";
export const dynamic = "force-dynamic";
export default async function WarehousePage() { const { context, scope } = await getAuthorizedScope(new URLSearchParams()); if (!canAccessBranch(context, 1)) throw new ForbiddenError(); return <OrdersClient warehouse branchId={scope.branchId} />; }
