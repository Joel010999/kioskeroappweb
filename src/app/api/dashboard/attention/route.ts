import { getAttention } from "@/server/analytics/dashboard";
import { getAuthorizedScope } from "@/server/auth/scope";
import { parsePeriod } from "@/server/validation/request";
import { apiResponse } from "../_shared";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  return apiResponse(async () => getAttention((await getAuthorizedScope(params)).scope, parsePeriod(params)));
}
