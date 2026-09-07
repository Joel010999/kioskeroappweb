import { updateOrder } from "@/server/orders/repository";
import { body, id, notes } from "@/server/orders/request";
import { getAuthorizedContext, getAuthorizedScope } from "@/server/auth/scope";
import { getAuthorizedOrder, toPolicyOrder } from "@/server/auth/orders";
import { canModifyOrder } from "@/server/auth/policies";
import { ForbiddenError } from "@/server/auth/errors";
import { apiResponse } from "../../dashboard/_shared";
export const runtime = "nodejs";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) { const params = new URL(request.url).searchParams; return apiResponse(async () => { const auth = await getAuthorizedContext(); const scope = (await getAuthorizedScope(params)).scope; return getAuthorizedOrder(auth, scope, id((await context.params).id, "id")); }); }
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) { const params = new URL(request.url).searchParams; return apiResponse(async () => { const auth = await getAuthorizedContext(); const scope = (await getAuthorizedScope(params)).scope; const orderId = id((await context.params).id, "id"); const order = await getAuthorizedOrder(auth, scope, orderId); if (!canModifyOrder(auth, toPolicyOrder(order))) throw new ForbiddenError(); await updateOrder(scope, orderId, notes((await body(request)).notes)); return { ok: true }; }); }
