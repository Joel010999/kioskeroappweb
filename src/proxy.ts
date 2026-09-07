import { NextResponse, type NextRequest } from "next/server";

const AUTH_SESSION_COOKIE = "monica_session";
const protectedPrefixes = ["/dashboard", "/replenishment", "/orders"];

export function proxy(request: NextRequest) {
  const isProtected = protectedPrefixes.some((prefix) => request.nextUrl.pathname === prefix || request.nextUrl.pathname.startsWith(`${prefix}/`));
  if (isProtected && !request.cookies.get(AUTH_SESSION_COOKIE)) return NextResponse.redirect(new URL("/login", request.url));
  return NextResponse.next();
}

export const config = { matcher: ["/dashboard/:path*", "/replenishment/:path*", "/orders/:path*"] };
