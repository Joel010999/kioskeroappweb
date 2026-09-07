"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export type NavigationRole = "PV" | "WAREHOUSE";

type NavigationItem = { href: string; label: string };

const navigationByRole: Record<NavigationRole, NavigationItem[]> = {
  PV: [
    { href: "/dashboard", label: "Resumen" },
    { href: "/replenishment", label: "Reposición semanal" },
    { href: "/replenishment/review", label: "Revisar" },
    { href: "/orders/suggestions", label: "Sugerencias V1" },
    { href: "/supply-rules", label: "Abastecimiento" },
    { href: "/orders", label: "Pedidos" },
  ],
  WAREHOUSE: [
    { href: "/dashboard", label: "Resumen" },
    { href: "/orders/warehouse", label: "Operación de depósito" },
  ],
};

export function navigationForRole(role: NavigationRole): NavigationItem[] {
  return navigationByRole[role];
}

export function isNavigationActive(pathname: string, href: string): boolean {
  if (href === "/dashboard") return pathname === href;
  if (href === "/replenishment") return pathname === href;
  if (href === "/orders/suggestions") return pathname === href;
  if (href === "/supply-rules") return pathname === href;
  if (href === "/orders")
    return pathname === "/orders" || /^\/orders\/\d+$/.test(pathname);
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function branchDisplayName(branchId: number, role: NavigationRole): string {
  if (role === "WAREHOUSE" || branchId === 1) return "DEPÓSITO";
  if (branchId === 2) return "PV1";
  if (branchId === 3) return "PV2";
  return "Punto autorizado";
}

export function OperationsNavigation({
  role,
  branchId,
}: {
  role: NavigationRole;
  branchId: number;
}) {
  const pathname = usePathname();
  return (
    <>
      <nav aria-label="Navegación principal">
        {navigationForRole(role).map((item) => {
          const active = isNavigationActive(pathname, item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={active ? "active" : undefined}
              aria-current={active ? "page" : undefined}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
      <div className="branch">
        <span className="status-dot" />
        {branchDisplayName(branchId, role)}
      </div>
    </>
  );
}
