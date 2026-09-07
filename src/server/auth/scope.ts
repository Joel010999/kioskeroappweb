import type { Scope } from "@/server/analytics/types";
import { getCurrentUser, type AuthorizationContext } from "./context";
import { ForbiddenError } from "./errors";
import { canAccessBranch } from "./policies";
import { getSourceForBranch } from "./sources";

export async function getAuthorizedContext() { return getCurrentUser(); }

export async function getAuthorizedScope(params: Pick<URLSearchParams, "get">): Promise<{ context: AuthorizationContext; scope: Scope }> {
  const context = await getCurrentUser();
  const requestedBranch = params.get("branch_id");
  const branchId = requestedBranch === null ? context.memberships[0]?.branchId : Number(requestedBranch);
  if (!branchId || !canAccessBranch(context, branchId)) throw new ForbiddenError("You cannot access this branch.");
  return { context, scope: { organizationId: context.organizationId, branchId, sourceId: await getSourceForBranch(context.organizationId, branchId) } };
}
