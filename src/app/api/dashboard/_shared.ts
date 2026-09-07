import { NextResponse } from "next/server";
import { AuthorizationError } from "@/server/auth/errors";
import { RequestValidationError } from "@/server/validation/request";

export async function apiResponse<T>(handler: () => Promise<T>) {
  try {
    const result = await handler();
    return result instanceof Response ? result : NextResponse.json(result);
  } catch (error) {
    if (error instanceof AuthorizationError) return NextResponse.json({ error: error.code }, { status: error.code === "UNAUTHENTICATED" ? 401 : error.code === "FORBIDDEN" ? 403 : 404 });
    if (error instanceof RequestValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error("Dashboard API request failed", { message: error instanceof Error ? error.message : "Unknown error" });
    return NextResponse.json({ error: "Unable to complete the dashboard request." }, { status: 500 });
  }
}
