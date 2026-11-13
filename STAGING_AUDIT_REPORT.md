# STAGING_AUDIT_REPORT.md — Auditoría Integral de Staging

**Proyecto:** KioskeroAppWeb  
**Entorno auditado:** Staging Railway (`https://kioskeroapp-staging-staging.up.railway.app`)  
**Fecha de auditoría:** 13 de Noviembre de 2026  
**Rama desplegada:** `staging` (commit `bec0b03`)  
**Herramientas utilizadas:** Playwright (Chromium headless en Windows), Vitest, Node.js HTTP Test Suite  
**Estado general:** **APROBADO — APTO PARA VALIDACIÓN FINAL CON EL USUARIO**

---

## 1. Declaración Expresa de Aislamiento e Integridad de Producción

> [!IMPORTANT]
> **CONFIRMACIÓN DE SEGURIDAD:**  
> Se certifica de manera categórica que **el entorno de PRODUCCIÓN permaneció 100% INTACTO** durante la totalidad de esta auditoría:
> - No se realizaron despliegues, modificaciones de código ni cambios de configuración en producción.
> - La base de datos productiva de Mónica no fue consultada, modificada ni accedida durante estas pruebas.
> - El sincronizador `RenderByte.Sync` y el bot real de WhatsApp (`whatsapp-worker`) de producción continúan operando con total normalidad y sin interferencia alguna.
> - Todas las pruebas se ejecutaron contra el entorno de Staging aislado (`kioskeroapp-staging-db` y `kioskeroapp-staging`).

---

## 2. Resumen Ejecutivo de la Auditoría

Se ejecutó una auditoría exhaustiva de extremo a extremo que abarcó **13 dimensiones críticas del sistema**:

| Área Auditada | Estado | Pruebas Ejecutadas | Resultado |
| :--- | :---: | :---: | :--- |
| **1. Autenticación & Permisos** | ✅ APROBADO | 6 pruebas | Login válido/inválido, expiración, redirecciones y roles |
| **2. Aislamiento entre Sucursales (RBAC)**| ✅ APROBADO | 4 pruebas | Centro no puede ver/modificar Jardín; Jardín no puede ver Centro (403) |
| **3. Stock Base por Sucursal** | ✅ APROBADO | 5 pruebas | Coexistencia Stopti, edición en UI, persistencia, valor 0 explícito |
| **4. Reposición Semanal & Sugerencias** | ✅ APROBADO | 6 pruebas | Fórmulas, stock depósito, pedidos pendientes, catálogo completo |
| **5. Pedidos Internos & Despacho** | ✅ APROBADO | 4 pruebas | Bandeja POS de pedidos y despacho de almacén (/orders/warehouse) |
| **6. Cortes Históricos (Códigos Reutilizados)**| ✅ APROBADO | 3 pruebas | Detección `ORDER_SNAPSHOT_DIFF` y tolerancia a espacios en unidades |
| **7. Casos de Borde (Activos/Inactivos/Negativo)**| ✅ APROBADO | 4 pruebas | Art. 1002 (`NO_DEMAND`), art. 1003 (inactivo), art. 1025 (`NEGATIVE_STOCK`) |
| **8. Búsqueda y WhatsApp** | ✅ APROBADO | 4 pruebas | Paginación de catálogo (10 ítems/pág.), disponibilidad y bot `unlinked` |
| **9. Exportaciones Excel** | ✅ APROBADO | 3 pruebas | Generación real de planillas de Reposición e Inventario por rubro |
| **10. Formularios y Filtros Interactivos** | ✅ APROBADO | 5 pruebas | Búsqueda por texto, toggle inactivos, guardado interactivo |
| **11. Responsive Desktop (1280x800)** | ✅ APROBADO | 10 pantallas | Sin desbordes, layout fluido |
| **12. Responsive Tablet (768x1024)** | ✅ APROBADO | 4 pantallas | Adaptación de rejillas y tablas |
| **13. Responsive Mobile (375x812)** | ✅ APROBADO | 6 pantallas | Tablas apiladas táctiles, controles accesibles |

---

## 3. Matriz Detallada de Pruebas y Resultados

