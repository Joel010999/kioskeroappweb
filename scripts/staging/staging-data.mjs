export const STAGING_ORG_ID = 1;
export const STAGING_ORG_NAME = "La Casa del Kioskero [STAGING SYNTHETIC]";

export const STAGING_SOURCES = {
  1: "staging_deposito",
  2: "staging_centro",
  3: "staging_jardin",
};

export const STAGING_USERS = [
  {
    email: "centro@gmail.com",
    name: "QA Centro Staging",
    branchId: 2,
    role: "PV_OPERATOR",
  },
  {
    email: "jardin@gmail.com",
    name: "QA Jardín Staging",
    branchId: 3,
    role: "PV_OPERATOR",
  },
  {
    email: "deposito@gmail.com",
    name: "QA Depósito Staging",
    branchId: 1,
    role: "WAREHOUSE_OPERATOR",
  },
];

export const STAGING_WHATSAPP_TEST_NUMBER = {
  phone: "+5490000000001",
  name: "QA Supervisor Staging (Ficticio)",
  role: "SUPERVISOR",
};

/**
 * Validates that environment variables and target connection string are strictly
 * isolated for staging and cannot accidentally target production or pair real WhatsApp.
 */
export function validateStagingExecutionEnvironment(env = process.env, explicitUrl = "") {
  if (String(env.STAGING_CONFIRM_ISOLATED ?? "").toLowerCase() !== "true") {
    throw new Error(
      "ABORT: STAGING_CONFIRM_ISOLATED=true es obligatorio para ejecutar scripts de staging."
    );
  }

  const railwayEnv = String(env.RAILWAY_ENVIRONMENT_NAME ?? "").trim().toLowerCase();
  if (railwayEnv === "production" || railwayEnv === "prod") {
    throw new Error(
      `ABORT: RAILWAY_ENVIRONMENT_NAME='${env.RAILWAY_ENVIRONMENT_NAME}' apunta a producción.`
    );
  }

  const railwayService = String(env.RAILWAY_SERVICE_NAME ?? "").trim().toLowerCase();
  if (railwayService.includes("production") || /(?:^|[-_])prod(?:$|[-_])/.test(railwayService)) {
    throw new Error(
      `ABORT: RAILWAY_SERVICE_NAME='${env.RAILWAY_SERVICE_NAME}' sugiere servicio de producción.`
    );
  }

  if (String(env.WHATSAPP_PAIRING_NUMBER ?? "").trim() !== "") {
    throw new Error(
      "ABORT: WHATSAPP_PAIRING_NUMBER debe estar vacío en staging para evitar vincular un teléfono real."
    );
  }

  const connectionString = (explicitUrl || env.STAGING_DATABASE_URL || env.DATABASE_URL || "").trim();
  if (!connectionString) {
    throw new Error(
      "ABORT: Debe configurarse STAGING_DATABASE_URL (o DATABASE_URL en entorno staging aislado)."
    );
  }

  let parsed;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error("ABORT: La URL de base de datos de staging no tiene un formato válido.");
  }

  const hostAndDb = `${parsed.hostname}${parsed.pathname}`.toLowerCase();
  if (/(?:^|[.\-_/:])(production|prod)(?:[.\-_/:]|$)/.test(hostAndDb)) {
    throw new Error(
      `ABORT: El host o nombre de base '${parsed.hostname}${parsed.pathname}' parece pertenecer a producción.`
    );
  }

  return {
    connectionString,
    hostname: parsed.hostname,
    database: parsed.pathname.replace(/^\//, "") || "default",
    usingDedicatedStagingVar: Boolean(explicitUrl || env.STAGING_DATABASE_URL),
  };
}

/**
 * Generates deterministic synthetic products covering all QA scenarios:
 * - Proveedor 50350 active without sales history (1002)
 * - Proveedor 50350 inactive excluded by default (1003)
 * - Independent branch base_stock + explicit 0 + legacy Stopti coexistence (1004)
 * - Reused code cutoff detection ORDER_SNAPSHOT_DIFF (1005)
 * - Presentation spacing equivalence 500ML vs 500 ML zero false positive (1006)
 * - Pending order subtraction isolated by branch (1007)
 * - >10 products across Rubros for WhatsApp pagination & Excel export (1008..1028)
 */
