import { WeeklyReplenishmentClient } from "@/features/replenishment/weekly-replenishment-client";
import { getAuthorizedScope } from "@/server/auth/scope";
export const dynamic = "force-dynamic";

export default async function ReplenishmentPage() {
  const { scope } = await getAuthorizedScope(new URLSearchParams());
  return <WeeklyReplenishmentClient authorizedBranchId={scope.branchId} />;
}
