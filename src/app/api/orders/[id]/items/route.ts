import { addItem } from "@/server/orders/repository";
import { body, id, quantity } from "@/server/orders/request";
import { getAuthorizedContext, getAuthorizedScope } from "@/server/auth/scope";
import { getAuthorizedOrder, toPolicyOrder } from "@/server/auth/orders";
import { canModifyOrder } from "@/server/auth/policies";
import { ForbiddenError } from "@/server/auth/errors";
import { RequestValidationError } from "@/server/validation/request";
import { apiResponse } from "../../../dashboard/_shared";
export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) { const params = new URL(request.url).searchParams; return apiResponse(async () => { const input = await body(request); if (!Number.isSafeInteger(input.article_id) || (input.article_id as number) < 1) throw new RequestValidationError("article_id must be a positive integer."); const auth = await getAuthorizedContext(); const scope = (await getAuthorizedScope(params)).scope; const orderId = id((await context.params).id, "id"); const order = await getAuthorizedOrder(auth, scope, orderId); if (!canModifyOrder(auth, toPolicyOrder(order))) throw new ForbiddenError(); await addItem(scope, orderId, input.article_id as number, input.requested_quantity === undefined ? undefined : quantity(input.requested_quantity), String(auth.userId)); return { ok: true }; }); }
