# Resumen Rápido - Entrega del Sistema

Este es un resumen compacto con los datos clave para operar el sistema.

### 🌐 Acceso al Sistema
- **URL de Producción:** [https://kioskeroappweb.up.railway.app](https://kioskeroappweb.up.railway.app)

### 👥 Usuarios y Roles
- **pv1@development.local**: Operador del Punto de Venta 1. Gestiona su local, revisa sugerencias, solicita mercadería al depósito y registra cuando llega.
- **pv2@development.local**: Operador del Punto de Venta 2. Hace exactamente lo mismo pero para su propio local.
- **deposito@development.local**: Encargado del Depósito central. Sube el Excel de stock, prepara los pedidos recibidos de las sucursales y despacha la mercadería física.

### 🔄 Flujo Básico (Paso a Paso)
1. **Actualización de Stock (Depósito):** El depósito carga su archivo Excel en la pestaña **Abastecimiento / Cargar Stock** para que el sistema sepa cuánta mercadería hay en el almacén.
2. **Generación del Pedido (Punto de Venta):** El PV entra a **Reposición Semanal**, selecciona el filtro *A reponer en depósito*, edita las cantidades sugeridas y aprieta el botón final para enviarle la orden al depósito.
3. **Preparación y Envío (Depósito):** El depósito entra a **Pedidos / Operación de Depósito**, abre la solicitud del PV, toca *Comenzar preparación*, arma las cajas, y luego presiona *Registrar despacho*.
4. **Recepción Final (Punto de Venta):** El PV verifica que le llegaron las cajas físicas, va a **Mis Pedidos**, abre la solicitud y presiona *Registrar recepción* cerrando el flujo.

### 🔌 Cierre de sesión y Soporte
- Para salir del sistema, buscar el botón **Cerrar sesión** arriba a la derecha.
- Todo el alojamiento web y base de datos funciona automáticamente en infraestructura de Railway (en la nube). El mantenimiento diario no requiere tareas técnicas por parte del cliente. En caso de fallas de infraestructura, el error clásico suele mostrar una pantalla negra con un tren (indica reinicio/actualización de servidor). Refresh con F5 tras un momento resuelve la inmensa mayoría de las caídas.
