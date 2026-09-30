"use client";

import { useRouter } from "next/navigation";

export function LogoutButton() {
  const router = useRouter();

  const logout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
    router.refresh();
  };

  return (
    <button 
      onClick={logout} 
      aria-label="Cerrar sesión"
      className="refresh"
      style={{ marginLeft: "8px", justifySelf: "flex-end" }}
    >
      <span>Cerrar sesión</span>
    </button>
  );
}
