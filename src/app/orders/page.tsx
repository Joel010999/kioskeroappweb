import { OrdersClient } from "@/features/orders/orders-client";
import { getAuthorizedScope } from "@/server/auth/scope";
import { canConfirmReplenishment } from "@/server/auth/policies";
import { ForbiddenError } from "@/server/auth/errors";
export const dynamic = "force-dynamic";
export default async function OrdersPage() { const { context, scope } = await getAuthorizedScope(new URLSearchParams()); if (!canConfirmReplenishment(context, scope.branchId)) throw new ForbiddenError(); return <OrdersClient branchId={scope.branchId} />; }
