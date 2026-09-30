"use client";

import { useState } from "react";
import Link from "next/link";
import { LogoutButton } from "@/features/navigation/logout-button";

type UploadSuccess = {
  filename: string;
  itemsProcessed: number;
  uploadedAt: Date;
};

export default function DepositUploadPage() {
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState<UploadSuccess | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleUpload = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) return;

    setLoading(true);
    setError(null);
    setSuccess(null);

    const formData = new FormData();
    formData.append("file", file);

    try {
      const res = await fetch("/api/snapshots", {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Error al subir");

      setSuccess({
        filename: file.name,
        itemsProcessed: data.itemsProcessed,
        uploadedAt: new Date(),
      });
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

      {success ? (
        <div className="bg-white p-8 rounded-lg shadow border border-green-200 text-center">
          <div className="w-16 h-16 bg-green-100 text-green-600 rounded-full flex items-center justify-center mx-auto mb-4">
            <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h2 className="text-2xl font-bold text-gray-900 mb-4">Stock cargado exitosamente</h2>
          <div className="text-gray-600 space-y-3 mb-8 bg-gray-50 p-4 rounded-md inline-block text-left border border-gray-100">
            <p><strong className="text-gray-800">Archivo:</strong> {success.filename}</p>
            <p><strong className="text-gray-800">Artículos procesados:</strong> {new Intl.NumberFormat('es-AR').format(success.itemsProcessed)}</p>
            <p><strong className="text-gray-800">Fecha de carga:</strong> {success.uploadedAt.toLocaleString('es-AR', { dateStyle: 'long', timeStyle: 'short' })}</p>
          </div>
          <button 
            type="button"
            onClick={() => setSuccess(null)}
            className="w-full flex justify-center py-2 px-4 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
          >
            Cargar otro Excel
          </button>
        </div>
      ) : (
        <form onSubmit={handleUpload} className="space-y-6 bg-white p-6 rounded-lg shadow border border-gray-200">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Archivo Excel (.xlsx)</label>
            <input 
              type="file" 
              accept=".xlsx"
              onChange={(e) => {
                setFile(e.target.files?.[0] || null);
                setError(null);
              }}
              className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded file:border-0 file:text-sm file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100"
            />
          </div>

          {error && (
            <div className="p-4 bg-red-50 text-red-700 rounded-md text-sm border border-red-200">
              {error}
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
      )}
    </main>
  );
}
