# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Mónica opera la sucursal MOSTRADOR y necesita entender el estado comercial y de stock sin revisar el histórico técnico.

## Product Purpose

Dashboard de gestión para interpretar unidades netas, movimientos, productos, stock y salud de la sincronización usando datos reales de PostgreSQL.

## Positioning

Centraliza una capa analítica validada sobre movimientos reales: las unidades netas aplican VT positivo e IN negativo, sin presentar métricas monetarias no confirmadas.

## Operating Context

Uso diario en desktop, tablet y móvil para revisar un período, detectar faltantes y confirmar que el pipeline sigue actualizado.

## Capabilities and Constraints

- Next.js y API Route Handlers existentes.
- El frontend consume exclusivamente los endpoints `/api/dashboard/*` implementados.
- No se exponen credenciales ni se accede a PostgreSQL desde el cliente.
- No se muestran facturación, margen, IA, WhatsApp ni umbrales arbitrarios de stock bajo.

## Evidence on Hand

Los endpoints devuelven datos reales para la organización La Casa del Kioskero, sucursal MOSTRADOR. No existen assets de marca ni reglas de freshness confirmadas.

## Product Principles

- Priorizar lectura rápida y acciones de seguimiento sobre decoración.
- Distinguir claramente datos reales, ausencia de datos y fallos de carga.
- Mantener el alcance preparado para futuras sucursales sin falsear el contexto actual.
- Hacer visible la calidad y actualización de los datos.

## Accessibility & Inclusion

Interfaz navegable por teclado, con semántica, estados visibles y contraste suficiente. Las tablas deben seguir siendo consultables en pantalla pequeña.
