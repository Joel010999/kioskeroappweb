"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { branchDisplayName } from "@/features/navigation/operations-navigation";
import type { ValidatedImportItem, ImportPreviewResult } from "@/server/orders/excel-import";

type ExcelImportModalProps = {
  isOpen: boolean;
  onClose: () => void;
  branchId: number;
  planningDate: string;
  onOrderCreated?: (orderId: number, orderNumber: number) => void;
};

type ViewTab = "ALL" | "VALID" | "WARNINGS" | "ERRORS";

const unitsFmt = new Intl.NumberFormat("es-AR", { maximumFractionDigits: 2 });

export function ExcelImportModal({
  isOpen,
  onClose,
  branchId,
  planningDate,
  onOrderCreated,
}: ExcelImportModalProps) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState<"UPLOAD" | "LOADING" | "PREVIEW" | "SUCCESS">("UPLOAD");
  const [dragActive, setDragActive] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewData, setPreviewData] = useState<ImportPreviewResult | null>(null);
  const [editedItems, setEditedItems] = useState<ValidatedImportItem[]>([]);
  const [currentTab, setCurrentTab] = useState<ViewTab>("ALL");
  const [allowPartialImport, setAllowPartialImport] = useState(false);
  const [orderNotes, setOrderNotes] = useState("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [createdOrder, setCreatedOrder] = useState<{ id: number; orderNumber: number; totalUnits: number; itemsCount: number } | null>(null);

  const resetAndClose = () => {
    setStep("UPLOAD");
    setSelectedFile(null);
    setPreviewData(null);
    setEditedItems([]);
    setCurrentTab("ALL");
    setAllowPartialImport(false);
    setErrorMsg(null);
    setConfirming(false);
    setCreatedOrder(null);
    setOrderNotes("");
    onClose();
  };

  if (!isOpen) return null;

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
      setDragActive(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      void processFile(e.dataTransfer.files[0]);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      void processFile(e.target.files[0]);
    }
  };

  const processFile = async (file: File) => {
    const validExtensions = [".xlsx", ".xls", ".csv"];
    const fileExt = file.name.substring(file.name.lastIndexOf(".")).toLowerCase();
    if (!validExtensions.includes(fileExt)) {
      setErrorMsg("Formato de archivo no compatible. Por favor seleccioná un archivo .xlsx, .xls o .csv.");
      return;
    }

    if (file.size > 10 * 1024 * 1024) {
      setErrorMsg("El archivo supera el tamaño máximo permitido de 10 MB.");
      return;
    }

    setSelectedFile(file);
    setOrderNotes(file.name);
    setErrorMsg(null);
    setStep("LOADING");

    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("branch_id", String(branchId));

      const res = await fetch("/api/orders/import-excel/preview", {
        method: "POST",
        body: formData,
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Error al procesar el archivo Excel.");
      }

      setPreviewData(data);
      setEditedItems(data.items || []);
      setStep("PREVIEW");
    } catch (err: any) {
      setErrorMsg(err.message || "Error al leer el archivo.");
      setStep("UPLOAD");
    }
  };

  const updateItemQty = (index: number, newQty: number) => {
    setEditedItems((prev) => {
      const copy = [...prev];
      const item = { ...copy[index] };
      item.requestedQuantity = Math.max(0, newQty);
      if (item.requestedQuantity === 0) {
        item.status = "ERROR_INVALID_QTY";
        item.message = "Cantidad debe ser mayor a 0";
      } else if (item.status === "ERROR_INVALID_QTY") {
        item.status = "VALID";
        item.message = undefined;
      }
      copy[index] = item;
      return copy;
    });
  };

  const toggleExcludeItem = (index: number) => {
    setEditedItems((prev) => {
      const copy = [...prev];
      copy[index] = { ...copy[index], isExcluded: !copy[index].isExcluded };
      return copy;
    });
  };

  // Re-asociar manualmente un artículo ingresando otro código
  const handleManualReassign = async (index: number, newArticleIdStr: string) => {
    const newId = parseInt(newArticleIdStr, 10);
    if (isNaN(newId) || newId <= 0) return;

    try {
      // Consultar datos de producto para el nuevo código
      const res = await fetch(`/api/orders/suggestions?article_id=${newId}&branch_id=${branchId}`);
      const data = await res.json();
      if (res.ok && data.rows && data.rows.length > 0) {
        const prod = data.rows[0];
        setEditedItems((prev) => {
          const copy = [...prev];
          copy[index] = {
            ...copy[index],
            articleId: prod.article_id,
            catalogDescription: prod.product_name || `Artículo #${prod.article_id}`,
            status: "VALID",
            message: `Asociado manualmente al código ${prod.article_id}`,
          };
          return copy;
        });
      } else {
        alert(`No se encontró ningún producto con el código ${newId} en el catálogo de la sucursal.`);
      }
    } catch {
      alert("Error al verificar código de producto.");
    }
  };

  // Cálculo de totales actuales teniendo en cuenta ediciones y exclusiones
  const activeItems = editedItems.filter((i) => !i.isExcluded);
  const validItems = activeItems.filter(
    (i) => !i.status.startsWith("ERROR_") && i.requestedQuantity > 0
  );
  const warningItems = activeItems.filter((i) => i.status.startsWith("WARNING_"));
  const errorItems = activeItems.filter((i) => i.status.startsWith("ERROR_"));
  const totalUnitsCalculated = validItems.reduce((sum, i) => sum + i.requestedQuantity, 0);

  const hasBlockingErrors = errorItems.length > 0 || (previewData?.unmatchedRows && previewData.unmatchedRows.length > 0);
  const canConfirm = validItems.length > 0 && (!hasBlockingErrors || allowPartialImport);

  const handleConfirmImport = async () => {
    if (!canConfirm) return;
    setConfirming(true);
    setErrorMsg(null);

    try {
      const itemsToConfirm = validItems.map((i) => ({
        article_id: i.articleId,
        requested_quantity: i.requestedQuantity,
      }));

      const idempotencyToken = `${branchId}:${planningDate}:${previewData?.fileHash || "manual"}`;

      const res = await fetch("/api/orders/import-excel/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          branch_id: branchId,
          planning_date: planningDate,
          items: itemsToConfirm,
          notes: orderNotes || selectedFile?.name || "Importado desde Excel",
          file_hash: previewData?.fileHash,
          idempotency_token: idempotencyToken,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Error al crear el pedido desde Excel.");
      }

      setCreatedOrder({
        id: data.id,
        orderNumber: data.order_number ?? data.id,
        totalUnits: data.total_units || totalUnitsCalculated,
        itemsCount: data.items_count || validItems.length,
      });

      if (onOrderCreated) {
        onOrderCreated(data.id, data.order_number ?? data.id);
      }

      setStep("SUCCESS");
    } catch (err: any) {
      setErrorMsg(err.message || "Error al confirmar la importación.");
    } finally {
      setConfirming(false);
    }
  };

  const branchName = branchDisplayName(branchId, "PV");

  // Filtrado para la pestaña activa
  const displayedItems = editedItems.filter((item) => {
    if (currentTab === "VALID") return !item.isExcluded && !item.status.startsWith("ERROR_") && item.requestedQuantity > 0;
    if (currentTab === "WARNINGS") return !item.isExcluded && item.status.startsWith("WARNING_");
    if (currentTab === "ERRORS") return !item.isExcluded && item.status.startsWith("ERROR_");
    return true; // ALL
  });

  return (
    <div className="export-modal-backdrop" onClick={() => !confirming && resetAndClose()}>
      <div
        className="confirm-review-modal-card"
        style={{ maxWidth: step === "PREVIEW" ? "920px" : "560px", maxHeight: "90vh", display: "flex", flexDirection: "column" }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-excel-title"
      >
        {/* HEADER */}
        <div className="confirm-modal-header" style={{ flexShrink: 0 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div>
              <h2 id="import-excel-title" style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                <span>📥</span> Importar pedido desde Excel
              </h2>
              <p>
                Sucursal {branchName} · Planificación para {planningDate}
              </p>
            </div>
            <button
              type="button"
              onClick={resetAndClose}
              disabled={confirming}
              style={{
                background: "none",
                border: "none",
                fontSize: "1.4rem",
                cursor: "pointer",
                color: "#64748b",
                padding: "0.2rem 0.5rem",
              }}
              title="Cerrar"
            >
              ×
            </button>
          </div>
        </div>

        {errorMsg && (
          <div
            style={{
              padding: "0.75rem 1rem",
              background: "#fef2f2",
              border: "1px solid #fecaca",
              borderRadius: "8px",
              color: "#991b1b",
              fontSize: "0.88rem",
              margin: "0 0 1rem",
            }}
          >
            <strong>⚠️ Atención:</strong> {errorMsg}
          </div>
        )}

        {/* STEP 1: UPLOAD */}
        {step === "UPLOAD" && (
          <div style={{ display: "flex", flexDirection: "column", gap: "1.2rem" }}>
            <div
              onDragEnter={handleDrag}
              onDragLeave={handleDrag}
              onDragOver={handleDrag}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              style={{
                border: dragActive ? "2px dashed #16a34a" : "2px dashed #cbd5e1",
                borderRadius: "12px",
                padding: "2.5rem 1.5rem",
                textAlign: "center",
                background: dragActive ? "#f0fdf4" : "#f8fafc",
                cursor: "pointer",
                transition: "all 0.15s ease",
              }}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx, .xls, .csv"
                style={{ display: "none" }}
                onChange={handleFileChange}
              />
              <div style={{ fontSize: "2.8rem", marginBottom: "0.75rem" }}>📄</div>
              <h3 style={{ margin: "0 0 0.35rem", fontSize: "1.1rem", color: "#0f172a" }}>
                Arrastrá tu archivo Excel aquí o hacé clic para seleccionar
              </h3>
              <p style={{ margin: 0, fontSize: "0.85rem", color: "#64748b" }}>
                Compatible con planillas de pedidos (.xlsx, .xls, .csv). Máx. 10 MB.
              </p>
            </div>

            <div
              style={{
                background: "#f1f5f9",
                borderRadius: "8px",
                padding: "1rem",
                fontSize: "0.85rem",
                color: "#334155",
                display: "grid",
                gap: "0.5rem",
              }}
            >
              <div style={{ fontWeight: 600, color: "#0f172a", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span>💡 Formato esperado del archivo:</span>
                <a
                  href="/api/orders/import-excel/template"
                  download="plantilla_pedido_kioskero.xlsx"
                  style={{
                    color: "#0369a1",
                    textDecoration: "underline",
                    fontSize: "0.82rem",
                    fontWeight: 600,
                  }}
                  onClick={(e) => e.stopPropagation()}
                >
                  📥 Descargar plantilla de ejemplo (.xlsx)
                </a>
              </div>
              <ul style={{ margin: 0, paddingLeft: "1.2rem", lineHeight: 1.5 }}>
                <li>
                  <strong>Código:</strong> Código numérico del artículo (ej. <em>2222</em>, <em>11109</em>).
                </li>
                <li>
                  <strong>Descripción:</strong> Nombre del producto (ej. <em>Aceite Cañuelas</em>).
                </li>
                <li>
                  <strong>Cantidad / Pedido:</strong> Unidades solicitadas (ej. <em>12</em> o <em>12 UNID</em>).
                </li>
                <li>
                  Las filas de rubros o categorías (ej. <em>ALMACEN</em>) se reconocen y descartan automáticamente.
                </li>
              </ul>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.75rem", marginTop: "0.5rem" }}>
              <button type="button" className="order-secondary" onClick={onClose}>
                Cancelar
              </button>
            </div>
          </div>
        )}

        {/* STEP 2: LOADING */}
        {step === "LOADING" && (
          <div style={{ padding: "3rem 1.5rem", textAlign: "center" }}>
            <div style={{ fontSize: "2.5rem", animation: "spin 1s infinite linear", display: "inline-block", marginBottom: "1rem" }}>
              ⏳
            </div>
            <h3 style={{ margin: "0 0 0.5rem", color: "#0f172a" }}>Analizando y validando archivo...</h3>
            <p style={{ margin: 0, color: "#64748b", fontSize: "0.9rem" }}>
              Verificando columnas, códigos de producto y disponibilidad en el catálogo de {branchName}.
            </p>
          </div>
        )}

        {/* STEP 3: PREVIEW & CORRECTION */}
        {step === "PREVIEW" && previewData && (
          <div style={{ display: "flex", flexDirection: "column", gap: "1rem", overflow: "hidden", flex: 1 }}>
            {/* Metadatos y badges de resumen */}
            <div className="confirm-modal-summary-pills" style={{ margin: 0, flexShrink: 0 }}>
              <div className="confirm-pill">
                <span>Archivo</span>
                <strong style={{ fontSize: "0.9rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={selectedFile?.name}>
                  {selectedFile?.name}
                </strong>
              </div>
              <div className="confirm-pill" style={{ background: "#f0fdf4", borderColor: "#bbf7d0" }}>
                <span>Listos para pedir</span>
                <strong style={{ color: "#166534" }}>{validItems.length} productos</strong>
              </div>
              <div className="confirm-pill" style={{ background: "#eff6ff", borderColor: "#bfdbfe" }}>
                <span>Unidades totales</span>
                <strong style={{ color: "#1e40af" }}>{unitsFmt.format(totalUnitsCalculated)} u.</strong>
              </div>
              {warningItems.length > 0 && (
                <div className="confirm-pill" style={{ background: "#fffbeb", borderColor: "#fde68a" }}>
                  <span>Advertencias</span>
                  <strong style={{ color: "#b45309" }}>{warningItems.length} filas</strong>
                </div>
              )}
              {errorItems.length > 0 && (
                <div className="confirm-pill" style={{ background: "#fef2f2", borderColor: "#fecaca" }}>
                  <span>Con errores</span>
                  <strong style={{ color: "#b91c1c" }}>{errorItems.length} filas</strong>
                </div>
              )}
            </div>

            {/* Pestañas de filtrado de vista */}
            <div style={{ display: "flex", gap: "0.5rem", borderBottom: "1px solid #e2e8f0", paddingBottom: "0.4rem", flexShrink: 0 }}>
              <button
                type="button"
                onClick={() => setCurrentTab("ALL")}
                style={{
                  padding: "0.35rem 0.75rem",
                  borderRadius: "6px",
                  fontSize: "0.82rem",
                  fontWeight: currentTab === "ALL" ? 700 : 500,
                  border: "none",
                  background: currentTab === "ALL" ? "#0f172a" : "transparent",
                  color: currentTab === "ALL" ? "#ffffff" : "#475569",
                  cursor: "pointer",
                }}
              >
                Todos ({activeItems.length})
              </button>
              <button
                type="button"
                onClick={() => setCurrentTab("VALID")}
                style={{
                  padding: "0.35rem 0.75rem",
                  borderRadius: "6px",
                  fontSize: "0.82rem",
                  fontWeight: currentTab === "VALID" ? 700 : 500,
                  border: "none",
                  background: currentTab === "VALID" ? "#16a34a" : "transparent",
                  color: currentTab === "VALID" ? "#ffffff" : "#475569",
                  cursor: "pointer",
                }}
              >
                ✓ Listos ({validItems.length})
              </button>
              {warningItems.length > 0 && (
                <button
                  type="button"
                  onClick={() => setCurrentTab("WARNINGS")}
                  style={{
                    padding: "0.35rem 0.75rem",
                    borderRadius: "6px",
                    fontSize: "0.82rem",
                    fontWeight: currentTab === "WARNINGS" ? 700 : 500,
                    border: "none",
                    background: currentTab === "WARNINGS" ? "#d97706" : "transparent",
                    color: currentTab === "WARNINGS" ? "#ffffff" : "#475569",
                    cursor: "pointer",
                  }}
                >
                  ⚠️ Advertencias ({warningItems.length})
                </button>
              )}
              {errorItems.length > 0 && (
                <button
                  type="button"
                  onClick={() => setCurrentTab("ERRORS")}
                  style={{
                    padding: "0.35rem 0.75rem",
                    borderRadius: "6px",
                    fontSize: "0.82rem",
                    fontWeight: currentTab === "ERRORS" ? 700 : 500,
                    border: "none",
                    background: currentTab === "ERRORS" ? "#dc2626" : "transparent",
                    color: currentTab === "ERRORS" ? "#ffffff" : "#475569",
                    cursor: "pointer",
                  }}
                >
                  ❌ Errores ({errorItems.length})
                </button>
              )}
            </div>

            {/* TABLA DE VISTA PREVIA */}
            <div className="confirm-modal-table-wrap" style={{ flex: 1, minHeight: "220px", maxHeight: "380px", overflowY: "auto" }}>
              <table className="confirm-modal-table" style={{ width: "100%", fontSize: "0.85rem" }}>
                <thead>
                  <tr>
                    <th style={{ width: "50px" }}>Fila</th>
                    <th>Estado</th>
                    <th>Producto (Catálogo)</th>
                    <th>Rubro</th>
                    <th style={{ textAlign: "right" }}>Stock Depósito</th>
                    <th style={{ width: "110px", textAlign: "center" }}>Cantidad a pedir</th>
                    <th style={{ width: "60px", textAlign: "center" }}>Acción</th>
                  </tr>
                </thead>
                <tbody>
                  {displayedItems.map((item, idx) => {
                    const originalIdx = editedItems.findIndex((x) => x.rowNumber === item.rowNumber && x.articleId === item.articleId);
                    const isShort = item.stockDepot !== null && item.requestedQuantity > item.stockDepot;
                    const isDirectSupplier = item.supplyMode === "DIRECT_SUPPLIER";

                    let statusBadge = (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: "0.25rem", padding: "0.2rem 0.5rem", borderRadius: "4px", background: "#f0fdf4", color: "#166534", fontSize: "0.75rem", fontWeight: 600 }}>
                        ✓ Listo
                      </span>
                    );

                    if (item.status === "WARNING_MATCHED_BY_NAME") {
                      statusBadge = (
                        <span style={{ display: "inline-flex", alignItems: "center", gap: "0.25rem", padding: "0.2rem 0.5rem", borderRadius: "4px", background: "#fef3c7", color: "#92400e", fontSize: "0.75rem", fontWeight: 600 }} title={item.message}>
                          ⚠️ Por nombre
                        </span>
                      );
                    } else if (item.status === "WARNING_DUPLICATE") {
                      statusBadge = (
                        <span style={{ display: "inline-flex", alignItems: "center", gap: "0.25rem", padding: "0.2rem 0.5rem", borderRadius: "4px", background: "#fef3c7", color: "#92400e", fontSize: "0.75rem", fontWeight: 600 }} title={item.message}>
                          ⚠️ Duplicado
                        </span>
                      );
                    } else if (item.status === "WARNING_DIRECT_SUPPLIER") {
                      statusBadge = (
                        <span style={{ display: "inline-flex", alignItems: "center", gap: "0.25rem", padding: "0.2rem 0.5rem", borderRadius: "4px", background: "#fef3c7", color: "#92400e", fontSize: "0.75rem", fontWeight: 600 }} title={item.message}>
                          ⚠️ Prov. Directo
                        </span>
                      );
                    } else if (item.status.startsWith("ERROR_")) {
                      statusBadge = (
                        <span style={{ display: "inline-flex", alignItems: "center", gap: "0.25rem", padding: "0.2rem 0.5rem", borderRadius: "4px", background: "#fef2f2", color: "#991b1b", fontSize: "0.75rem", fontWeight: 600 }} title={item.message}>
                          ❌ Error
                        </span>
                      );
                    }

                    return (
                      <tr key={`${item.rowNumber}-${item.articleId}`} style={{ opacity: item.isExcluded ? 0.4 : 1 }}>
                        <td style={{ color: "#64748b", fontSize: "0.8rem" }}>#{item.rowNumber}</td>
                        <td>
                          {statusBadge}
                          {item.message && (
                            <div style={{ fontSize: "0.72rem", color: "#64748b", marginTop: "0.15rem" }}>
                              {item.message}
                            </div>
                          )}
                        </td>
                        <td>
                          <strong>{item.catalogDescription}</strong>
                          <div style={{ fontSize: "0.75rem", color: "#64748b" }}>
                            Cód. #{item.articleId} {item.detectedCode && item.detectedCode !== String(item.articleId) ? `(Excel: ${item.detectedCode})` : ""}
                            {item.supplierCode ? ` · Prov. ${item.supplierCode}` : ""}
                            {item.presentationDisplay ? ` · ${item.presentationDisplay}` : ""}
                          </div>
                          {isDirectSupplier && (
                            <span style={{ display: "inline-block", fontSize: "0.7rem", color: "#b45309", background: "#fef3c7", padding: "0.1rem 0.35rem", borderRadius: "3px", marginTop: "0.15rem" }}>
                              ⚠️ Abastecido por proveedor directo
                            </span>
                          )}
                        </td>
                        <td>
                          <span className="rubro-tag">{item.rubro || "Sin rubro"}</span>
                        </td>
                        <td style={{ textAlign: "right", color: isShort ? "#dc2626" : "#0f172a" }}>
                          {item.stockDepot !== null ? `${unitsFmt.format(item.stockDepot)} u.` : "-"}
                          {isShort && <div style={{ fontSize: "0.7rem", color: "#dc2626" }}>Pide más de lo disponible</div>}
                        </td>
                        <td style={{ textAlign: "center" }}>
                          <input
                            type="number"
                            min="0"
                            step="any"
                            value={item.requestedQuantity}
                            onChange={(e) => updateItemQty(originalIdx, parseFloat(e.target.value) || 0)}
                            style={{
                              width: "80px",
                              padding: "0.3rem",
                              textAlign: "center",
                              border: "1px solid #cbd5e1",
                              borderRadius: "6px",
                              fontWeight: 600,
                            }}
                          />
                        </td>
                        <td style={{ textAlign: "center" }}>
                          <button
                            type="button"
                            onClick={() => toggleExcludeItem(originalIdx)}
                            title={item.isExcluded ? "Volver a incluir" : "Descartar fila"}
                            style={{
                              background: "none",
                              border: "none",
                              cursor: "pointer",
                              fontSize: "1rem",
                              color: item.isExcluded ? "#16a34a" : "#94a3b8",
                            }}
                          >
                            {item.isExcluded ? "↩" : "🗑️"}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* SECCIÓN DE FILAS NO ENCONTRADAS / ERRORES DE DETECCIÓN */}
            {previewData.unmatchedRows && previewData.unmatchedRows.length > 0 && (
              <div
                style={{
                  background: "#fff1f2",
                  border: "1px solid #fecdd3",
                  borderRadius: "8px",
                  padding: "0.75rem 1rem",
                  fontSize: "0.82rem",
                  color: "#9f1239",
                }}
              >
                <strong>⚠️ {previewData.unmatchedRows.length} fila(s) no pudieron ser reconocidas automáticamente:</strong>
                <div style={{ maxHeight: "100px", overflowY: "auto", marginTop: "0.35rem" }}>
                  {previewData.unmatchedRows.map((err, i) => (
                    <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "0.2rem 0", borderBottom: "1px dotted #fda4af" }}>
                      <span>
                        Fila #{err.rowNumber}: {err.rawCode ? `Cód. ${err.rawCode} - ` : ""}{err.rawDescription || "Sin descripción"} ({err.rawQuantity || "sin cantidad"})
                      </span>
                      <span style={{ fontWeight: 600 }}>{err.error}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* BLOQUE DE CONTROL DE ERRORES / IMPORTACIÓN PARCIAL */}
            {hasBlockingErrors && (
              <div
                style={{
                  background: "#fffbeb",
                  border: "1px solid #fde68a",
                  borderRadius: "8px",
                  padding: "0.75rem 1rem",
                  fontSize: "0.85rem",
                  color: "#92400e",
                  display: "flex",
                  alignItems: "center",
                  gap: "0.75rem",
                }}
              >
                <input
                  type="checkbox"
                  id="allow-partial"
                  checked={allowPartialImport}
                  onChange={(e) => setAllowPartialImport(e.target.checked)}
                  style={{ width: "18px", height: "18px", cursor: "pointer" }}
                />
                <label htmlFor="allow-partial" style={{ cursor: "pointer", fontWeight: 500 }}>
                  Comprendo que existen filas con errores. Deseo importar exclusivamente los <strong>{validItems.length} productos válidos</strong> ({unitsFmt.format(totalUnitsCalculated)} u.) y omitir las filas problemáticas.
                </label>
              </div>
            )}

            {/* NOTAS DEL PEDIDO */}
            <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
              <label htmlFor="order-notes" style={{ fontSize: "0.85rem", color: "#475569", fontWeight: 600, whiteSpace: "nowrap" }}>
                Nota / Referencia:
              </label>
              <input
                id="order-notes"
                type="text"
                placeholder="Ej. Planilla semanal Depósito Centro 12-9"
                value={orderNotes}
                onChange={(e) => setOrderNotes(e.target.value)}
                style={{
                  flex: 1,
                  padding: "0.4rem 0.75rem",
                  border: "1px solid #cbd5e1",
                  borderRadius: "6px",
                  fontSize: "0.85rem",
                }}
              />
            </div>

            {/* FOOTER ACTIONS */}
            <div className="confirm-modal-footer" style={{ flexShrink: 0, marginTop: "0.5rem" }}>
              <button
                type="button"
                className="order-secondary"
                disabled={confirming}
                onClick={() => {
                  setStep("UPLOAD");
                  setSelectedFile(null);
                  setPreviewData(null);
                }}
              >
                ← Subir otro archivo
              </button>
              <button
                type="button"
                className="order-primary"
                disabled={!canConfirm || confirming}
                onClick={handleConfirmImport}
                style={{
                  opacity: !canConfirm || confirming ? 0.6 : 1,
                  cursor: !canConfirm || confirming ? "not-allowed" : "pointer",
                }}
              >
                {confirming
                  ? "Creando pedido..."
                  : `✓ Confirmar e importar pedido (${validItems.length} productos · ${unitsFmt.format(totalUnitsCalculated)} u.)`}
              </button>
            </div>
          </div>
        )}

        {/* STEP 4: SUCCESS */}
        {step === "SUCCESS" && createdOrder && (
          <div style={{ padding: "2.5rem 1rem", textAlign: "center", display: "grid", gap: "1rem" }}>
            <div style={{ fontSize: "3.5rem" }}>🎉</div>
            <h2 style={{ margin: 0, color: "#166534", fontSize: "1.5rem" }}>
              ¡Pedido #{createdOrder.orderNumber} creado exitosamente!
            </h2>
            <p style={{ margin: 0, color: "#475569", fontSize: "0.95rem" }}>
              Se generó la solicitud confirmada a Depósito con <strong>{createdOrder.itemsCount} productos</strong> por un total de <strong>{unitsFmt.format(createdOrder.totalUnits)} unidades</strong>.
            </p>

            <div
              style={{
                background: "#f8fafc",
                border: "1px solid #e2e8f0",
                borderRadius: "8px",
                padding: "1rem",
                margin: "0.5rem auto",
                maxWidth: "360px",
                fontSize: "0.88rem",
                textAlign: "left",
                display: "grid",
                gap: "0.4rem",
              }}
            >
              <div><strong>Nº de Pedido:</strong> #{createdOrder.orderNumber}</div>
              <div><strong>Sucursal de origen:</strong> {branchName}</div>
              <div><strong>Destino:</strong> Depósito Central</div>
              <div><strong>Planificación:</strong> {planningDate}</div>
              <div><strong>Estado:</strong> Confirmado (Listo para preparar)</div>
            </div>

            <div style={{ display: "flex", justifyContent: "center", gap: "1rem", marginTop: "1rem" }}>
              <button
                type="button"
                className="order-primary"
                onClick={() => {
                  resetAndClose();
                  router.push(`/orders/${createdOrder.id}`);
                }}
              >
                Ver pedido en Mis Pedidos
              </button>
              <button
                type="button"
                className="order-secondary"
                onClick={() => {
                  resetAndClose();
                  router.refresh();
                }}
              >
                Cerrar
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
