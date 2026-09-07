import { ReplenishmentReviewClient } from "@/features/replenishment/replenishment-review-client";
import { getAuthorizedScope } from "@/server/auth/scope";
export const dynamic = "force-dynamic";

export default async function ReplenishmentReviewPage() {
  const { scope } = await getAuthorizedScope(new URLSearchParams());
  return <ReplenishmentReviewClient authorizedBranchId={scope.branchId} />;
}
