/**
 * End-to-end live HTTP validation suite against the real Railway staging deployment.
 * Validates authentication, RBAC cross-branch isolation, Base Stock CRUD,
 * Weekly Replenishment formula, History Cutoffs, and WhatsApp unlinked status.
 */

const BASE_URL = process.env.STAGING_APP_URL || "https://kioskeroapp-staging-staging.up.railway.app";
const STAGING_PASSWORD = process.env.STAGING_TEST_PASSWORD || "StagingQA!2026";

async function request(path, options = {}) {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    redirect: "manual",
  });

  const contentType = res.headers.get("content-type") || "";
  let data = null;
  if (contentType.includes("application/json")) {
    try {
      data = await res.json();
    } catch {}
  } else {
    data = await res.text();
  }

  const setCookie = res.headers.get("set-cookie") || "";
  let sessionCookie = "";
  if (setCookie) {
    const match = setCookie.match(/quiosquero_session=([^;]+)/);
    if (match) sessionCookie = match[1];
  }

  return { status: res.status, headers: res.headers, data, sessionCookie };
}

async function login(email, password = STAGING_PASSWORD) {
  const res = await request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  if (res.status !== 200 || !res.sessionCookie) {
    throw new Error(`Login failed for ${email}: status=${res.status}, data=${JSON.stringify(res.data)}`);
  }
  return res.sessionCookie;
}

function authHeaders(cookie) {
  return { Cookie: `quiosquero_session=${cookie}` };
}

