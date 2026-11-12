import { readFile, readdir } from "node:fs/promises";
import { randomBytes, scrypt as scryptCallback } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pg from "pg";
import {
  STAGING_ORG_ID,
  STAGING_ORG_NAME,
  STAGING_SOURCES,
  STAGING_USERS,
  STAGING_WHATSAPP_TEST_NUMBER,
  buildSyntheticMovements,
  buildSyntheticProducts,
  validateStagingExecutionEnvironment,
} from "./staging-data.mjs";

const scrypt = promisify(scryptCallback);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, "..", "..");
const BOOTSTRAP_SQL_PATH = join(__dirname, "bootstrap.sql");
const MIGRATIONS_DIR = join(ROOT_DIR, "migrations");

function parseArgs(argv) {
  let phase = "all";
  let url = "";
  for (const arg of argv) {
    if (arg.startsWith("--phase=")) {
      phase = arg.slice("--phase=".length).trim().toLowerCase();
    } else if (arg.startsWith("--url=")) {
      url = arg.slice("--url=".length).trim();
    }
  }
  const validPhases = new Set(["all", "bootstrap", "migrate", "seed", "verify"]);
  if (!validPhases.has(phase)) {
    throw new Error(`Invalid --phase='${phase}'. Expected one of: all, bootstrap, migrate, seed, verify.`);
  }
  return { phase, url };
}

async function createPasswordHash(password) {
  const salt = randomBytes(16).toString("base64url");
  const derived = await scrypt(password, salt, 64);
  return `scrypt$${salt}$${Buffer.from(derived).toString("base64url")}`;
}

async function assertStagingDatabaseGuard(client) {
  const orgTable = await client.query(
    "SELECT to_regclass('public.organizations') AS tbl"
  );
  if (orgTable.rows[0]?.tbl) {
    const orgRes = await client.query("SELECT id, name FROM organizations ORDER BY id ASC");
    const org1 = orgRes.rows.find((row) => Number(row.id) === STAGING_ORG_ID);
    if (org1 && org1.name !== STAGING_ORG_NAME) {
      throw new Error(
        `ABORT: La base conectada tiene organization id=1 ('${org1.name}'), que no coincide con '${STAGING_ORG_NAME}'. Posible base de producción.`
      );
    }
    const otherRealOrgs = orgRes.rows.filter(
      (row) => Number(row.id) !== STAGING_ORG_ID && !String(row.name).includes("STAGING")
    );
    if (otherRealOrgs.length > 0) {
      throw new Error("ABORT: La base contiene organizaciones ajenas a staging.");
    }
  }

  const prodCheck = await client.query(
    "SELECT to_regclass('public.products_raw') AS p_tbl, to_regclass('public.whatsapp_baileys_session') AS wa_tbl"
  );
  if (prodCheck.rows[0]?.p_tbl) {
    const nonStagingProducts = await client.query(
      "SELECT COUNT(*)::int AS cnt FROM products_raw WHERE source_id NOT LIKE 'staging_%'"
    );
    if (nonStagingProducts.rows[0]?.cnt > 0) {
      throw new Error(
        `ABORT: products_raw contiene ${nonStagingProducts.rows[0].cnt} registros con source_id fuera de staging. Abortado para proteger datos reales.`
      );
    }
  }
  if (prodCheck.rows[0]?.wa_tbl) {
    const creds = await client.query(
      "SELECT COUNT(*)::int AS cnt FROM whatsapp_baileys_session WHERE key_id = 'creds'"
    );
    if (creds.rows[0]?.cnt > 0) {
      throw new Error(
        "ABORT: La base contiene una sesión real de WhatsApp en whatsapp_baileys_session. Abortado por seguridad."
      );
    }
  }
}

