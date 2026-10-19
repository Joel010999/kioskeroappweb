import { describe, expect, it, vi } from "vitest";
import { query } from "@/server/db/client";

vi.mock("@/server/db/client", () => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
}));

import {
  queryOrderDetail,
  queryProductStock,
  queryProductSupplier,
  querySupplierProducts,
  resolveScope,
} from "./queries";

describe("WhatsApp Queries Security & Read-Only Guarantees", () => {
  it("uses parameterized queries preventing SQL injection on product search", async () => {
    let capturedQuery = "";
    let capturedValues: any[] = [];

    vi.mocked(query).mockImplementation(async (text: string, values: any) => {
      capturedQuery = text;
      capturedValues = values;
      return { rows: [] } as any;
    });

    const maliciousSearch = "alfajor' OR 1=1; DROP TABLE orders; --";
    await queryProductStock({ productSearch: maliciousSearch }, "ALL");

    // The SQL statement itself must not contain the raw malicious string
    expect(capturedQuery).not.toContain(maliciousSearch);
    expect(capturedQuery).toContain("$"); // Uses parameters $1, $2, etc.
    expect(capturedValues).toContain(`%${maliciousSearch}%`);
  });

  it("strictly executes read-only SELECT statements, never mutating queries", async () => {
    const executedQueries: string[] = [];

    vi.mocked(query).mockImplementation(async (text: string) => {
      executedQueries.push(text.trim());
      return { rows: [] } as any;
    });

    await queryProductStock({ articleId: 1052 }, "ALL");
    await queryProductSupplier({ articleId: 1052 });
    await querySupplierProducts("Arcor");

    for (const q of executedQueries) {
      const upper = q.toUpperCase();
      expect(upper.startsWith("SELECT")).toBe(true);
      expect(upper).not.toContain("INSERT INTO");
      expect(upper).not.toContain("UPDATE ");
      expect(upper).not.toContain("DELETE FROM");
      expect(upper).not.toContain("DROP TABLE");
      expect(upper).not.toContain("ALTER TABLE");
    }
  });

  it("handles empty results gracefully without throwing unexpected errors", async () => {
    vi.mocked(query).mockResolvedValue({ rows: [] } as any);

    const stockResult = await queryProductStock({ productSearch: "ProductoInexistente9999" });
    expect(stockResult.items).toEqual([]);
    expect(stockResult.totalFound).toBe(0);

    const supplierResult = await queryProductSupplier({ productSearch: "ProductoInexistente9999" });
    expect(supplierResult).toEqual([]);

    const supplierProductsResult = await querySupplierProducts("ProveedorInexistente9999");
    expect(supplierProductsResult).toEqual([]);
  });

  it("resolves branch scopes reliably", async () => {
    const scopeCentro = await resolveScope(2);
    expect(scopeCentro.branchId).toBe(2);
    expect(scopeCentro.organizationId).toBe(1);

    const scopeJardin = await resolveScope(3);
    expect(scopeJardin.branchId).toBe(3);

    const scopeDepo = await resolveScope(1);
    expect(scopeDepo.branchId).toBe(1);
  });
});
