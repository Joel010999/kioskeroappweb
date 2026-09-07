import { NextResponse } from "next/server";
import { createDevelopmentSessionToken, AUTH_SESSION_COOKIE } from "@/server/auth/context";
import { query } from "@/server/db/client";
import { NotFoundError } from "@/server/auth/errors";
import { RequestValidationError } from "@/server/validation/request";
import { apiResponse } from "../../dashboard/_shared";

export const runtime = "nodejs";

const developmentUsers = {
  PV1: "pv1@development.local",
  PV2: "pv2@development.local",
  WAREHOUSE: "deposito@development.local",
} as const;

export async function POST(request: Request) {
  return apiResponse(async () => {
    if (process.env.NODE_ENV === "production" || process.env.ALLOW_DEVELOPMENT_SESSION !== "true") throw new NotFoundError();
    const body: unknown = await request.json();
    const key = body && typeof body === "object" && !Array.isArray(body) ? (body as { user?: unknown }).user : undefined;
    if (key !== "PV1" && key !== "PV2" && key !== "WAREHOUSE") throw new RequestValidationError("user must be PV1, PV2, or WAREHOUSE.");
    const secret = process.env.AUTH_SESSION_SECRET;
    if (!secret) throw new RequestValidationError("AUTH_SESSION_SECRET must be configured.");
    const result = await query<{ id: string; organization_id: number }>("SELECT m.user_id AS id, m.organization_id FROM users u JOIN memberships m ON m.user_id=u.id WHERE u.email=$1 AND u.active=true AND m.active=true LIMIT 2", [developmentUsers[key]]);
    if (result.rows.length !== 1) throw new NotFoundError("Development user is not configured.");
    const token = createDevelopmentSessionToken(Number(result.rows[0].id), result.rows[0].organization_id, secret);
    const response = NextResponse.json({ user: key });
    response.cookies.set(AUTH_SESSION_COOKIE, token, { httpOnly: true, sameSite: "lax", secure: false, path: "/", maxAge: 8 * 60 * 60 });
    return response;
  });
}
