"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { OperationsNavigation } from "@/features/navigation/operations-navigation";

type Status =
  | "SUGGESTION_AVAILABLE"
  | "NO_SUGGESTION"
  | "INSUFFICIENT_HISTORY"
  | "NEGATIVE_STOCK"
  | "IRREGULAR_DEMAND"
  | "NO_DEMAND";
type Filter =
  | ""
  | "WITH_SUGGESTION"
  | "NO_SUGGESTION"
  | "REVIEW_REQUIRED"
  | "NO_DEMAND"
  | "INSUFFICIENT_HISTORY"
  | "IRREGULAR_DEMAND"
  | "ZERO_STOCK"
  | "NEGATIVE_STOCK"
  | "DEPOT_POSITIVE"
  | "DEPOT_ZERO"
  | "DEPOT_NEGATIVE"
  | "DEPOT_NO_ROW"
  | "DEPOT_NOT_POSITIVE"
  | "SUGGESTION_EXCEEDS_DEPOT"
  | "SUPPLY_DEPOT"
  | "SUPPLY_DIRECT_SUPPLIER"
  | "SUPPLY_UNDEFINED";
type Sort = "SUGGESTED_DESC" | "DEMAND_DESC" | "STOCK_ASC" | "DEPOT_GAP_DESC";
type DepotState =
  | "DEPOT_STOCK_POSITIVE"
  | "DEPOT_STOCK_ZERO"
  | "DEPOT_STOCK_NEGATIVE"
  | "DEPOT_NO_ROW";
type SupplyMode = "DEPOT" | "DIRECT_SUPPLIER" | "UNDEFINED";
type Item = {
  article_id: number;
  description: string | null;
  supplier_code: string | null;
  classification_code: string | null;
  unit_measure: string | null;
  stock_current: number;
  stock_depot: number | null;
  depot_stock_state: DepotState;
  supply_mode: SupplyMode;
  weekly_demand: number | null;
  target_stock: number | null;
  suggested_quantity: number | null;
  requested_quantity: number;
  active_weeks: number;
  status: Status;
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

const units = new Intl.NumberFormat("es-AR", { maximumFractionDigits: 2 });
const statusLabel: Record<Status, string> = {
  SUGGESTION_AVAILABLE: "Sugerencia disponible",
  NO_SUGGESTION: "Sin sugerencia",
  INSUFFICIENT_HISTORY: "Historial insuficiente",
  NEGATIVE_STOCK: "Saldo negativo · Revisión manual",
  IRREGULAR_DEMAND: "Demanda irregular · Revisar",
  NO_DEMAND: "Sin demanda reciente",
};
const depotLabel: Record<DepotState, string> = {
  DEPOT_STOCK_POSITIVE: "Stock positivo",
  DEPOT_STOCK_ZERO: "Stock cero",
  DEPOT_STOCK_NEGATIVE: "Stock negativo",
  DEPOT_NO_ROW: "Sin registro",
};
const supplyLabel: Record<SupplyMode, string> = {
  DEPOT: "DEPÓSITO",
  DIRECT_SUPPLIER: "PROVEEDOR DIRECTO",
  UNDEFINED: "SIN DEFINIR",
};
const quickFilters: Array<[Filter, string]> = [
  ["", "Todos"],
  ["WITH_SUGGESTION", "Con sugerencia"],
  ["REVIEW_REQUIRED", "Revisión manual"],
  ["NO_DEMAND", "Sin demanda"],
  ["DEPOT_NOT_POSITIVE", "Depósito sin stock"],
  ["SUGGESTION_EXCEEDS_DEPOT", "Sugerida > depósito"],
];
const filters: Array<[Filter, string]> = [
  ["", "Todos"],
  ["WITH_SUGGESTION", "Con sugerencia"],
  ["NO_SUGGESTION", "Sin sugerencia"],
  ["REVIEW_REQUIRED", "Revisión manual"],
  ["NO_DEMAND", "Sin demanda"],
  ["INSUFFICIENT_HISTORY", "Historial insuficiente"],
  ["IRREGULAR_DEMAND", "Demanda irregular"],
  ["NEGATIVE_STOCK", "Saldo PV negativo"],
  ["DEPOT_POSITIVE", "Depósito positivo"],
  ["DEPOT_ZERO", "Depósito cero"],
  ["DEPOT_NEGATIVE", "Depósito negativo"],
  ["DEPOT_NO_ROW", "Depósito sin registro"],
  ["DEPOT_NOT_POSITIVE", "Depósito sin stock"],
  ["SUGGESTION_EXCEEDS_DEPOT", "Sugerida > stock depósito"],
  ["SUPPLY_DEPOT", "Abastecimiento: depósito"],
  ["SUPPLY_DIRECT_SUPPLIER", "Abastecimiento: proveedor directo"],
  ["SUPPLY_UNDEFINED", "Abastecimiento: sin definir"],
];

function nextSaturday() {
  const now = new Date();
  const date = new Date(
    Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()),
  );
  date.setUTCDate(date.getUTCDate() + ((6 - date.getUTCDay() + 7) % 7));
  return date.toISOString().slice(0, 10);
}
function requestedKey(
  branchId: string,
  planningDate: string,
  articleId: number,
) {
  return `${branchId}:${planningDate}:${articleId}`;
}

