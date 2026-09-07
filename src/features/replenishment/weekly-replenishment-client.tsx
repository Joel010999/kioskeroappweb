"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  branchDisplayName,
  OperationsNavigation,
} from "@/features/navigation/operations-navigation";

type Status =
  | "SUGGESTION_AVAILABLE"
  | "NO_SUGGESTION"
  | "INSUFFICIENT_HISTORY"
  | "NEGATIVE_STOCK"
  | "IRREGULAR_DEMAND"
  | "NO_DEMAND";
type Item = {
  article_id: number;
  description: string | null;
  supplier_code: string | null;
  classification_code: string | null;
  unit_measure: string | null;
  stock_current: number;
  stock_depot: number | null;
  weekly_demand: number | null;
  target_stock: number | null;
  suggested_quantity: number | null;
  requested_quantity: number;
  active_weeks: number;
  status: Status;
  warnings: string[];
  fulfillment_type: string;
};
type Response = {
  planning_date: string;
  location: { branch_id: number; label: string };
  window_weeks: number;
  total: number;
  items: Item[];
  page: number;
  page_size: number;
};

const units = new Intl.NumberFormat("es-AR", {
  maximumFractionDigits: 2,
});
const statusLabels: Record<Status, string> = {
  SUGGESTION_AVAILABLE: "Sugerencia disponible",
  NO_SUGGESTION: "Sin sugerencia",
  INSUFFICIENT_HISTORY: "Historial insuficiente",
  NEGATIVE_STOCK: "Saldo negativo",
  IRREGULAR_DEMAND: "Demanda irregular",
  NO_DEMAND: "Sin demanda reciente",
};
const filterOptions = [
  ["", "Todos"],
  ["WITH_SUGGESTION", "Con sugerencia"],
  ["ZERO_STOCK", "Sin stock PV"],
  ["NEGATIVE_STOCK", "Stock negativo"],
  ["NO_DEPOT_STOCK", "Sin stock deposito"],
  ["INSUFFICIENT_HISTORY", "Historial insuficiente"],
  ["IRREGULAR_DEMAND", "Demanda irregular"],
] as const;

function saturday(): string {
  const now = new Date();
  const date = new Date(
    Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()),
  );
  date.setUTCDate(date.getUTCDate() + ((6 - date.getUTCDay() + 7) % 7));
  return date.toISOString().slice(0, 10);
}

