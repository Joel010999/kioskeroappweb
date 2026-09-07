"use client";
/* eslint-disable @next/next/no-html-link-for-pages */

import { useEffect, useState } from "react";
import { dashboardApi } from "./api";
import type { Attention, AttentionNoMovementItem, AttentionStockItem, DataHealth, Overview, Period, Product, StockResponse, TimeseriesPoint } from "./types";

type Granularity = "day" | "week" | "month";
type Resource<T> = { data: T | null; error: string | null; loading: boolean };

const initial = <T,>(): Resource<T> => ({ data: null, error: null, loading: true });
const number = new Intl.NumberFormat("es-AR", { maximumFractionDigits: 2 });
const units = new Intl.NumberFormat("es-AR", { maximumFractionDigits: 3 });
const dateTime = new Intl.DateTimeFormat("es-AR", { dateStyle: "medium", timeStyle: "short" });

function iso(date: Date) {
  // Date filters represent the operator's local calendar day, not a UTC timestamp.
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function today() { return new Date(); }
function addDays(date: Date, days: number) { const copy = new Date(date); copy.setDate(copy.getDate() + days); return copy; }
function monthStart(date: Date) { return new Date(date.getFullYear(), date.getMonth(), 1); }
function monthEnd(date: Date) { return new Date(date.getFullYear(), date.getMonth() + 1, 0); }

function periodFor(key: string): Period {
  const now = today();
  switch (key) {
    case "today": return { from: iso(now), to: iso(now), label: "Hoy" };
    case "yesterday": { const day = addDays(now, -1); return { from: iso(day), to: iso(day), label: "Ayer" }; }
    case "week": return { from: iso(addDays(now, -6)), to: iso(now), label: "Últimos 7 días" };
    case "month": return { from: iso(addDays(now, -29)), to: iso(now), label: "Últimos 30 días" };
    case "current-month": return { from: iso(monthStart(now)), to: iso(monthEnd(now)), label: "Mes actual" };
    case "previous-month": { const prior = new Date(now.getFullYear(), now.getMonth() - 1, 1); return { from: iso(prior), to: iso(monthEnd(prior)), label: "Mes anterior" }; }
    case "year": return { from: `${now.getFullYear()}-01-01`, to: iso(now), label: "Año actual" };
    default: return { from: iso(addDays(now, -29)), to: iso(now), label: "Últimos 30 días" };
  }
}

function Icon({ name, size = 18 }: { name: "refresh" | "calendar" | "trend" | "box" | "pulse" | "search" | "arrow" | "attention"; size?: number }) {
  const paths = {
    refresh: <><path d="M20 11a8 8 0 1 0 2.1 5.4" /><path d="M20 4v7h-7" /></>,
    calendar: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M16 3v4M8 3v4M3 10h18" /></>,
    trend: <><path d="m3 17 6-6 4 4 8-9" /><path d="M16 6h5v5" /></>,
    box: <><path d="m3 7 9-4 9 4-9 4-9-4Z" /><path d="m3 7 9 4 9-4M12 11v10" /></>,
    pulse: <path d="M3 12h4l2-6 4 12 2-6h6" />,
    search: <><circle cx="11" cy="11" r="6" /><path d="m20 20-4.2-4.2" /></>,
    arrow: <path d="m9 18 6-6-6-6" />,
    attention: <><path d="M12 3 2.8 20h18.4L12 3Z" /><path d="M12 9v4M12 17h.01" /></>,
  };
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

function Retry({ onClick }: { onClick: () => void }) { return <button className="retry" onClick={onClick}>Reintentar <Icon name="refresh" size={14} /></button>; }

function Metric({ label, value, note, icon, loading, featured = false }: { label: string; value: string; note: string; icon: Parameters<typeof Icon>[0]["name"]; loading: boolean; featured?: boolean }) {
  return <article className={`metric ${featured ? "metric-featured" : ""}`}>
    <div className="metric-top"><span>{label}</span><span className="metric-icon"><Icon name={icon} size={16} /></span></div>
    {loading ? <div className="skeleton metric-skeleton" /> : <strong>{value}</strong>}
    <small>{note}</small>
  </article>;
}

function TrendChart({ points, granularity }: { points: TimeseriesPoint[]; granularity: Granularity }) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  if (!points.length) return <div className="empty chart-empty">No hay datos para este período.</div>;
  const width = 740; const height = 250; const pad = 24;
  const values = points.map((point) => point.net_units); const min = Math.min(0, ...values); const max = Math.max(0, ...values); const range = max - min || 1;
  const xy = points.map((point, index) => ({ x: pad + (index * (width - pad * 2)) / Math.max(points.length - 1, 1), y: pad + (max - point.net_units) * (height - pad * 2) / range }));
  const path = xy.map((point, index) => `${index ? "L" : "M"}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
  const area = `${path} L${xy.at(-1)?.x ?? pad},${height - pad} L${xy[0]?.x ?? pad},${height - pad} Z`;
  const zeroY = pad + (max * (height - pad * 2)) / range;
  const active = activeIndex === null ? null : points[activeIndex];
  return <div className="chart-wrap"><div className="chart-reading" aria-live="polite"><span>{active ? active.date : `Agrupado por ${granularity === "day" ? "día" : granularity === "week" ? "semana" : "mes"}`}</span><strong>{active ? `${units.format(active.net_units)} unidades` : `${units.format(points.reduce((total, point) => total + point.net_units, 0))} unidades netas`}</strong><small>{active ? `${number.format(active.movements)} movimientos` : "Pasá sobre un punto para inspeccionarlo"}</small></div><svg className="chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Evolución de unidades netas por ${granularity === "day" ? "día" : granularity === "week" ? "semana" : "mes"}`} onMouseLeave={() => setActiveIndex(null)}>
    <defs><linearGradient id="chart-fill" x1="0" x2="0" y1="0" y2="1"><stop stopColor="#8ee3cf" stopOpacity=".28" /><stop offset="1" stopColor="#8ee3cf" stopOpacity="0" /></linearGradient></defs>
    <line x1={pad} x2={width - pad} y1={zeroY} y2={zeroY} className="chart-zero" />
    <path d={area} fill="url(#chart-fill)" /><path d={path} className="chart-line" />
    {xy.map((point, index) => <circle key={points[index].date} cx={point.x} cy={point.y} r={activeIndex === index ? "5" : "3"} className={`chart-dot ${activeIndex === index ? "active" : ""}`} tabIndex={0} onMouseEnter={() => setActiveIndex(index)} onFocus={() => setActiveIndex(index)} onBlur={() => setActiveIndex(null)}><title>{`${points[index].date}: ${units.format(points[index].net_units)} unidades`}</title></circle>)}
  </svg><div className="chart-labels"><span>{points[0].date}</span><span>{points.at(-1)?.date}</span></div></div>;
}

export function DashboardClient({ branchName }: { branchName: string }) {
  const dashboardScope = { branchName };
  const [period, setPeriod] = useState<Period>(() => periodFor("month"));
  const [granularity, setGranularity] = useState<Granularity>("day");
  const [overview, setOverview] = useState<Resource<Overview>>(initial);
  const [series, setSeries] = useState<Resource<TimeseriesPoint[]>>(initial);
  const [products, setProducts] = useState<Resource<Product[]>>(initial);
  const [health, setHealth] = useState<Resource<DataHealth>>(initial);
  const [attention, setAttention] = useState<Resource<Attention>>(initial);
  const [stock, setStock] = useState<Resource<StockResponse>>(initial);
  const [refreshKey, setRefreshKey] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [productSearch, setProductSearch] = useState(""); const [stockSearch, setStockSearch] = useState(""); const [depo, setDepo] = useState(""); const [page, setPage] = useState(1);

  useEffect(() => {
    const controller = new AbortController();
    const overviewRequest = dashboardApi.overview(period.from, period.to, controller.signal);
    const seriesRequest = dashboardApi.timeseries(period.from, period.to, granularity, controller.signal);
    const productsRequest = dashboardApi.topProducts(period.from, period.to, controller.signal);
    const healthRequest = dashboardApi.health(controller.signal);
    const attentionRequest = dashboardApi.attention(period.from, period.to, controller.signal);
    overviewRequest.then((data) => setOverview({ data, error: null, loading: false })).catch((error: Error) => { if (error.name !== "AbortError") setOverview({ data: null, error: error.message, loading: false }); });
    seriesRequest.then((data) => setSeries({ data, error: null, loading: false })).catch((error: Error) => { if (error.name !== "AbortError") setSeries({ data: null, error: error.message, loading: false }); });
    productsRequest.then((data) => setProducts({ data, error: null, loading: false })).catch((error: Error) => { if (error.name !== "AbortError") setProducts({ data: null, error: error.message, loading: false }); });
    healthRequest.then((data) => setHealth({ data, error: null, loading: false })).catch((error: Error) => { if (error.name !== "AbortError") setHealth({ data: null, error: error.message, loading: false }); });
    attentionRequest.then((data) => setAttention({ data, error: null, loading: false })).catch((error: Error) => { if (error.name !== "AbortError") setAttention({ data: null, error: error.message, loading: false }); });
    Promise.allSettled([overviewRequest, seriesRequest, productsRequest, healthRequest, attentionRequest]).then(() => setIsRefreshing(false));
    return () => controller.abort();
  }, [period.from, period.to, granularity, refreshKey]);

  useEffect(() => { const controller = new AbortController(); const timer = window.setTimeout(() => dashboardApi.stock(page, stockSearch, depo, controller.signal).then((data) => setStock({ data, error: null, loading: false })).catch((error: Error) => { if (error.name !== "AbortError") setStock({ data: null, error: error.message, loading: false }); }), 250); return () => { controller.abort(); window.clearTimeout(timer); }; }, [page, stockSearch, depo, refreshKey]);

  const applyPreset = (key: string) => { if (key !== "custom") setPeriod(periodFor(key)); };
  const refresh = () => { setIsRefreshing(true); setRefreshKey((value) => value + 1); };
  const activeOverview = overview.data;
  const periodIsEmpty = Boolean(activeOverview && activeOverview.movements === 0);
  const reviewStock = () => { setStockSearch(""); setPage(1); document.getElementById("stock")?.scrollIntoView({ behavior: "smooth", block: "start" }); };

  return <main className="dashboard-shell">
    <header className="topbar"><a className="brand" href="/dashboard" aria-label="Dashboard de Mónica"><span className="brand-mark">M</span><span>MONICA<span className="brand-sub">Panel de operación</span></span></a><nav aria-label="Secciones"><a className="active" href="#overview">Resumen</a><a href="#evolucion">Evolución</a><a href="#productos">Productos</a><a href="#stock">Stock</a><a href="/orders/suggestions">Sugerencias</a></nav><div className="branch"><span className="status-dot" />{dashboardScope.branchName}</div><button className={`refresh ${isRefreshing ? "is-refreshing" : ""}`} onClick={refresh} disabled={isRefreshing} aria-label="Actualizar datos" aria-live="polite"><Icon name="refresh" /> <span>{isRefreshing ? "Actualizando" : "Actualizar"}</span></button></header>

    <section className="period-bar" aria-label="Selector de período"><div><p className="page-context">Dashboard de Mónica · {dashboardScope.branchName}</p><h1>Estado de la operación</h1><p>Ventas, disponibilidad y datos de una misma jornada de decisión.</p>{activeOverview?.last_updated_at && <span className="last-updated">Actualizado {dateTime.format(new Date(activeOverview.last_updated_at))}</span>}</div><div className="period-controls"><label className="select-wrap"><Icon name="calendar" size={16} /><span className="sr-only">Período rápido</span><select value={period.label} onChange={(event) => applyPreset(Object.entries({ today: "Hoy", yesterday: "Ayer", week: "Últimos 7 días", month: "Últimos 30 días", "current-month": "Mes actual", "previous-month": "Mes anterior", year: "Año actual", custom: "Personalizado" }).find(([, value]) => value === event.target.value)?.[0] ?? "custom")}><option>Hoy</option><option>Ayer</option><option>Últimos 7 días</option><option>Últimos 30 días</option><option>Mes actual</option><option>Mes anterior</option><option>Año actual</option><option>Personalizado</option></select></label><div className="date-pair"><label className="date-input"><span>Desde</span><input type="date" value={period.from} onChange={(event) => setPeriod((current) => ({ ...current, from: event.target.value, to: event.target.value > current.to ? event.target.value : current.to, label: "Personalizado" }))} /></label><span>→</span><label className="date-input"><span>Hasta</span><input type="date" value={period.to} min={period.from} onChange={(event) => setPeriod((current) => ({ ...current, to: event.target.value < current.from ? current.from : event.target.value, label: "Personalizado" }))} /></label></div></div></section>

    <section id="overview" className="signal-grid" aria-label="Indicadores principales">
      <Metric featured label="Unidades netas" value={activeOverview ? periodIsEmpty ? "—" : units.format(activeOverview.net_units) : ""} note={periodIsEmpty ? "No hay movimientos en este período" : `${period.label} · VT suma, IN resta`} icon="trend" loading={overview.loading} />
      <Metric label="Movimientos" value={activeOverview ? periodIsEmpty ? "—" : number.format(activeOverview.movements) : ""} note={periodIsEmpty ? "Sin actividad registrada" : "actividad registrada"} icon="pulse" loading={overview.loading} />
      <Metric label="Variación" value={periodIsEmpty ? "—" : activeOverview?.variation_vs_previous_percent === null ? "Sin base previa" : activeOverview ? `${activeOverview.variation_vs_previous_percent >= 0 ? "↑ " : "↓ "}${number.format(Math.abs(activeOverview.variation_vs_previous_percent))}%` : ""} note={periodIsEmpty ? "Elegí otro período para comparar" : "vs. período anterior equivalente"} icon="trend" loading={overview.loading} />
      <Metric label="Stock total" value={activeOverview ? units.format(activeOverview.stock_total) : ""} note="saldo actual" icon="box" loading={overview.loading} />
      <Metric label="Productos activos" value={activeOverview ? number.format(activeOverview.active_products) : ""} note="catálogo vigente" icon="pulse" loading={overview.loading} />
      <Metric label="Sin stock" value={activeOverview ? number.format(activeOverview.products_without_stock) : ""} note="saldo igual o menor a cero" icon="box" loading={overview.loading} />
    </section>
    {periodIsEmpty && <p className="period-empty-notice" role="status">No hay datos de movimientos para el período seleccionado. El stock mostrado corresponde al último snapshot disponible.</p>}
    {overview.error && <section className="error-banner"><strong>No pudimos cargar los indicadores.</strong><span>{overview.error}</span><Retry onClick={refresh} /></section>}

    <section className="attention-panel" aria-labelledby="attention-title">
      <div className="attention-head"><div><h2 id="attention-title">Atención operativa</h2><p>Situaciones observables para revisar en {period.label.toLowerCase()}.</p></div><Icon name="attention" size={19} /></div>
      {attention.loading ? <div className="attention-skeletons"><div className="skeleton" /><div className="skeleton" /><div className="skeleton" /></div> : attention.error ? <div className="error-state"><p>No pudimos cargar las situaciones operativas.</p><Retry onClick={refresh} /></div> : attention.data && <AttentionList attention={attention.data} onReviewStock={reviewStock} />}
    </section>

    <section id="evolucion" className="content-grid"><article className="panel evolution"><div className="panel-head"><div><h2>Evolución de unidades</h2><p>Cómo se movió el período seleccionado.</p></div><div className="segment" aria-label="Granularidad">{(["day", "week", "month"] as Granularity[]).map((item) => <button key={item} onClick={() => setGranularity(item)} className={granularity === item ? "selected" : ""}>{item === "day" ? "Día" : item === "week" ? "Semana" : "Mes"}</button>)}</div></div>{series.loading ? <div className="skeleton chart-skeleton" /> : series.error ? <div className="error-state"><p>No pudimos cargar la evolución.</p><Retry onClick={refresh} /></div> : <TrendChart points={series.data ?? []} granularity={granularity} />}</article>
      <aside className="panel health"><div className="panel-head"><div><h2>Calidad de datos</h2><p>Estado de la última sincronización.</p></div></div>{health.loading ? <div className="skeleton health-skeleton" /> : health.error ? <div className="error-state"><p>No pudimos cargar el estado.</p><Retry onClick={refresh} /></div> : health.data && <><div className={`health-status ${health.data.freshness.status.toLowerCase()}`}><span className="status-dot" />{health.data.freshness.status === "UNCONFIGURED" ? "Sin SLA definido" : health.data.freshness.status}</div><dl><div><dt>Último movimiento</dt><dd>{health.data.last_movement ? dateTime.format(new Date(health.data.last_movement)) : "Sin datos"}</dd></div><div><dt>Última recepción</dt><dd>{health.data.last_received_at ? dateTime.format(new Date(health.data.last_received_at)) : "Sin datos"}</dd></div><div><dt>Movimientos</dt><dd>{number.format(health.data.total_movements)}</dd></div><div><dt>AJUS</dt><dd className={health.data.ajus === 0 ? "good" : "attention"}>{health.data.ajus === 0 ? "0 · correcto" : health.data.ajus}</dd></div></dl></>}</aside></section>

    <section id="productos" className="panel products"><div className="panel-head"><div><h2>Productos que más se movieron</h2><p>Ranking por unidades netas. La vista de menor movimiento requiere una ampliación de API.</p></div><label className="search"><Icon name="search" size={16} /><input value={productSearch} onChange={(event) => setProductSearch(event.target.value)} placeholder="Filtrar en la lista" /></label></div>{products.loading ? <div className="skeleton table-skeleton" /> : products.error ? <div className="error-state"><p>No pudimos cargar el ranking.</p><Retry onClick={refresh} /></div> : <ProductList products={(products.data ?? []).filter((product) => `${product.description} ${product.brand}`.toLowerCase().includes(productSearch.toLowerCase()))} />}</section>

    <section id="stock" className="panel stock"><div className="panel-head"><div><h2>Estado de stock</h2><p>Detectá faltantes y revisá el saldo por depósito.</p></div><div className="stock-tools"><label className="search"><Icon name="search" size={16} /><input value={stockSearch} onChange={(event) => { setStockSearch(event.target.value); setPage(1); }} placeholder="Buscar producto" /></label><label className="depo-select"><span>Depósito</span><select value={depo} onChange={(event) => { setDepo(event.target.value); setPage(1); }}><option value="">Todos</option><option value="2">2</option></select></label></div></div>{stock.loading ? <div className="skeleton table-skeleton" /> : stock.error ? <div className="error-state"><p>No pudimos cargar el stock.</p><Retry onClick={refresh} /></div> : <StockTable stock={stock.data} onPage={setPage} />}</section>
  </main>;
}

function isAttentionStockItem(item: AttentionStockItem | AttentionNoMovementItem): item is AttentionStockItem {
  return "saldo" in item;
}

function AttentionList({ attention, onReviewStock }: { attention: Attention; onReviewStock: () => void }) {
  const signals = [
    { key: "negative", count: attention.negative_stock.count, title: "Productos con saldo negativo", description: "El saldo registrado es menor a cero.", items: attention.negative_stock.items, tone: "negative" },
    { key: "depleted", count: attention.out_of_stock.count, title: "Productos agotados", description: attention.out_of_stock.with_activity_count > 0 ? `${number.format(attention.out_of_stock.with_activity_count)} con movimiento durante el período.` : "Sin saldo registrado.", items: attention.out_of_stock.items, tone: "depleted" },
    { key: "quiet", count: attention.no_movement.count, title: "Sin movimiento en el período", description: "Productos activos sin registros de movimiento.", items: attention.no_movement.items, tone: "quiet" },
  ];
  return <div className="attention-list">{signals.map((signal) => <article className={`attention-item ${signal.tone}`} key={signal.key}><div className="attention-count">{number.format(signal.count)}</div><div className="attention-copy"><h3>{signal.title}</h3><p>{signal.description}</p>{signal.items.length > 0 && <ul>{signal.items.slice(0, 2).map((item) => <li key={item.article_id}><strong>{item.description || `Artículo ${item.article_id}`}</strong>{isAttentionStockItem(item) ? <span>{units.format(item.saldo)} saldo · Depósito {item.depo}</span> : <span>Artículo #{item.article_id}</span>}</li>)}</ul>}</div><button className="attention-action" onClick={onReviewStock}>Revisar stock <Icon name="arrow" size={14} /></button></article>)}</div>;
}

function ProductList({ products }: { products: Product[] }) {
  if (!products.length) return <div className="empty">No hay datos para este período.</div>;
  const maximum = Math.max(...products.map((product) => product.net_units), 1);
  return <ol className="product-list">{products.map((product, index) => <li key={product.article_id}><span className="rank">{String(index + 1).padStart(2, "0")}</span><div className="product-name"><strong title={product.description || undefined}>{product.description || `Artículo ${product.article_id}`}</strong><small>{[product.brand, product.unit_measure].filter(Boolean).join(" · ") || "Sin descripción adicional"}</small><span className="product-bar" aria-hidden="true"><i style={{ "--share": `${Math.max(3, (product.net_units / maximum) * 100)}%` } as React.CSSProperties} /></span></div><div className="product-value"><strong>{units.format(product.net_units)}</strong><small>{number.format(product.movements)} movimientos</small></div></li>)}</ol>;
}

export function stockState(saldo: number) {
  if (saldo < 0) return { label: "Saldo negativo", tone: "negative" };
  if (saldo === 0) return { label: "Agotado", tone: "depleted" };
  return { label: "Disponible", tone: "available" };
}

export function pageItems(current: number, total: number): Array<number | "ellipsis"> {
  if (total <= 5) return Array.from({ length: total }, (_, index) => index + 1);
  if (current <= 3) return [1, 2, 3, "ellipsis", total];
  if (current >= total - 2) return [1, "ellipsis", total - 2, total - 1, total];
  return [1, "ellipsis", current, "ellipsis", total];
}

function StockTable({ stock, onPage }: { stock: StockResponse | null; onPage: (page: number) => void }) {
  if (!stock?.rows.length) return <div className="empty">No hay productos que coincidan con este filtro.</div>;
  const pages = Math.ceil(stock.total / stock.limit);
  return <><div className="stock-table-wrap"><table><thead><tr><th>Producto</th><th>Estado</th><th>Depósito</th><th>Bulto</th><th>Saldo</th><th>Piezas</th></tr></thead><tbody>{stock.rows.map((row) => { const state = stockState(row.saldo); return <tr key={`${row.article_id}-${row.depo}-${row.bulto}`}><td data-label="Producto"><strong title={row.description || undefined}>{row.description || `Artículo ${row.article_id}`}</strong><small>#{row.article_id}</small></td><td data-label="Estado"><span className={`stock-tag ${state.tone}`}>{state.label}</span></td><td data-label="Depósito">{row.depo}</td><td data-label="Bulto">{row.bulto}</td><td data-label="Saldo" className={state.tone === "negative" ? "negative-number" : undefined}>{units.format(row.saldo)}</td><td data-label="Piezas">{units.format(row.piezas)}</td></tr>; })}</tbody></table></div><div className="pagination"><span>{number.format(stock.total)} resultados · {stock.limit} por página</span><div className="pagination-controls"><button disabled={stock.page === 1} onClick={() => onPage(stock.page - 1)}>Anterior</button>{pageItems(stock.page, pages).map((item, index) => item === "ellipsis" ? <span className="page-ellipsis" key={`ellipsis-${index}`}>…</span> : <button key={item} className={item === stock.page ? "page-current" : ""} aria-current={item === stock.page ? "page" : undefined} onClick={() => onPage(item)}>{item}</button>)}<button disabled={stock.page >= pages} onClick={() => onPage(stock.page + 1)}>Siguiente <Icon name="arrow" size={14} /></button></div></div></>;
}
