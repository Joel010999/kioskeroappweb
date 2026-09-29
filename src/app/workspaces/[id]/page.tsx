"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { use } from "react";

export default function WorkspaceEditorPage({ params }: { params: Promise<{ id: string }> }) {
  const resolvedParams = use(params);
  const [catalog, setCatalog] = useState<any[]>([]);
  const [workspace, setWorkspace] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  // Temporal auth param
  const branchId = "2"; 
  const router = useRouter();

  useEffect(() => {
    const fetchCatalog = async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/workspaces/${resolvedParams.id}/catalog?branch_id=${branchId}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        setCatalog(data.catalog);
        setWorkspace(data.workspace);
      } catch (err: any) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };
    fetchCatalog();
  }, [resolvedParams.id, branchId]);

  const handleQtyChange = (articleId: number, qty: number) => {
    setCatalog(prev => prev.map(item => 
      item.article_id === articleId ? { ...item, requested_qty: Math.max(0, qty) } : item
    ));
  };

  const saveWorkspace = async () => {
    setSaving(true);
    try {
      const itemsToSave = catalog
        .filter(item => item.requested_qty > 0)
        .map(item => ({
          articleId: item.article_id,
          requestedQuantity: item.requested_qty,
          stockDepositoSnapshot: item.stock_depo,
          stockRealAtCreation: item.stock_db,
          category: item.category
        }));

      const res = await fetch(`/api/workspaces/${resolvedParams.id}?branch_id=${branchId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branch_id: branchId, items: itemsToSave }),
      });
      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || "Error al guardar");
      }
      alert("Pedido guardado como borrador!");
    } catch (err: any) {
      alert("Error: " + err.message);
    } finally {
      setSaving(false);
    }
  };

  const downloadExcel = async () => {
    try {
      await saveWorkspace(); // Ensure it's saved before downloading
      
      // Form POST or fetch to get blob
      const res = await fetch(`/api/workspaces/${resolvedParams.id}?branch_id=${branchId}`, { method: "POST" });
      if (!res.ok) throw new Error("Error al generar excel");
      
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `PEDIDO_CENTRO_PV${branchId}.xlsx`;
      a.click();
      
      // Refresh to update status to DOWNLOADED
      // The fetchCatalog will not be available here, we need to manually trigger a re-fetch or use router.refresh()
      window.location.reload();
    } catch (err: any) {
      alert("Error descargando excel: " + err.message);
    }
  };

  if (loading) return <div className="p-8">Cargando catálogo unificado...</div>;
  if (error) return <div className="p-8 text-red-600">{error}</div>;

  const isReadOnly = workspace?.status === 'FINALIZED' || workspace?.status === 'DOWNLOADED';

  return (
    <main className="p-8 max-w-6xl mx-auto">
      <header className="mb-6 flex justify-between items-end border-b pb-4">
        <div>
          <Link href="/workspaces" className="text-blue-600 hover:underline mb-2 inline-block">&larr; Volver a Mis Pedidos</Link>
          <h1 className="text-2xl font-bold">Armado de Pedido #{workspace?.id}</h1>
          <p className="text-gray-600">Estado: {workspace?.status}</p>
        </div>
        <div className="flex gap-4">
          <button 
            onClick={saveWorkspace} 
            disabled={saving || isReadOnly}
            className="px-4 py-2 border rounded shadow-sm hover:bg-gray-50 disabled:opacity-50 bg-white"
          >
            {saving ? "Guardando..." : "Guardar Borrador"}
          </button>
          <button 
            onClick={downloadExcel}
            className="px-4 py-2 bg-green-600 text-white rounded shadow-sm hover:bg-green-700"
          >
            Exportar Excel & Marcar Terminado
          </button>
        </div>
      </header>

      <div className="bg-white rounded border shadow overflow-hidden">
        <table className="w-full text-left text-sm">
          <thead className="bg-gray-100 border-b">
            <tr>
              <th className="p-3">Código</th>
              <th className="p-3">Rubro</th>
              <th className="p-3">Descripción</th>
              <th className="p-3 text-right">Stock (Depósito)</th>
              <th className="p-3 text-right">Stock Real (BD)</th>
              <th className="p-3 text-center">A Pedir</th>
            </tr>
          </thead>
          <tbody>
            {catalog.map((item, idx) => {
              const rowClass = item.requested_qty > 0 ? "bg-blue-50" : (idx % 2 === 0 ? "bg-white" : "bg-gray-50");
              const hasAlert = item.stock_depo === null || item.stock_db === null || (item.stock_depo === 0 && item.stock_db > 0);
              
              return (
                <tr key={item.article_id} className={`border-b ${rowClass}`}>
                  <td className="p-3">{item.article_id}</td>
                  <td className="p-3 text-gray-500">{item.category}</td>
                  <td className="p-3">
                    {item.description}
                    {hasAlert && <span className="ml-2 inline-block px-2 py-0.5 bg-yellow-100 text-yellow-800 text-xs rounded-full" title="Diferencia detectada o No Informado">⚠</span>}
                  </td>
                  <td className="p-3 text-right">
                    {item.stock_depo !== null ? item.stock_depo : <span className="text-gray-400 italic">No inf.</span>}
                  </td>
                  <td className="p-3 text-right font-medium">
                    {item.stock_db !== null ? item.stock_db : <span className="text-gray-400 italic">Sin BD</span>}
                  </td>
                  <td className="p-3 text-center">
                    <input 
                      type="number" 
                      min="0"
                      value={item.requested_qty || ""}
                      onChange={e => handleQtyChange(item.article_id, parseInt(e.target.value) || 0)}
                      disabled={isReadOnly}
                      className="w-20 border rounded p-1 text-center disabled:bg-gray-100"
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </main>
  );
}
