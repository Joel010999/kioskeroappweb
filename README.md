# Dashboard de Monica

Base server-side para el dashboard de La Casa del Kioskero. La UI completa queda fuera de esta etapa.

## Configuracion

Copiar `.env.example` a `.env.local` y completar `DATABASE_URL`. Para evitar enviar filtros de alcance en cada request, configurar tambien `DASHBOARD_SOURCE_ID` y `DASHBOARD_BRANCH_ID` en el entorno del servidor.

`DATABASE_URL` nunca se usa desde componentes cliente ni se devuelve por la API.

## Endpoints

- `GET /api/dashboard/overview?from=2026-08-01&to=2026-08-25&source_id=...&branch_id=2`
- `GET /api/dashboard/timeseries?from=2026-08-01&to=2026-08-25&granularity=day&source_id=...&branch_id=2`
- `GET /api/dashboard/products/top?from=2026-08-01&to=2026-08-25&limit=20&search=...&source_id=...&branch_id=2`
- `GET /api/dashboard/stock?limit=50&page=1&depo=2&search=...&low_stock_threshold=...&source_id=...&branch_id=2`
- `GET /api/dashboard/data-health?source_id=...&branch_id=2`

Todas las fechas de movimientos usan `fedepo::timestamp`. El parámetro `to` es inclusivo. `low_stock_threshold` es opcional porque no hay un umbral de negocio definido. El estado de freshness queda como `UNCONFIGURED` hasta configurar los límites `FRESHNESS_WARNING_MINUTES` y `FRESHNESS_ERROR_MINUTES`.

## Verificacion

```bash
npm run typecheck
npm run lint
npm run test
npm run build
```
