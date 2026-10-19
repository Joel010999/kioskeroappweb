"use client";

import { useState } from "react";
import Link from "next/link";
import { OperationsNavigation } from "@/features/navigation/operations-navigation";

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
    <main className="orders-shell deposit-upload-shell">
      <header className="orders-topbar">
        <Link className="brand" href="/dashboard" aria-label="Dashboard de La Casa del Kioskero">
          <span>
            LA CASA DEL KIOSKERO<span className="brand-sub">Panel de operación</span>
          </span>
        </Link>
        <OperationsNavigation role="WAREHOUSE" branchId={1} />
      </header>

      <section className="orders-intro">
        <div>
          <Link className="back-link" href="/dashboard">
            &larr; Volver al panel central
          </Link>
          <h1>Cargar Stock de Depósito</h1>
          <p>
            Subí el Excel oficial del depósito para que los Puntos de Venta puedan armar sus pedidos.
          </p>
        </div>
      </section>

      <div className="deposit-upload-wrap">
        {success ? (
          <div className="deposit-upload-card success-card">
            <div className="deposit-upload-icon-circle">
              <svg width="32" height="32" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <div>
              <h2 style={{ margin: "0 0 0.5rem", fontSize: "1.35rem", fontWeight: 780, color: "var(--ink)" }}>
                Stock cargado exitosamente
              </h2>
              <p style={{ margin: 0, color: "var(--muted)", fontSize: "0.88rem" }}>
                El catálogo y las existencias quedaron actualizadas para todas las sucursales.
              </p>
            </div>
            <div className="deposit-upload-details">
              <div>
                <strong style={{ color: "var(--ink)" }}>Archivo:</strong>{" "}
                <span style={{ color: "var(--ink-soft)" }}>{success.filename}</span>
              </div>
              <div>
                <strong style={{ color: "var(--ink)" }}>Artículos procesados:</strong>{" "}
                <span style={{ color: "var(--ink-soft)" }}>
                  {new Intl.NumberFormat("es-AR").format(success.itemsProcessed)}
                </span>
              </div>
              <div>
                <strong style={{ color: "var(--ink)" }}>Fecha de carga:</strong>{" "}
                <span style={{ color: "var(--ink-soft)" }}>
                  {success.uploadedAt.toLocaleString("es-AR", { dateStyle: "long", timeStyle: "short" })}
                </span>
              </div>
            </div>
            <div style={{ display: "flex", gap: "0.75rem", width: "100%", justifyContent: "center" }}>
              <button
                type="button"
                onClick={() => setSuccess(null)}
                className="order-secondary"
                style={{ padding: "0.65rem 1.25rem", fontSize: "0.85rem" }}
              >
                Cargar otro Excel
              </button>
              <Link
                href="/orders/warehouse"
                className="order-primary"
                style={{ padding: "0.65rem 1.25rem", fontSize: "0.85rem" }}
              >
                Ir a Bandeja de Depósito &rarr;
              </Link>
            </div>
          </div>
        ) : (
          <form onSubmit={handleUpload} className="deposit-upload-card">
            <div className="deposit-upload-field">
              <label htmlFor="deposit-excel-file">Archivo Excel oficial (.xlsx)</label>
              <input
                id="deposit-excel-file"
                type="file"
                accept=".xlsx"
                onChange={(e) => {
                  setFile(e.target.files?.[0] || null);
                  setError(null);
                }}
              />
              <span style={{ display: "block", marginTop: "0.45rem", fontSize: "0.76rem", color: "var(--muted)" }}>
                Formatos compatibles: planilla Excel con columnas de código, descripción y saldo.
              </span>
            </div>

            {error && (
              <div className="orders-error" role="alert" style={{ margin: 0 }}>
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={!file || loading}
              className="order-primary"
              style={{ padding: "0.75rem 1.25rem", fontSize: "0.9rem", width: "100%" }}
            >
              {loading ? "Procesando archivo..." : "Subir y procesar Excel"}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
