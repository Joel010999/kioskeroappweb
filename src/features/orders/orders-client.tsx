"use client";
/* eslint-disable @next/next/no-html-link-for-pages, react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */

import { useEffect, useState } from "react";
import { activityActorLabel } from "./activity";
import {
  branchDisplayName,
  OperationsNavigation,
} from "@/features/navigation/operations-navigation";

type Status =
  | "DRAFT"
  | "CONFIRMED"
  | "IN_PREPARATION"
  | "DISPATCHED"
  | "COMPLETED"
  | "CANCELLED";
type Item = {
  id: number;
  article_id: number;
  product_name_snapshot: string;
  requested_quantity: number;
  approved_quantity: number | null;
  prepared_quantity: number | null;
  dispatched_quantity: number | null;
  received_quantity: number | null;
  unit_measure_snapshot?: string | null;
};
type Event = {
  id: number;
  event_type: string;
  created_at: string;
  user_id: string | null;
  actor_name?: string | null;
  actor_email?: string | null;
};
type Order = {
  id: number;
  status: Status;
  created_at: string;
  item_count: number;
  requested_units: number;
  approved_units: number;
  prepared_units: number;
  dispatched_units: number;
  received_units: number;
  origin_branch_id?: number | null;
  planning_date?: string | null;
  items?: Item[];
  events?: Event[];
};
type Summary = {
  pending: number;
  inPreparation: number;
  readyToDispatch: number;
  dispatched: number;
  completed: number;
};

const fmt = new Intl.NumberFormat("es-AR", { maximumFractionDigits: 2 });
const labels: Record<Status, string> = {
  DRAFT: "Borrador",
  CONFIRMED: "Confirmado",
  IN_PREPARATION: "En preparacion",
  DISPATCHED: "Despachado",
  COMPLETED: "Completado",
  CANCELLED: "Cancelado",
};
const events: Record<string, string> = {
  ORDER_CREATED: "Pedido creado",
  ORDER_CONFIRMED: "Solicitud confirmada",
  ORDER_CANCELLED: "Pedido cancelado",
  ORDER_IN_PREPARATION: "Preparacion iniciada",
  ORDER_DISPATCHED: "Despacho registrado",
  ORDER_COMPLETED: "Recepcion completada",
  ITEM_APPROVED_QUANTITY_CHANGED: "Cantidad aprobada actualizada",
  ITEM_PREPARED_QUANTITY_CHANGED: "Cantidad preparada actualizada",
  ITEM_DISPATCHED_QUANTITY_CHANGED: "Cantidad despachada registrada",
  ITEM_RECEIVED_QUANTITY_CHANGED: "Cantidad recibida registrada",
};
const filters: Array<{
  value: string;
  label: string;
  status?: Status;
  ready?: boolean;
}> = [
  { value: "", label: "Todos" },
  { value: "pending", label: "Pendientes de preparacion", status: "CONFIRMED" },
  { value: "preparing", label: "En preparacion", status: "IN_PREPARATION" },
  { value: "ready", label: "Listos para despacho", ready: true },
  { value: "dispatched", label: "Despachados", status: "DISPATCHED" },
  { value: "completed", label: "Completados", status: "COMPLETED" },
  { value: "cancelled", label: "Cancelados", status: "CANCELLED" },
];

async function api(path: string, init?: RequestInit) {
  const response = await fetch(path, init);
  const result = await response.json();
  if (!response.ok)
    throw new Error(result.error || "No pudimos completar la accion.");
  return result;
}
function Header({
  active,
  branchId,
}: {
  active: "orders" | "warehouse";
  branchId?: number;
}) {
  return (
    <header className="orders-topbar">
      <a className="brand" href="/dashboard">
        <span className="brand-mark">M</span>
        <span>
          MONICA<span className="brand-sub">Panel de operacion</span>
        </span>
      </a>
      <OperationsNavigation
        role={active === "warehouse" ? "WAREHOUSE" : "PV"}
        branchId={active === "warehouse" ? 1 : branchId ?? 0}
      />
    </header>
  );
}
function next(order: Order) {
  if (order.status === "CONFIRMED") return "Comenzar preparacion";
  if (order.status === "IN_PREPARATION")
    return order.prepared_units >= order.approved_units
      ? "Listo para despacho"
      : "Continuar preparacion";
  if (order.status === "DISPATCHED") return "Esperando recepcion del PV";
  return labels[order.status];
}

