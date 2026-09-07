"use client";

import Link from "next/link";
import { useEffect, useEffectEvent, useState } from "react";

type Mode = "UNDEFINED" | "DEPOT" | "DIRECT_SUPPLIER";
type Evidence = "POSSIBLE_DEPOT" | "POSSIBLE_DIRECT_SUPPLIER" | "NO_EVIDENCE";
type Row = {
  article_id: number;
  description: string | null;
  brand: string | null;
  supply_mode: Mode;
  historical_documents: number;
  depot_stock: number | null;
  reviewed: boolean;
  evidence: Evidence;
};
type Data = {
  rows: Row[];
  total: number;
  counts: Record<Mode, number>;
  evidence_counts: Record<Evidence, number>;
  page: number;
  limit: number;
};
const labels: Record<Mode, string> = {
  UNDEFINED: "SIN DEFINIR",
  DEPOT: "DEPÓSITO",
  DIRECT_SUPPLIER: "PROVEEDOR DIRECTO",
};
const evidenceLabels: Record<Evidence, string> = {
  POSSIBLE_DEPOT: "POSIBLE DEPÓSITO",
  POSSIBLE_DIRECT_SUPPLIER: "POSIBLE PROVEEDOR DIRECTO",
  NO_EVIDENCE: "SIN EVIDENCIA",
};