export function buildSyntheticProducts() {
  const catalog = [
    {
      articleId: 1001,
      description: "ALFAJOR STAGING DULCE X 50G",
      brand: "STAGING_SWEET",
      supplierCode: "50350",
      classificationCode: "009001",
      rubro: "GALLETITAS",
      bulto: "12",
      unitMeasure: "UN",
      estado: "1",
      stopti: "",
      stockDepot: 40,
      stockCentro: 2,
      stockJardin: 8,
    },
    {
      articleId: 1002,
      description: "GALLETITA NUEVA 50350 SIN HISTORIAL X 120G",
      brand: "STAGING_CRISP",
      supplierCode: "50350",
      classificationCode: "009002",
      rubro: "GALLETITAS",
      bulto: "10",
      unitMeasure: "UN",
      estado: "1",
      stopti: "",
      stockDepot: 24,
      stockCentro: 0,
      stockJardin: 0,
    },
    {
      articleId: 1003,
      description: "CARAMELO INACTIVO 50350 TEST",
      brand: "STAGING_CANDY",
      supplierCode: "50350",
      classificationCode: "013001",
      rubro: "CARAMELOS",
      bulto: "20",
      unitMeasure: "UN",
      estado: "0",
      stopti: "",
      stockDepot: 10,
      stockCentro: 3,
      stockJardin: 2,
    },
    {
      articleId: 1004,
      description: "CHOCOLATE BASE STOCK 100G",
      brand: "STAGING_CACAO",
      supplierCode: "50350",
      classificationCode: "006001",
      rubro: "CHOCOLATES",
      bulto: "6",
      unitMeasure: "UN",
      estado: "1",
      stopti: "18",
      stockDepot: 50,
      stockCentro: 1,
      stockJardin: 5,
    },
    {
      articleId: 1005,
      description: "GALLETITA CODIGO REUTILIZADO 200G",
      brand: "STAGING_CRISP",
      supplierCode: "50350",
      classificationCode: "009003",
      rubro: "GALLETITAS",
      bulto: "8",
      unitMeasure: "UN",
      estado: "1",
      stopti: "",
      stockDepot: 30,
      stockCentro: 2,
      stockJardin: 6,
    },
    {
      articleId: 1006,
      description: "GASEOSA STAGING COLA 500ML",
      brand: "STAGING_FIZZ",
      supplierCode: "50350",
      classificationCode: "014001",
      rubro: "BEBIDAS",
      bulto: "6",
      unitMeasure: "UN",
      estado: "1",
      stopti: "",
      stockDepot: 48,
      stockCentro: 6,
      stockJardin: 6,
    },
    {
      articleId: 1007,
      description: "PAPAS FRITAS STAGING 90G",
      brand: "STAGING_CRUNCH",
      supplierCode: "50350",
      classificationCode: "005001",
      rubro: "COPETIN",
      bulto: "10",
      unitMeasure: "UN",
      estado: "1",
      stopti: "",
      stockDepot: 36,
      stockCentro: 2,
      stockJardin: 1,
    },
  ];

  // Additional 50350 items (1008..1019) to exceed WHATSAPP_PAGE_SIZE=10 on supplier & low stock queries
  const extra50350 = [
    ["TURRON STAGING MANI 25G", "013002", "CARAMELOS", 60, 1, 2],
    ["BOMBOM STAGING SURTIDO X12", "006002", "CHOCOLATES", 24, 0, 3],
    ["MANI SALADO STAGING 80G", "005002", "COPETIN", 30, 1, 4],
    ["OBLEA STAGING VAINILLA 75G", "009004", "GALLETITAS", 36, 2, 1],
    ["PASTILLA STAGING MENTA 30G", "013003", "CARAMELOS", 40, 1, 1],
    ["CHICLE STAGING FRUTAL", "013004", "CARAMELOS", 50, 0, 2],
    ["BARRA CEREAL STAGING MIEL", "011001", "ALMACEN", 24, 1, 5],
    ["BUDIN STAGING LIMON 170G", "011002", "ALMACEN", 18, 0, 2],
    ["MAICITOS STAGING QUESO 60G", "005003", "COPETIN", 28, 2, 0],
    ["BIZCOCHOS STAGING GRASA 200G", "009005", "GALLETITAS", 32, 1, 3],
    ["ALFAJOR STAGING TRIPLE NEGRO", "006003", "CHOCOLATES", 42, 0, 1],
    ["GOMITAS STAGING ACIDAS 90G", "013005", "CARAMELOS", 30, 1, 0],
  ];

  extra50350.forEach(([description, classificationCode, rubro, stockDepot, stockCentro, stockJardin], idx) => {
    catalog.push({
      articleId: 1008 + idx,
      description,
      brand: "STAGING_50350",
      supplierCode: "50350",
      classificationCode,
      rubro,
      bulto: "12",
      unitMeasure: "UN",
      estado: "1",
      stopti: "",
      stockDepot,
      stockCentro,
      stockJardin,
    });
  });

  // Other suppliers, negative stock, out of stock & Figuritas rubro (1020..1028)
  const otherItems = [
    {
      articleId: 1020,
      description: "JUGO STAGING NARANJA 1L",
      brand: "BEBIDAS_QA",
      supplierCode: "50100",
      classificationCode: "014002",
      rubro: "BEBIDAS",
      bulto: "12",
      unitMeasure: "UN",
      estado: "1",
      stopti: "10",
      stockDepot: 24,
      stockCentro: 3,
      stockJardin: 4,
    },
    {
      articleId: 1021,
      description: "YERBA STAGING SUAVE 500G",
      brand: "ALMACEN_QA",
      supplierCode: "50100",
      classificationCode: "011003",
      rubro: "ALMACEN",
      bulto: "10",
      unitMeasure: "UN",
      estado: "1",
      stopti: "",
      stockDepot: 20,
      stockCentro: 2,
      stockJardin: 5,
    },
    {
      articleId: 1022,
      description: "CIGARRILLOS STAGING BOX 20",
      brand: "TABACO_QA",
      supplierCode: "50200",
      classificationCode: "001001",
      rubro: "CIGARRILLOS",
      bulto: "10",
      unitMeasure: "UN",
      estado: "1",
      stopti: "",
      stockDepot: 15,
      stockCentro: 4,
      stockJardin: 2,
    },
    {
      articleId: 1023,
      description: "ENCENDEDOR STAGING CHISPA",
      brand: "VARIOS_QA",
      supplierCode: "50200",
      classificationCode: "034001",
      rubro: "ENCENDIDOS",
      bulto: "25",
      unitMeasure: "UN",
      estado: "1",
      stopti: "",
      stockDepot: 50,
      stockCentro: 5,
      stockJardin: 5,
    },
    {
      articleId: 1024,
      description: "CHOCOLATE AMARGO 70% STAGING",
      brand: "CHOCO_QA",
      supplierCode: "50200",
      classificationCode: "006004",
      rubro: "CHOCOLATES",
      bulto: "8",
      unitMeasure: "UN",
      estado: "1",
      stopti: "",
      stockDepot: 16,
      stockCentro: 1,
      stockJardin: 3,
    },
    {
      articleId: 1025,
      description: "ENERGIZANTE STOCK NEGATIVO 250ML",
      brand: "BEBIDAS_QA",
      supplierCode: "50100",
      classificationCode: "014003",
      rubro: "BEBIDAS",
      bulto: "12",
      unitMeasure: "UN",
      estado: "1",
      stopti: "",
      stockDepot: 12,
      stockCentro: -2,
      stockJardin: 1,
    },
    {
      articleId: 1026,
      description: "AGUA MINERAL AGOTADA 500ML",
      brand: "BEBIDAS_QA",
      supplierCode: "50100",
      classificationCode: "014004",
      rubro: "BEBIDAS",
      bulto: "12",
      unitMeasure: "UN",
      estado: "1",
      stopti: "",
      stockDepot: 0,
      stockCentro: 0,
      stockJardin: 0,
    },
    {
      articleId: 1027,
      description: "ALBUM FIGURITAS STAGING QA",
      brand: "FIGURITAS_QA",
      supplierCode: "50400",
      classificationCode: "017001",
      rubro: "FIGURITAS",
      bulto: "10",
      unitMeasure: "UN",
      estado: "1",
      stopti: "",
      stockDepot: 20,
      stockCentro: 2,
      stockJardin: 4,
    },
    {
      articleId: 1028,
      description: "SOBRE FIGURITAS STAGING QA X5",
      brand: "FIGURITAS_QA",
      supplierCode: "50400",
      classificationCode: "017002",
      rubro: "FIGURITAS",
      bulto: "50",
      unitMeasure: "UN",
      estado: "1",
      stopti: "",
      stockDepot: 100,
      stockCentro: 5,
      stockJardin: 10,
    },
  ];

  return [...catalog, ...otherItems];
}

