# Manual de Uso y Entrega del Sistema

## 1. ¿Qué es el sistema?
El sistema es una plataforma web de analítica y gestión operativa diseñada para administrar el flujo de reposición de mercadería entre Puntos de Venta (PV) y un Depósito central. Su objetivo principal es automatizar el cálculo de demanda sugerida basándose en las ventas históricas (y estacionales) y el stock actual, conectando de forma fluida el pedido de los locales con la preparación y el despacho desde el depósito.

El sistema NO modifica ni descuenta stock automáticamente al realizar despachos; su función es actuar como un "motor de sugerencias" y un gestor de solicitudes (órdenes) para digitalizar la comunicación de reposición.

## 2. Acceso
El acceso se realiza mediante un navegador web a través de la URL de producción configurada. Para ingresar, se requiere iniciar sesión con una cuenta y contraseña autorizadas.

## 3. Usuarios y Permisos
Existen tres roles conceptuales principales en la estructura del sistema:
- **Usuario PV1:** Corresponde al operador de la Sucursal 1.
- **Usuario PV2:** Corresponde al operador de la Sucursal 2.
- **Usuario Depósito:** Corresponde al encargado del depósito central.

### ¿Qué puede hacer el PV?
- Ver el Dashboard (Resumen operativo y stock de su sucursal).
- Ver la pantalla de "Reposición Semanal" para consultar sugerencias y generar pedidos de reposición.
- Revisar y editar las cantidades preseleccionadas antes de confirmarlas.
- Ver la bandeja de "Mis Pedidos" (estado de sus solicitudes).
- Registrar la recepción final de la mercadería cuando llega.
- **NO puede** ver las solicitudes de otras sucursales, ni operar las bandejas del depósito.

### ¿Qué puede hacer el Depósito?
- Ver su Dashboard (operativa del depósito).
- Cargar archivos Excel con la actualización del stock del depósito.
- Entrar a "Operación de depósito" para ver la bandeja unificada de solicitudes de todos los PVs.
- Confirmar, preparar y despachar pedidos.
- **NO puede** generar pedidos para el PV ni registrar recepciones en destino.

## 4. Dashboard
Es la pantalla inicial después de iniciar sesión. 
- **Resumen:** Muestra unidades netas, movimientos, y alertas operativas (productos sin stock).
- **Evolución:** Muestra gráficos del volumen de movimientos.
- **Stock:** Refleja la última foto conocida del stock. 
- En el caso del Depósito, el Dashboard incluye botones directos para "Cargar Stock Depósito" y "Operación de depósito".

## 5. Reposición Semanal
Esta es la pantalla donde el sistema calcula automáticamente cuánto debería pedir cada PV. 
- **Cálculo (YoY):** El sistema analiza la venta de las últimas 6 semanas y la compara con las mismas 6 semanas del año anterior, tomando el valor más alto para recomendar una sugerencia inteligente adaptada a la estacionalidad (ej: protectores solares en verano).
- **Filtro Recomendado:** Seleccionando "A reponer en depósito (Recomendado)", el sistema aísla exclusivamente los productos con sugerencia > 0 y cuyo proveedor designado es el Depósito (o que no están asignados, `UNDEFINED`).

## 6. Revisar y Confirmar Reposición
El usuario del PV usa los filtros para ver la preselección de La Casa del Kioskero. 
- La sugerencia es *solo una recomendación*. El operador puede hacer clic en cualquier casilla de "CANTIDAD A PEDIR" y editar el número a gusto.
- Al final de la página, un botón de **Confirmar reposición** permite enviar esa lista directamente al depósito.

## 7. Mis Pedidos
Pantalla exclusiva del PV que actúa como historial. Aquí el PV puede ver en qué estado están sus solicitudes (Pendiente, En Preparación, Despachado). 
Cuando la orden aparece como **Despachado**, el PV debe entrar para revisar la cantidad que le enviaron y presionar **Registrar Recepción** (lo cual pasa la orden a Completado).

## 8. Carga de Stock del Depósito
Pantalla exclusiva para el Depósito. 
- Permite subir un archivo `.xlsx` (Excel) con el stock actual.
- Este archivo genera un **snapshot** (foto) del stock que La Casa del Kioskero usará únicamente de manera *informativa* para avisar a los PV si el depósito tiene la mercadería que están pidiendo.

