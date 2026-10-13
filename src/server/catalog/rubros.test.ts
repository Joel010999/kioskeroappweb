import { describe, expect, it } from "vitest";
import { resolveRubroName, CANONICAL_RUBROS } from "./rubros";

describe("catalog/rubros", () => {
  it("resolves specific cigarette codes mentioned in user report", () => {
    expect(resolveRubroName("0014343")).toBe("CIGARRILLOS");
    expect(resolveRubroName("0010133")).toBe("CIGARRILLOS");
    expect(resolveRubroName("0010113")).toBe("CIGARRILLOS");
    expect(resolveRubroName("0014342")).toBe("CIGARRILLOS");
  });

  it("resolves standard 3-digit prefixes to canonical categories", () => {
    expect(resolveRubroName("0090012")).toBe("GALLETITAS");
    expect(resolveRubroName("0060032")).toBe("CHOCOLATES");
    expect(resolveRubroName("0114462")).toBe("ALMACEN");
    expect(resolveRubroName("0134342")).toBe("CARAMELOS");
    expect(resolveRubroName("0040032")).toBe("PILAS");
    expect(resolveRubroName("0050012")).toBe("COPETIN");
    expect(resolveRubroName("0150022")).toBe("PERFUMERIA");
    expect(resolveRubroName("0160252")).toBe("INSECTICIDA");
    expect(resolveRubroName("0184352")).toBe("LIMPIEZA");
    expect(resolveRubroName("0190192")).toBe("PEGAMENTOS");
    expect(resolveRubroName("02023 2")).toBe("BEBIDAS");
    expect(resolveRubroName("0264042")).toBe("TABACO Y AFINES");
    expect(resolveRubroName("0310012")).toBe("NAIPES");
    expect(resolveRubroName("0344342")).toBe("ENCENDIDOS");
    expect(resolveRubroName("0424262")).toBe("DESCARTABLES");
  });

  it("preserves canonical rubro if already passed", () => {
    expect(resolveRubroName(null, "GALLETITAS")).toBe("GALLETITAS");
    expect(resolveRubroName("0014343", "CIGARRILLOS")).toBe("CIGARRILLOS");
  });

  it("handles empty or missing classification as Sin rubro", () => {
    expect(resolveRubroName(null, null)).toBe("Sin rubro");
    expect(resolveRubroName("", "")).toBe("Sin rubro");
    expect(resolveRubroName(undefined, undefined)).toBe("Sin rubro");
  });

  it("contains all 18 canonical business categories", () => {
    expect(CANONICAL_RUBROS).toHaveLength(18);
    expect(CANONICAL_RUBROS).toContain("CIGARRILLOS");
    expect(CANONICAL_RUBROS).toContain("GALLETITAS");
    expect(CANONICAL_RUBROS).toContain("CHOCOLATES");
    expect(CANONICAL_RUBROS).toContain("ALMACEN");
    expect(CANONICAL_RUBROS).toContain("BEBIDAS");
  });
});
