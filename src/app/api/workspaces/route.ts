import { NextRequest } from "next/server";
import { getAuthorizedScope } from "@/server/auth/scope";
import { createWorkspace, getWorkspaces } from "@/server/workspaces/repository";
import { apiResponse } from "@/app/api/dashboard/_shared";
import { RequestValidationError } from "@/server/validation/request";

export async function GET(request: NextRequest) {
  return apiResponse(async () => {
    const { searchParams } = new URL(request.url);
    const branchId = searchParams.get("branch_id");
    if (!branchId) throw new RequestValidationError("branch_id is required");

    const { scope } = await getAuthorizedScope(new URLSearchParams({ branch_id: branchId }));
    
    // El frontend necesita ver todos los pedidos
    const workspaces = await getWorkspaces(scope.branchId);
    return { workspaces };
  });
}

export async function POST(request: NextRequest) {
  return apiResponse(async () => {
    const input = await request.json();
    const branchId = String(input.branch_id);
    if (!branchId) throw new RequestValidationError("branch_id is required");

    const { context, scope } = await getAuthorizedScope(new URLSearchParams({ branch_id: branchId }));
    
    const workspaceId = await createWorkspace({
      scope,
      actorId: String(context.userId),
      stockSnapshotId: input.snapshot_id ? Number(input.snapshot_id) : undefined
    });
    
    return { id: workspaceId };
  });
}
