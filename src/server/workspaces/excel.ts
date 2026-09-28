import * as xlsx from "xlsx";

export type DepotStockRow = {
  articleId: number;
  description: string;
  stock: number;
};

export function parseDepotStockExcel(buffer: Buffer): DepotStockRow[] {
  const wb = xlsx.read(buffer, { type: "buffer" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = xlsx.utils.sheet_to_json<any[]>(ws, { header: 1 });
  
  const results: DepotStockRow[] = [];
  
  for (const row of rows) {
    if (!row || row.length === 0) continue;
    
    // El formato real tiene: Col 0: Id, Col 1: Descripcion, Col 2: Stock
    const id = parseInt(row[0], 10);
    const desc = row[1];
    const stock = parseFloat(row[2]);
    
    // Filtramos los encabezados o categorías que no tengan un ID numérico válido o stock
    if (!isNaN(id) && typeof stock === "number" && !isNaN(stock)) {
      results.push({
        articleId: id,
        description: desc ? String(desc).trim() : "",
        stock: stock
      });
    }
  }
  
  return results;
}

export type OrderExportRow = {
  articleId: number;
  description: string;
  stockPv: number;
  requestedQty: number;
  category: string; // Para generar las filas agrupadoras "RUBRO"
};

export function generatePedidoExcel(items: OrderExportRow[]): Buffer {
  const wsData: any[][] = [];
  wsData.push(["articulo", "descri", null, "stock", "PEDIDO"]); // Header
  
  // Agrupar por categoría
  const byCategory = items.reduce((acc, item) => {
    const cat = item.category || "SIN CATEGORIA";
    if (!acc[cat]) acc[cat] = [];
    acc[cat].push(item);
    return acc;
  }, {} as Record<string, OrderExportRow[]>);
  
  for (const [category, catItems] of Object.entries(byCategory)) {
    // Fila separadora de Rubro
    wsData.push([category, null, null, null, null]);
    
    for (const item of catItems) {
      if (item.requestedQty > 0) {
        wsData.push([
          item.articleId,
          item.description,
          null,
          item.stockPv,
          `${item.requestedQty} UNID`
        ]);
      }
    }
  }
  
  const ws = xlsx.utils.aoa_to_sheet(wsData);
  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, ws, "Pedido");
  
  return xlsx.write(wb, { type: "buffer", bookType: "xlsx" });
}