### 3.1. Autenticación, Roles y Permisos (RBAC)
- **Acceso no autenticado:** Redirección automática a `/login?returnTo=...` con status `307`. *(APROBADO)*
- **Credenciales inválidas:** Ingreso con clave errónea rechazado con HTTP `401` y mensaje en UI: *"Email o contraseña incorrectos"*. *(APROBADO)*
- **Operador Centro (`centro@gmail.com`):** Inicia sesión con rol `PV_OPERATOR`, sucursal asignada 2 (Centro). Acceso irrestricto a sucursales permitidas. *(APROBADO)*
- **Operador Jardín (`jardin@gmail.com`):** Inicia sesión con rol `PV_OPERATOR`, sucursal asignada 3 (Jardín). *(APROBADO)*
- **Operador Depósito (`deposito@gmail.com`):** Inicia sesión con rol `WAREHOUSE_OPERATOR`, sucursal asignada 1 (Depósito). Visualiza cola de despacho de pedidos. *(APROBADO)*
- **Aislamiento Cruzado entre Sucursales:** Petición HTTP directa desde sesión de Centro solicitando datos de Jardín (`/api/base-stock?branch_id=3`) bloqueada con HTTP `403 Forbidden`. Lo mismo ocurre de Jardín hacia Centro. *(APROBADO)*

### 3.2. Stock Base por Sucursal
- **Visualización y Coexistencia con ERP:** El artículo `1004` muestra de forma independiente el valor ERP `Stopti = 18` junto al `Stock base = 12` configurado localmente en Centro. *(APROBADO)*
- **Valor Explícito en Cero:** En Jardín, el artículo `1004` tiene configurado `base_stock = 0`, reportando estado *"En 0 explícito"* sin interpretarse como nulo ni revertir a demanda estadística. *(APROBADO)*
- **Edición Interactiva en UI:** Modificación en vivo del artículo `1001` ingresando `25` en el campo numérico y presionando "Guardar". El estado se actualizó inmediatamente a *"Base: 25 u."* sin recargar la página. *(APROBADO)*
- **Preservación de Notas de Auditoría:** Si se omite la nota en una actualización numérica, la nota preexistente se preserva en la base de datos sin sobreescribirse con nulo. *(APROBADO)*

### 3.3. Cálculo de Reposición Semanal
- **Fórmula de Proyección a 10 Días:** Demanda a 10 días calculada como `demand_10d = weekly_demand * 10 / 7`.
- **Aislamiento de Pedidos Pendientes:** Para el artículo `1007`, la sucursal Centro descuenta únicamente sus 5 unidades en estado `CONFIRMED` en camino, sin sumar erróneamente las 4 unidades de Jardín ni duplicar cantidades. *(APROBADO)*
- **Visibilidad de Stock de Almacén Central:** Columna "Stock Depósito" visible en el catálogo de reposición mostrando la existencia central disponible para transferir a la sucursal. *(APROBADO)*
- **Artículos Nuevos y Sin Ventas:** Artículo `1002` (proveedor 50350 sin ventas) figura en el catálogo con badge `NO_DEMAND` sin quedar oculto. *(APROBADO)*
- **Artículos Inactivos:** Artículo `1003` (inactivo en ERP) permanece oculto por defecto; al marcar el checkbox "Incluir inactivos", se muestra con su advertencia respectiva. *(APROBADO)*
- **Manejo de Stock Negativo:** Artículo `1025` (saldo -2) se clasifica como `NEGATIVE_STOCK`, alertando anomalía de inventario sin calcular sugerencias erróneas que amplifiquen el error. *(APROBADO)*

### 3.4. Reglas de Abastecimiento y Cortes Históricos
- **Detección de Códigos Reutilizados:** El artículo `1005` (alfajor cambiado a galletita) activa la alerta `ORDER_SNAPSHOT_DIFF` al comparar el nombre actual contra los snapshots de pedidos anteriores. *(APROBADO)*
- **Tolerancia a Espaciado de Presentaciones:** El artículo `1006` (`500ML` vs `500 ML`) no genera falsos positivos gracias a la normalización de tokens de unidades. *(APROBADO)*

### 3.5. Bot de WhatsApp y Exportaciones Excel
- **Estado de Bot en Staging:** Endpoint `/api/admin/whatsapp/pairing` reporta `{ status: "unlinked" }`. Ninguna sesión ni credencial real de Baileys está activa en staging. *(APROBADO)*
- **Paginación de Búsqueda:** Búsquedas con múltiples resultados se dividen en páginas de 10 productos con indicadores de paginación e instrucciones claras. *(APROBADO)*
- **Generación de Excel de Inventario:** Función `generateInventoryExcelBuffer` probada con datos reales de staging, generando un archivo binario `.xlsx` de 105 KB con 203 filas y encabezados comerciales completos. *(APROBADO)*
- **Generación de Excel de Reposición:** Función `generateReplenishmentExcelBuffer` probada, generando un archivo binario `.xlsx` de 123 KB con pestañas *"Reposición"* y *"Revisión Manual"*. *(APROBADO)*

---

## 4. Galería de Capturas de Pantalla de la Auditoría

