import { describe, expect, it } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  STAGING_ORG_NAME,
  STAGING_SOURCES,
  STAGING_USERS,
  buildSyntheticMovements,
  buildSyntheticProducts,
  validateStagingExecutionEnvironment,
  // @ts-expect-error ESM script module without .d.ts
} from "../../../scripts/staging/staging-data.mjs";

const rootDir = process.cwd();

describe("Staging bootstrap DDL, migration order & isolation guards", () => {
  it("bootstrap.sql defines all 5 required external Alegon/source tables and production abort guards", async () => {
    const ddl = await readFile(join(rootDir, "scripts/staging/bootstrap.sql"), "utf8");

    expect(ddl).toContain("CREATE TABLE IF NOT EXISTS organizations");
    expect(ddl).toContain("CREATE TABLE IF NOT EXISTS sources");
    expect(ddl).toContain("CREATE TABLE IF NOT EXISTS products_raw");
    expect(ddl).toContain("CREATE TABLE IF NOT EXISTS stock_levels_raw");
    expect(ddl).toContain("CREATE TABLE IF NOT EXISTS stock_movements_raw");
    expect(ddl).toContain(STAGING_ORG_NAME);
    expect(ddl).toContain("RAISE EXCEPTION 'ABORT:");
    expect(ddl).toContain("source_id NOT LIKE 'staging_%'");

    for (const sourceId of Object.values(STAGING_SOURCES)) {
      expect(ddl).toContain(sourceId);
    }
  });

  it("migrations 001..019 are strictly contiguous, numbered sequentially, and free of duplicates", async () => {
    const files = (await readdir(join(rootDir, "migrations")))
      .filter((f) => f.endsWith(".sql"))
      .sort((a, b) => a.localeCompare(b, "en"));

    expect(files.length).toBeGreaterThanOrEqual(19);

    files.forEach((file, index) => {
      const expectedPrefix = String(index + 1).padStart(3, "0") + "_";
      expect(file.startsWith(expectedPrefix)).toBe(true);
    });
  });

  it("rejects execution unless explicit staging isolation confirmation and safe environment are set", () => {
    expect(() =>
      validateStagingExecutionEnvironment({
        STAGING_DATABASE_URL: "postgresql://postgres:pass@switchyard.proxy.rlwy.net:1234/railway",
      })
    ).toThrow(/STAGING_CONFIRM_ISOLATED/);

    expect(() =>
      validateStagingExecutionEnvironment({
        STAGING_CONFIRM_ISOLATED: "true",
        RAILWAY_ENVIRONMENT_NAME: "production",
        STAGING_DATABASE_URL: "postgresql://postgres:pass@switchyard.proxy.rlwy.net:1234/railway",
      })
    ).toThrow(/producción/i);

    expect(() =>
      validateStagingExecutionEnvironment({
        STAGING_CONFIRM_ISOLATED: "true",
        WHATSAPP_PAIRING_NUMBER: "5491112345678",
        STAGING_DATABASE_URL: "postgresql://postgres:pass@switchyard.proxy.rlwy.net:1234/railway",
      })
    ).toThrow(/WHATSAPP_PAIRING_NUMBER/);

    expect(() =>
      validateStagingExecutionEnvironment({
        STAGING_CONFIRM_ISOLATED: "true",
        STAGING_DATABASE_URL: "postgresql://postgres:pass@prod-db.internal:5432/kioskero_prod",
      })
    ).toThrow(/producción/i);

    const ok = validateStagingExecutionEnvironment({
      STAGING_CONFIRM_ISOLATED: "true",
      RAILWAY_ENVIRONMENT_NAME: "staging",
      WHATSAPP_PAIRING_NUMBER: "",
      STAGING_DATABASE_URL: "postgresql://postgres:pass@switchyard.proxy.rlwy.net:54321/railway",
    });
    expect(ok.usingDedicatedStagingVar).toBe(true);
    expect(ok.hostname).toBe("switchyard.proxy.rlwy.net");
  });

  it("synthetic staging dataset covers all QA scenarios cleanly", () => {
    const products = buildSyntheticProducts();
    const movements = buildSyntheticMovements();

    expect(products.length).toBeGreaterThanOrEqual(28);
    expect(STAGING_USERS.map((u: { branchId: number }) => u.branchId).sort()).toEqual([1, 2, 3]);

    // 1002 active 50350 product has zero sales movements
    const p1002 = products.find((p: { articleId: number }) => p.articleId === 1002);
    expect(p1002?.supplierCode).toBe("50350");
    expect(p1002?.estado).toBe("1");
    expect(movements.some((m: { idarti: string }) => m.idarti === "1002")).toBe(false);

    // 1003 inactive 50350 product
    const p1003 = products.find((p: { articleId: number }) => p.articleId === 1003);
    expect(p1003?.estado).toBe("0");

    // >= 15 active 50350 items to exercise WhatsApp pagination (>10)
    const active50350 = products.filter(
      (p: { supplierCode: string; estado: string }) => p.supplierCode === "50350" && p.estado === "1"
    );
    expect(active50350.length).toBeGreaterThanOrEqual(15);

    // Non-numeric idarti edge case included to verify regex guards in live PostgreSQL
    expect(movements.some((m: { idarti: string }) => m.idarti === "NO-NUM-TEST")).toBe(true);
  });
});

