import { describe, expect, it } from "vitest";
import { resolveProductPresentation } from "./presentations";

describe("resolveProductPresentation", () => {
  it("resolves products with bulto > 1 as Bulto with equivalence", () => {
    const res18 = resolveProductPresentation({ bulto: "18", unitMeasure: "1 UN" });
    expect(res18.presentation).toBe("Bulto");
    expect(res18.packageUnits).toBe(18);
    expect(res18.displayText).toBe("Bulto (18 u.)");
    expect(res18.badgeText).toBe("Bulto x18");

    const res24 = resolveProductPresentation({ bulto: 24, unitMeasure: "1 UN" });
    expect(res24.presentation).toBe("Bulto");
    expect(res24.packageUnits).toBe(24);
    expect(res24.displayText).toBe("Bulto (24 u.)");
    expect(res24.badgeText).toBe("Bulto x24");
  });

  it("resolves products with bulto = 1 as Unidad", () => {
    const res1 = resolveProductPresentation({ bulto: "1", unitMeasure: "1 UN" });
    expect(res1.presentation).toBe("Unidad");
    expect(res1.packageUnits).toBe(1);
    expect(res1.displayText).toBe("Unidad");
    expect(res1.badgeText).toBe("Unidad");
  });

  it("resolves unit measure when bulto is missing or zero", () => {
    const resKg = resolveProductPresentation({ bulto: null, unitMeasure: "KG" });
    expect(resKg.presentation).toBe("Kg");
    expect(resKg.packageUnits).toBeNull();
    expect(resKg.displayText).toBe("Kg");

    const resLitro = resolveProductPresentation({ bulto: "0", unitMeasure: "Litro" });
    expect(resLitro.presentation).toBe("Litro");
    expect(resLitro.packageUnits).toBeNull();

    const resUn = resolveProductPresentation({ bulto: "", unitMeasure: "1 UN" });
    expect(resUn.presentation).toBe("Unidad");
    expect(resUn.packageUnits).toBe(1);

    const res12Un = resolveProductPresentation({ bulto: null, unitMeasure: "12 UN" });
    expect(res12Un.presentation).toBe("Bulto");
    expect(res12Un.packageUnits).toBe(12);
  });

  it("handles missing or unrecorded presentation safely without inventing data", () => {
    const resEmpty = resolveProductPresentation({});
    expect(resEmpty.presentation).toBe("No especificada");
    expect(resEmpty.packageUnits).toBeNull();
    expect(resEmpty.displayText).toBe("-");

    const resNull = resolveProductPresentation(undefined);
    expect(resNull.presentation).toBe("No especificada");
    expect(resNull.displayText).toBe("-");
  });
});
