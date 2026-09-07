import { query } from "@/server/db/client";
import { NotFoundError } from "./errors";

export async function getSourceForBranch(organizationId: number, branchId: number) {
  const result = await query<{ source_id: string }>("SELECT s.source_id FROM sources s JOIN branches b ON b.id=s.branch_id AND b.organization_id=s.organization_id WHERE s.organization_id=$1 AND s.branch_id=$2 AND s.is_active=true AND b.active=true ORDER BY s.id LIMIT 2", [organizationId, branchId]);
  if (!result.rows[0]) throw new NotFoundError("No active source is configured for this branch.");
  if (result.rows[1]) throw new Error("More than one active source is configured for this branch.");
  return result.rows[0].source_id;
}
