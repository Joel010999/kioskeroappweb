import { DashboardClient } from "@/features/dashboard/dashboard-client";
import { getAuthorizedScope } from "@/server/auth/scope";
import { query } from "@/server/db/client";

export const dynamic = "force-dynamic";
export default async function DashboardPage() {
  const { scope } = await getAuthorizedScope(new URLSearchParams());
  const result = await query<{ name: string; type: "POS" | "WAREHOUSE" }>("SELECT name, type FROM branches WHERE id=$1 AND organization_id=$2 AND active=true", [scope.branchId, scope.organizationId]);
  const branch = result.rows[0];
  if (!branch) throw new Error("Authorized branch is unavailable.");
  return <DashboardClient branchName={branch.type === "WAREHOUSE" ? "DEPÓSITO" : branch.name} />;
}
