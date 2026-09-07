export type Overview = {
  period: { from: string; to: string };
  net_units: number; movements: number; variation_vs_previous_percent: number | null;
  previous_net_units: number; stock_total: number; products_without_stock: number;
  active_products: number; last_updated_at: string | null;
};
export type TimeseriesPoint = { date: string; net_units: number; movements: number };
export type Product = { article_id: number; description: string | null; brand: string | null; bulto: string | null; unit_measure: string | null; net_units: number; movements: number };
export type StockRow = { article_id: number; description: string | null; depo: number; bulto: string; saldo: number; piezas: number; last_updated_at: string; stock_status: "OUT_OF_STOCK" | "AVAILABLE"; is_low_stock: boolean | null };
export type StockResponse = { total: number; rows: StockRow[]; page: number; limit: number };
export type DataHealth = { first_movement: string | null; last_movement: string | null; total_movements: number; last_received_at: string | null; ajus: number; freshness: { status: "OK" | "WARNING" | "ERROR" | "UNCONFIGURED"; age_minutes: number | null } };
export type Period = { from: string; to: string; label: string };
export type AttentionStockItem = { article_id: number; description: string | null; depo: number; bulto: string; saldo: number; movements: number; net_units: number };
export type AttentionNoMovementItem = { article_id: number; description: string | null };
export type Attention = {
  negative_stock: { count: number; items: AttentionStockItem[] };
  out_of_stock: { count: number; with_activity_count: number; items: AttentionStockItem[] };
  no_movement: { count: number; items: AttentionNoMovementItem[] };
};
