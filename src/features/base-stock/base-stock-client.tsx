"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { OperationsNavigation } from "@/features/navigation/operations-navigation";

type ConfigState = "ALL" | "CONFIGURED" | "UNCONFIGURED" | "ZERO";

type BaseStockRow = {
  article_id: number;
  description: string | null;
  brand: string | null;
  supplier_code: string | null;
  classification_code: string | null;
  rubro: string;
  unit_measure: string | null;
  is_active: boolean;
  current_stock: number;
  depot_stock: number | null;
  erp_stopti: number | null;
  base_stock: number | null;
  is_configured: boolean;
  notes: string | null;
  updated_at: string | null;
  history_cutoff_date: string | null;
  snapshot_mismatch: {
    previous_description: string;
    order_id: number;
    order_created_at: string;
  } | null;
};

type BaseStockResponse = {
  branch_id: number;
  branch_label: string;
  migrated: boolean;
  cutoffs_migrated: boolean;
  total: number;
  page: number;
  limit: number;
  summary: {
    total_active: number;
    configured_count: number;
    unconfigured_count: number;
    zero_count: number;
  };
  rubros: string[];
  suppliers: string[];
  available_branches?: Array<{ branch_id: number; label: string }>;
  rows: BaseStockRow[];
};

const unitsFormatter = new Intl.NumberFormat("es-AR", {
  maximumFractionDigits: 3,
});
const integerFormatter = new Intl.NumberFormat("es-AR", {
  maximumFractionDigits: 0,
});

function branchLabel(branchId: number): string {
  if (branchId === 2) return "Centro";
  if (branchId === 3) return "Jardín";
  if (branchId === 1) return "Depósito";
  return `Sucursal ${branchId}`;
}

