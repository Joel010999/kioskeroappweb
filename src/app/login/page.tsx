import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/auth/context";
import { AuthorizationError } from "@/server/auth/errors";
import { LoginForm } from "./login-form";

export default async function LoginPage() {
  try { await getCurrentUser(); redirect("/dashboard"); } catch (error) { if (!(error instanceof AuthorizationError)) throw error; }
  return <LoginForm />;
}
