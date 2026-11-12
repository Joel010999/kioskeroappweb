import { BaseStockClient } from "@/features/base-stock/base-stock-client";
import { getAuthorizedScope } from "@/server/auth/scope";
import { canConfirmReplenishment } from "@/server/auth/policies";
import { ForbiddenError, UnauthenticatedError } from "@/server/auth/errors";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function BaseStockPage() {
  let authorizedBranchId: number;
  let availableBranches: number[];

  try {
    const { context, scope } = await getAuthorizedScope(new URLSearchParams());
    if (!canConfirmReplenishment(context, scope.branchId)) {
      throw new ForbiddenError();
    }
    authorizedBranchId = scope.branchId;
    const pvBranches = [
      ...new Set(
        context.memberships
          .filter(
            (m) => m.active && m.role === "PV_OPERATOR" && typeof m.branchId === "number",
          )
          .map((m) => m.branchId as number),
      ),
    ].sort((a, b) => a - b);
    availableBranches = pvBranches.length ? pvBranches : [scope.branchId];
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      redirect("/login?returnTo=/base-stock");
    }
    throw error;
  }

  return (
    <BaseStockClient
      defaultBranchId={authorizedBranchId}
      authorizedBranchIds={availableBranches}
    />
  );
}

