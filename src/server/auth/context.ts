import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { query } from "@/server/db/client";
import { UnauthenticatedError } from "./errors";

export const AUTH_SESSION_COOKIE = "monica_session";
export type AuthorizationMembership = { branchId: number; role: "PV_OPERATOR" | "WAREHOUSE_OPERATOR"; active: boolean };
export type AuthorizationContext = { userId: number; organizationId: number; userActive: boolean; memberships: AuthorizationMembership[] };
type SessionPayload = { userId: number; organizationId: number; expiresAt: number };

function encode(payload: SessionPayload) { return Buffer.from(JSON.stringify(payload)).toString("base64url"); }
function sign(encoded: string, secret: string) { return createHmac("sha256", secret).update(encoded).digest("base64url"); }

export function createDevelopmentSessionToken(userId: number, organizationId: number, secret: string, expiresAt = Date.now() + 8 * 60 * 60 * 1000) {
  const encoded = encode({ userId, organizationId, expiresAt });
  return `${encoded}.${sign(encoded, secret)}`;
}

function parseSession(token: string, secret: string): SessionPayload {
  const [encoded, signature, extra] = token.split(".");
  if (!encoded || !signature || extra) throw new UnauthenticatedError("Session is invalid.");
  const expected = sign(encoded, secret);
  const receivedBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);
  if (receivedBytes.length !== expectedBytes.length || !timingSafeEqual(receivedBytes, expectedBytes)) throw new UnauthenticatedError("Session is invalid.");
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as SessionPayload;
    if (!Number.isSafeInteger(payload.userId) || !Number.isSafeInteger(payload.organizationId) || !Number.isFinite(payload.expiresAt) || payload.expiresAt <= Date.now()) throw new Error();
    return payload;
  } catch { throw new UnauthenticatedError("Session is invalid or expired."); }
}

export async function getCurrentUser(): Promise<AuthorizationContext> {
  const secret = process.env.AUTH_SESSION_SECRET;
  if (!secret) throw new UnauthenticatedError("AUTH_SESSION_SECRET must be configured.");
  const token = (await cookies()).get(AUTH_SESSION_COOKIE)?.value;
  if (!token) throw new UnauthenticatedError();
  const session = parseSession(token, secret);
  const user = await query<{ id: string }>("SELECT id FROM users WHERE id=$1 AND active=true", [session.userId]);
  if (!user.rows[0]) throw new UnauthenticatedError("User is inactive or unavailable.");
  const memberships = await query<{ branch_id: number; role: "PV_OPERATOR" | "WAREHOUSE_OPERATOR"; active: boolean }>("SELECT m.branch_id, m.role, m.active FROM memberships m JOIN branches b ON b.id=m.branch_id AND b.organization_id=m.organization_id WHERE m.user_id=$1 AND m.organization_id=$2 AND m.active=true AND b.active=true", [session.userId, session.organizationId]);
  return { userId: session.userId, organizationId: session.organizationId, userActive: true, memberships: memberships.rows.map((membership) => ({ branchId: membership.branch_id, role: membership.role, active: membership.active })) };
}
