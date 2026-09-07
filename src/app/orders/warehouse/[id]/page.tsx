import { OrderDetailClient } from "@/features/orders/orders-client";

export default async function WarehouseOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  return <OrderDetailClient orderId={Number.isSafeInteger(id) && id > 0 ? id : 0} surface="warehouse" />;
}