export function SupplyRulesClient({ branches }: { branches: number[] }) {
  const [branchId, setBranchId] = useState(branches[0]);
  const [search, setSearch] = useState("");
  const [mode, setMode] = useState<Mode | "">("");
  const [evidence, setEvidence] = useState<Evidence | "">("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<number | null>(null);
  const load = useEffectEvent(async () => {
    const params = new URLSearchParams({
      branch_id: String(branchId),
      page: String(page),
      limit: "25",
    });
    if (search) params.set("search", search);
    if (mode) params.set("supply_mode", mode);
    if (evidence) params.set("evidence", evidence);
    const response = await fetch(`/api/supply-rules?${params}`);
    const result = await response.json();
    if (!response.ok)
      throw new Error(result.error || "No pudimos cargar las reglas.");
    setData(result);
  });
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load()
        .then(() => setError(null))
        .catch((cause) => setError((cause as Error).message));
    }, 180);
    return () => window.clearTimeout(timer);
  }, [branchId, search, mode, evidence, page]);
  const save = async (row: Row, next: Mode) => {
    setSaving(row.article_id);
    try {
      const response = await fetch("/api/supply-rules", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          branch_id: branchId,
          article_id: row.article_id,
          supply_mode: next,
        }),
      });
      const result = (await response.json()) as {
        supply_mode: Mode;
        error?: string;
      };
      if (!response.ok)
        throw new Error(result.error || "No pudimos guardar la ruta.");
      setData((current) =>
        current
          ? {
              ...current,
              rows: current.rows.map((item) =>
                item.article_id === row.article_id
                  ? { ...item, supply_mode: result.supply_mode, reviewed: true }
                  : item,
              ),
              counts: {
                ...(row.supply_mode === result.supply_mode
                  ? current.counts
                  : {
                      ...current.counts,
                      [row.supply_mode]: current.counts[row.supply_mode] - 1,
                      [result.supply_mode]: current.counts[result.supply_mode] + 1,
                    }),
              },
              evidence_counts:
                !row.reviewed && row.evidence !== "NO_EVIDENCE"
                  ? {
                      ...current.evidence_counts,
                      [row.evidence]: current.evidence_counts[row.evidence] - 1,
                    }
                  : current.evidence_counts,
            }
          : current,
      );
      setError(null);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setSaving(null);
    }
  };
  return (
    <main className="orders-shell">
      <header className="orders-topbar">
        <Link className="brand" href="/dashboard">
          <span className="brand-mark">M</span>
          <span>
            MONICA<span className="brand-sub">Panel de operación</span>
          </span>
        </Link>
        <nav>
          <Link href="/dashboard">Resumen</Link>
          <Link href="/replenishment">Validación</Link>
          <Link className="active" href="/supply-rules">
            Abastecimiento
          </Link>
          <Link href="/orders">Pedidos</Link>
        </nav>
        <div className="branch">
          <span className="status-dot" />
          Reglas operativas
        </div>
      </header>
      <section className="orders-intro">
        <div>
          <p className="page-context">Configuración</p>
          <h1>Abastecimiento por producto</h1>
          <p>
            Definí la ruta de cada artículo para el punto de venta autorizado.
          </p>
        </div>
      </section>
      {data && (
        <section className="review-summary" aria-label="Revisión sugerida">
          <div className="supply-review-heading">
            <strong>Revisión sugerida</strong>
            <span>Son candidatos históricos: la ruta solo cambia cuando la confirmás.</span>
          </div>
          {(
            ["POSSIBLE_DEPOT", "POSSIBLE_DIRECT_SUPPLIER", "NO_EVIDENCE"] as Evidence[]
          ).map((value) => (
            <button
              key={value}
              className={evidence === value ? "is-active" : ""}
              onClick={() => {
                setEvidence(evidence === value ? "" : value);
                setPage(1);
              }}
            >
              {evidenceLabels[value]} ({data.evidence_counts[value]})
            </button>
          ))}
        </section>
      )}
      <section className="orders-controls">
        <label className="filter-select">
          <span>Punto de venta</span>
          <select
            value={branchId}
            onChange={(event) => {
              setBranchId(Number(event.target.value));
              setPage(1);
            }}
          >
            {branches.map((branch) => (
              <option key={branch} value={branch}>
                PV{branch}
              </option>
            ))}
          </select>
        </label>
        <label className="search">
          <span>Buscar</span>
          <input
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
            placeholder="Artículo, descripción o marca"
          />
        </label>
        <label className="filter-select">
          <span>Abastecimiento</span>
          <select
            value={mode}
            onChange={(event) => {
              setMode(event.target.value as Mode | "");
              setPage(1);
            }}
          >
            <option value="">Todos</option>
            {(Object.keys(labels) as Mode[]).map((value) => (
              <option key={value} value={value}>
                {labels[value]}
              </option>
            ))}
          </select>
        </label>
      </section>
      {data && (
        <section className="review-summary">
          {(
            ["", "DEPOT", "DIRECT_SUPPLIER", "UNDEFINED"] as Array<Mode | "">
          ).map((value) => (
            <button
              key={value || "all"}
              className={mode === value ? "is-active" : ""}
              onClick={() => {
                setMode(value);
                setPage(1);
              }}
            >
              {value
                ? `${labels[value]} (${data.counts[value]})`
                : `Todos (${data.counts.DEPOT + data.counts.DIRECT_SUPPLIER + data.counts.UNDEFINED})`}
            </button>
          ))}
        </section>
      )}
      {error && <section className="orders-error">{error}</section>}
      <section className="orders-table-panel">
        <div className="orders-table-wrap">
          <table className="orders-table">
            <thead>
              <tr>
                <th>Producto</th>
                <th>Artículo</th>
                <th>Marca</th>
                <th>Historial</th>
                <th>Stock depósito</th>
                <th>Revisión sugerida</th>
                <th>Abastecimiento</th>
              </tr>
            </thead>
            <tbody>
              {data?.rows.map((row) => (
                <tr key={row.article_id}>
                  <td data-label="Producto">
                    <strong>
                      {row.description || `Artículo ${row.article_id}`}
                    </strong>
                  </td>
                  <td data-label="Artículo">#{row.article_id}</td>
                  <td data-label="Marca">{row.brand || "-"}</td>
                  <td data-label="Entradas históricas">{row.historical_documents}</td>
                  <td data-label="Stock depósito">
                    {row.depot_stock === null ? "Sin fila" : row.depot_stock}
                  </td>
                  <td data-label="Revisión sugerida">
                    {row.reviewed ? (
                      <small>Decisión guardada</small>
                    ) : (
                      <span className="suggestion-status manual_review">
                        {evidenceLabels[row.evidence]}
                      </span>
                    )}
                    {!row.reviewed && row.evidence !== "NO_EVIDENCE" && (
                      <small>Confianza media</small>
                    )}
                  </td>
                  <td data-label="Abastecimiento">
                    <select
                      disabled={saving === row.article_id}
                      value={row.supply_mode}
                      onChange={(event) =>
                        void save(row, event.target.value as Mode)
                      }
                    >
                      {(Object.keys(labels) as Mode[]).map((value) => (
                        <option key={value} value={value}>
                          {labels[value]}
                        </option>
                      ))}
                    </select>
                    {saving === row.article_id && <small>Guardando...</small>}
                    {!row.reviewed && row.supply_mode === "UNDEFINED" && (
                      <button
                        type="button"
                        disabled={saving === row.article_id}
                        onClick={() => void save(row, "UNDEFINED")}
                      >
                        Marcar revisado
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {data && !data.rows.length && (
          <p className="orders-empty">No hay productos para este filtro.</p>
        )}
        {data && (
          <div className="orders-pagination">
            <span>{data.total} productos</span>
            <div className="pagination-controls">
              <button disabled={page === 1} onClick={() => setPage(page - 1)}>
                Anterior
              </button>
              <span>Página {page}</span>
              <button
                disabled={page * data.limit >= data.total}
                onClick={() => setPage(page + 1)}
              >
                Siguiente
              </button>
            </div>
          </div>
        )}
      </section>
    </main>
  );
}
