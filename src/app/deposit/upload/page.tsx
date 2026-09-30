"use client";

import { useState } from "react";
import Link from "next/link";
import { LogoutButton } from "@/features/navigation/logout-button";

export default function DepositUploadPage() {
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleUpload = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) return;

    setLoading(true);
    setError(null);
    setResult(null);

    const formData = new FormData();
    formData.append("file", file);

    try {
      const res = await fetch("/api/snapshots", {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Error al subir");

      setResult(`Stock cargado correctamente. ${data.itemsProcessed} artículos procesados.`);
      setFile(null);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="p-8 max-w-2xl mx-auto">
      <header className="mb-8 flex justify-between items-start">
        <div>
          <Link href="/dashboard" className="text-blue-600 hover:underline mb-4 inline-block">&larr; Volver al inicio</Link>
          <h1 className="text-2xl font-bold">Cargar Stock de Depósito</h1>
          <p className="text-gray-600 mt-2">Subí el Excel oficial del depósito para que los Puntos de Venta puedan armar sus pedidos.</p>
        </div>
        <LogoutButton />
      </header>

      <form onSubmit={handleUpload} className="space-y-6 bg-white p-6 rounded-lg shadow border border-gray-200">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">Archivo Excel (.xlsx)</label>
          <input 
            type="file" 
            accept=".xlsx"
            onChange={(e) => setFile(e.target.files?.[0] || null)}
            className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded file:border-0 file:text-sm file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100"
          />
        </div>

        {error && (
          <div className="p-4 bg-red-50 text-red-700 rounded-md text-sm border border-red-200">
            {error}
          </div>
        )}

        {result && (
          <div className="p-4 bg-green-50 text-green-700 rounded-md text-sm border border-green-200">
            {result}
          </div>
        )}

        <button 
          type="submit" 
          disabled={!file || loading}
          className="w-full flex justify-center py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50"
        >
          {loading ? "Procesando..." : "Subir y procesar Excel"}
        </button>
      </form>
    </main>
  );
}
