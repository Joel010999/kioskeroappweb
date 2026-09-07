import { NextResponse } from "next/server";
import { AUTH_SESSION_COOKIE, createDevelopmentSessionToken } from "@/server/auth/context";
import { verifyPassword } from "@/server/auth/passwords";
import { query } from "@/server/db/client";
import { RequestValidationError } from "@/server/validation/request";
import { apiResponse } from "../../dashboard/_shared";

export const runtime = "nodejs";
const invalidCredentials = () => NextResponse.json({ error: "INVALID_CREDENTIALS" }, { status: 401 });

export async function POST(request: Request) {
  return apiResponse(async () => {
    const body: unknown = await request.json();
    const input = body && typeof body === "object" && !Array.isArray(body) ? body as { email?: unknown; password?: unknown } : null;
    if (!input || typeof input.email !== "string" || typeof input.password !== "string") throw new RequestValidationError("email and password are required.");
    const email = input.email.trim().toLowerCase();
    if (!email || !input.password) return invalidCredentials();
    const user = await query<{ id: string; organization_id: number | null; password_hash: string | null }>("SELECT id, organization_id, password_hash FROM users WHERE email=$1 AND active=true LIMIT 1", [email]);
    const record = user.rows[0];
    if (!record || !record.organization_id || !(await verifyPassword(input.password, record.password_hash))) return invalidCredentials();
    const secret = process.env.AUTH_SESSION_SECRET;
    if (!secret) throw new Error("AUTH_SESSION_SECRET must be configured.");
    const response = NextResponse.json({ ok: true });
    response.cookies.set(AUTH_SESSION_COOKIE, createDevelopmentSessionToken(Number(record.id), record.organization_id, secret), { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 8 * 60 * 60 });
    return response;
  });
}
