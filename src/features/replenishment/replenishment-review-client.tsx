"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useMemo } from "react";
import {
  branchDisplayName,
  OperationsNavigation,
} from "@/features/navigation/operations-navigation";
import {
  downloadReplenishmentExcel,
  type ReplenishmentExportItem,
} from "@/features/excel/order-export";

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
  | "SUPPLY_UNDEFINED"
  | "TO_REPLENISH";
type Sort =
  | "SUGGESTED_DESC"
  | "DEMAND_DESC"
  | "STOCK_ASC"
  | "DEPOT_GAP_DESC"
  | "RUBRO_ASC";
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
  rubro?: string | null;
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
  rubros?: string[];
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
  ["TO_REPLENISH", "A reponer en depósito (Recomendado)"],
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

const draftStorageKey = (branchId: string, planningDate: string) =>
  `kioskero_draft_v1_${branchId}_${planningDate}`;

type StoredDraft = {
  requested?: Record<string, number>;
  edited?: Record<string, true>;
  selected?: Record<string, boolean>;
  selectedItems?: Record<
    string,
    {
      article_id: number;
      requested_quantity: number;
      supply_mode: SupplyMode;
    }
  >;
  itemRegistry?: Record<number, ReplenishmentExportItem>;
};

function readDraftFromStorage(
  branchId: string,
  planningDate: string,
): StoredDraft | null {
  if (typeof window === "undefined") return null;
  try {
    const saved = localStorage.getItem(draftStorageKey(branchId, planningDate));
    if (saved) {
      const parsed = JSON.parse(saved);
      if (parsed && typeof parsed === "object") return parsed as StoredDraft;
    }
  } catch {}
  return null;
}