async function runBootstrap(client) {
  console.log("[1/4] Ejecutando bootstrap DDL para tablas externas en staging...");
  const sql = await readFile(BOOTSTRAP_SQL_PATH, "utf8");
  await client.query("BEGIN");
  try {
    await client.query(sql);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
  console.log("      Bootstrap DDL aplicado e idempotente (organizations, sources, products_raw, stock_levels_raw, stock_movements_raw).");
}

async function runMigrations(client) {
  console.log("[2/4] Verificando y aplicando migraciones 001..019 en orden estricto...");
  const files = (await readdir(MIGRATIONS_DIR))
    .filter((name) => name.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b, "en"));

  await client.query("BEGIN");
  try {
    await client.query(
      "CREATE TABLE IF NOT EXISTS renderbyte_schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"
    );
    const appliedRes = await client.query("SELECT version FROM renderbyte_schema_migrations");
    const applied = new Set(appliedRes.rows.map((r) => r.version));

    let appliedCount = 0;
    for (const file of files) {
      if (applied.has(file)) continue;
      const migrationSql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
      await client.query(migrationSql);
      await client.query("INSERT INTO renderbyte_schema_migrations (version) VALUES ($1)", [file]);
      console.log(`      + Applied ${file}`);
      appliedCount++;
    }
    await client.query("COMMIT");
    console.log(`      Migraciones completadas (${appliedCount} nuevas, ${files.length} totales verificadas).`);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function runSeed(client, env) {
  console.log("[3/4] Sembrando datos sintéticos y usuarios de prueba (idempotente)...");
  const stagingPassword = (env.STAGING_TEST_PASSWORD || "StagingQA!2026").trim();
  const passwordHash = await createPasswordHash(stagingPassword);
  const products = buildSyntheticProducts();
  const movements = buildSyntheticMovements();

  await client.query("BEGIN");
  try {
    // 1. Ensure branches exist with canonical names
    await client.query(`
      INSERT INTO branches (id, organization_id, name, type, active)
      VALUES
        (1, $1, 'DEPÓSITO', 'WAREHOUSE', true),
        (2, $1, 'CENTRO', 'POS', true),
        (3, $1, 'JARDÍN', 'POS', true)
      ON CONFLICT (id) DO UPDATE
      SET organization_id = EXCLUDED.organization_id,
          name = EXCLUDED.name,
          type = EXCLUDED.type,
          active = true,
          updated_at = now()
    `, [STAGING_ORG_ID]);

    // 2. Refresh active staging sources timestamps
    for (const [branchIdStr, sourceId] of Object.entries(STAGING_SOURCES)) {
      await client.query(
        `INSERT INTO sources (organization_id, branch_id, source_id, is_active, last_seen_at)
         VALUES ($1, $2, $3, true, now())
         ON CONFLICT (organization_id, branch_id, source_id) DO UPDATE
         SET is_active = true, last_seen_at = now(), updated_at = now()`,
        [STAGING_ORG_ID, Number(branchIdStr), sourceId]
      );
    }

    // 3. Provision staging users + memberships
    for (const u of STAGING_USERS) {
      const userRes = await client.query(
        `INSERT INTO users (name, email, organization_id, password_hash, active)
         VALUES ($1, $2, $3, $4, true)
         ON CONFLICT (email) DO UPDATE
         SET name = EXCLUDED.name,
             organization_id = EXCLUDED.organization_id,
             password_hash = EXCLUDED.password_hash,
             active = true,
             updated_at = now()
         RETURNING id`,
        [u.name, u.email, STAGING_ORG_ID, passwordHash]
      );
      const userId = userRes.rows[0].id;
      await client.query(
        `INSERT INTO memberships (user_id, organization_id, branch_id, role, active)
         VALUES ($1, $2, $3, $4, true)
         ON CONFLICT (user_id, organization_id, branch_id, role) DO UPDATE
         SET active = true, updated_at = now()`,
        [userId, STAGING_ORG_ID, u.branchId, u.role]
      );
    }

    // 4. Upsert synthetic products_raw + stock_levels_raw across branches 1, 2, 3
    for (const item of products) {
      const payload = {
        Descripcion: item.description,
        ArticuloDesc: item.description,
        Marca: item.brand,
        Proveedor: item.supplierCode,
        ArticuloProveedor: `PROV-${item.articleId}`,
        HabilitadoCompra: "true",
        Clasificacion: item.classificationCode,
        Rubro: item.rubro,
        Bulto: item.bulto,
        UnidadMedida: item.unitMeasure,
        Estado: item.estado,
        Stopti: item.stopti,
      };

      const branchStocks = [
        [1, STAGING_SOURCES[1], item.stockDepot],
        [2, STAGING_SOURCES[2], item.stockCentro],
        [3, STAGING_SOURCES[3], item.stockJardin],
      ];

      for (const [branchId, sourceId, saldo] of branchStocks) {
        await client.query(
          `INSERT INTO products_raw (organization_id, source_id, branch_id, article_id, is_present, source_seen_at, payload)
           VALUES ($1, $2, $3, $4, true, now(), $5::jsonb)
           ON CONFLICT (organization_id, source_id, branch_id, article_id) DO UPDATE
           SET is_present = true,
               source_seen_at = now(),
               payload = EXCLUDED.payload`,
          [STAGING_ORG_ID, sourceId, branchId, item.articleId, JSON.stringify(payload)]
        );

        await client.query(
          `INSERT INTO stock_levels_raw (organization_id, source_id, branch_id, article_id, depo, bulto, saldo, piezas, source_seen_at)
           VALUES ($1, $2, $3, $4, 1, $5, $6, 0, now())
           ON CONFLICT (organization_id, source_id, branch_id, article_id, depo) DO UPDATE
           SET bulto = EXCLUDED.bulto,
               saldo = EXCLUDED.saldo,
               source_seen_at = now()`,
          [STAGING_ORG_ID, sourceId, branchId, item.articleId, item.bulto, saldo]
        );
      }
    }

    // 5. Upsert synthetic stock_movements_raw idempotently
    for (const mv of movements) {
      await client.query(
        `INSERT INTO stock_movements_raw (organization_id, source_id, branch_id, idarti, fedepo, tipomov, cantidad, codcom, numero, received_at, external_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), $10)
         ON CONFLICT (external_key) DO NOTHING`,
        [
          STAGING_ORG_ID,
          mv.sourceId,
          mv.branchId,
          mv.idarti,
          mv.fedepo,
          mv.tipomov,
          mv.cantidad,
          mv.codcom,
          mv.numero,
          mv.externalKey,
        ]
      );
    }

    // 6. Sync suppliers & product_suppliers (same derivation as migration 007)
    const supplierNames = {
      "50350": "DISTRIBUIDORA SINTETICA 50350",
      "50100": "BEBIDAS DEL SUR SINTETICA",
      "50200": "KIOSCO MAYORISTA SINTETICO",
      "50400": "FIGURITAS QA DISTRIBUCION",
    };
    for (const [code, name] of Object.entries(supplierNames)) {
      await client.query(
        `INSERT INTO suppliers (organization_id, external_code, name, active)
         VALUES ($1, $2, $3, true)
         ON CONFLICT (organization_id, external_code) DO UPDATE
         SET name = EXCLUDED.name, active = true, updated_at = now()`,
        [STAGING_ORG_ID, code, name]
      );
    }

    await client.query(`
      WITH source_products AS (
        SELECT DISTINCT ON (p.organization_id, p.article_id)
          p.organization_id,
          p.article_id,
          btrim(p.payload->>'Proveedor') AS supplier_code,
          NULLIF(btrim(p.payload->>'ArticuloProveedor'), '') AS supplier_article_code,
          CASE WHEN lower(COALESCE(p.payload->>'HabilitadoCompra', 'false')) IN ('true', 't', '1', 'yes') THEN true ELSE false END AS purchase_enabled
        FROM products_raw p
        WHERE p.organization_id = $1 AND p.is_present
          AND NULLIF(btrim(p.payload->>'Proveedor'), '') IS NOT NULL
        ORDER BY p.organization_id, p.article_id, p.branch_id
      )
      INSERT INTO product_suppliers (organization_id, article_id, supplier_id, supplier_article_code, purchase_enabled, supply_mode)
      SELECT sp.organization_id, sp.article_id, s.id, sp.supplier_article_code, sp.purchase_enabled, 'UNDEFINED'
      FROM source_products sp
      JOIN suppliers s ON s.organization_id = sp.organization_id AND s.external_code = sp.supplier_code
      ON CONFLICT (organization_id, article_id) DO UPDATE
      SET supplier_id = EXCLUDED.supplier_id,
          supplier_article_code = EXCLUDED.supplier_article_code,
          purchase_enabled = EXCLUDED.purchase_enabled,
          updated_at = now()
    `, [STAGING_ORG_ID]);

    // 7. Seed branch_product_supply_rules idempotently
    await client.query(`
      INSERT INTO branch_product_supply_rules (organization_id, branch_id, article_id, supply_mode)
      SELECT DISTINCT p.organization_id, p.branch_id, p.article_id,
        CASE WHEN p.article_id BETWEEN 1001 AND 1019 THEN 'DEPOT' ELSE 'UNDEFINED' END
      FROM products_raw p
      JOIN branches b ON b.organization_id = p.organization_id AND b.id = p.branch_id AND b.type = 'POS'
      WHERE p.organization_id = $1 AND p.is_present
      ON CONFLICT (organization_id, branch_id, article_id) DO NOTHING
    `, [STAGING_ORG_ID]);

    // 8. Seed initial independent branch_product_base_stock QA examples (Centro=12, Jardín=0 explicit on 1004)
    await client.query(
      `INSERT INTO branch_product_base_stock (organization_id, branch_id, article_id, base_stock, notes, updated_by_user_id)
       VALUES
         ($1, 2, 1004, 12, 'QA Staging: base stock Centro independiente de Jardín y de Stopti=18', 'staging-seed'),
         ($1, 3, 1004, 0, 'QA Staging: cero explícito en Jardín', 'staging-seed')
       ON CONFLICT (organization_id, branch_id, article_id) DO NOTHING`,
      [STAGING_ORG_ID]
    );

    // 9. Seed historical order (for reused code 1005 + spacing tolerance 1006) & active pending orders (1007)
    const historicOrderRes = await client.query(
      `INSERT INTO orders (organization_id, source_id, branch_id, status, order_type, origin_branch_id, destination_branch_id, planning_date, idempotency_key, confirmed_at, completed_at, notes, created_by, confirmed_by)
       VALUES ($1, $2, 2, 'COMPLETED', 'INTERNAL_REPLENISHMENT', 2, 1, (CURRENT_DATE - interval '30 days')::date, 'staging-seed-cutoff-1005-1006', now() - interval '30 days', now() - interval '28 days', 'QA Staging: pedido histórico para detección de código reutilizado y tolerancia de espacios', 'staging-seed', 'staging-seed')
       ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
       RETURNING id`,
      [STAGING_ORG_ID, STAGING_SOURCES[2]]
    );
    const historicOrderId = historicOrderRes.rows[0]?.id ?? (
      await client.query("SELECT id FROM orders WHERE idempotency_key = 'staging-seed-cutoff-1005-1006'")
    ).rows[0]?.id;

    if (historicOrderId) {
      await client.query(
        `INSERT INTO order_items (order_id, article_id, product_name_snapshot, suggested_quantity, requested_quantity, approved_quantity, prepared_quantity, dispatched_quantity, received_quantity, stock_at_creation, stock_target_at_creation, confidence_at_creation, status_at_creation)
         VALUES
           ($1, 1005, 'ALFAJOR VIEJO REUTILIZADO 50G', 10, 10, 10, 10, 10, 10, 2, 12, 'SEMANAL', 'REPLENISH'),
           ($1, 1006, 'GASEOSA STAGING COLA 500 ML', 12, 12, 12, 12, 12, 12, 4, 16, 'SEMANAL', 'REPLENISH')
         ON CONFLICT (order_id, article_id) DO NOTHING`,
        [historicOrderId]
      );
    }

    // Active pending order on Centro (branch 2) -> tests branch-scoped pending subtraction & depot committed
    const pendingCentroRes = await client.query(
      `INSERT INTO orders (organization_id, source_id, branch_id, status, order_type, origin_branch_id, destination_branch_id, planning_date, idempotency_key, confirmed_at, notes, created_by, confirmed_by)
       VALUES ($1, $2, 2, 'IN_PREPARATION', 'INTERNAL_REPLENISHMENT', 2, 1, date_trunc('week', CURRENT_DATE)::date, 'staging-seed-pending-centro-1007', now() - interval '1 day', 'QA Staging: pedido pendiente Centro art 1007', 'staging-seed', 'staging-seed')
       ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
       RETURNING id`,
      [STAGING_ORG_ID, STAGING_SOURCES[2]]
    );
    const pendingCentroId = pendingCentroRes.rows[0]?.id ?? (
      await client.query("SELECT id FROM orders WHERE idempotency_key = 'staging-seed-pending-centro-1007'")
    ).rows[0]?.id;
    if (pendingCentroId) {
      await client.query(
        `INSERT INTO order_items (order_id, article_id, product_name_snapshot, suggested_quantity, requested_quantity, approved_quantity, prepared_quantity, stock_at_creation, stock_target_at_creation, confidence_at_creation, status_at_creation)
         VALUES ($1, 1007, 'PAPAS FRITAS STAGING 90G', 5, 5, 5, 0, 2, 10, 'SEMANAL', 'REPLENISH')
         ON CONFLICT (order_id, article_id) DO NOTHING`,
        [pendingCentroId]
      );
    }

    // Active pending order on Jardín (branch 3) -> must NOT subtract from Centro, SHOULD sum to depot_committed
    const pendingJardinRes = await client.query(
      `INSERT INTO orders (organization_id, source_id, branch_id, status, order_type, origin_branch_id, destination_branch_id, planning_date, idempotency_key, confirmed_at, notes, created_by, confirmed_by)
       VALUES ($1, $2, 3, 'CONFIRMED', 'INTERNAL_REPLENISHMENT', 3, 1, date_trunc('week', CURRENT_DATE)::date, 'staging-seed-pending-jardin-1007', now() - interval '1 day', 'QA Staging: pedido pendiente Jardín art 1007', 'staging-seed', 'staging-seed')
       ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
       RETURNING id`,
      [STAGING_ORG_ID, STAGING_SOURCES[3]]
    );
    const pendingJardinId = pendingJardinRes.rows[0]?.id ?? (
      await client.query("SELECT id FROM orders WHERE idempotency_key = 'staging-seed-pending-jardin-1007'")
    ).rows[0]?.id;
    if (pendingJardinId) {
      await client.query(
        `INSERT INTO order_items (order_id, article_id, product_name_snapshot, suggested_quantity, requested_quantity, stock_at_creation, stock_target_at_creation, confidence_at_creation, status_at_creation)
         VALUES ($1, 1007, 'PAPAS FRITAS STAGING 90G', 4, 4, 1, 8, 'SEMANAL', 'REPLENISH')
         ON CONFLICT (order_id, article_id) DO NOTHING`,
        [pendingJardinId]
      );
    }

    // 10. Synthetic dummy authorized WhatsApp test record (NO real number, NO Baileys pairing)
    await client.query(
      `INSERT INTO whatsapp_authorized_numbers (phone, name, role, active)
       VALUES ($1, $2, $3, true)
       ON CONFLICT (phone) DO NOTHING`,
      [STAGING_WHATSAPP_TEST_NUMBER.phone, STAGING_WHATSAPP_TEST_NUMBER.name, STAGING_WHATSAPP_TEST_NUMBER.role]
    );

    await client.query("COMMIT");
    console.log(
      `      Seed sintético completado (${products.length} artículos x 3 sucursales, ${movements.length} movimientos, 3 usuarios QA).`
    );
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function runVerify(client) {
  console.log("[4/4] Ejecutando verificación de integridad post-inicialización en staging...");

  const orgRes = await client.query("SELECT id, name FROM organizations WHERE id = $1", [STAGING_ORG_ID]);
  if (orgRes.rows[0]?.name !== STAGING_ORG_NAME) {
    throw new Error(`Verification failed: unexpected organization name '${orgRes.rows[0]?.name}'.`);
  }

  const migrationFiles = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  const appliedRes = await client.query("SELECT version FROM renderbyte_schema_migrations ORDER BY version");
  const appliedSet = new Set(appliedRes.rows.map((r) => r.version));
  const missingMigrations = migrationFiles.filter((f) => !appliedSet.has(f));
  if (missingMigrations.length > 0) {
    throw new Error(`Verification failed: missing migrations: ${missingMigrations.join(", ")}`);
  }

  const counts = await client.query(`
    SELECT
      (SELECT COUNT(*)::int FROM branches WHERE organization_id = $1 AND active = true) AS active_branches,
      (SELECT COUNT(*)::int FROM sources WHERE organization_id = $1 AND is_active = true AND source_id LIKE 'staging_%') AS active_sources,
      (SELECT COUNT(*)::int FROM users WHERE organization_id = $1 AND active = true AND password_hash IS NOT NULL) AS active_users,
      (SELECT COUNT(DISTINCT article_id)::int FROM products_raw WHERE organization_id = $1 AND is_present) AS distinct_products,
      (SELECT COUNT(*)::int FROM products_raw WHERE organization_id = $1 AND source_id NOT LIKE 'staging_%') AS non_staging_products,
      (SELECT COUNT(*)::int FROM stock_levels_raw WHERE organization_id = $1) AS stock_rows,
      (SELECT COUNT(*)::int FROM stock_movements_raw WHERE organization_id = $1) AS movement_rows,
      (SELECT COUNT(*)::int FROM suppliers WHERE organization_id = $1 AND external_code = '50350') AS supplier_50350,
      (SELECT COUNT(*)::int FROM branch_product_base_stock WHERE organization_id = $1) AS base_stock_rows,
      (SELECT COUNT(*)::int FROM orders WHERE organization_id = $1) AS order_rows,
      (SELECT COUNT(*)::int FROM whatsapp_baileys_session WHERE key_id = 'creds') AS live_wa_creds
  `, [STAGING_ORG_ID]);

  const c = counts.rows[0];
  console.table([c]);

  if (c.active_branches !== 3) throw new Error(`Expected 3 active branches, got ${c.active_branches}`);
  if (c.active_sources !== 3) throw new Error(`Expected 3 active staging sources, got ${c.active_sources}`);
  if (c.active_users < 3) throw new Error(`Expected >= 3 provisioned users, got ${c.active_users}`);
  if (c.non_staging_products !== 0) throw new Error(`Detected ${c.non_staging_products} non-staging products`);
  if (c.supplier_50350 !== 1) throw new Error("Expected synthetic supplier 50350 to exist");
  if (c.live_wa_creds !== 0) throw new Error("Staging must NOT contain live WhatsApp Baileys credentials");

  console.log("      VERIFICACION OK: Entorno de staging sintético consistente, aislado y listo para pruebas.");
}

async function main() {
  const { phase, url } = parseArgs(process.argv.slice(2));
  const target = validateStagingExecutionEnvironment(process.env, url);
  console.log(
    `Target staging DB verificado: host=${target.hostname} db=${target.database} (dedicatedVar=${target.usingDedicatedStagingVar})`
  );

  const pool = new pg.Pool({
    connectionString: target.connectionString,
    ssl: process.env.POSTGRES_SSL === "false" ? false : { rejectUnauthorized: false },
  });

  const client = await pool.connect();
  try {
    await assertStagingDatabaseGuard(client);

    if (phase === "bootstrap" || phase === "all") {
      await runBootstrap(client);
    }
    if (phase === "migrate" || phase === "all") {
      await runMigrations(client);
    }
    if (phase === "seed" || phase === "all") {
      await runSeed(client, process.env);
    }
    if (phase === "verify" || phase === "all") {
      await runVerify(client);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error("STAGING INIT ERROR:", error?.message ?? error);
  process.exit(1);
});

