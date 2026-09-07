import { getDataHealth } from "@/server/analytics/dashboard";
import { getAuthorizedScope } from "@/server/auth/scope";
import { apiResponse } from "../_shared";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  return apiResponse(async () => getDataHealth((await getAuthorizedScope(params)).scope));
}
