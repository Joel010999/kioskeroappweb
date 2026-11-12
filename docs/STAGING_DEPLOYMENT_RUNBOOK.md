# Runbook de Despliegue y Validación — Entorno STAGING (`KioskeroAppWeb`)

> **Regla absoluta:** Todo lo descripto aquí se ejecuta **exclusivamente** en el entorno `staging` dentro del proyecto oficial de Railway, sobre una base PostgreSQL nueva e independiente, con la rama Git `staging` y el bot de WhatsApp **sin vincular** al número de Mónica. **Producción (`main` / ambiente `production`) no se toca.**

---

## 1. Arquitectura Aislada en Railway (Proyecto Oficial)

Dentro del proyecto oficial `kioskeroappweb` en Railway:

1. **Environment:** `staging` (creado limpio o con servicios independientes `kioskeroapp-staging` + `kioskeroapp-staging-db`).
2. **Rama conectada en `kioskeroapp-staging`:** `staging` (nunca `main`).
3. **PostgreSQL (`kioskeroapp-staging-db`):** instancia nueva e independiente (NO usar `DATABASE_URL` de `production`).
4. **WhatsApp Worker:** **NO desplegar / NO vincular** (`WHATSAPP_PAIRING_NUMBER=` vacío, 0 credenciales en `whatsapp_baileys_session`). Las capacidades del bot se validan mediante tests y consultas directas sin Baileys activo.

---

## 2. Variables de Entorno en Railway (`staging`)

Configurar en el servicio Web `kioskeroapp-staging` tomando como plantilla [`.env.staging.example`](../.env.staging.example):

| Variable | Valor en `staging` | Notas de aislamiento |
| :--- | :--- | :--- |
| `DATABASE_URL` | Reference a `${{kioskeroapp-staging-db.DATABASE_URL}}` | Verificar host/servicio de staging, **jamás** producción |
| `POSTGRES_SSL` | `true` | TLS activo en Railway |
| `AUTH_SESSION_SECRET` | Nuevo secreto aleatorio 64 hex | Generado nuevo; no reutilizar el de producción |
| `DASHBOARD_ORGANIZATION_ID` | `1` | Coincide con `organizations.id = 1` de staging |
| `DASHBOARD_SOURCE_ID` | *(vacío)* | Permite resolver por sucursal desde tabla `sources` |
| `DASHBOARD_BRANCH_ID` | *(vacío)* | Resuelve `1` Depósito, `2` Centro, `3` Jardín por usuario |
| `ALLOW_DEVELOPMENT_SESSION` | *(vacío / `false`)* | Nunca habilitar login de desarrollo |
| `WHATSAPP_PAIRING_NUMBER` | *(vacío)* | Obligatorio vacío para no emparejar ningún teléfono |
| `WHATSAPP_ALLOWED_NUMBERS` | `+5490000000001` | Sólo número ficticio de QA |
| `WHATSAPP_SESSION_ENCRYPTION_KEY` | Nuevo secreto aleatorio 64 hex (o vacío) | Nunca usar la clave real de producción |
| `LOG_LEVEL` | `info` | Opcional |

---

## 3. Tablas Externas de Alegón (Bootstrap Requerido Antes del Primer Deploy)

[`railway.toml`](../railway.toml) ejecuta automáticamente `preDeployCommand = "npm run db:migrate"`, que aplica [`migrations/001..019`](../migrations) en orden lexicográfico.

En una base PostgreSQL nueva de Railway, **5 tablas externas de Alegón** no son creadas por `migrations/001..019` porque en producción las sincroniza el conector externo:

1. `organizations` (requerida desde `004_authorization_foundation.sql` y `006`, `007`, `008`, `011`, `018`, `019`).
2. `sources` (consultada por [`src/server/auth/sources.ts`](../src/server/auth/sources.ts) y [`src/server/inventory/freshness.ts`](../src/server/inventory/freshness.ts)).
3. `products_raw` (consultada por `007`, `009` y todo el catálogo/reposición).
4. `stock_levels_raw` (consultada por stock, dashboard, reposición semanal y bot).
5. `stock_movements_raw` (consultada por demanda, historial, reglas de suministro y frescura).

