import { getSuggestions, suggestionConfidences, suggestionStatuses, type SuggestionConfidence, type SuggestionStatus } from "@/server/analytics/demand";
import { getAuthorizedScope } from "@/server/auth/scope";
import { canConfirmReplenishment } from "@/server/auth/policies";
import { ForbiddenError } from "@/server/auth/errors";
import { RequestValidationError, parseOptionalPositiveInteger, parseSearch } from "@/server/validation/request";
import { apiResponse } from "../../dashboard/_shared";

export const runtime = "nodejs";

function parseOption<T extends string>(value: string | null, options: readonly T[], name: string): T | undefined {
  if (!value) return undefined;
  if ((options as readonly string[]).includes(value)) return value as T;
  throw new RequestValidationError(`${name} is not valid.`);
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  return apiResponse(async () => {
    const page = parseOptionalPositiveInteger(params.get("page"), "page") ?? 1;
    const pageSize = parseOptionalPositiveInteger(params.get("page_size"), "page_size") ?? 25;
    if (pageSize > 100) throw new RequestValidationError("page_size cannot exceed 100.");
    const { context, scope } = await getAuthorizedScope(params);
    if (!canConfirmReplenishment(context, scope.branchId))
      throw new ForbiddenError();
    return getSuggestions(scope, {
      search: parseSearch(params.get("search")), status: parseOption<SuggestionStatus>(params.get("status"), suggestionStatuses, "status"),
      confidence: parseOption<SuggestionConfidence>(params.get("confidence"), suggestionConfidences, "confidence"), limit: pageSize, offset: (page - 1) * pageSize,
    }).then((result) => ({ ...result, page, page_size: pageSize }));
  });
}