## 9. Flujo del Depósito
El usuario del depósito entra a **Operación de Depósito**. Aquí caen las Solicitudes Confirmadas por los PVs.
1. Abre la solicitud y hace clic en **Comenzar Preparación**.
2. Automáticamente el sistema *rellenará* las cantidades de Aprobado y Preparado copiando todo lo que pidió el PV para evitar que el operario escriba todo a mano.
3. Si le falta stock de algo, el operario edita ese número hacia abajo.
4. Luego, hace clic en **Registrar Despacho**, y el sistema autocompleta el envío.

## 10. Excel
El Excel que usa el depósito debe mantener el formato de columnas extraídas originalmente de sus sistemas contables/stock (incluyendo columnas como `idarti` y `saldo`). 
- El sistema procesa la columna de saldo y artículo. 
- La información de este archivo NO altera los saldos reales de caja ni ventas del PV, es puramente para actualizar el *snapshot* informativo del depósito.

## 11. Cómo Funciona el Stock
- **Stock del PV:** Se calcula en tiempo real a partir de los datos transaccionales brutos extraídos del software de facturación original.
- **Stock del Depósito:** Es una foto (snapshot) estática que se actualiza únicamente cuando el depósito sube un Excel. Si el depósito despacha 100 unidades por el sistema, *no* se restan mágicamente del Excel; la foto de stock seguirá igual hasta que el depósito suba el próximo Excel.
- **Cantidades Operativas:** Lo solicitado, aprobado, preparado, despachado y recibido pertenecen exclusivamente a la orden del sistema y no afectan el stock contable automáticamente.

## 12. Flujo Completo Paso a Paso
1. **Depósito:** Sube su Excel de stock para que La Casa del Kioskero sepa qué hay disponible.
2. **PV:** Entra a "Reposición Semanal", filtra por sugeridas para el depósito, edita cantidades si quiere, y toca "Confirmar".
3. **Depósito:** Entra a la Bandeja de Operaciones, abre la orden, toca "Comenzar Preparación" (se auto-llena todo), ajusta las faltantes, y toca "Registrar Despacho".
4. **PV:** Recibe la mercadería física, abre "Mis Pedidos", verifica las cantidades despachadas, y toca "Registrar Recepción" para cerrar el ciclo.

## 13. Problemas Frecuentes
- **"La orden se despachó con ceros":** Ocurría si el operario borraba los números prellenados. Ahora el sistema rellena automáticamente.
- **"El PV no ve el botón de recibir":** La orden debe figurar sí o sí como "Despachada" por el depósito. Si el depósito olvidó despachar, el PV no puede recibir.
- **"Not Found - The train has not arrived at the station":** Error temporal de red/Railway. Indica que el sistema está reiniciando o actualizándose. Refrescar con F5 tras un par de minutos suele resolverlo.
- **"Sugerencia 0 pero se vende":** Puede ser que las reglas de stock meta consideren que el local ya tiene suficiente stock actual para cubrir las próximas semanas.

## 14. Cierre de Sesión
El botón "Cerrar sesión" se encuentra en la parte superior derecha de la barra de navegación, asegurando que el puesto quede bloqueado cuando el operador no esté frente a la pantalla.

## 15. Consideraciones Operativas
- **Uso Diario:** El sistema fue diseñado para agilizar, pero la decisión final siempre es humana. Es fundamental que los encargados revisen la información antes de confirmarla.
- **Backups y Hosting:** Toda la base de datos corre en PostgreSQL gestionado a través de Railway, que maneja backups automatizados de volumen.

## 16. Credenciales de Entrega
Los usuarios configurados en el sistema provienen de la inicialización de la base de datos.
- **Punto de Venta 1:** `pv1@development.local`
- **Punto de Venta 2:** `pv2@development.local`
- **Depósito Central:** `deposito@development.local`

*(NOTA AL CLIENTE: El acceso exacto de las contraseñas depende de lo asignado por el equipo técnico al desplegar producción. En caso de requerir un blanqueo, comunicarse con soporte).*