El DDL idempotente y validado se encuentra en [`scripts/staging/bootstrap.sql`](../scripts/staging/bootstrap.sql) y el inicializador integral en [`scripts/staging/init-staging.mjs`](../scripts/staging/init-staging.mjs).

### Protecciones anti-producción incorporadas en `init-staging.mjs`

1. Exige `STAGING_CONFIRM_ISOLATED=true` explícito.
2. Rechaza cualquier entorno con `RAILWAY_ENVIRONMENT_NAME=production` o `RAILWAY_SERVICE_NAME` productivo.
3. Exige `WHATSAPP_PAIRING_NUMBER` vacío.
4. Inspecciona la DB destino antes de escribir: **aborta inmediatamente** si `organizations.id=1` no se llama `'La Casa del Kioskero [STAGING SYNTHETIC]'`, si hay `products_raw` con `source_id` distinto de `staging_%`, o si existe alguna sesión real en `whatsapp_baileys_session`.

---

## 4. Secuencia Exacta de Despliegue (Cuando Tengamos Acceso a Railway)

### Paso A — Crear recursos aislados en Railway (environment `staging`)
1. Crear `kioskeroapp-staging-db` (PostgreSQL).
2. Obtener la `DATABASE_PUBLIC_URL` temporal de `kioskeroapp-staging-db` (solo para inicializar desde CLI).

### Paso B — Inicializar Bootstrap + Migraciones + Seed Sintético en `kioskeroapp-staging-db`
Desde la raíz del repo (`c:\Renderbyte\Monica`, rama `staging`):

```powershell
$env:STAGING_DATABASE_URL="<PUBLIC_URL_DE_STAGING_DB>"
$env:STAGING_CONFIRM_ISOLATED="true"
$env:STAGING_TEST_PASSWORD="StagingQA!2026"
$env:WHATSAPP_PAIRING_NUMBER=""

npm run staging:init
```

Esto ejecuta secuencialmente:
1. `--phase=bootstrap`: crea las 5 tablas externas, inserta `organizations (id=1)` marcado `[STAGING SYNTHETIC]` y `sources` activas (`staging_deposito`, `staging_centro`, `staging_jardin`).
2. `--phase=migrate`: aplica `001_orders.sql` hasta `019_article_history_cutoffs.sql` en orden estricto dentro de `renderbyte_schema_migrations`.
3. `--phase=seed`: inserta de forma 100% idempotente los 28 artículos sintéticos (`1001`–`1028`), stock por sucursal, movimientos semanales (`VT`/`IN`/`AJUS` + fila edge no numérica), proveedores (`50350`, `50100`, `50200`, `50400`), reglas de suministro, ejemplos de stock base/pedidos pendientes y usuarios QA con password `scrypt`.
4. `--phase=verify`: valida conteos, integridad de migraciones (`19/19`), `0` productos fuera de `staging_%` y `0` credenciales reales en `whatsapp_baileys_session`.

### Paso C — Desplegar servicio Web `kioskeroapp-staging`
1. Conectar al repo `Joel010999/kioskeroappweb`, rama **`staging`**.
2. Cargar las variables de entorno de la Sección 2 (`DATABASE_URL` apuntando a `kioskeroapp-staging-db`).
3. Ejecutar deploy. `railway.toml` correrá `npm run db:migrate` (verificando que `001`..`019` ya están aplicadas) e iniciará Next.js (`npm run start`).

---

## 5. Usuarios y Datos Ficticios de Prueba (`staging`)

### Usuarios QA provisionados

| Sucursal | Rol | Email | Branch ID | Source ID |
| :--- | :--- | :--- | :---: | :--- |
| CENTRO | `PV_OPERATOR` | `centro@gmail.com` | `2` | `staging_centro` |
| JARDÍN | `PV_OPERATOR` | `jardin@gmail.com` | `3` | `staging_jardin` |
| DEPÓSITO | `WAREHOUSE_OPERATOR` | `deposito@gmail.com` | `1` | `staging_deposito` |

*Contraseña inicial sintética configurable vía `STAGING_TEST_PASSWORD` (por defecto `StagingQA!2026`).*

### Catálogo Sintético Clave (Artículos `1001`–`1028`)

