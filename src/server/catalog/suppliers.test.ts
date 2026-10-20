import { describe, expect, it } from "vitest";
import { findSupplierByCode, resolveSupplier } from "./suppliers";

describe("Suppliers Resolution & Canonical Mapping", () => {
  describe("findSupplierByCode", () => {
    it("finds supplier by exact numeric code", () => {
      const s1 = findSupplierByCode("50350");
      expect(s1).toBeDefined();
      expect(s1?.name).toBe("Arcor");

      const s2 = findSupplierByCode("50001");
      expect(s2).toBeDefined();
      expect(s2?.name).toBe("Massalin Particulares");

      const s3 = findSupplierByCode("600036");
      expect(s3).toBeDefined();
      expect(s3?.name).toBe("Baggio");
    });

    it("returns null for unknown numeric code", () => {
      expect(findSupplierByCode("9999999")).toBeNull();
    });
  });

  describe("resolveSupplier", () => {
    it("resolves by numeric code: 'proveedor 50350' or '50350'", () => {
      const r1 = resolveSupplier("50350");
      expect(r1.status).toBe("EXACT");
      if (r1.status === "EXACT") {
        expect(r1.supplier.code).toBe("50350");
        expect(r1.supplier.name).toBe("Arcor");
      }

      const r2 = resolveSupplier("proveedor 600036");
      expect(r2.status).toBe("EXACT");
      if (r2.status === "EXACT") {
        expect(r2.supplier.code).toBe("600036");
        expect(r2.supplier.name).toBe("Baggio");
      }
    });

    it("resolves by brand name: 'Arcor', 'Coca-Cola', 'Baggio', 'Massalin'", () => {
      const rArcor = resolveSupplier("Arcor");
      expect(rArcor.status).toBe("EXACT");
      if (rArcor.status === "EXACT") {
        expect(rArcor.supplier.code).toBe("50350");
      }

      const rCoca = resolveSupplier("coca cola");
      expect(rCoca.status).toBe("EXACT");
      if (rCoca.status === "EXACT") {
        expect(rCoca.supplier.name).toBe("Coca-Cola / Andina");
      }

      const rMarlboro = resolveSupplier("Marlboro");
      expect(rMarlboro.status).toBe("EXACT");
      if (rMarlboro.status === "EXACT") {
        expect(rMarlboro.supplier.name).toBe("Massalin Particulares");
      }
    });

    it("resolves typos and aliases: 'bagio', 'cocacola'", () => {
      const rBaggioTypo = resolveSupplier("bagio");
      expect(rBaggioTypo.status).toBe("EXACT");
      if (rBaggioTypo.status === "EXACT") {
        expect(rBaggioTypo.supplier.name).toBe("Baggio");
      }

      const rCocaAlias = resolveSupplier("cocacola");
      expect(rCocaAlias.status).toBe("EXACT");
    });

    it("returns AMBIGUOUS when multiple suppliers match a common generic token", () => {
      // e.g. "bebidas" or "distribuidora"
      const rAmbiguous = resolveSupplier("distribuidora");
      if (rAmbiguous.status === "AMBIGUOUS") {
        expect(rAmbiguous.candidates.length).toBeGreaterThanOrEqual(2);
      }
    });

    it("returns NOT_FOUND for completely non-existent suppliers", () => {
      const rNotFound = resolveSupplier("proveedor inventado xyz 999");
      expect(rNotFound.status).toBe("NOT_FOUND");
    });
  });
});
