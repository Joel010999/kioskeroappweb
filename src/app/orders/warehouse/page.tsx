import { OrdersClient } from "@/features/orders/orders-client";
import { getAuthorizedScope } from "@/server/auth/scope";
export const dynamic = "force-dynamic";
export default async function WarehousePage() { const { scope } = await getAuthorizedScope(new URLSearchParams()); return <OrdersClient warehouse branchId={scope.branchId} />; }