| Artículo | Caso QA cubierto |
| :---: | :--- |
| `1001` | Demanda semanal normal (8 semanas activas), proveedor `50350`, stock bajo en Centro |
| `1002` | **Proveedor `50350` activo SIN historial de ventas** (stock Depot `24`, Centro `0`) |
| `1003` | **Producto INACTIVO (`Estado='0'`)** proveedor `50350` — debe excluirse por defecto |
| `1004` | **Stock base independiente por sucursal** (`Centro=12`, `Jardín=0 explícito`), coexiste con `Stopti='18'` |
| `1005` | **Código reutilizado**: pedido histórico `'ALFAJOR VIEJO REUTILIZADO 50G'` vs `'GALLETITA CODIGO REUTILIZADO 200G'` (`ORDER_SNAPSHOT_DIFF` + prueba de corte histórico) |
| `1006` | **Tolerancia de espacios**: `'GASEOSA STAGING COLA 500 ML'` vs `'500ML'` — NO debe generar falso positivo |
| `1007` | **Pedidos internos pendientes aislados**: Centro (`5u` `IN_PREPARATION`) y Jardín (`4u` `CONFIRMED`) sin duplicación ni mezcla entre sucursales |
| `1008`–`1019` | 12 artículos adicionales de `50350` para superar `WHATSAPP_PAGE_SIZE=10` y probar paginación (`ver más`, `siguiente`, `ver todos`, `página N`) y exportación Excel |
| `1025` | Stock negativo (`-2`) para probar alertas y hoja de stock negativo en Excel |
| `1026` | Stock agotado (`0`) con ventas recientes |
| `1027`–`1028` | Rubro `FIGURITAS` (`Clasificacion=017...`) |
| `NO-NUM-TEST` | Fila en `stock_movements_raw` con `idarti` no numérico para verificar el filtro regex `^[0-9]+$` en PostgreSQL real |

---

## 6. Checklist de Validación Obligatoria en `staging` (Pre-Aprobación a `main`)

1. **Migraciones:** verificar `renderbyte_schema_migrations` (`001`..`019`), FKs, índices y ausencia de errores en logs de `preDeployCommand`.
2. **Autenticación y Permisos:** login con `centro@gmail.com`, `jardin@gmail.com` y `deposito@gmail.com`; confirmar rechazo `401/403` entre sucursales (`Centro` no edita `Jardín`, `Depósito` tiene alcance warehouse y rechazado en rutas exclusivas de PV si aplica).
3. **Stock Base (`/base-stock` + `/api/base-stock`):**
   - Consultar Centro vs Jardín en `1004` (`12` vs `0`).
   - Configurar un nuevo artículo con valor positivo, luego `0` explícito, editar preservando `notes`, y eliminar configuración verificando retorno a `null` (sin configuración).
4. **Reposición Semanal (`/replenishment` + `/api/replenishment/weekly`):**
   - Verificar que `1002` aparece en catálogo completo/proveedor `50350` y `1003` se excluye salvo filtro inactivos.
   - Confirmar en `1007` que Centro descuenta solo su pedido pendiente (`5u`) y no las `4u` de Jardín, mientras `depot_committed` suma ambos si corresponden al depósito.
5. **Cortes Históricos (`/api/history-cutoffs`):**
   - Verificar alerta `ORDER_SNAPSHOT_DIFF` para `1005` y **0 alertas** para `1006`.
   - Aplicar fecha de corte en `1005`, comprobar recalculo excluyendo ventas pre-corte, y limpiar corte al finalizar prueba.
6. **Bot / Excel (sin Baileys conectado):**
   - Verificar `/api/admin/whatsapp/pairing` devuelve `{ status: "unlinked" }` (confirmando bot desvinculado).
   - Ejecutar smoke tests de queries y generación real de `.xlsx` contra `STAGING_DATABASE_URL` verificando múltiples hojas, paginación y resultados completos de proveedor `50350` sin límite fijo de 50 filas.
7. **UI Desktop / Tablet / Mobile:** login real en URL pública de `kioskeroapp-staging`, navegar por `/dashboard`, `/replenishment`, `/base-stock`, `/orders`, `/supply-rules`.
8. **Gate final:** sólo tras completar 1–7 sin regresiones se autoriza merge/push hacia `main`.

