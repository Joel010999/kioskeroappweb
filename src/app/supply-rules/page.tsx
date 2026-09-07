import { SupplyRulesClient } from "@/features/supply/supply-rules-client";
import { getAuthorizedContext } from "@/server/auth/scope";
import { ForbiddenError } from "@/server/auth/errors";

export const dynamic = "force-dynamic";

export default async function SupplyRulesPage() {
  const context = await getAuthorizedContext();
  const branches = [
    ...new Set(
      context.memberships
        .filter((membership) => membership.role === "PV_OPERATOR")
        .map((membership) => membership.branchId),
    ),
  ];
  if (!branches.length) throw new ForbiddenError();
  return <SupplyRulesClient branches={branches} />;
}