export function ReplenishmentReviewClient({
  authorizedBranchId,
}: {
  authorizedBranchId: number;
}) {
  const branchId = String(authorizedBranchId);
  const [planningDate, setPlanningDate] = useState(nextSaturday);
  const [filter, setFilter] = useState<Filter>("");
  const [sort, setSort] = useState<Sort>("SUGGESTED_DESC");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Response | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [requested, setRequested] = useState<Record<string, number>>({});
  const [edited, setEdited] = useState<Record<string, true>>({});
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const selectedRef = useRef<Record<string, boolean>>({});
  const [selectedItems, setSelectedItems] = useState<
    Record<
      string,
      {
        article_id: number;
        requested_quantity: number;
        supply_mode: SupplyMode;
      }
    >
  >({});
  const [confirming, setConfirming] = useState(false);
  const [confirmedOrder, setConfirmedOrder] = useState<number | null>(null);
  const [existingOrder, setExistingOrder] = useState<{
    id: number;
    branchId: string;
    planningDate: string;
  } | null>(null);
  const requestVersion = useRef(0);
  const currentExistingOrder =
    existingOrder?.branchId === branchId &&
    existingOrder.planningDate === planningDate
      ? existingOrder.id
      : null;
  useEffect(() => {
    const version = requestVersion.current + 1;
    requestVersion.current = version;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      const params = new URLSearchParams({
        planning_date: planningDate,
        page: String(page),
        page_size: "50",
        sort,
      });
      if (filter) params.set("filter", filter);
      if (search) params.set("search", search);
      try {
        setLoading(true);
        const [response, existingResponse] = await Promise.all([
          fetch(`/api/replenishment/weekly?${params}`, {
            signal: controller.signal,
          }),
          fetch(
            `/api/orders?pv=1&active=1&planning_date=${planningDate}&limit=1`,
            { signal: controller.signal },
          ),
        ]);
        const result = await response.json();
        const existing = await existingResponse.json();
        if (controller.signal.aborted || version !== requestVersion.current)
          return;
        if (!response.ok)
          throw new Error(
            result.error || "No pudimos cargar la revisión semanal.",
          );
        if (!existingResponse.ok)
          throw new Error(
            existing.error ||
              "No pudimos consultar las solicitudes existentes.",
          );
        setData(result);
        setSelected((current) => {
          const next = { ...current };
          for (const item of result.items as Item[]) {
            const key = requestedKey(branchId, planningDate, item.article_id);
            if (next[key] === undefined)
              next[key] =
                item.supply_mode === "DEPOT" && item.requested_quantity > 0;
            else if (item.supply_mode !== "DEPOT") next[key] = false;
          }
          selectedRef.current = next;
          return next;
        });
        setSelectedItems((current) => {
          const next = { ...current };
          for (const item of result.items as Item[]) {
            const key = requestedKey(branchId, planningDate, item.article_id);
            if (item.supply_mode !== "DEPOT") delete next[key];
            else if (selectedRef.current[key] && !next[key])
              next[key] = {
                article_id: item.article_id,
                requested_quantity: item.requested_quantity,
                supply_mode: item.supply_mode,
              };
          }
          return next;
        });
        const existingId = existing.rows?.[0]?.id;
        setExistingOrder(
          typeof existingId === "number"
            ? { id: existingId, branchId, planningDate }
            : null,
        );
        setConfirmedOrder(null);
        setError(null);
      } catch (cause) {
        if (
          !controller.signal.aborted &&
          version === requestVersion.current &&
          (cause as Error).name !== "AbortError"
        )
          setError((cause as Error).message);
      } finally {
        if (!controller.signal.aborted && version === requestVersion.current)
          setLoading(false);
      }
    }, 180);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [branchId, planningDate, filter, sort, search, page]);
  const resetPage = <T extends string>(
    setter: (value: T) => void,
    value: T,
  ) => {
    setter(value);
    setPage(1);
  };
  const valueFor = (item: Item) =>
    requested[requestedKey(branchId, planningDate, item.article_id)] ??
    item.requested_quantity;
  const selectedFor = (item: Item) =>
    item.supply_mode === "DEPOT" &&
    (selected[requestedKey(branchId, planningDate, item.article_id)] ??
      valueFor(item) > 0);
  const globalSelections = Object.entries(selectedItems)
    .filter(
      ([key, item]) =>
        key.startsWith(`${branchId}:${planningDate}:`) &&
        item.supply_mode === "DEPOT",
    )
    .map(([, item]) => item);
  const globalEditedCount = Object.keys(edited).filter(
    (key) =>
      key.startsWith(`${branchId}:${planningDate}:`) && selectedItems[key],
  ).length;
  const toggleSelection = (item: Item, checked: boolean) => {
    if (item.supply_mode !== "DEPOT") return;
    const key = requestedKey(branchId, planningDate, item.article_id);
    setSelected((current) => {
      const next = { ...current, [key]: checked };
      selectedRef.current = next;
      return next;
    });
    setSelectedItems((current) => {
      const next = { ...current };
      if (checked)
        next[key] = {
          article_id: item.article_id,
          requested_quantity: valueFor(item),
          supply_mode: item.supply_mode,
        };
      else delete next[key];
      return next;
    });
  };
  const setQuantity = (item: Item, value: number) => {
    const key = requestedKey(branchId, planningDate, item.article_id);
    setRequested((current) => ({ ...current, [key]: value }));
    setSelectedItems((current) =>
      current[key]
        ? {
            ...current,
            [key]: {
              article_id: item.article_id,
              requested_quantity: value,
              supply_mode: item.supply_mode,
            },
          }
        : current,
    );
    setEdited((current) => ({ ...current, [key]: true }));
  };
  const restore = (item: Item) => {
    const key = requestedKey(branchId, planningDate, item.article_id);
    setRequested((current) => ({
      ...current,
      [key]: item.suggested_quantity ?? 0,
    }));
    setEdited((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    setSelectedItems((current) =>
      current[key]
        ? {
            ...current,
            [key]: {
              article_id: item.article_id,
              requested_quantity: item.suggested_quantity ?? 0,
              supply_mode: item.supply_mode,
            },
          }
        : current,
    );
  };
  const confirm = async () => {
    if (!data) return;
    const items = globalSelections.filter(
      (item) => item.requested_quantity > 0,
    );
    if (
      !items.length ||
      !window.confirm(
        `Confirmar solicitud de ${items.length} productos para ${data.location.label}?`,
      )
    )
      return;
    setConfirming(true);
    try {
      const response = await fetch("/api/replenishment/weekly/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          branch_id: Number(branchId),
          planning_date: planningDate,
          items,
        }),
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error || "No pudimos confirmar la solicitud.");
      setConfirmedOrder(result.id);
      setExistingOrder(result.id);
      setError(null);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setConfirming(false);
    }
  };
  return (
    <main className="orders-shell replenishment-review-shell">
      <header className="orders-topbar">
        <Link className="brand" href="/dashboard">
          <span className="brand-mark">M</span>
          <span>
            MONICA<span className="brand-sub">Panel de operación</span>
          </span>
        </Link>
        <OperationsNavigation role="PV" branchId={authorizedBranchId} />
      </header>
      <section className="review-heading">
        <div>
          <Link className="back-link" href="/replenishment">
            Volver a validación
          </Link>
          <h1>Reposición semanal</h1>
          <p>
            La sugerencia es una referencia; la cantidad solicitada es la
            decisión de quien opera.
          </p>
        </div>
        <div className="review-method">
          <strong>Motor semanal</strong>
          <span>6 semanas completas anteriores</span>
        </div>
      </section>
      <section className="review-toolbar" aria-label="Controles de reposición">
        <label>
          <span>Punto de venta</span>
          <select value={branchId} disabled>
            <option value={branchId}>
              {authorizedBranchId === 2 ? "PV1" : "PV2"}
            </option>
          </select>
        </label>
        <label>
          <span>Planificación</span>
          <input
            type="date"
            value={planningDate}
            onChange={(event) => resetPage(setPlanningDate, event.target.value)}
          />
        </label>
        <label className="review-search">
          <span>Buscar</span>
          <input
            value={search}
            onChange={(event) => resetPage(setSearch, event.target.value)}
            placeholder="Producto, artículo, proveedor o clasificación"
          />
        </label>
        <label>
          <span>Ordenar</span>
          <select
            value={sort}
            onChange={(event) => resetPage(setSort, event.target.value as Sort)}
          >
            <option value="SUGGESTED_DESC">Mayor sugerida</option>
            <option value="DEMAND_DESC">Mayor demanda</option>
            <option value="STOCK_ASC">Menor stock PV</option>
            <option value="DEPOT_GAP_DESC">Mayor diferencia depósito</option>
          </select>
        </label>
      </section>
      <section className="review-summary" aria-label="Resumen operativo">
        {quickFilters.map(([value, label]) => (
          <button
            key={value || "all"}
            className={filter === value ? "is-active" : ""}
            onClick={() => resetPage(setFilter, value)}
          >
            {label}
          </button>
        ))}
      </section>
      <section className="review-filter-line">
        <label>
          <span>Filtro detallado</span>
          <select
            value={filter}
            onChange={(event) =>
              resetPage(setFilter, event.target.value as Filter)
            }
          >
            {filters.map(([value, label]) => (
              <option key={value || "all"} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {data && (
          <span>
            {units.format(data.total)} productos relevantes en{" "}
            {data.location.label}
          </span>
        )}
        {currentExistingOrder && (
          <Link className="order-primary" href={`/orders/${currentExistingOrder}`}>
            Solicitud existente #{currentExistingOrder}
          </Link>
        )}
        <button
          className="order-primary"
          disabled={
            !data ||
            confirming ||
            confirmedOrder !== null ||
            currentExistingOrder !== null
          }
          onClick={() => void confirm()}
        >
          {confirmedOrder
            ? `Solicitud #${confirmedOrder} confirmada`
            : confirming
              ? "Confirmando..."
              : "Confirmar reposición"}
        </button>
      </section>
      {!loading && data && (
        <section className="replenishment-note">
          <strong>
            {globalSelections.length} productos para depósito ·{" "}
            {units.format(
              globalSelections.reduce(
                (sum, item) => sum + item.requested_quantity,
                0,
              ),
            )}{" "}
            unidades solicitadas
          </strong>
          <span>
            {globalEditedCount
              ? `${globalEditedCount} cantidades modificadas manualmente. `
              : ""}
            Solo los artículos con abastecimiento DEPÓSITO generan una solicitud interna.
          </span>
        </section>
      )}
      {confirmedOrder && (
        <section className="replenishment-note">
          <strong>Solicitud enviada al depósito · #{confirmedOrder}</strong>
          <Link className="order-link" href={`/orders/${confirmedOrder}`}>
            Ver solicitud
          </Link>
        </section>
      )}
      {loading ? (
        <div className="orders-loading">
          <div className="skeleton" />
          <div className="skeleton" />
          <div className="skeleton" />
        </div>
      ) : error ? (
        <section className="orders-error">
          <strong>No pudimos cargar la revisión.</strong>
          <span>{error}</span>
        </section>
      ) : (
        <section className="review-table-panel">
          <div className="review-table-wrap">
            <table className="review-table">
              <thead>
                <tr>
                  <th>Incluir</th>
                  <th>Producto</th>
                  <th>Abastecimiento</th>
                  <th>Clasificación</th>
                  <th>Stock PV</th>
                  <th>Demanda semanal</th>
                  <th>Objetivo</th>
                  <th>Sugerida</th>
                  <th>Solicitada</th>
                  <th>Stock depósito</th>
                  <th>Estado depósito</th>
                  <th>Estado</th>
                </tr>
              </thead>
              <tbody>
                {data?.items.map((item) => {
                  const key = requestedKey(
                    branchId,
                    planningDate,
                    item.article_id,
                  );
                  const isEdited = Boolean(edited[key]);
                  const requestedValue = valueFor(item);
                  const depotShort =
                    item.suggested_quantity !== null &&
                    item.stock_depot !== null &&
                    item.suggested_quantity > item.stock_depot;
                  return (
                    <tr key={item.article_id}>
                      <td data-label="Incluir">
                        <input
                          type="checkbox"
                          disabled={item.supply_mode !== "DEPOT"}
                          checked={selectedFor(item)}
                          onChange={(event) =>
                            toggleSelection(item, event.target.checked)
                          }
                        />
                      </td>
                      <td data-label="Producto" className="review-product">
                        <strong>
                          {item.description || `Artículo ${item.article_id}`}
                        </strong>
                        <small>
                          #{item.article_id} · Prov. {item.supplier_code || "-"}{" "}
                          · {item.unit_measure || "sin unidad"}
                        </small>
                      </td>
                      <td data-label="Abastecimiento">
                        <span className={`depot-state supply-${item.supply_mode.toLowerCase()}`}>
                          {supplyLabel[item.supply_mode]}
                        </span>
                        {item.supply_mode !== "DEPOT" && (
                          <small>
                            {item.supply_mode === "DIRECT_SUPPLIER"
                              ? "No integra el pedido al depósito"
                              : "Definí la ruta antes de pedir al depósito"}
                          </small>
                        )}
                      </td>
                      <td data-label="Clasificación">
                        <code>{item.classification_code || "-"}</code>
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
                        <small>{item.active_weeks}/6 activas</small>
                      </td>
                      <td data-label="Stock objetivo">
                        {item.target_stock === null
                          ? "Revisar"
                          : units.format(item.target_stock)}
                      </td>
                      <td data-label="Sugerida" className="review-suggested">
                        {item.suggested_quantity === null
                          ? "-"
                          : units.format(item.suggested_quantity)}
                        <small>Sistema</small>
                      </td>
                      <td data-label="Solicitada">
                        <div className="requested-control">
                          <input
                            className={
                              isEdited
                                ? "quantity-input is-edited"
                                : "quantity-input"
                            }
                            type="number"
                            min="0"
                            step="any"
                            value={requestedValue}
                            aria-label={`Solicitada para ${item.description || item.article_id}`}
                            onChange={(event) => {
                              const next = Number(event.target.value);
                              if (Number.isFinite(next) && next >= 0)
                                setQuantity(item, next);
                            }}
                          />
                          {isEdited ? (
                            <button onClick={() => restore(item)}>
                              Restaurar sugerida
                            </button>
                          ) : (
                            <small>Operador</small>
                          )}
                        </div>
                      </td>
                      <td
                        data-label="Stock depósito"
                        className={
                          item.stock_depot !== null && item.stock_depot < 0
                            ? "negative-number"
                            : ""
                        }
                      >
                        {item.stock_depot === null
                          ? "-"
                          : units.format(item.stock_depot)}
                        {depotShort && (
                          <small className="depot-warning">
                            Stock depósito menor a la sugerencia
                          </small>
                        )}
                      </td>
                      <td data-label="Estado depósito">
                        <span
                          className={`depot-state ${item.depot_stock_state.toLowerCase()}`}
                        >
                          {depotLabel[item.depot_stock_state]}
                        </span>
                      </td>
                      <td data-label="Estado">
                        <span
                          className={`suggestion-status ${item.status.toLowerCase()}`}
                        >
                          {statusLabel[item.status]}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {data && (
            <div className="orders-pagination">
              <span>Los cambios de solicitada no se guardan todavía.</span>
              <div className="pagination-controls">
                <button disabled={page === 1} onClick={() => setPage(page - 1)}>
                  Anterior
                </button>
                <span>Página {page}</span>
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
      )}
    </main>
  );
}