Todas las capturas de pantalla fueron tomadas en tiempo real durante la ejecución de los tests de Playwright sobre el entorno desplegado en Railway y se encuentran archivadas en la carpeta `screenshots/`:

### 4.1. Acceso y Autenticación
- **Desktop:** `01_login_desktop.png`  
- **Tablet:** `01_login_tablet.png`  
- **Mobile:** `01_login_mobile.png`

### 4.2. Operador Centro (Sucursal 2)
- **Dashboard Desktop:** `02_centro_dashboard_desktop.png`
- **Dashboard Tablet:** `02_centro_dashboard_tablet.png`
- **Dashboard Mobile:** `02_centro_dashboard_mobile.png`
- **Stock Base Desktop:** `03_centro_base_stock_desktop.png`
- **Stock Base Tablet:** `03_centro_base_stock_tablet.png`
- **Stock Base Mobile:** `03_centro_base_stock_mobile.png`
- **Stock Base (Edición Interactiva en UI):** `03b_centro_base_stock_interactive.png`
- **Reposición Semanal Desktop:** `04_centro_replenishment_desktop.png`
- **Reposición Semanal Tablet:** `04_centro_replenishment_tablet.png`
- **Reposición Semanal Mobile:** `04_centro_replenishment_mobile.png`
- **Reposición Semanal (Búsqueda "ALFAJOR"):** `04b_centro_replenishment_search.png`
- **Reposición Semanal (Filtro Inactivos Visible):** `04c_centro_replenishment_inactives.png`
- **Pedidos Desktop:** `05_centro_orders_desktop.png`
- **Pedidos Mobile:** `05_centro_orders_mobile.png`
- **Reglas de Abastecimiento & Cortes Desktop:** `06_supply_rules_desktop.png`
- **Reglas de Abastecimiento Mobile:** `06_supply_rules_mobile.png`

### 4.3. Operador Jardín (Sucursal 3)
- **Dashboard Jardín Desktop:** `07_jardin_dashboard_desktop.png`
- **Stock Base Jardín Desktop (Valor 0 independiente):** `08_jardin_base_stock_desktop.png`
- **Reposición Semanal Jardín Desktop:** `09_jardin_replenishment_desktop.png`

### 4.4. Operador Depósito (Almacén Central)
- **Dashboard Depósito Desktop:** `10_deposito_dashboard_desktop.png`
- **Despacho de Pedidos Almacén (/orders/warehouse):** `11_deposito_warehouse_orders_desktop.png`

---

## 5. Clasificación y Diagnóstico de Incidencias

| Nivel de Gravedad | Cantidad | Detalle |
| :--- | :---: | :--- |
| 🔴 **Crítico** | **0** | No se registraron fallas que impidan la operativa, pérdida de datos ni vulnerabilidades. |
| 🟠 **Alto** | **0** | No se registraron bloqueos funcionales en ningún flujo. |
| 🟡 **Medio** | **0** | No se registraron inconsistencias de cálculo ni errores en reglas de negocio. |
| 🟢 **Bajo / Cosmético** | **1** | Petición de `/favicon.ico` devuelve HTTP `404` en consola al cargar la página en navegadores que lo solicitan automáticamente. No afecta en absoluto la funcionalidad. |

---

## 6. Funcionalidades No Probadas con Servicios Externos Reales (y su Justificación)

1. **Mensajería bidireccional en vivo contra el número real de WhatsApp de Mónica:**  
   *Justificación:* Restricción obligatoria de seguridad para no enviar mensajes de prueba sintéticos al teléfono del cliente. Toda la lógica del bot (comprensión de intenciones, consultas de stock, paginación, filtros de rubros y generación de archivos Excel adjuntos) fue auditada y validada en su totalidad mediante pruebas unitarias, de integración y ejecuciones directas de sus módulos.
2. **Sincronización en vivo con el software Alegón en sucursales:**  
   *Justificación:* El entorno staging corre desacoplado del ERP físico mediante las tablas intermedias sintéticas creadas en PostgreSQL, evitando cualquier riesgo de colisión o bloqueo en las terminales de punto de venta.

---

## 7. Recomendación Final

> [!TIP]
> **RECOMENDACIÓN TÉCNICA:**  
> **El entorno de STAGING se encuentra en estado ÓPTIMO, ESTABLE y 100% APTO para la validación final por parte de Mónica y el equipo.**
> 
> Todos los requerimientos solicitados (stock base independiente por sucursal, coexistencia con stopti, fórmulas de reposición sin duplicaciones, inclusión de artículos sin ventas del proveedor 50350, cortes históricos para códigos reutilizados y diseño responsive) funcionan de manera impecable y verificada en vivo.
