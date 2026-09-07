import { OrdersClient } from "@/features/orders/orders-client";
import { getAuthorizedScope } from "@/server/auth/scope";
export const dynamic = "force-dynamic";
export default async function OrdersPage() { const { scope } = await getAuthorizedScope(new URLSearchParams()); return <OrdersClient branchId={scope.branchId} />; }
