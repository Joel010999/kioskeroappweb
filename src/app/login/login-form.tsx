"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

export function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setLoading(true); setError(null);
    const response = await fetch("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
    if (!response.ok) { setError("Email o contraseña incorrectos."); setLoading(false); return; }
    router.replace("/dashboard"); router.refresh();
  }
  return <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24, background: "#f2f5f7" }}><form onSubmit={submit} style={{ width: "min(100%, 360px)", display: "grid", gap: 16, padding: 28, background: "white", border: "1px solid #d8e0e7", borderRadius: 12 }}><div><p style={{ margin: 0, color: "#5e6c78", fontSize: 13 }}>Mónica</p><h1 style={{ margin: "4px 0 0" }}>Ingresar</h1></div><label>Email<input required type="email" value={email} onChange={(event) => setEmail(event.target.value)} style={{ width: "100%" }} /></label><label>Contraseña<input required type="password" value={password} onChange={(event) => setPassword(event.target.value)} style={{ width: "100%" }} /></label>{error && <p role="alert" style={{ margin: 0, color: "#b42318" }}>{error}</p>}<button disabled={loading} type="submit">{loading ? "Ingresando..." : "Ingresar"}</button></form></main>;
}
