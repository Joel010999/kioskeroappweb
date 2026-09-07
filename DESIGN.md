# Design System

## Dashboard de Monica

El producto usa una interfaz de operación luminosa y sobria: lectura secuencial, información densa pero respirable y color reservado para estado, foco y evolución. No se utiliza una retícula de tarjetas decorativas como estructura principal.

## Tokens

- Fondo: `#f4f6fa`; superficies: blanco; tinta: `#17233b`.
- Acento interactivo: violeta `#7267d7`.
- Estados: verde `#34a886`, aviso cálido `#d69834`, atención `#c65273`.
- Tipografía: Source Sans 3 Variable, con títulos de alto contraste por peso y escala, no por tratamientos decorativos.
- Bordes: `#dce2ec`, 1px; radios pequeños de 6-7px; sombras evitadas salvo que una futura capa lo necesite para jerarquía real.

## Componentes

- La cabecera reúne identidad, sucursal, navegación y actualización.
- Los KPIs forman una banda de lectura y se reordenan en dos columnas en móvil.
- Los paneles responden una pregunta operativa concreta y contienen estados de carga, error y vacío.
- Las etiquetas de stock comunican únicamente disponibilidad o falta de stock; no infieren umbrales bajos.

## Responsive

Desktop prioriza una señal de unidades netas, una evolución de alto contraste y contexto operativo comprimido. En móvil se priorizan métricas, período, gráfico, productos, stock y luego detalle técnico; la tabla de stock se convierte en fichas de atributos para conservar lectura táctil.
