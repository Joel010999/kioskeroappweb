import { getTimeseries } from "@/server/analytics/dashboard";
import { getAuthorizedScope } from "@/server/auth/scope";
import { parseGranularity, parsePeriod } from "@/server/validation/request";
import { apiResponse } from "../_shared";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  return apiResponse(async () => getTimeseries((await getAuthorizedScope(params)).scope, parsePeriod(params), parseGranularity(params.get("granularity"))));
}
