import { NextResponse } from "next/server";
import { AuthorizationError } from "@/server/auth/errors";
import { RequestValidationError } from "@/server/validation/request";

export async function apiResponse<T>(handler: () => Promise<T>) {
  try {
    const result = await handler();
    return result instanceof Response ? result : NextResponse.json(result);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      const message =
        error.code === "UNAUTHENTICATED"
          ? "Tu sesión ha expirado o no es válida. Por favor, volvé a iniciar sesión para continuar."
          : error.code === "FORBIDDEN"
            ? "No tenés permisos para realizar esta acción."
            : "Recurso no encontrado.";
      return NextResponse.json(
        { error: error.code, message },
        { status: error.code === "UNAUTHENTICATED" ? 401 : error.code === "FORBIDDEN" ? 403 : 404 }
      );
    }
    if (error instanceof RequestValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error("Dashboard API request failed", { message: error instanceof Error ? error.message : "Unknown error" });
    return NextResponse.json({ error: "Unable to complete the dashboard request." }, { status: 500 });
  }
}