function todayIso(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
    now.getDate(),
  ).padStart(2, "0")}`;
}

function formatInput(value: number | null): string {
  if (value === null) return "";
  return String(value);
}

export function BaseStockClient({
  defaultBranchId,
  authorizedBranchIds,
}: {
  defaultBranchId: number;
  authorizedBranchIds: number[];
}) {
  const [branchId, setBranchId] = useState<number>(defaultBranchId);
  const [configState, setConfigState] = useState<ConfigState>("ALL");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [rubro, setRubro] = useState("");
  const [supplier, setSupplier] = useState("");
  const [includeInactive, setIncludeInactive] = useState(false);
  const [page, setPage] = useState(1);
  const limit = 25;

  const [data, setData] = useState<BaseStockResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [draftValues, setDraftValues] = useState<Record<number, string>>({});
  const [savingId, setSavingId] = useState<number | null>(null);
  const [cutoffSavingId, setCutoffSavingId] = useState<number | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearch(search);
      setPage(1);
    }, 260);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    const controller = new AbortController();

    async function fetchRows() {
      await Promise.resolve();
      if (controller.signal.aborted) return;
      setLoading(true);
      setError(null);

      const params = new URLSearchParams({
        branch_id: String(branchId),
        config_state: configState,
        page: String(page),
        limit: String(limit),
      });
      if (debouncedSearch.trim()) params.set("search", debouncedSearch.trim());
      if (rubro) params.set("rubro", rubro);
      if (supplier) params.set("supplier", supplier);
      if (includeInactive) params.set("include_inactive", "true");

      try {
        const response = await fetch(`/api/base-stock?${params.toString()}`, {
          signal: controller.signal,
        });
        const body = (await response.json()) as BaseStockResponse & { message?: string };
        if (!response.ok) {
          throw new Error(body.message ?? "No se pudo cargar el stock base.");
        }
        setData(body);
        setDraftValues({});
      } catch (err) {
        const errorObj = err as Error;
        if (errorObj.name !== "AbortError") {
          setError(errorObj.message);
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    }

    void fetchRows();
    return () => controller.abort();
  }, [branchId, configState, debouncedSearch, rubro, supplier, includeInactive, page, reloadTick]);

  const handleSaveBaseStock = useCallback(
    async (row: BaseStockRow, overrideValue?: number | null) => {
      const rawText =
        overrideValue === undefined
          ? (draftValues[row.article_id] ?? formatInput(row.base_stock)).trim()
          : overrideValue === null
            ? ""
            : String(overrideValue);

      let targetBaseStock: number | null;
      if (overrideValue !== undefined) {
        targetBaseStock = overrideValue;
      } else if (rawText === "") {
        targetBaseStock = null;
      } else {
        const parsed = Number(rawText.replace(",", "."));
        if (!Number.isFinite(parsed) || parsed < 0) {
          setError("Ingresá un número válido mayor o igual a 0 (o dejalo vacío para quitar).");
          return;
        }
        targetBaseStock = parsed;
      }

      setSavingId(row.article_id);
      setError(null);
      setFeedback(null);

      try {
        const response = await fetch("/api/base-stock", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            branch_id: branchId,
            article_id: row.article_id,
            base_stock: targetBaseStock,
          }),
        });
        const body = (await response.json()) as { message?: string };
        if (!response.ok) {
          throw new Error(body.message ?? "No se pudo guardar el stock base.");
        }

        setFeedback(
          targetBaseStock === null
            ? `Se quitó el stock base de #${row.article_id} en ${branchLabel(branchId)}.`
            : `Stock base de #${row.article_id} guardado en ${unitsFormatter.format(targetBaseStock)} u. para ${branchLabel(branchId)}.`,
        );
        setReloadTick((t) => t + 1);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Error al guardar stock base.");
      } finally {
        setSavingId(null);
      }
    },
    [branchId, draftValues],
  );

  const handleResetHistoryCutoff = useCallback(
    async (row: BaseStockRow) => {
      setCutoffSavingId(row.article_id);
      setError(null);
      setFeedback(null);
      try {
        const response = await fetch("/api/history-cutoffs", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            branch_id: branchId,
            article_id: row.article_id,
            cutoff_date: todayIso(),
            previous_description: row.snapshot_mismatch?.previous_description ?? null,
            reason: row.snapshot_mismatch
              ? `Cambio detectado vs pedido #${row.snapshot_mismatch.order_id}`
              : "Reinicio manual de historial desde panel de Stock base",
            detection_source: row.snapshot_mismatch ? "ORDER_SNAPSHOT_DIFF" : "MANUAL",
          }),
        });
        const body = (await response.json()) as { message?: string };
        if (!response.ok) {
          throw new Error(body.message ?? "No se pudo registrar el corte de historial.");
        }
        setFeedback(
          `Historial reiniciado para #${row.article_id} en ${branchLabel(branchId)} desde ${todayIso()}. Las ventas previas no se borran ni se usan en proyecciones futuras.`,
        );
        setReloadTick((t) => t + 1);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Error al guardar corte de historial.");
      } finally {
        setCutoffSavingId(null);
      }
    },
    [branchId],
  );

  const handleClearHistoryCutoff = useCallback(
    async (row: BaseStockRow) => {
      setCutoffSavingId(row.article_id);
      setError(null);
      setFeedback(null);
      try {
        const params = new URLSearchParams({
          branch_id: String(branchId),
          article_id: String(row.article_id),
        });
        const response = await fetch(`/api/history-cutoffs?${params.toString()}`, {
          method: "DELETE",
        });
        const body = (await response.json()) as { message?: string };
        if (!response.ok) {
          throw new Error(body.message ?? "No se pudo quitar el corte de historial.");
        }
        setFeedback(
          `Se restauró el historial completo para #${row.article_id} en ${branchLabel(branchId)}.`,
        );
        setReloadTick((t) => t + 1);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Error al restaurar historial.");
      } finally {
        setCutoffSavingId(null);
      }
    },
    [branchId],
  );

  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / limit));
  const summary = data?.summary ?? {
    total_active: 0,
    configured_count: 0,
    unconfigured_count: 0,
    zero_count: 0,
  };
  const branchesToShow = data?.available_branches?.length
    ? data.available_branches
    : authorizedBranchIds.map((id) => ({ branch_id: id, label: branchLabel(id) }));

  return (
    <main className="orders-shell replenishment-review-shell">
      <header className="orders-topbar">
        <Link className="brand" href="/dashboard">
          <span>
            LA CASA DEL KIOSKERO
            <span className="brand-sub">Stock base por sucursal</span>
          </span>
        </Link>
        <OperationsNavigation role="PV" branchId={branchId} />
      </header>

      <section className="review-heading">
        <div>
          <Link className="back-link" href="/replenishment">
            ← Volver a Reposición semanal
          </Link>
          <h1>Stock base de exhibición</h1>
          <p>
            Definí el stock mínimo que querés mantener visible en góndola por artículo y
            sucursal. Complementa las estadísticas de venta usando siempre el mayor valor
            entre demanda proyectada y stock base.
          </p>
        </div>

        <aside className="review-method">
          <strong>Fórmula combinada</strong>
          <span>Objetivo = máx(Demanda 10 días, Stock base)</span>
          <span>Sugerido = máx(0, Objetivo − (Actual + Pendiente))</span>
        </aside>
      </section>

      <section className="base-stock-branch-bar" aria-label="Selector de sucursal">
        <div className="base-stock-branch-tabs">
          <span className="base-stock-branch-label">Sucursal activa:</span>
          {branchesToShow.map((branch) => (
            <button
              key={branch.branch_id}
              type="button"
              className={`base-stock-branch-btn ${
                branch.branch_id === branchId ? "is-selected" : ""
              }`}
              onClick={() => {
                setBranchId(branch.branch_id);
                setPage(1);
                setFeedback(null);
                setError(null);
              }}
            >
              {branch.label}
            </button>
          ))}
        </div>
        <span className="base-stock-branch-hint">
          Cada sucursal guarda su propia configuración de stock base (cambiar{" "}
          {branchLabel(branchId)} no modifica la otra sucursal).
        </span>
      </section>

      {data && !data.migrated && (
        <div className="auth-alert-banner" role="status">
          <div className="auth-alert-message">
            <strong>Base de datos pendiente de migración (018_branch_product_base_stock)</strong>
            <span>
              Estás visualizando el catálogo actual y el valor de referencia del ERP. Para guardar
              cambios de Stock base en esta base, primero ejecutá las migraciones 018 y 019 en el
              entorno correspondiente.
            </span>
          </div>
        </div>
      )}

      <div className="review-summary" role="group" aria-label="Resumen de configuración">
        <button
          type="button"
          className={configState === "ALL" ? "is-active" : undefined}
          onClick={() => {
            setConfigState("ALL");
            setPage(1);
          }}
        >
          Todos ({integerFormatter.format(summary.total_active)})
        </button>
        <button
          type="button"
          className={configState === "CONFIGURED" ? "is-active" : undefined}
          onClick={() => {
            setConfigState("CONFIGURED");
            setPage(1);
          }}
        >
          Configurados ({integerFormatter.format(summary.configured_count)})
        </button>
        <button
          type="button"
          className={configState === "UNCONFIGURED" ? "is-active" : undefined}
          onClick={() => {
            setConfigState("UNCONFIGURED");
            setPage(1);
          }}
        >
          Sin configurar ({integerFormatter.format(summary.unconfigured_count)})
        </button>
        <button
          type="button"
          className={configState === "ZERO" ? "is-active" : undefined}
          onClick={() => {
            setConfigState("ZERO");
            setPage(1);
          }}
        >
          En 0 ({integerFormatter.format(summary.zero_count)})
        </button>
      </div>

      <section className="base-stock-toolbar" aria-label="Filtros de productos">
        <label className="base-stock-search">
          Buscar por nombre, código o marca
          <input
            type="search"
            placeholder="Ej: Chocolate, 522, Arcor, Beldent..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>

        <label>
          Rubro / Categoría
          <select
            value={rubro}
            onChange={(e) => {
              setRubro(e.target.value);
              setPage(1);
            }}
          >
            <option value="">Todos los rubros</option>
            <option value="__SIN_RUBRO__">Sin rubro</option>
            {(data?.rubros ?? []).map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>

        <label>
          Proveedor
          <select
            value={supplier}
            onChange={(e) => {
              setSupplier(e.target.value);
              setPage(1);
            }}
          >
            <option value="">Todos los proveedores</option>
            {(data?.suppliers ?? []).map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>

        <label className="base-stock-toggle">
          <span>Catálogo</span>
          <span className="base-stock-checkbox-row">
            <input
              type="checkbox"
              checked={includeInactive}
              onChange={(e) => {
                setIncludeInactive(e.target.checked);
                setPage(1);
              }}
            />
            Mostrar inactivos
          </span>
        </label>
      </section>

      {error && (
        <div className="orders-error" role="alert">
          <strong>No pudimos completar la acción</strong>
          <span>{error}</span>
        </div>
      )}

      {feedback && (
        <div className="replenishment-draft-notice" role="status">
          <span>
            <strong>Actualizado:</strong> {feedback}
          </span>
          <button
            type="button"
            className="order-text-button"
            onClick={() => setFeedback(null)}
          >
            Cerrar
          </button>
        </div>
      )}

      <section className="orders-table-panel">
        {loading ? (
          <div className="orders-loading" style={{ padding: "1rem" }}>
            <div className="skeleton" />
            <div className="skeleton" />
            <div className="skeleton" />
          </div>
        ) : !data?.rows.length ? (
          <p className="orders-empty">
            No encontramos artículos para los filtros seleccionados en {branchLabel(branchId)}.
          </p>
        ) : (
          <div className="orders-table-wrap">
            <table className="base-stock-table">
              <thead>
                <tr>
                  <th>Producto</th>
                  <th>Rubro / Prov.</th>
                  <th>Stock actual</th>
                  <th>Stock depósito</th>
                  <th>Ref. ERP (Stopti)</th>
                  <th>Stock base ({branchLabel(branchId)})</th>
                  <th>Estado e historial</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row) => {
                  const currentInput =
                    draftValues[row.article_id] ?? formatInput(row.base_stock);
                  const committedText = formatInput(row.base_stock);
                  const isDirty = currentInput.trim() !== committedText;
                  const isBusy = savingId === row.article_id;
                  const isCutoffBusy = cutoffSavingId === row.article_id;

                  return (
                    <tr key={row.article_id}>
                      <td data-label="Producto">
                        <strong title={row.description ?? undefined}>
                          {row.description ?? `Artículo #${row.article_id}`}
                        </strong>
                        <small>
                          Cód. #{row.article_id}
                          {row.brand ? ` · ${row.brand}` : ""}
                          {row.unit_measure ? ` · ${row.unit_measure}` : ""}
                          {!row.is_active ? " · INACTIVO" : ""}
                        </small>
                      </td>

                      <td data-label="Rubro / Prov.">
                        <span className="rubro-tag">{row.rubro}</span>
                        <small>
                          {row.supplier_code ? `Prov. ${row.supplier_code}` : "Sin proveedor"}
                        </small>
                      </td>

                      <td
                        data-label="Stock actual"
                        className={row.current_stock < 0 ? "negative-number" : undefined}
                      >
                        {unitsFormatter.format(row.current_stock)}
                      </td>

                      <td data-label="Stock depósito">
                        {row.depot_stock === null ? (
                          <span className="base-stock-muted">Sin registro</span>
                        ) : (
                          unitsFormatter.format(row.depot_stock)
                        )}
                      </td>

                      <td data-label="Ref. ERP (Stopti)">
                        {row.erp_stopti !== null && row.erp_stopti > 0 ? (
                          <div className="base-stock-stopti-cell">
                            <span>{unitsFormatter.format(row.erp_stopti)}</span>
                            <button
                              type="button"
                              className="base-stock-link-btn"
                              disabled={isBusy || !data.migrated}
                              onClick={() => handleSaveBaseStock(row, row.erp_stopti)}
                              title="Copiar valor de referencia Stopti del ERP a Stock base"
                            >
                              Usar valor
                            </button>
                          </div>
                        ) : (
                          <span className="base-stock-muted">—</span>
                        )}
                      </td>

                      <td data-label="Stock base">
                        <div className="base-stock-editor">
                          <input
                            type="number"
                            min={0}
                            step="any"
                            aria-label={`Stock base para artículo ${row.article_id}`}
                            placeholder="Sin config."
                            className={`quantity-input ${isDirty ? "is-edited" : ""}`}
                            value={currentInput}
                            disabled={isBusy || !data.migrated}
                            onChange={(e) => {
                              const next = e.target.value;
                              setDraftValues((prev) => ({
                                ...prev,
                                [row.article_id]: next,
                              }));
                            }}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" && !isBusy && data.migrated) {
                                void handleSaveBaseStock(row);
                              }
                            }}
                          />
                          <button
                            type="button"
                            className="order-primary base-stock-save-btn"
                            disabled={isBusy || !isDirty || !data.migrated}
                            onClick={() => void handleSaveBaseStock(row)}
                          >
                            {isBusy ? "Guardando..." : "Guardar"}
                          </button>
                          {row.is_configured && (
                            <button
                              type="button"
                              className="base-stock-link-btn"
                              disabled={isBusy || !data.migrated}
                              onClick={() => void handleSaveBaseStock(row, null)}
                              title="Quitar configuración y volver a usar solo demanda estadística"
                            >
                              Quitar
                            </button>
                          )}
                        </div>
                      </td>

                      <td data-label="Estado e historial">
                        <div className="base-stock-status-stack">
                          {row.is_configured ? (
                            <span
                              className={`base-stock-badge ${
                                row.base_stock === 0 ? "is-zero" : "is-configured"
                              }`}
                            >
                              {row.base_stock === 0
                                ? "En 0 explícito"
                                : `Base: ${unitsFormatter.format(row.base_stock ?? 0)}`}
                            </span>
                          ) : (
                            <span className="base-stock-badge is-unconfigured">
                              Sin configurar
                            </span>
                          )}

                          {row.history_cutoff_date && (
                            <div className="base-stock-cutoff-pill">
                              <span>Historial desde {row.history_cutoff_date}</span>
                              {data.cutoffs_migrated && (
                                <button
                                  type="button"
                                  className="base-stock-link-btn"
                                  disabled={isCutoffBusy}
                                  onClick={() => void handleClearHistoryCutoff(row)}
                                >
                                  Restaurar
                                </button>
                              )}
                            </div>
                          )}

                          {row.snapshot_mismatch && !row.history_cutoff_date && (
                            <div className="base-stock-mismatch-alert">
                              <span>
                                Cambio de descripción vs pedido #
                                {row.snapshot_mismatch.order_id} (
                                {row.snapshot_mismatch.previous_description})
                              </span>
                              {data.cutoffs_migrated && (
                                <button
                                  type="button"
                                  className="base-stock-link-btn"
                                  disabled={isCutoffBusy}
                                  onClick={() => void handleResetHistoryCutoff(row)}
                                >
                                  Reiniciar historial
                                </button>
                              )}
                            </div>
                          )}

                          {!row.snapshot_mismatch && !row.history_cutoff_date && (
                            <button
                              type="button"
                              className="base-stock-link-btn base-stock-muted-btn"
                              disabled={isCutoffBusy || !data.cutoffs_migrated}
                              onClick={() => void handleResetHistoryCutoff(row)}
                              title="Marcar si este código fue reutilizado para otro producto y querés ignorar ventas viejas"
                            >
                              Reiniciar historial
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="orders-pagination">
          <span>
            Mostrando {data?.rows.length ?? 0} de {integerFormatter.format(data?.total ?? 0)}{" "}
            artículos · Página {page} de {totalPages}
          </span>
          <div className="pagination-controls">
            <button
              type="button"
              disabled={page <= 1 || loading}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Anterior
            </button>
            <span className="page-ellipsis">
              {page} / {totalPages}
            </span>
            <button
              type="button"
              disabled={page >= totalPages || loading}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            >
              Siguiente
            </button>
          </div>
        </div>
      </section>
    </main>
  );
}

