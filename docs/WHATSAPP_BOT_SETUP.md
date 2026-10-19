# Guía de Configuración y Puesta en Marcha: Bot de WhatsApp (Mónica)

Esta guía detalla los pasos exactos para conectar el bot de WhatsApp de **La Casa del Kioskero** con la **WhatsApp Cloud API oficial de Meta** y el backend desplegado en **Railway**.

---

## 1. Prerrequisitos en Meta Developers

1. Ingresar a [Meta for Developers](https://developers.facebook.com/) con la cuenta comercial de Facebook/Meta Business.
2. Ir a **Mis Apps (My Apps)** y seleccionar **Crear App (Create App)**.
   - Tipo de app: **Otro (Other)** $\rightarrow$ **Negocios (Business)**.
   - Nombre de la app: por ejemplo, `Kioskero WhatsApp Bot`.
3. En el panel de la aplicación, buscar el producto **WhatsApp** y hacer clic en **Configurar (Set up)**.

---

## 2. Obtención de Credenciales de Meta

Dentro de la sección de WhatsApp en el panel de Meta:

### A. Identificador del Número de Teléfono (`WHATSAPP_PHONE_NUMBER_ID`)
- Ir a **WhatsApp > Configuración de la API (API Setup)**.
- En el menú desplegable seleccionar el número telefónico que responderá los mensajes.
- Copiar el valor numérico del campo **Identificador de número de teléfono** (ej. `102938475610293`).

### B. Token de Acceso Permanente (`WHATSAPP_ACCESS_TOKEN`)
*Nota: El token temporal de prueba vence cada 24 horas. Para producción se debe crear un System User.*
1. Ir al **Meta Business Manager** (Configuración del negocio).
2. En el menú lateral: **Usuarios > Usuarios del sistema (System Users)** $\rightarrow$ **Agregar**.
3. Asignarle rol de Empleado o Administrador y nombre (ej. `bot-kioskero-service`).
4. En **Activos asignados**, agregar la cuenta de WhatsApp con control total.
5. Hacer clic en **Generar nuevo token (Generate Token)**:
   - Seleccionar la App creada.
   - Marcar los permisos:
     - `whatsapp_business_messaging`
     - `whatsapp_business_management`
   - Vigencia: **Nunca expira (Permanent)**.
6. Copiar el token generado.

### C. Secreto de la Aplicación (`WHATSAPP_APP_SECRET`)
- En el menú lateral izquierdo: **Configuración de la app > Básica**.
- En el campo **Clave secreta de la app (App Secret)**, hacer clic en "Mostrar" y copiar el valor alfanumérico.

---

## 3. Configuración de Variables de Entorno en Railway

Ingresar al proyecto en [Railway Dashboard](https://railway.app/), entrar al servicio web de `kioskeroappweb` y en la pestaña **Variables** agregar:

| Variable | Descripción | Ejemplo / Formato |
| :--- | :--- | :--- |
| `WHATSAPP_PHONE_NUMBER_ID` | Identificador del número de teléfono en Meta | `102938475610293` |
| `WHATSAPP_ACCESS_TOKEN` | Token permanente generado para el System User | `EAAB...` |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | Cadena secreta inventada para validar el handshake | `kioskero_verify_sec_99a8b7` |
| `WHATSAPP_APP_SECRET` | Secreto de la aplicación Meta | `4a8f9c...` |
| `WHATSAPP_ALLOWED_NUMBERS` | Números autorizados separados por coma (E.164) | `+5491112345678, 5491187654321` |

> [!IMPORTANT]
> Los números en `WHATSAPP_ALLOWED_NUMBERS` deben incluir el código de país `54` y el prefijo móvil `9` (ejemplo para CABA: `+54911xxxxxxxx`). El sistema normaliza automáticamente variantes sin espacios ni guiones.

---

## 4. Configuración del Webhook en Meta Developers

1. En el panel de Meta de la App, ir a **WhatsApp > Configuración (Configuration)**.
2. En la sección **Webhook**, hacer clic en **Editar (Edit)**:
   - **URL de devolución de llamada (Callback URL):**  
     `https://kioskeroappweb.up.railway.app/api/whatsapp/webhook`
   - **Identificador de verificación (Verify Token):**  
     El mismo texto configurado en `WHATSAPP_WEBHOOK_VERIFY_TOKEN` en Railway.
3. Hacer clic en **Verificar y guardar (Verify and save)**.  
   *(Meta enviará un GET de prueba; si el token coincide, confirmará con tilde verde).*
4. En **Campos de webhook (Webhook fields)**, hacer clic en **Administrar (Manage)** y marcar:
   - `messages` $\rightarrow$ **Suscribirse (Subscribe)**.

---

## 5. Migración Automática de Base de Datos

El archivo de migración [`migrations/016_whatsapp_bot.sql`](file:///c:/Renderbyte/Monica/migrations/016_whatsapp_bot.sql) ya se encuentra preparado en el repositorio.

Cuando se despliegue a Railway, el comando configurado en `railway.toml`:
```toml
preDeployCommand = "npm run db:migrate"
```
ejecutará automáticamente la migración, creando las tablas:
- `whatsapp_processed_messages`: para deduplicación atómica y auditoría.
- `whatsapp_authorized_numbers`: para persistencia opcional de números autorizados.

---

## 6. Procedimiento de Prueba Inicial con Mónica

1. **Prueba de Bienvenida:**
   - Desde el número de Mónica configurado en `WHATSAPP_ALLOWED_NUMBERS`, enviar:  
     `Hola`
   - El bot debe responder saludando por su nombre con el menú de opciones.
2. **Prueba de Consulta de Stock:**
   - Enviar: `Stock alfajor havanna`
   - El bot responderá con el stock discriminado en Centro, Jardín y Depósito Central (indicando fecha del Excel).
3. **Prueba de Pedidos:**
   - Enviar: `¿Qué pedidos siguen pendientes?`
   - Enviar: `Pedido #3` (para ver el detalle de ítems, estado y cantidades de un pedido).
4. **Prueba de Reposición:**
   - Enviar: `Reposición Centro`
   - El bot mostrará los productos con sugerencia de reposición basada en demanda histórica YoY.
5. **Prueba de Resumen Histórico:**
   - Enviar: `¿Qué pasó durante septiembre?` o `Resumen este mes`
   - El bot devolverá unidades netas vendidas, movimientos y variación porcentual.
6. **Prueba de Seguridad (Número No Autorizado):**
   - Enviar un mensaje desde cualquier número no incluido en la lista.
   - El bot responderá con un aviso de acceso restringido sin revelar datos del negocio.