/**
 * Generates deterministic synthetic sales (VT), depot entries (IN/HOJD),
 * adjustments (AJUS), and 1 non-numeric edge row to exercise SQL regex guards.
 */
export function buildSyntheticMovements(referenceDate = new Date()) {
  const movements = [];
  const isoDay = (daysAgo) => {
    const d = new Date(referenceDate);
    d.setUTCHours(14, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() - daysAgo);
    return d.toISOString().slice(0, 19);
  };

  // Articles with steady 8-week demand history on Centro (branch 2) and Jardín (branch 3)
  // Note: 1002 intentionally has NO movements (active product without sales history).
  const demandProfiles = [
    { articleId: 1001, qtyCentro: 6, qtyJardin: 5 },
    { articleId: 1003, qtyCentro: 2, qtyJardin: 1 }, // inactive product with old movement
    { articleId: 1004, qtyCentro: 4, qtyJardin: 3 },
    { articleId: 1006, qtyCentro: 8, qtyJardin: 4 },
    { articleId: 1007, qtyCentro: 9, qtyJardin: 6 },
    { articleId: 1008, qtyCentro: 5, qtyJardin: 3 },
    { articleId: 1009, qtyCentro: 4, qtyJardin: 2 },
    { articleId: 1010, qtyCentro: 5, qtyJardin: 3 },
    { articleId: 1011, qtyCentro: 3, qtyJardin: 2 },
    { articleId: 1012, qtyCentro: 4, qtyJardin: 2 },
    { articleId: 1013, qtyCentro: 3, qtyJardin: 1 },
    { articleId: 1020, qtyCentro: 5, qtyJardin: 4 },
    { articleId: 1021, qtyCentro: 4, qtyJardin: 3 },
    { articleId: 1025, qtyCentro: 7, qtyJardin: 2 },
    { articleId: 1026, qtyCentro: 6, qtyJardin: 2 },
    { articleId: 1028, qtyCentro: 12, qtyJardin: 8 },
  ];

  for (const profile of demandProfiles) {
    for (let week = 1; week <= 8; week++) {
      const daysAgo = week * 7;
      movements.push({
        branchId: 2,
        sourceId: STAGING_SOURCES[2],
        idarti: String(profile.articleId),
        fedepo: isoDay(daysAgo),
        tipomov: "VT",
        cantidad: profile.qtyCentro,
        codcom: "TICK",
        numero: `STG-C-${profile.articleId}-W${week}`,
        externalKey: `stg-vt-c-${profile.articleId}-w${week}`,
      });
      movements.push({
        branchId: 3,
        sourceId: STAGING_SOURCES[3],
        idarti: String(profile.articleId),
        fedepo: isoDay(daysAgo),
        tipomov: "VT",
        cantidad: profile.qtyJardin,
        codcom: "PRES",
        numero: `STG-J-${profile.articleId}-W${week}`,
        externalKey: `stg-vt-j-${profile.articleId}-w${week}`,
      });
    }
  }

  // Reused code 1005: high old sales (pre-cutoff 45..70 days ago) + low recent sales (5 & 12 days ago)
  for (const [idx, daysAgo] of [70, 56, 49, 42].entries()) {
    movements.push({
      branchId: 2,
      sourceId: STAGING_SOURCES[2],
      idarti: "1005",
      fedepo: isoDay(daysAgo),
      tipomov: "VT",
      cantidad: 25,
      codcom: "TICK",
      numero: `STG-OLD-1005-${idx}`,
      externalKey: `stg-old-1005-${idx}`,
    });
  }
  for (const [idx, daysAgo] of [12, 5].entries()) {
    movements.push({
      branchId: 2,
      sourceId: STAGING_SOURCES[2],
      idarti: "1005",
      fedepo: isoDay(daysAgo),
      tipomov: "VT",
      cantidad: 3,
      codcom: "FACV",
      numero: `STG-NEW-1005-${idx}`,
      externalKey: `stg-new-1005-${idx}`,
    });
  }

  // Historical IN / HOJD documents (>= 3) for supply rules evidence classification
  for (const articleId of [1001, 1004, 1006, 1007]) {
    for (const docIdx of [1, 2, 3]) {
      movements.push({
        branchId: 2,
        sourceId: STAGING_SOURCES[2],
        idarti: String(articleId),
        fedepo: isoDay(docIdx * 10),
        tipomov: "IN",
        cantidad: 12,
        codcom: "HOJD",
        numero: `HOJD-STG-${articleId}-${docIdx}`,
        externalKey: `stg-hojd-c-${articleId}-${docIdx}`,
      });
    }
  }

  // Edge movement rows: AJUS adjustment + non-numeric idarti to verify regex guard in PostgreSQL
  movements.push({
    branchId: 2,
    sourceId: STAGING_SOURCES[2],
    idarti: "1001",
    fedepo: isoDay(3),
    tipomov: "AJUS",
    cantidad: 1,
    codcom: "AJUS",
    numero: "STG-AJUS-1001",
    externalKey: "stg-ajus-1001",
  });
  movements.push({
    branchId: 2,
    sourceId: STAGING_SOURCES[2],
    idarti: "NO-NUM-TEST",
    fedepo: isoDay(4),
    tipomov: "VT",
    cantidad: 2,
    codcom: "TICK",
    numero: "STG-EDGE-NONNUM",
    externalKey: "stg-edge-nonnum",
  });

  return movements;
}

