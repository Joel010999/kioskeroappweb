import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migration = await readFile("migrations/007_suppliers_and_product_suppliers.sql", "utf8");
const branchRulesSeed = await readFile("migrations/009_seed_branch_product_supply_rules.sql", "utf8");

describe("supplier master migration", () => {
  it("keeps supplier codes unique and supply routes explicit", () => {
    expect(migration).toContain("UNIQUE (organization_id, external_code)");
    expect(migration).toContain("UNIQUE (organization_id, article_id)");
    expect(migration).toContain("CHECK (supply_mode IN ('UNDEFINED', 'DEPOT', 'DIRECT_TO_POS'))");
    expect(migration).toContain("'UNDEFINED'");
  });

  it("maps only confirmed catalog fields and is idempotent", () => {
    expect(migration).toContain("payload->>'Proveedor'");
    expect(migration).toContain("payload->>'ArticuloProveedor'");
    expect(migration).toContain("payload->>'HabilitadoCompra'");
    expect(migration).toContain("ON CONFLICT (organization_id, external_code) DO NOTHING");
    expect(migration).toContain("ON CONFLICT (organization_id, article_id) DO UPDATE");
  });

  it("does not derive purchasing rules from unconfirmed or raw movement data", () => {
    expect(migration).not.toContain("NMinMay");
    expect(migration).not.toContain("Cossimp");
    expect(migration).not.toContain("stock_levels_raw");
    expect(migration).not.toContain("stock_movements_raw");
  });

  it("initializes point-of-sale routes as undefined without inferring a commercial path", () => {
    expect(branchRulesSeed).toContain("b.type = 'POS'");
    expect(branchRulesSeed).toContain("'UNDEFINED'");
    expect(branchRulesSeed).toContain("ON CONFLICT (organization_id, branch_id, article_id) DO NOTHING");
    expect(branchRulesSeed).not.toContain("'DEPOT'");
    expect(branchRulesSeed).not.toContain("'DIRECT_SUPPLIER'");
  });
});
