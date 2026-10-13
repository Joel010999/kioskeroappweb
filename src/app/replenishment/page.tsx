import { ReplenishmentReviewClient } from "@/features/replenishment/replenishment-review-client";
import { getAuthorizedScope } from "@/server/auth/scope";
import { canConfirmReplenishment } from "@/server/auth/policies";
import { ForbiddenError, UnauthenticatedError } from "@/server/auth/errors";
import { redirect } from "next/navigation";
export const dynamic = "force-dynamic";

export default async function ReplenishmentReviewPage() {
  let authorizedBranchId: number;
  try {
    const { context, scope } = await getAuthorizedScope(new URLSearchParams());
    if (!canConfirmReplenishment(context, scope.branchId)) throw new ForbiddenError();
    authorizedBranchId = scope.branchId;
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      redirect("/login?returnTo=/replenishment");
    }
    throw error;
  }
  return <ReplenishmentReviewClient authorizedBranchId={authorizedBranchId} />;
}
