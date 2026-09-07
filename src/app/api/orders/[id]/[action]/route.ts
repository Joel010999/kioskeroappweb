import { changeStatus, fulfillOrder } from "@/server/orders/repository";
import { body, id, operationalItems } from "@/server/orders/request";
import { getAuthorizedContext, getAuthorizedScope } from "@/server/auth/scope";
import { getAuthorizedOrder, toPolicyOrder } from "@/server/auth/orders";
import { ForbiddenError } from "@/server/auth/errors";
import { canDispatchOrder, canModifyOrder, canPrepareOrder, canReceiveOrder } from "@/server/auth/policies";
import { RequestValidationError } from "@/server/validation/request";
import { apiResponse } from "../../../dashboard/_shared";
export const runtime = "nodejs";
const actions = { confirm: "CONFIRMED", cancel: "CANCELLED", prepare: "IN_PREPARATION", dispatch: "DISPATCHED", complete: "COMPLETED" } as const;
export async function POST(request: Request, context: { params: Promise<{ id: string; action: string }> }) { const params = new URL(request.url).searchParams; return apiResponse(async () => { const route = await context.params; const status = actions[route.action as keyof typeof actions]; if (!status) throw new RequestValidationError("Order action is not valid."); const auth = await getAuthorizedContext(); const scope = (await getAuthorizedScope(params)).scope; const orderId = id(route.id, "id"); const order = await getAuthorizedOrder(auth, scope, orderId); const policy = toPolicyOrder(order); const allowed = route.action === "prepare" ? canPrepareOrder(auth, policy) : route.action === "dispatch" ? canDispatchOrder(auth, policy) : route.action === "complete" ? canReceiveOrder(auth, policy) : canModifyOrder(auth, policy); if (!allowed) throw new ForbiddenError(); const actorId = String(auth.userId); if (route.action === "dispatch" || route.action === "complete") { const input = await body(request); await fulfillOrder(scope, orderId, route.action === "dispatch" ? "dispatched_quantity" : "received_quantity", operationalItems(input.items), actorId); } else await changeStatus(scope, orderId, status, actorId); return { ok: true, status }; }); }