export function WeeklyReplenishmentClient({
  authorizedBranchId,
}: {
  authorizedBranchId: number;
}) {
  const branchId = String(authorizedBranchId);
  const branchName = branchDisplayName(authorizedBranchId, "PV");
  const [planningDate, setPlanningDate] = useState(saturday);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Response | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [requested, setRequested] = useState<Record<number, number>>({});

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      const params = new URLSearchParams({
        branch_id: branchId,
        planning_date: planningDate,
        page: String(page),
        page_size: "25",
      });
      if (search) params.set("search", search);
      if (filter) params.set("filter", filter);

      try {
        setLoading(true);
        const response = await fetch(
          "/api/replenishment/weekly?" + params.toString(),
          { signal: controller.signal },
        );
        const result = await response.json();
        if (!response.ok) {
          throw new Error(result.error || "No pudimos calcular la reposicion.");
        }
        setData(result);
        setError(null);
      } catch (cause) {
        if ((cause as Error).name !== "AbortError") {
          setError((cause as Error).message);
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 200);

    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [branchId, planningDate, search, filter, page]);

  const resetPage = (setter: (value: string) => void, value: string) => {
    setter(value);
    setPage(1);
  };

  return (
    <main className="orders-shell replenishment-shell">
      <header className="orders-topbar">
        <Link className="brand" href="/dashboard">
          <span className="brand-mark">M</span>
          <span>
            MONICA<span className="brand-sub">Panel de operacion</span>
          </span>
        </Link>
        <OperationsNavigation role="PV" branchId={authorizedBranchId} />
      </header>
      <section className="orders-intro">
        <div>
          <Link className="back-link" href="/dashboard">
            Volver al panel central
          </Link>
          <h1>Reposicion semanal</h1>
          <p>
            Referencia de trabajo para tu punto de venta autorizado. La
            solicitud es editable y no crea pedidos.
          </p>
        </div>
        <div className="method-note">
          <strong>V1 semanal - mediana de 6 semanas</strong>
          <span>Semanas completas anteriores a la fecha de planificacion.</span>
        </div>
      </section>
      <section className="orders-controls replenishment-controls">
        <label className="filter-select">
          <span>Punto de venta</span>
          <select value={branchId} disabled>
            <option value={branchId}>{branchName}</option>
          </select>
        </label>
        <label className="filter-select">
          <span>Fecha de planificacion</span>
          <input
            type="date"
            value={planningDate}
            onChange={(event) => resetPage(setPlanningDate, event.target.value)}
          />
        </label>
        <label className="search">
          <span>Buscar</span>
          <input
            value={search}
            onChange={(event) => resetPage(setSearch, event.target.value)}
            placeholder="Producto o articulo"
          />
        </label>
        <label className="filter-select">
          <span>Filtro</span>
          <select
            value={filter}
            onChange={(event) => resetPage(setFilter, event.target.value)}
          >
            {filterOptions.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </section>
      {loading ? (
        <div className="orders-loading">
          <div className="skeleton" />
          <div className="skeleton" />
        </div>
      ) : error ? (
        <section className="orders-error">
          <strong>No pudimos completar el calculo.</strong>
          <span>{error}</span>
        </section>
      ) : (
        <>
          <section className="replenishment-note">
            <strong>
              {data?.location.label} - {data?.window_weeks} semanas completas
            </strong>
            <span>
              Stock deposito es un dato informativo: no representa disponibilidad
              garantizada.
            </span>
          </section>
          <section className="orders-table-panel">
            <div className="orders-table-wrap">
              <table className="orders-table replenishment-table">
                <thead>
                  <tr>
                    <th>Producto</th>
                    <th>Stock PV</th>
                    <th>Demanda semanal</th>
                    <th>Objetivo</th>
                    <th>Sugerida</th>
                    <th>Solicitada</th>
                    <th>Stock deposito</th>
                    <th>Estado</th>
                  </tr>
                </thead>
                <tbody>
                  {data?.items.map((item) => {
                    const value =
                      requested[item.article_id] ?? item.requested_quantity;
                    const warning =
                      item.warnings
                        .filter((entry) => !entry.startsWith("DEPOT_"))
                        .join(" - ") || item.warnings.at(-1);
                    return (
                      <tr key={item.article_id}>
                        <td data-label="Producto">
                          <strong>
                            {item.description || "Articulo " + item.article_id}
                          </strong>
                          <small>
                            #{item.article_id} - Prov.{" "}
                            {item.supplier_code || "-"} - Clasif.{" "}
                            {item.classification_code || "-"} -{" "}
                            {item.unit_measure || "sin unidad"}
                          </small>
                        </td>
                        <td
                          data-label="Stock PV"
                          className={
                            item.stock_current < 0 ? "negative-number" : ""
                          }
                        >
                          {units.format(item.stock_current)}
                        </td>
                        <td data-label="Demanda semanal">
                          {item.weekly_demand === null
                            ? "-"
                            : units.format(item.weekly_demand)}
                          <small>{item.active_weeks}/6 semanas activas</small>
                        </td>
                        <td data-label="Objetivo">
                          {item.target_stock === null
                            ? "Revisar"
                            : units.format(item.target_stock)}
                        </td>
                        <td data-label="Sugerida" className="suggested-value">
                          {item.suggested_quantity === null
                            ? "Revisar"
                            : units.format(item.suggested_quantity)}
                        </td>
                        <td data-label="Solicitada">
                          <input
                            className="quantity-input"
                            aria-label={
                              "Cantidad solicitada para " +
                              (item.description || item.article_id)
                            }
                            type="number"
                            min="0"
                            step="any"
                            value={value}
                            onChange={(event) => {
                              const next = Number(event.target.value);
                              if (Number.isFinite(next) && next >= 0) {
                                setRequested((current) => ({
                                  ...current,
                                  [item.article_id]: next,
                                }));
                              }
                            }}
                          />
                        </td>
                        <td
                          data-label="Stock deposito"
                          className={
                            item.stock_depot !== null && item.stock_depot < 0
                              ? "negative-number"
                              : ""
                          }
                        >
                          {item.stock_depot === null
                            ? "Sin fila"
                            : units.format(item.stock_depot)}
                          <small>
                            {item.fulfillment_type ===
                            "SUPPLIER_PURCHASE_CANDIDATE"
                              ? "Candidato proveedor"
                              : item.fulfillment_type ===
                                  "DEPOT_REVIEW_REQUIRED"
                                ? "Revision deposito"
                                : "Reposicion interna candidata"}
                          </small>
                        </td>
                        <td data-label="Estado">
                          <span
                            className={
                              "suggestion-status " + item.status.toLowerCase()
                            }
                          >
                            {statusLabels[item.status]}
                          </span>
                          <small>{warning}</small>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {data && (
              <div className="orders-pagination">
                <span>
                  {units.format(data.total)} productos con actividad historica
                </span>
                <div className="pagination-controls">
                  <button disabled={page === 1} onClick={() => setPage(page - 1)}>
                    Anterior
                  </button>
                  <span>Pagina {page}</span>
                  <button
                    disabled={page * data.page_size >= data.total}
                    onClick={() => setPage(page + 1)}
                  >
                    Siguiente
                  </button>
                </div>
              </div>
            )}
          </section>
        </>
      )}
    </main>
  );
}
