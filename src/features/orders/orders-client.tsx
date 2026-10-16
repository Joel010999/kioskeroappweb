"use client";
/* eslint-disable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */

import { useEffect, useState } from "react";
import { activityActorLabel } from "./activity";
import {
  branchDisplayName,
  OperationsNavigation,
} from "@/features/navigation/operations-navigation";
import { downloadOrderExcel } from "@/features/excel/order-export";

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
  classification_code_snapshot?: string | null;
  requested_quantity: number;
  approved_quantity: number | null;
  prepared_quantity: number | null;
  dispatched_quantity: number | null;
  received_quantity: number | null;
  unit_measure_snapshot?: string | null;
  rubro?: string | null;
  package_units?: number | null;
  presentation?: string | null;
  presentation_display?: string | null;
  stock_depot?: number | null;
  supplier_code?: string | null;
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
  order_number?: number;
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
        <span className="brand-mark">LCQ</span>
        <span>LA CASA DEL KIOSKERO<span className="brand-sub">Panel de operación</span>
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
      if (warehouse && origin) params.set("origin_branch_id", origin);
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
  const exportOrderFromList = async (order: Order) => {
    try {
      const fullOrder = await api(`/api/orders/${order.id}`);
      downloadOrderExcel({
        orderId: fullOrder.order_number ?? fullOrder.id,
        status: labels[fullOrder.status as Status] || fullOrder.status,
        branchLabel: branchDisplayName(fullOrder.origin_branch_id ?? 0, "PV"),
        planningDate: fullOrder.planning_date?.slice(0, 10),
        items: fullOrder.items ?? [],
      });
    } catch (err: unknown) {
      alert(
        "Error al exportar orden: " +
          (err instanceof Error ? err.message : "Error desconocido"),
      );
    }
  };
  const reset = (setter: (value: string) => void, value: string) => {
    setter(value);
    setPage(1);
  };
  const pages = Math.max(1, Math.ceil(total / 20));
  const currentBranchName = branchDisplayName(branchId, "PV");

  return (
    <main className={`orders-shell ${warehouse ? "warehouse-shell" : ""}`}>
      <Header
        active={warehouse ? "warehouse" : "orders"}
        branchId={branchId}
      />
      <section className="orders-intro">
        <div>
          <p className="page-context">
            {warehouse ? "Centro operativo" : `Sucursal ${currentBranchName}`}
          </p>
          <h1>{warehouse ? "Bandeja de depósito" : "Mis pedidos"}</h1>
          <p>
            {warehouse
              ? "Solicitudes para preparar, despachar y seguir hasta su recepción."
              : "Seguimiento de pedidos solicitados, en preparación, despachados y recibidos."}
          </p>
        </div>
        {!warehouse && (
          <a className="order-primary" href="/replenishment">
            + Nuevo pedido
          </a>
        )}
      </section>

      {summary && (
        <section className="warehouse-summary">
          <button
            type="button"
            className={filter === "" ? "is-active" : ""}
            onClick={() => reset(setFilter, "")}
          >
            <span>Todos los pedidos</span>
            <strong>
              {fmt.format(
                (summary.pending ?? 0) +
                  (summary.inPreparation ?? 0) +
                  (summary.dispatched ?? 0) +
                  (summary.completed ?? 0),
              )}
            </strong>
            <small>Total en circuito</small>
          </button>
          <button
            type="button"
            className={
              filter === (warehouse ? "pending" : "CONFIRMED")
                ? "is-active"
                : ""
            }
            onClick={() =>
              reset(setFilter, warehouse ? "pending" : "CONFIRMED")
            }
          >
            <span>Pendientes</span>
            <strong>{fmt.format(summary.pending ?? 0)}</strong>
            <small>{warehouse ? "Por iniciar" : "En espera de depósito"}</small>
          </button>
          <button
            type="button"
            className={
              filter === (warehouse ? "preparing" : "IN_PREPARATION")
                ? "is-active"
                : ""
            }
            onClick={() =>
              reset(setFilter, warehouse ? "preparing" : "IN_PREPARATION")
            }
          >
            <span>En preparación</span>
            <strong>{fmt.format(summary.inPreparation ?? 0)}</strong>
            <small>{warehouse ? "En trabajo" : "Armándose en depósito"}</small>
          </button>
          <button
            type="button"
            className={
              filter === (warehouse ? "dispatched" : "DISPATCHED")
                ? "is-active"
                : ""
            }
            onClick={() =>
              reset(setFilter, warehouse ? "dispatched" : "DISPATCHED")
            }
          >
            <span>Despachados</span>
            <strong>{fmt.format(summary.dispatched ?? 0)}</strong>
            <small>{warehouse ? "Esperan PV" : "En viaje / a recibir"}</small>
          </button>
          <button
            type="button"
            className={
              filter === (warehouse ? "completed" : "COMPLETED")
                ? "is-active"
                : ""
            }
            onClick={() =>
              reset(setFilter, warehouse ? "completed" : "COMPLETED")
            }
          >
            <span>Completados</span>
            <strong>{fmt.format(summary.completed ?? 0)}</strong>
            <small>Entregados</small>
          </button>
        </section>
      )}

      <section className="orders-controls">
        <label className="search">
          <span>Buscar</span>
          <input
            value={search}
            onChange={(event) => reset(setSearch, event.target.value)}
            placeholder="Buscar por nº (#21), artículo o descripción..."
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
                <option value="">Todos los estados</option>
                <option value="CONFIRMED">Pendiente de preparación</option>
                <option value="IN_PREPARATION">En preparación</option>
                <option value="DISPATCHED">Despachado</option>
                <option value="COMPLETED">Completado</option>
                <option value="CANCELLED">Cancelado</option>
              </>
            )}
          </select>
        </label>
        <label className="filter-select">
          <span>{warehouse ? "Sucursal origen" : "Sucursal"}</span>
          {warehouse ? (
            <select
              value={origin}
              onChange={(event) => reset(setOrigin, event.target.value)}
            >
              <option value="">Centro y Jardín</option>
              <option value="2">Centro</option>
              <option value="3">Jardín</option>
            </select>
          ) : (
            <select value={origin} disabled>
              <option value={String(branchId)}>
                {currentBranchName}
              </option>
            </select>
          )}
        </label>
        <label className="filter-select">
          <span>Planificación</span>
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
              <h2>{warehouse ? "Solicitudes de depósito" : "Listado de pedidos"}</h2>
              <span>
                {fmt.format(total)} resultado{total === 1 ? "" : "s"}
              </span>
            </div>
            <small>
              {warehouse
                ? "Las solicitudes con acción pendiente aparecen primero."
                : "Hacé click en \"Ver detalle\" para revisar productos o exportar a Excel."}
            </small>
          </div>
          <div className="orders-table-wrap">
            <table className="orders-table warehouse-table">
              <thead>
                <tr>
                  <th>Pedido</th>
                  <th>Sucursal</th>
                  <th>Planificación</th>
                  <th>Fecha</th>
                  <th>Estado</th>
                  <th>Progreso</th>
                  <th>Acción siguiente</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((order) => (
                  <tr key={order.id}>
                    <td data-label="Pedido">
                      <strong>#{order.order_number ?? order.id}</strong>
                      <small>
                        {order.item_count} producto
                        {order.item_count === 1 ? "" : "s"} · Reposición a depósito
                      </small>
                    </td>
                    <td data-label="Sucursal">
                      {branchDisplayName(order.origin_branch_id ?? 0, "PV")}
                    </td>
                    <td data-label="Planificación">
                      {order.planning_date
                        ? new Date(order.planning_date).toLocaleDateString(
                            "es-AR",
                            { timeZone: "UTC" },
                          )
                        : "-"}
                    </td>
                    <td data-label="Fecha">
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
                    <td data-label="Acción">
                      <span
                        className={`next-action ${order.status.toLowerCase()}`}
                      >
                        {next(order)}
                      </span>
                    </td>
                    <td data-label="Acciones">
                      <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                        <a
                          className="order-link"
                          href={
                            warehouse
                              ? `/orders/warehouse/${order.id}`
                              : `/orders/${order.id}`
                          }
                        >
                          Ver detalle
                        </a>
                        <button
                          type="button"
                          className="order-export-btn-sm"
                          onClick={() => void exportOrderFromList(order)}
                          title={`Exportar pedido #${order.order_number ?? order.id} a Excel (.xlsx)`}
                        >
                          📊 Excel
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!rows.length && (
            <div className="orders-empty-state">
              <span className="empty-emoji">📦</span>
              <h3>No se encontraron pedidos</h3>
              <p>
                {search || filter || planning
                  ? "No hay pedidos que coincidan con los filtros aplicados. Podés limpiar la búsqueda o cambiar el estado."
                  : "No tenés ningún pedido en curso para esta sucursal."}
              </p>
              {!warehouse && !search && !filter && !planning && (
                <a className="order-primary" href="/replenishment">
                  + Crear nuevo pedido desde Reposición
                </a>
              )}
            </div>
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
            quantity: values[item.id] ?? item[field] ?? (field === "dispatched_quantity" ? item.prepared_quantity : item.dispatched_quantity) ?? 0,
          })) ?? [],
      }),
    });
  const input = (
    item: Item,
    field: "dispatched_quantity" | "received_quantity",
    maximum: number,
  ) => {
    const fallback = field === "dispatched_quantity" ? item.prepared_quantity : item.dispatched_quantity;
    return (
      <input
        className="quantity-input"
        type="number"
        min="0"
        max={maximum}
        step="any"
        value={values[item.id] ?? item[field] ?? fallback ?? ""}
        onChange={(event) =>
          setValues((current) => ({
            ...current,
            [item.id]: Number(event.target.value),
          }))
        }
      />
    );
  };
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
          <p className="page-context">Solicitud interna #{order.order_number ?? order.id}</p>
          <h1>
            {branchDisplayName(order.origin_branch_id ?? 0, "PV")} a deposito
          </h1>
          <p>
            Planificacion {order.planning_date?.slice(0, 10)} · Creada{" "}
            {new Date(order.created_at).toLocaleDateString("es-AR")}
          </p>
        </div>
        <div style={{ display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap" }}>
          <button
            type="button"
            className="order-export-btn"
            onClick={() =>
              downloadOrderExcel({
                orderId: order.order_number ?? order.id,
                status: difference ? "Completado con diferencia" : labels[order.status],
                branchLabel: branchDisplayName(order.origin_branch_id ?? 0, "PV"),
                planningDate: order.planning_date?.slice(0, 10),
                items: order.items ?? [],
              })
            }
            title="Exportar este pedido a planilla Excel (.xlsx)"
          >
            📊 Exportar a Excel
          </button>
          <span className={`order-status ${order.status.toLowerCase()}`}>
            {difference ? "Completado con diferencia" : labels[order.status]}
          </span>
        </div>
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
                  <th>Presentación</th>
                  <th>Rubro</th>
                  <th>Stock Depósito Central</th>
                  <th>Solicitado</th>
                  <th>Aprobado</th>
                  <th>Preparado</th>
                  <th>Despachado</th>
                  <th>Recibido</th>
                </tr>
              </thead>
              <tbody>
                {order.items?.map((item) => {
                  const isBulto = Boolean(item.package_units && item.package_units > 1);
                  return (
                  <tr key={item.id}>
                    <td data-label="Producto">
                      <strong>{item.product_name_snapshot}</strong>
                      <small>
                        #{item.article_id}
                        {item.supplier_code ? ` · Prov. ${item.supplier_code}` : ""}
                        {item.unit_measure_snapshot ? ` · ${item.unit_measure_snapshot}` : ""}
                      </small>
                      <div style={{ marginTop: "4px" }}>
                        <span className={`presentation-badge ${isBulto ? "bulto" : "unidad"}`}>
                          📦 {item.presentation_display || "Unidad"}
                        </span>
                      </div>
                    </td>
                    <td data-label="Presentación">
                      <span className={`presentation-badge ${isBulto ? "bulto" : "unidad"}`}>
                        {item.presentation_display || "Unidad"}
                      </span>
                    </td>
                    <td data-label="Rubro">
                      <span className="rubro-tag">
                        {item.rubro || "Sin rubro"}
                      </span>
                    </td>
                    <td data-label="Stock Depósito Central">
                      {item.stock_depot !== null && item.stock_depot !== undefined
                        ? `${fmt.format(item.stock_depot)} u.`
                        : "-"}
                    </td>
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
                );
              })}
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