export function ReplenishmentReviewClient({
  authorizedBranchId,
}: {
  authorizedBranchId: number;
}) {
  const branchId = String(authorizedBranchId);
  const branchName = branchDisplayName(authorizedBranchId, "PV");
  const [planningDate, setPlanningDate] = useState(nextSaturday);
  const [filter, setFilter] = useState<Filter>("TO_REPLENISH");
  const [rubro, setRubro] = useState<string>("");
  const [sort, setSort] = useState<Sort>("SUGGESTED_DESC");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Response | null>(null);
  const [allRubros, setAllRubros] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [authError, setAuthError] = useState(false);
  const [showExportModal, setShowExportModal] = useState(false);
  const [reloadCounter, setReloadCounter] = useState(0);

  const [requested, setRequested] = useState<Record<string, number>>(() => {
    const draft = readDraftFromStorage(branchId, nextSaturday());
    return draft?.requested ?? {};
  });
  const requestedRef = useRef(requested);
  useEffect(() => {
    requestedRef.current = requested;
  }, [requested]);

  const [edited, setEdited] = useState<Record<string, true>>(() => {
    const draft = readDraftFromStorage(branchId, nextSaturday());
    return draft?.edited ?? {};
  });
  const [selected, setSelected] = useState<Record<string, boolean>>(() => {
    const draft = readDraftFromStorage(branchId, nextSaturday());
    return draft?.selected ?? {};
  });
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
  >(() => {
    const draft = readDraftFromStorage(branchId, nextSaturday());
    return draft?.selectedItems ?? {};
  });

  const [itemRegistry, setItemRegistry] = useState<
    Record<number, ReplenishmentExportItem>
  >(() => {
    const draft = readDraftFromStorage(branchId, nextSaturday());
    return draft?.itemRegistry ?? {};
  });

  const [draftRestored, setDraftRestored] = useState<boolean>(() => {
    const draft = readDraftFromStorage(branchId, nextSaturday());
    return Boolean(draft?.edited && Object.keys(draft.edited).length > 0);
  });

  const [confirming, setConfirming] = useState(false);
  const [confirmedOrder, setConfirmedOrder] = useState<number | null>(null);
  const [confirmedOrderId, setConfirmedOrderId] = useState<number | null>(null);
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

  const handlePlanningDateChange = (newDate: string) => {
    setPlanningDate(newDate);
    setPage(1);
    const draft = readDraftFromStorage(branchId, newDate);
    setRequested(draft?.requested ?? {});
    setEdited(draft?.edited ?? {});
    setSelected(draft?.selected ?? {});
    selectedRef.current = draft?.selected ?? {};
    setSelectedItems(draft?.selectedItems ?? {});
    setItemRegistry(draft?.itemRegistry ?? {});
    setDraftRestored(Boolean(draft?.edited && Object.keys(draft.edited).length > 0));
  };

  // Persist draft to localStorage on any change
  useEffect(() => {
    try {
      const hasContent =
        Object.keys(requested).length > 0 ||
        Object.keys(selectedItems).length > 0 ||
        Object.keys(edited).length > 0;
      if (hasContent) {
        localStorage.setItem(
          draftStorageKey(branchId, planningDate),
          JSON.stringify({
            requested,
            edited,
            selected,
            selectedItems,
            itemRegistry,
            savedAt: Date.now(),
          }),
        );
      }
    } catch {
      // Ignore quota errors
    }
  }, [
    branchId,
    planningDate,
    requested,
    edited,
    selected,
    selectedItems,
    itemRegistry,
  ]);

  const clearDraft = () => {
    try {
      localStorage.removeItem(draftStorageKey(branchId, planningDate));
    } catch {}
    setRequested({});
    setEdited({});
    setSelected({});
    selectedRef.current = {};
    setSelectedItems({});
    setDraftRestored(false);
    setReloadCounter((c) => c + 1);
  };

  useEffect(() => {
    const version = requestVersion.current + 1;
    requestVersion.current = version;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      const params = new URLSearchParams({
        branch_id: branchId,
        planning_date: planningDate,
        page: String(page),
        page_size: "50",
        sort,
      });
      if (filter) params.set("filter", filter);
      if (search) params.set("search", search);
      if (rubro) params.set("rubro", rubro);

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

        if (response.status === 401 || result.error === "UNAUTHENTICATED") {
          setAuthError(true);
          throw new Error(
            result.message ||
              "Tu sesión ha expirado o requiere autenticación. Tus cantidades ingresadas están guardadas de forma segura en este navegador.",
          );
        }

        if (!response.ok)
          throw new Error(
            result.message ||
              result.error ||
              "No pudimos cargar la revisión semanal.",
          );
        if (!existingResponse.ok)
          throw new Error(
            existing.message ||
              existing.error ||
              "No pudimos consultar las solicitudes existentes.",
          );

        setData(result);
        if (result.rubros && Array.isArray(result.rubros)) {
          setAllRubros(result.rubros);
        }
        setAuthError(false);
        setError(null);

        // Update item registry with metadata
        setItemRegistry((current) => {
          const next = { ...current };
          for (const item of result.items as Item[]) {
            const key = requestedKey(branchId, planningDate, item.article_id);
            const reqVal = requestedRef.current[key] ?? item.requested_quantity;
            next[item.article_id] = {
              article_id: item.article_id,
              description: item.description,
              rubro: item.rubro ?? item.classification_code ?? null,
              classification_code: item.classification_code,
              stock_current: item.stock_current,
              stock_depot: item.stock_depot,
              suggested_quantity: item.suggested_quantity,
              requested_quantity: reqVal,
              supply_mode: item.supply_mode,
              supplier_code: item.supplier_code,
              unit_measure: item.unit_measure,
            };
          }
          return next;
        });

        setSelected((current) => {
          const next = { ...current };
          for (const item of result.items as Item[]) {
            const key = requestedKey(branchId, planningDate, item.article_id);
            if (next[key] === undefined)
              next[key] =
                (item.supply_mode === "DEPOT" ||
                  item.supply_mode === "UNDEFINED") &&
                item.requested_quantity > 0;
            else if (item.supply_mode === "DIRECT_SUPPLIER") next[key] = false;
          }
          selectedRef.current = next;
          return next;
        });

        setSelectedItems((current) => {
          const next = { ...current };
          for (const item of result.items as Item[]) {
            const key = requestedKey(branchId, planningDate, item.article_id);
            if (item.supply_mode === "DIRECT_SUPPLIER") delete next[key];
            else if (selectedRef.current[key] && !next[key]) {
              const reqVal = requestedRef.current[key] ?? item.requested_quantity;
              next[key] = {
                article_id: item.article_id,
                requested_quantity: reqVal,
                supply_mode: item.supply_mode,
              };
            }
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
  }, [
    branchId,
    planningDate,
    filter,
    sort,
    search,
    rubro,
    page,
    reloadCounter,
  ]);

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
    (item.supply_mode === "DEPOT" || item.supply_mode === "UNDEFINED") &&
    (selected[requestedKey(branchId, planningDate, item.article_id)] ??
      valueFor(item) > 0);

  const globalSelections = Object.entries(selectedItems)
    .filter(
      ([key, item]) =>
        key.startsWith(`${branchId}:${planningDate}:`) &&
        (item.supply_mode === "DEPOT" || item.supply_mode === "UNDEFINED"),
    )
    .map(([, item]) => item);

  const globalEditedCount = Object.keys(edited).filter(
    (key) =>
      key.startsWith(`${branchId}:${planningDate}:`) && selectedItems[key],
  ).length;

  const toggleSelection = (item: Item, checked: boolean) => {
    if (item.supply_mode === "DIRECT_SUPPLIER") return;
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
    setItemRegistry((current) => ({
      ...current,
      [item.article_id]: {
        ...(current[item.article_id] || {
          article_id: item.article_id,
          description: item.description,
          rubro: item.rubro ?? item.classification_code ?? null,
          classification_code: item.classification_code,
          stock_current: item.stock_current,
          stock_depot: item.stock_depot,
          suggested_quantity: item.suggested_quantity,
          supply_mode: item.supply_mode,
          supplier_code: item.supplier_code,
          unit_measure: item.unit_measure,
        }),
        requested_quantity: value,
      },
    }));
    setEdited((current) => ({ ...current, [key]: true }));
  };

  const restore = (item: Item) => {
    const key = requestedKey(branchId, planningDate, item.article_id);
    const sug = item.suggested_quantity ?? 0;
    setRequested((current) => ({
      ...current,
      [key]: sug,
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
              requested_quantity: sug,
              supply_mode: item.supply_mode,
            },
          }
        : current,
    );
    setItemRegistry((current) => ({
      ...current,
      [item.article_id]: {
        ...(current[item.article_id] || {
          article_id: item.article_id,
          description: item.description,
          rubro: item.rubro ?? item.classification_code ?? null,
          classification_code: item.classification_code,
          stock_current: item.stock_current,
          stock_depot: item.stock_depot,
          suggested_quantity: item.suggested_quantity,
          supply_mode: item.supply_mode,
          supplier_code: item.supplier_code,
          unit_measure: item.unit_measure,
        }),
        requested_quantity: sug,
      },
    }));
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
          idempotency_token:
            typeof crypto !== "undefined" && crypto.randomUUID
              ? crypto.randomUUID()
              : `kioskero-${branchId}-${planningDate}-${Date.now()}`,
        }),
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error || "No pudimos confirmar la solicitud.");
      const returnedOrderNumber = result.order_number ?? result.id;
      const returnedId = result.id;
      setConfirmedOrder(returnedOrderNumber);
      setConfirmedOrderId(returnedId);
      setExistingOrder({ id: returnedId, branchId, planningDate });
      try {
        localStorage.removeItem(draftStorageKey(branchId, planningDate));
      } catch {}
      setDraftRestored(false);
      setError(null);
      setAuthError(false);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setConfirming(false);
    }
  };

  const handleExport = (mode: "selected" | "visible") => {
    if (mode === "selected") {
      const exportList: ReplenishmentExportItem[] = globalSelections
        .map((sel) => {
          const meta = itemRegistry[sel.article_id];
          return {
            article_id: sel.article_id,
            description: meta?.description ?? `Artículo ${sel.article_id}`,
            rubro: meta?.rubro ?? meta?.classification_code ?? "Sin rubro",
            classification_code: meta?.classification_code ?? null,
            stock_current: meta?.stock_current ?? 0,
            stock_depot: meta?.stock_depot ?? null,
            suggested_quantity: meta?.suggested_quantity ?? null,
            requested_quantity: sel.requested_quantity,
            supply_mode: sel.supply_mode,
            supplier_code: meta?.supplier_code ?? null,
            unit_measure: meta?.unit_measure ?? "UN",
          };
        })
        .filter((item) => item.requested_quantity > 0);

      if (exportList.length === 0) {
        alert("No hay productos con cantidad solicitada mayor a 0 para exportar.");
        return;
      }

      downloadReplenishmentExcel({
        items: exportList,
        branchLabel: branchName,
        planningDate,
        title: "Pedido a Depósito Completo",
        filename: `PEDIDO_COMPLETO_${branchName.replace(/\s+/g, "_")}_${planningDate}.xlsx`,
      });
    } else if (mode === "visible" && data) {
      const exportList: ReplenishmentExportItem[] = data.items.map((item) => ({
        article_id: item.article_id,
        description: item.description,
        rubro: item.rubro ?? item.classification_code ?? "Sin rubro",
        classification_code: item.classification_code,
        stock_current: item.stock_current,
        stock_depot: item.stock_depot,
        suggested_quantity: item.suggested_quantity,
        requested_quantity: valueFor(item),
        supply_mode: item.supply_mode,
        supplier_code: item.supplier_code,
        unit_measure: item.unit_measure,
      }));

      downloadReplenishmentExcel({
        items: exportList,
        branchLabel: branchName,
        planningDate,
        title: `Productos Filtrados (${rubro || "Todos los rubros"})`,
        filename: `REPOSICION_FILTRADA_${branchName.replace(/\s+/g, "_")}_${planningDate}.xlsx`,
      });
    }
    setShowExportModal(false);
  };

  return (
    <main className="orders-shell replenishment-review-shell">
      <header className="orders-topbar">
        <Link className="brand" href="/dashboard">
          <span className="brand-mark">LCQ</span>
          <span>
            LA CASA DEL KIOSKERO<span className="brand-sub">Panel de operación</span>
          </span>
        </Link>
        <OperationsNavigation role="PV" branchId={authorizedBranchId} />
      </header>

      <section className="review-heading">
        <div>
          <Link className="back-link" href="/dashboard">
            Volver al panel central
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

      {/* Toolbar with Rubro selector & Sort */}
      <section className="review-toolbar" aria-label="Controles de reposición">
        <label>
          <span>Punto de venta</span>
          <select value={branchId} disabled>
            <option value={branchId}>{branchName}</option>
          </select>
        </label>
        <label>
          <span>Planificación</span>
          <input
            type="date"
            value={planningDate}
            onChange={(event) => handlePlanningDateChange(event.target.value)}
          />
        </label>
        <label className="review-search">
          <span>Buscar</span>
          <input
            value={search}
            onChange={(event) => resetPage(setSearch, event.target.value)}
            placeholder="Producto, artículo, proveedor o rubro"
          />
        </label>
        <label>
          <span>Rubro</span>
          <select
            value={rubro}
            onChange={(event) => resetPage(setRubro, event.target.value)}
            aria-label="Filtrar por rubro"
          >
            <option value="">Todos los rubros</option>
            {allRubros.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
            <option value="__SIN_RUBRO__">Sin rubro</option>
          </select>
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
            <option value="RUBRO_ASC">Rubro (A - Z)</option>
          </select>
        </label>
      </section>

      {/* Quick Filters */}
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

      {/* Filter and Actions Bar */}
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
            {rubro ? ` (Rubro: ${rubro === "__SIN_RUBRO__" ? "Sin rubro" : rubro})` : ""}
          </span>
        )}

        <div className="review-actions-group">
          {/* Excel Export Button */}
          <button
            type="button"
            className="order-export-btn"
            onClick={() => setShowExportModal(true)}
            title="Exportar productos del pedido a archivo Excel (.xlsx)"
          >
            📥 Exportar a Excel
          </button>

          {currentExistingOrder && (
            <Link
              className="order-primary"
              href={`/orders/${currentExistingOrder}`}
            >
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
        </div>
      </section>

      {/* Restored Draft Notice */}
      {draftRestored && (
        <section className="replenishment-draft-notice">
          <div>
            <strong>💾 Borrador recuperado:</strong> Se restauraron las
            cantidades ingresadas previamente ({globalSelections.length}{" "}
            productos,{" "}
            {units.format(
              globalSelections.reduce(
                (sum, item) => sum + item.requested_quantity,
                0,
              ),
            )}{" "}
            unidades).
          </div>
          <button
            type="button"
            className="order-text-button"
            onClick={clearDraft}
          >
            Descartar borrador y reiniciar
          </button>
        </section>
      )}

      {/* Global Order Summary Banner */}
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
            Solo los artículos con abastecimiento DEPÓSITO generan una solicitud
            interna.
          </span>
        </section>
      )}

      {confirmedOrder && (
        <section className="replenishment-note">
          <strong>Solicitud enviada al depósito · #{confirmedOrder}</strong>
          <Link className="order-link" href={`/orders/${confirmedOrderId || confirmedOrder}`}>
            Ver solicitud
          </Link>
        </section>
      )}

      {/* Resilient Error & Authentication Alert Banners */}
      {authError ? (
        <section className="auth-alert-banner">
          <div className="auth-alert-message">
            <strong>⚠️ Tu sesión ha expirado o requiere autenticación</strong>
            <span>
              Tus modificaciones ({globalSelections.length} productos,{" "}
              {units.format(
                globalSelections.reduce(
                  (sum, item) => sum + item.requested_quantity,
                  0,
                ),
              )}{" "}
              unidades solicitadas) están guardadas de forma segura en este
              navegador.
            </span>
          </div>
          <div className="auth-alert-actions">
            <a
              className="order-primary"
              href="/login?returnTo=/replenishment"
              target="_blank"
              rel="noopener noreferrer"
            >
              Iniciar sesión en otra pestaña
            </a>
            <button
              type="button"
              className="order-secondary"
              onClick={() => setReloadCounter((c) => c + 1)}
            >
              Reintentar conexión
            </button>
            <button
              type="button"
              className="order-export-btn"
              onClick={() => handleExport("selected")}
            >
              📥 Exportar pedido a Excel ahora
            </button>
          </div>
        </section>
      ) : error ? (
        <section className="auth-alert-banner" style={{ borderLeftColor: "#e11d48", background: "#fff1f2", color: "#9f1239" }}>
          <div className="auth-alert-message">
            <strong style={{ color: "#be123c" }}>No pudimos cargar los datos</strong>
            <span>{error}</span>
          </div>
          <div className="auth-alert-actions">
            <button
              type="button"
              className="order-secondary"
              onClick={() => setReloadCounter((c) => c + 1)}
            >
              Reintentar
            </button>
          </div>
        </section>
      ) : null}

      {/* Main Table / Skeletons */}
      {loading && !data ? (
        <div className="orders-loading">
          <div className="skeleton" />
          <div className="skeleton" />
          <div className="skeleton" />
        </div>
      ) : data ? (
        <section className="review-table-panel">
          <div className="review-table-wrap">
            <table className="review-table">
              <thead>
                <tr>
                  <th>Incluir</th>
                  <th>Producto</th>
                  <th>Rubro</th>
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
                {data.items.map((item) => {
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
                          disabled={item.supply_mode === "DIRECT_SUPPLIER"}
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
                      <td data-label="Rubro">
                        <span className="rubro-tag">
                          {item.rubro || "Sin rubro"}
                        </span>
                      </td>
                      <td data-label="Abastecimiento">
                        <span
                          className={`supply-pill ${item.supply_mode.toLowerCase()}`}
                        >
                          {supplyLabel[item.supply_mode]}
                        </span>
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
                      </td>
                      <td data-label="Objetivo">
                        {item.target_stock === null
                          ? "-"
                          : units.format(item.target_stock)}
                      </td>
                      <td data-label="Sugerida" className="review-suggested">
                        {item.suggested_quantity === null
                          ? "-"
                          : units.format(item.suggested_quantity)}
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

          <div className="orders-pagination">
            <span>
              Tus cambios se guardan automáticamente en este navegador hasta confirmar.
            </span>
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
        </section>
      ) : null}

      {/* Export to Excel Modal */}
      {showExportModal && (
        <div
          className="export-modal-backdrop"
          onClick={() => setShowExportModal(false)}
        >
          <div
            className="export-modal-card"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="export-modal-title"
          >
            <div className="export-modal-header">
              <h3 id="export-modal-title">📥 Exportar Pedido a Excel</h3>
              <p>
                Seleccioná qué conjunto de productos querés exportar al archivo
                .xlsx:
              </p>
            </div>
            <div className="export-modal-options">
              <button
                type="button"
                className="export-option-btn"
                onClick={() => handleExport("selected")}
              >
                <strong>
                  1. Exportar pedido completo (Recomendado)
                </strong>
                <span>
                  Incluye todos los <strong>{globalSelections.length} productos</strong> marcados para depósito ({units.format(globalSelections.reduce((sum, item) => sum + item.requested_quantity, 0))} unidades totales), sin importar el rubro o página actual.
                </span>
              </button>
              <button
                type="button"
                className="export-option-btn"
                onClick={() => handleExport("visible")}
              >
                <strong>2. Exportar productos filtrados de esta vista</strong>
                <span>
                  Exporta únicamente los {data?.items.length ?? 0} artículos visibles actualmente con el filtro o rubro activo.
                </span>
              </button>
            </div>
            <div className="export-modal-footer">
              <button
                type="button"
                className="order-secondary"
                onClick={() => setShowExportModal(false)}
              >
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