export function OrdersClient({
  warehouse = false,
  branchId,
}: {
  warehouse?: boolean;
  branchId: number;
}) {
  const [rows, setRows] = useState<Order[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [filter, setFilter] = useState("");
  const [origin, setOrigin] = useState(warehouse ? "" : String(branchId));
  const [planning, setPlanning] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const selected = filters.find((item) => item.value === filter);
  const load = async () => {
    try {
      const params = new URLSearchParams({ limit: "20", page: String(page) });
      if (warehouse) {
        params.set("warehouse", "1");
        if (selected?.status) params.set("status", selected.status);
        if (selected?.ready) params.set("ready", "1");
      } else {
        params.set("pv", "1");
        if (filter) params.set("status", filter);
      }
      if (origin) params.set("origin_branch_id", origin);
      if (planning) params.set("planning_date", planning);
      if (search) params.set("search", search);
      const result = await api(`/api/orders?${params}`);
      setRows(result.rows);
      setTotal(result.total);
      setSummary(result.summary ?? null);
      setError(null);
    } catch (cause) {
      setError((cause as Error).message);
    }
  };
  useEffect(() => {
    void load();
  }, [filter, origin, planning, search, page]);
  const reset = (setter: (value: string) => void, value: string) => {
    setter(value);
    setPage(1);
  };
  const pages = Math.max(1, Math.ceil(total / 20));
  return (
    <main className={`orders-shell ${warehouse ? "warehouse-shell" : ""}`}>
      <Header
        active={warehouse ? "warehouse" : "orders"}
        branchId={branchId}
      />
      <section className="orders-intro">
        <div>
          <p className="page-context">
            {warehouse ? "Centro operativo" : "Seguimiento"}
          </p>
          <h1>{warehouse ? "Bandeja de deposito" : "Mis solicitudes"}</h1>
          <p>
            {warehouse
              ? "Solicitudes para preparar, despachar y seguir hasta su recepcion."
              : "Seguimiento de lo pedido, aprobado, despachado y recibido."}
          </p>
        </div>
        {!warehouse && (
          <a className="order-primary" href="/orders/suggestions">
            Nueva solicitud
          </a>
        )}
      </section>
      {warehouse && (
        <section className="warehouse-summary">
          <button
            className={filter === "pending" ? "is-active" : ""}
            onClick={() => reset(setFilter, "pending")}
          >
            <span>Pendientes</span>
            <strong>{fmt.format(summary?.pending ?? 0)}</strong>
            <small>Por iniciar</small>
          </button>
          <button
            className={filter === "preparing" ? "is-active" : ""}
            onClick={() => reset(setFilter, "preparing")}
          >
            <span>En preparacion</span>
            <strong>{fmt.format(summary?.inPreparation ?? 0)}</strong>
            <small>En trabajo</small>
          </button>
          <button
            className={filter === "ready" ? "is-active" : ""}
            onClick={() => reset(setFilter, "ready")}
          >
            <span>Listos</span>
            <strong>{fmt.format(summary?.readyToDispatch ?? 0)}</strong>
            <small>Para despacho</small>
          </button>
          <button
            className={filter === "dispatched" ? "is-active" : ""}
            onClick={() => reset(setFilter, "dispatched")}
          >
            <span>Despachados</span>
            <strong>{fmt.format(summary?.dispatched ?? 0)}</strong>
            <small>Esperan PV</small>
          </button>
          <button
            className={filter === "completed" ? "is-active" : ""}
            onClick={() => reset(setFilter, "completed")}
          >
            <span>Completados</span>
            <strong>{fmt.format(summary?.completed ?? 0)}</strong>
            <small>Circuito cerrado</small>
          </button>
        </section>
      )}
      <section className="orders-controls">
        <label className="search">
          <span>Buscar</span>
          <input
            value={search}
            onChange={(event) => reset(setSearch, event.target.value)}
            placeholder="Solicitud, articulo o descripcion"
          />
        </label>
        <label className="filter-select">
          <span>Estado</span>
          <select
            value={filter}
            onChange={(event) => reset(setFilter, event.target.value)}
          >
            {warehouse ? (
              filters.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))
            ) : (
              <>
                <option value="">Todos</option>
                {Object.entries(labels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </>
            )}
          </select>
        </label>
        <label className="filter-select">
          <span>PV origen</span>
          {warehouse ? (
            <select
              value={origin}
              onChange={(event) => reset(setOrigin, event.target.value)}
            >
              <option value="">PV1 y PV2</option>
              <option value="2">PV1</option>
              <option value="3">PV2</option>
            </select>
          ) : (
            <select value={origin} disabled>
              <option value={String(branchId)}>
                {branchDisplayName(branchId, "PV")}
              </option>
            </select>
          )}
        </label>
        <label className="filter-select">
          <span>Planificacion</span>
          <input
            type="date"
            value={planning}
            onChange={(event) => reset(setPlanning, event.target.value)}
          />
        </label>
        <button className="order-secondary" onClick={() => void load()}>
          Actualizar
        </button>
      </section>
      {error ? (
        <section className="orders-error">{error}</section>
      ) : (
        <section className="orders-table-panel warehouse-table-panel">
          <div className="warehouse-table-head">
            <div>
              <h2>{warehouse ? "Solicitudes de reposicion" : "Solicitudes"}</h2>
              <span>
                {fmt.format(total)} resultado{total === 1 ? "" : "s"}
              </span>
            </div>
            <small>
              {warehouse
                ? "Las solicitudes con accion pendiente aparecen primero."
                : ""}
            </small>
          </div>
          <div className="orders-table-wrap">
            <table className="orders-table warehouse-table">
              <thead>
                <tr>
                  <th>Solicitud</th>
                  <th>PV</th>
                  <th>Planificacion</th>
                  <th>Creada</th>
                  <th>Estado</th>
                  <th>Progreso</th>
                  <th>Accion siguiente</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((order) => (
                  <tr key={order.id}>
                    <td data-label="Solicitud">
                      <strong>#{order.id}</strong>
                      <small>
                        {order.item_count} linea
                        {order.item_count === 1 ? "" : "s"} · Reposicion interna
                      </small>
                    </td>
                    <td data-label="PV">PV {order.origin_branch_id ?? "-"}</td>
                    <td data-label="Planificacion">
                      {order.planning_date
                        ? new Date(order.planning_date).toLocaleDateString(
                            "es-AR",
                            { timeZone: "UTC" },
                          )
                        : "-"}
                    </td>
                    <td data-label="Creada">
                      {new Date(order.created_at).toLocaleDateString("es-AR")}
                    </td>
                    <td data-label="Estado">
                      <span
                        className={`order-status ${order.status.toLowerCase()}`}
                      >
                        {labels[order.status]}
                      </span>
                    </td>
                    <td data-label="Progreso">
                      <div className="order-progress">
                        <strong>
                          {fmt.format(order.requested_units)} solicitado
                        </strong>
                        <small>
                          Aprob. {fmt.format(order.approved_units)} · Prep.{" "}
                          {fmt.format(order.prepared_units)} · Desp.{" "}
                          {fmt.format(order.dispatched_units)}
                          {order.status === "COMPLETED"
                            ? ` · Rec. ${fmt.format(order.received_units)}`
                            : ""}
                        </small>
                      </div>
                    </td>
                    <td data-label="Accion">
                      <span
                        className={`next-action ${order.status.toLowerCase()}`}
                      >
                        {next(order)}
                      </span>
                    </td>
                    <td data-label="Abrir">
                      <a
                        className="order-link"
                        href={
                          warehouse
                            ? `/orders/warehouse/${order.id}`
                            : `/orders/${order.id}`
                        }
                      >
                        Abrir
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!rows.length && (
            <p className="orders-empty">No hay solicitudes para este filtro.</p>
          )}
          {pages > 1 && (
            <div className="orders-pagination">
              <span>
                Pagina {page} de {pages}
              </span>
              <div className="pagination-controls">
                <button disabled={page === 1} onClick={() => setPage(page - 1)}>
                  Anterior
                </button>
                <button
                  disabled={page >= pages}
                  onClick={() => setPage(page + 1)}
                >
                  Siguiente
                </button>
              </div>
            </div>
          )}
        </section>
      )}
    </main>
  );
}

export function OrderDetailClient({
  orderId,
  surface,
  branchId,
}: {
  orderId: number;
  surface: "pv" | "warehouse";
  branchId: number;
}) {
  const [order, setOrder] = useState<Order | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [values, setValues] = useState<Record<number, number>>({});
  const load = async () => {
    try {
      const result = await api(`/api/orders/${orderId}`);
      setOrder(result);
      setValues({});
      setError(null);
    } catch (cause) {
      setError((cause as Error).message);
    }
  };
  useEffect(() => {
    void load();
  }, [orderId]);
  const mutate = async (path: string, init?: RequestInit) => {
    setBusy(true);
    try {
      await api(path, init);
      await load();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (!order)
    return (
      <main className="orders-shell">
        <Header
          active={surface === "warehouse" ? "warehouse" : "orders"}
          branchId={branchId}
        />
        <div className="orders-loading">
          <div className="skeleton" />
        </div>
      </main>
    );
  const operational =
    surface === "warehouse" && order.status === "IN_PREPARATION";
  const difference =
    order.status === "COMPLETED" &&
    order.items?.some(
      (item) =>
        item.dispatched_quantity !== null &&
        item.received_quantity !== null &&
        item.received_quantity < item.dispatched_quantity,
    );
  const update = (
    item: Item,
    field: "approved_quantity" | "prepared_quantity",
    value: number,
  ) =>
    void mutate(`/api/orders/${order.id}/items/${item.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ [field]: value }),
    });
  const fulfill = (
    action: "dispatch" | "complete",
    field: "dispatched_quantity" | "received_quantity",
  ) =>
    void mutate(`/api/orders/${order.id}/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        items:
          order.items?.map((item) => ({
            item_id: item.id,
            quantity: values[item.id] ?? item[field] ?? 0,
          })) ?? [],
      }),
    });
  const input = (
    item: Item,
    field: "dispatched_quantity" | "received_quantity",
    maximum: number,
  ) => (
    <input
      className="quantity-input"
      type="number"
      min="0"
      max={maximum}
      step="any"
      value={values[item.id] ?? item[field] ?? ""}
      onChange={(event) =>
        setValues((current) => ({
          ...current,
          [item.id]: Number(event.target.value),
        }))
      }
    />
  );
  const action =
    surface === "warehouse" ? (
      order.status === "CONFIRMED" ? (
        <>
          <button
            className="order-primary"
            disabled={busy}
            onClick={() =>
              void mutate(`/api/orders/${order.id}/prepare`, { method: "POST" })
            }
          >
            Comenzar preparacion
          </button>
          <button
            className="order-secondary"
            disabled={busy}
            onClick={() =>
              void mutate(`/api/orders/${order.id}/cancel`, { method: "POST" })
            }
          >
            Cancelar
          </button>
        </>
      ) : order.status === "IN_PREPARATION" ? (
        <button
          className="order-primary"
          disabled={busy}
          onClick={() => {
            if (
              window.confirm(
                "El despacho registra las cantidades efectivamente enviadas al PV.",
              )
            )
              fulfill("dispatch", "dispatched_quantity");
          }}
        >
          Registrar despacho
        </button>
      ) : null
    ) : order.status === "DISPATCHED" ? (
      <button
        className="order-primary"
        disabled={busy}
        onClick={() => {
          if (
            window.confirm("Registrar la recepcion y completar esta solicitud?")
          )
            fulfill("complete", "received_quantity");
        }}
      >
        Registrar recepcion
      </button>
    ) : null;
  return (
    <main className="orders-shell warehouse-detail-shell">
      <Header
        active={surface === "warehouse" ? "warehouse" : "orders"}
        branchId={branchId}
      />
      <section className="orders-intro">
        <div>
          <a
            className="back-link"
            href={surface === "warehouse" ? "/orders/warehouse" : "/orders"}
          >
            Volver
          </a>
          <p className="page-context">Solicitud interna #{order.id}</p>
          <h1>PV {order.origin_branch_id} a deposito</h1>
          <p>
            Planificacion {order.planning_date?.slice(0, 10)} · Creada{" "}
            {new Date(order.created_at).toLocaleDateString("es-AR")}
          </p>
        </div>
        <span className={`order-status ${order.status.toLowerCase()}`}>
          {difference ? "Completado con diferencia" : labels[order.status]}
        </span>
      </section>
      {error && <section className="orders-error">{error}</section>}
      <section className="order-steps">
        {["Solicitada", "Aprobada", "Preparada", "Despachada", "Recibida"].map(
          (label, index) => (
            <div
              key={label}
              className={
                index === 0 ||
                (index < 3 && order.status !== "CONFIRMED") ||
                (index === 3 &&
                  ["DISPATCHED", "COMPLETED"].includes(order.status)) ||
                (index === 4 && order.status === "COMPLETED")
                  ? "is-active"
                  : ""
              }
            >
              <span>
                {index === 0 || order.status === "COMPLETED" ? "✓" : ""}
              </span>
              <strong>{label}</strong>
            </div>
          ),
        )}
      </section>
      <section className="order-detail-grid">
        <div className="orders-table-panel">
          <div className="order-detail-head">
            <div>
              <h2>Preparacion por producto</h2>
              <span>
                Solicitado, aprobado, preparado y despachado son cantidades
                operativas.
              </span>
            </div>
            <small>
              El stock registrado en deposito es informativo y no limita
              automaticamente.
            </small>
          </div>
          <div className="orders-table-wrap">
            <table className="orders-table preparation-table">
              <thead>
                <tr>
                  <th>Producto</th>
                  <th>Articulo</th>
                  <th>Solicitado</th>
                  <th>Aprobado</th>
                  <th>Preparado</th>
                  <th>Despachado</th>
                  <th>Recibido</th>
                </tr>
              </thead>
              <tbody>
                {order.items?.map((item) => (
                  <tr key={item.id}>
                    <td data-label="Producto">
                      <strong>{item.product_name_snapshot}</strong>
                      <small>
                        {item.unit_measure_snapshot ?? "Sin unidad registrada"}
                      </small>
                    </td>
                    <td data-label="Articulo">#{item.article_id}</td>
                    <td data-label="Solicitado" className="suggested-value">
                      {fmt.format(item.requested_quantity)}
                    </td>
                    <td data-label="Aprobado">
                      {operational ? (
                        <input
                          className="quantity-input"
                          type="number"
                          min="0"
                          max={item.requested_quantity}
                          step="any"
                          defaultValue={item.approved_quantity ?? ""}
                          onBlur={(event) => {
                            const value = Number(event.target.value);
                            if (Number.isFinite(value))
                              update(item, "approved_quantity", value);
                          }}
                        />
                      ) : item.approved_quantity === null ? (
                        "-"
                      ) : (
                        fmt.format(item.approved_quantity)
                      )}
                    </td>
                    <td data-label="Preparado">
                      {operational ? (
                        <>
                          <input
                            className="quantity-input"
                            type="number"
                            min="0"
                            max={item.approved_quantity ?? 0}
                            step="any"
                            defaultValue={item.prepared_quantity ?? ""}
                            onBlur={(event) => {
                              const value = Number(event.target.value);
                              if (Number.isFinite(value))
                                update(item, "prepared_quantity", value);
                            }}
                          />
                          <small>
                            Pendiente{" "}
                            {fmt.format(
                              Math.max(
                                0,
                                (item.approved_quantity ?? 0) -
                                  (item.prepared_quantity ?? 0),
                              ),
                            )}
                          </small>
                        </>
                      ) : item.prepared_quantity === null ? (
                        "-"
                      ) : (
                        fmt.format(item.prepared_quantity)
                      )}
                    </td>
                    <td data-label="Despachado">
                      {operational
                        ? input(
                            item,
                            "dispatched_quantity",
                            item.prepared_quantity ?? 0,
                          )
                        : item.dispatched_quantity === null
                          ? "-"
                          : fmt.format(item.dispatched_quantity)}
                    </td>
                    <td data-label="Recibido">
                      {surface === "pv" && order.status === "DISPATCHED"
                        ? input(
                            item,
                            "received_quantity",
                            item.dispatched_quantity ?? 0,
                          )
                        : item.received_quantity === null
                          ? "-"
                          : fmt.format(item.received_quantity)}
                      {item.dispatched_quantity !== null &&
                      item.received_quantity !== null &&
                      item.dispatched_quantity !== item.received_quantity ? (
                        <small className="negative-number">
                          Diferencia{" "}
                          {fmt.format(
                            item.dispatched_quantity - item.received_quantity,
                          )}
                        </small>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <aside className="order-side">
          <h2>{surface === "pv" ? "Recepcion" : "Accion operativa"}</h2>
          <p>
            {surface === "pv"
              ? "La recepcion se habilita cuando deposito despacha."
              : operational
                ? "Registra aprobado y preparado. Luego carga explicitamente lo que se despacha."
                : order.status === "DISPATCHED"
                  ? "El despacho fue registrado. La recepcion corresponde exclusivamente al PV."
                  : next(order)}
          </p>
          <div className="order-actions">{action}</div>
          <div className="warehouse-stock-note">
            <strong>Stock registrado en deposito</strong>
            <span>
              No esta disponible en el snapshot de esta solicitud. No se
              realizan reservas ni descuentos automaticos.
            </span>
          </div>
          <h2>Actividad</h2>
          <ol className="order-events">
            {order.events?.map((event) => (
              <li key={event.id}>
                <strong>{events[event.event_type] || event.event_type}</strong>
                <span>
                  {activityActorLabel(event)} · {new Date(event.created_at).toLocaleString("es-AR")}
                </span>
              </li>
            ))}
          </ol>
        </aside>
      </section>
    </main>
  );
}
