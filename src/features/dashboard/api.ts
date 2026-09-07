import type { Attention, DataHealth, Overview, Product, StockResponse, TimeseriesPoint } from "./types";

function scopeParams() { return new URLSearchParams(); }

async function fetchApi<T>(path: string, params: URLSearchParams, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${path}?${params.toString()}`, { signal, cache: "no-store" });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error ?? `La consulta no pudo completarse (${response.status}).`);
  }
  return response.json() as Promise<T>;
}

function periodParams(from: string, to: string) {
  const params = scopeParams(); params.set("from", from); params.set("to", to); return params;
}

export const dashboardApi = {
  overview: (from: string, to: string, signal?: AbortSignal) => fetchApi<Overview>("/api/dashboard/overview", periodParams(from, to), signal),
  timeseries: (from: string, to: string, granularity: string, signal?: AbortSignal) => { const params = periodParams(from, to); params.set("granularity", granularity); return fetchApi<TimeseriesPoint[]>("/api/dashboard/timeseries", params, signal); },
  topProducts: (from: string, to: string, signal?: AbortSignal) => { const params = periodParams(from, to); params.set("limit", "8"); return fetchApi<Product[]>("/api/dashboard/products/top", params, signal); },
  stock: (page: number, search: string, depo: string, signal?: AbortSignal) => { const params = scopeParams(); params.set("page", String(page)); params.set("limit", "25"); if (search) params.set("search", search); if (depo) params.set("depo", depo); return fetchApi<StockResponse>("/api/dashboard/stock", params, signal); },
  attention: (from: string, to: string, signal?: AbortSignal) => fetchApi<Attention>("/api/dashboard/attention", periodParams(from, to), signal),
  health: (signal?: AbortSignal) => fetchApi<DataHealth>("/api/dashboard/data-health", scopeParams(), signal),
};
