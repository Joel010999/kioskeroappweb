import { getStock } from "@/server/analytics/dashboard";
import { getAuthorizedScope } from "@/server/auth/scope";
import {
  parseOptionalNonNegativeNumber,
  parseOptionalPositiveInteger,
  parsePagination,
  parseSearch,
} from "@/server/validation/request";
import { apiResponse } from "../_shared";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  return apiResponse(async () => {
    const { limit, page, offset } = parsePagination(params);
    return getStock((await getAuthorizedScope(params)).scope, {
      limit,
      offset,
      depo: parseOptionalPositiveInteger(params.get("depo"), "depo"),
      search: parseSearch(params.get("search")),
      lowStockThreshold: parseOptionalNonNegativeNumber(params.get("low_stock_threshold"), "low_stock_threshold"),
    }).then((result) => ({ ...result, page, limit }));
  });
}