const results = [];
function record(name, pass, details = "") {
  results.push({ test: name, status: pass ? "PASS" : "FAIL", details });
  console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${details ? ` -> ${details}` : ""}`);
}

async function runLiveTests() {
  console.log(`=== INICIANDO VALIDACIÓN EN VIVO EN STAGING: ${BASE_URL} ===\n`);

  // 1. Unauthenticated protection
  {
    const res = await request("/dashboard");
    const isRedirect = res.status === 307 || res.status === 302;
    record("1. Acceso no autenticado redirige a /login", isRedirect, `status=${res.status}`);
  }

  // 2. Authentication: invalid credentials rejected
  {
    const res = await request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: "centro@gmail.com", password: "WrongPassword!" }),
    });
    record("2. Login con contraseña inválida devuelve 401", res.status === 401);
  }

  // 3. Login with all 3 QA users
  let cookieCentro, cookieJardin, cookieDeposito;
  try {
    cookieCentro = await login("centro@gmail.com");
    record("3a. Login exitoso usuario Centro (PV_OPERATOR branch 2)", Boolean(cookieCentro));
  } catch (e) {
    record("3a. Login exitoso usuario Centro", false, e.message);
  }

  try {
    cookieJardin = await login("jardin@gmail.com");
    record("3b. Login exitoso usuario Jardín (PV_OPERATOR branch 3)", Boolean(cookieJardin));
  } catch (e) {
    record("3b. Login exitoso usuario Jardín", false, e.message);
  }

  try {
    cookieDeposito = await login("deposito@gmail.com");
    record("3c. Login exitoso usuario Depósito (WAREHOUSE_OPERATOR branch 1)", Boolean(cookieDeposito));
  } catch (e) {
    record("3c. Login exitoso usuario Depósito", false, e.message);
  }

  // 4. RBAC: Centro cannot access or edit Jardín (and vice versa)
  if (cookieCentro) {
    const res = await request("/api/base-stock?branch_id=3", { headers: authHeaders(cookieCentro) });
    record("4a. Centro intentando consultar Jardín es rechazado con 403 Forbidden", res.status === 403);
  }
  if (cookieJardin) {
    const res = await request("/api/base-stock?branch_id=2", { headers: authHeaders(cookieJardin) });
    record("4b. Jardín intentando consultar Centro es rechazado con 403 Forbidden", res.status === 403);
  }

  // 5. Stock Base Centro inspection (branch 2)
  if (cookieCentro) {
    const res = await request("/api/base-stock?branch_id=2&limit=50", { headers: authHeaders(cookieCentro) });
    const ok = res.status === 200 && res.data?.rows?.length > 0;
    const item1004 = res.data?.rows?.find((r) => r.article_id === 1004);
    const pass1004 =
      item1004?.base_stock === 12 &&
      item1004?.erp_stopti === 18 &&
      item1004?.is_configured === true;

    record(
      "5a. Base Stock Centro: consulta correcta y coexistencia de Stopti=18 con Stock Base=12 en art. 1004",
      pass1004,
      `base_stock=${item1004?.base_stock}, erp_stopti=${item1004?.erp_stopti}`
    );
  }

  // 6. Stock Base Jardín inspection (branch 3) - explicit zero
  if (cookieJardin) {
    const res = await request("/api/base-stock?branch_id=3&limit=50", { headers: authHeaders(cookieJardin) });
    const item1004 = res.data?.rows?.find((r) => r.article_id === 1004);
    const passZero =
      item1004?.base_stock === 0 &&
      item1004?.is_configured === true &&
      res.data?.summary?.zero_count >= 1;

    record(
      "6a. Base Stock Jardín: valor explícito cero en art. 1004 (independiente de Centro)",
      passZero,
      `base_stock=${item1004?.base_stock}, is_configured=${item1004?.is_configured}, zero_count=${res.data?.summary?.zero_count}`
    );
  }

  // 7. Base stock CRUD & Note preservation
  if (cookieCentro) {
    // 7a. Set base stock with note
    const putRes1 = await request("/api/base-stock", {
      method: "PUT",
      headers: authHeaders(cookieCentro),
      body: JSON.stringify({
        branch_id: 2,
        article_id: 1001,
        base_stock: 25,
        notes: "Nota inicial QA Centro",
      }),
    });
    const p1 = putRes1.status === 200 && putRes1.data?.base_stock === 25 && putRes1.data?.notes === "Nota inicial QA Centro";

    // 7b. Update base stock without sending notes -> notes must be preserved!
    const putRes2 = await request("/api/base-stock", {
      method: "PUT",
      headers: authHeaders(cookieCentro),
      body: JSON.stringify({
        branch_id: 2,
        article_id: 1001,
        base_stock: 30,
      }),
    });
    const p2 = putRes2.status === 200 && putRes2.data?.base_stock === 30 && putRes2.data?.notes === "Nota inicial QA Centro";

    // 7c. Delete base stock configuration (set to null)
    const putRes3 = await request("/api/base-stock", {
      method: "PUT",
      headers: authHeaders(cookieCentro),
      body: JSON.stringify({
        branch_id: 2,
        article_id: 1001,
        base_stock: null,
      }),
    });
    const p3 = putRes3.status === 200 && putRes3.data?.base_stock === null && putRes3.data?.is_configured === false;

    record("7a. Base Stock: creación con nota", p1);
    record("7b. Base Stock: actualización de cantidad PRESERVANDO nota previa cuando se omite", p2);
    record("7c. Base Stock: eliminación y retorno a estado no configurado (null)", p3);
  }

  // 8. Weekly Replenishment formula validation in Centro
  if (cookieCentro) {
    const today = new Date().toISOString().slice(0, 10);
    const res = await request(
      `/api/replenishment/weekly?branch_id=2&planning_date=${today}&page_size=100`,
      { headers: authHeaders(cookieCentro) }
    );

    const items = res.data?.items || [];

    // 8a. Proveedor 50350: artículo 1002 activo SIN historial de ventas
    const art1002 = items.find((i) => i.article_id === 1002);
    const pass1002 = Boolean(art1002 && art1002.is_active === true && art1002.supplier_code === "50350");
    record(
      "8a. Reposición: artículo 1002 de proveedor 50350 activo SIN historial de ventas está incluido en catálogo",
      pass1002,
      art1002 ? `encontrado, status=${art1002.status}` : "no encontrado"
    );

    // 8b. Proveedor 50350: artículo 1003 inactivo excluido por defecto
    const art1003Default = items.find((i) => i.article_id === 1003);
    record(
      "8b. Reposición: artículo 1003 inactivo de 50350 EXCLUIDO por defecto",
      art1003Default === undefined,
      art1003Default ? "error: incluido cuando debería filtrarse" : "excluido correctamente"
    );

    // 8c. Proveedor 50350: artículo 1003 incluido con include_inactive=true
    const resInactive = await request(
      `/api/replenishment/weekly?branch_id=2&planning_date=${today}&include_inactive=true&page_size=100`,
      { headers: authHeaders(cookieCentro) }
    );
    const art1003Inactive = resInactive.data?.items?.find((i) => i.article_id === 1003);
    record(
      "8c. Reposición: artículo 1003 inactivo INCLUIDO al solicitar include_inactive=true",
      Boolean(art1003Inactive && art1003Inactive.is_active === false)
    );

    // 8d. Pedidos internos pendientes aislados por sucursal en art. 1007
    // Centro tiene 5 unidades pendientes, Jardín tiene 4. Centro DEBE ver exactamente 5, NO 9.
    const art1007 = items.find((i) => i.article_id === 1007);
    const passPending = art1007?.pending_order_quantity === 5;
    record(
      "8d. Reposición: pedido interno pendiente aislado por sucursal en art. 1007 (Centro=5, no suma las 4 de Jardín)",
      passPending,
      `pending_order_quantity=${art1007?.pending_order_quantity}`
    );

    // 8e. Stock negativo art. 1025 -> status NEGATIVE_STOCK, sugerencia null para revisión manual
    const art1025 = items.find((i) => i.article_id === 1025);
    const passNeg =
      art1025?.status === "NEGATIVE_STOCK" &&
      art1025?.stock_current < 0 &&
      (art1025?.suggested_quantity === null || art1025?.suggested_quantity === undefined);
    record(
      "8e. Reposición: stock negativo (art. 1025, saldo=-2) catalogado NEGATIVE_STOCK sin sugerencia automática errónea",
      passNeg,
      `status=${art1025?.status}, stock=${art1025?.stock_current}`
    );

    // 8f. Depósito Central stock visible
    const art1001 = items.find((i) => i.article_id === 1001);
    record(
      "8f. Reposición: stock de depósito visible en columna depot_stock",
      typeof art1001?.stock_depot === "number" && art1001.stock_depot >= 0,
      `stock_depot=${art1001?.stock_depot}`
    );
  }

  // 9. History Cutoffs detection & spacing tolerance
  if (cookieCentro) {
    const res = await request("/api/history-cutoffs?branch_id=2", { headers: authHeaders(cookieCentro) });
    const mismatches = res.data?.mismatches || [];

    // 9a. Code 1005: description changed from 'ALFAJOR VIEJO REUTILIZADO 50G' to 'GALLETITA CODIGO REUTILIZADO 200G'
    const m1005 = mismatches.find((m) => m.article_id === 1005);
    record(
      "9a. Cortes históricos: detecta alerta ORDER_SNAPSHOT_DIFF para código reutilizado (art. 1005)",
      Boolean(m1005),
      m1005 ? `snapshot='${m1005.previous_description}' vs actual='${m1005.current_description}'` : "no detectado"
    );

    // 9b. Code 1006: spacing tolerance '500ML' vs '500 ML' -> ZERO false positive!
    const m1006 = mismatches.find((m) => m.article_id === 1006);
    record(
      "9b. Cortes históricos: tolerancia a espacios en unidades (500ML == 500 ML en art. 1006) NO genera falso positivo",
      m1006 === undefined,
      m1006 ? "error: generó falso positivo" : "cero falsos positivos"
    );
  }

  // 10. WhatsApp Bot status check via admin endpoint
  if (cookieCentro) {
    const res = await request("/api/admin/whatsapp/pairing", { headers: authHeaders(cookieCentro) });
    const isUnlinked = res.status === 200 && res.data?.status === "unlinked";
    record(
      "10. WhatsApp en staging: endpoint /api/admin/whatsapp/pairing confirma 'unlinked' (0 credenciales reales)",
      isUnlinked,
      `status='${res.data?.status}'`
    );
  }

  console.log("\n=== RESUMEN FINAL DE PRUEBAS EN VIVO ===");
  const total = results.length;
  const passed = results.filter((r) => r.status === "PASS").length;
  const failed = total - passed;
  console.log(`Total: ${total} | Aprobadas: ${passed} | Fallidas: ${failed}`);

  if (failed > 0) {
    console.error("ALERTA: Se detectaron fallas en la validación en vivo.");
    process.exit(1);
  } else {
    console.log("TODAS LAS PRUEBAS EN VIVO EN STAGING PASARON AL 100%.");
  }
}

runLiveTests().catch((err) => {
  console.error("FATAL RUNNER ERROR:", err);
  process.exit(1);
});
