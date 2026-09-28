"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

export default function WorkspacesListPage() {
  const [workspaces, setWorkspaces] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  // En el sistema real, el branchId vendría del Auth context. Usamos 2 (PV1) o 3 (PV2).
  // Aquí usamos un selector temporal para probar
  const [branchId, setBranchId] = useState("2");
  const router = useRouter();

  useEffect(() => {
    fetchWorkspaces();
  }, [branchId]);

  const fetchWorkspaces = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/workspaces?branch_id=${branchId}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setWorkspaces(data.workspaces || []);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = async () => {
    setCreating(true);
    try {
      // Intentamos obtener el último snapshot de stock para asociarlo
      const snapRes = await fetch(`/api/snapshots`);
      const snapData = await snapRes.json();
      const snapshotId = snapData.snapshot?.id;

      const res = await fetch(`/api/workspaces`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branch_id: branchId, snapshot_id: snapshotId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      router.push(`/workspaces/${data.id}?branch_id=${branchId}`);
    } catch (err: any) {
      setError(err.message);
      setCreating(false);
    }
  };

  return (
    <main className="p-8 max-w-5xl mx-auto">
      <header className="flex justify-between items-center mb-8 border-b pb-4">
        <div>
          <Link href="/dashboard" className="text-blue-600 hover:underline mb-2 inline-block">&larr; Volver al inicio</Link>
          <h1 className="text-2xl font-bold">Mis Pedidos</h1>
          <p className="text-gray-600">Creá y gestioná múltiples pedidos sin restricciones.</p>
        </div>
        <div className="flex gap-4 items-center">
          <select 
            value={branchId} 
            onChange={e => setBranchId(e.target.value)}
            className="border p-2 rounded"
          >
            <option value="2">PV1 (Branch 2)</option>
            <option value="3">PV2 (Branch 3)</option>
          </select>
          <button 
            onClick={handleCreate}
            disabled={creating}
            className="bg-blue-600 text-white px-4 py-2 rounded shadow hover:bg-blue-700 disabled:opacity-50"
          >
            + Nuevo Pedido
          </button>
        </div>
      </header>

      {error && (
        <div className="p-4 bg-red-50 text-red-700 rounded-md mb-6 border border-red-200">
          {error}
        </div>
      )}

      {loading ? (
        <div className="text-gray-500">Cargando pedidos...</div>
      ) : workspaces.length === 0 ? (
        <div className="text-gray-500 text-center p-12 bg-gray-50 rounded border border-dashed">
          No tenés ningún pedido en curso. Hacé click en "Nuevo Pedido" para empezar.
        </div>
      ) : (
        <div className="grid gap-4">
          {workspaces.map(w => (
            <div key={w.id} className="bg-white border rounded p-4 flex justify-between items-center shadow-sm">
              <div>
                <h3 className="font-medium text-lg">Pedido #{w.id}</h3>
                <p className="text-sm text-gray-500">
                  Creado: {new Date(w.created_at).toLocaleString()} | Estado: <strong className="text-gray-700">{w.status}</strong>
                </p>
                {w.stock_snapshot_id && (
                  <p className="text-xs text-blue-600 mt-1">Snapshot de Depósito: #{w.stock_snapshot_id}</p>
                )}
              </div>
              <div>
                <Link 
                  href={`/workspaces/${w.id}?branch_id=${branchId}`}
                  className="px-4 py-2 bg-gray-100 hover:bg-gray-200 border rounded text-sm font-medium"
                >
                  {w.status === 'DRAFT' ? 'Editar / Continuar' : 'Ver Detalles'}
                </Link>
              </div>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
