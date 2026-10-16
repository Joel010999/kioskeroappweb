import { describe, expect, it } from "vitest";
import { resolveRubroName, CANONICAL_RUBROS, compareRubros, compareByRubroAndProduct } from "./rubros";

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

  it("sorts rubros alphabetically A to Z and places Sin rubro at the end", () => {
    const rubros = ["GALLETITAS", "Sin rubro", "BEBIDAS", null, "ALMACEN", ""];
    const sorted = [...rubros].sort(compareRubros);
    expect(sorted.slice(0, 3)).toEqual(["ALMACEN", "BEBIDAS", "GALLETITAS"]);
    // Null, empty, and "Sin rubro" must be at the end
    expect(sorted.slice(3).every((r) => !r || r.toLowerCase() === "sin rubro")).toBe(true);
  });

  it("sorts rubros case and accent insensitively", () => {
    expect(compareRubros("Árboles", "Bar")).toBeLessThan(0);
    expect(compareRubros("almacen", "BEBIDAS")).toBeLessThan(0);
  });

  it("sorts products by rubro A-Z, then by product description A-Z within rubro", () => {
    const items = [
      { article_id: 1, rubro: "GALLETITAS", description: "Oreo" },
      { article_id: 2, rubro: null, description: "Cosa sin rubro A" },
      { article_id: 3, rubro: "ALMACEN", description: "Yerba Rosamonte" },
      { article_id: 4, rubro: "ALMACEN", description: "Aceite Cañuelas" },
      { article_id: 5, rubro: "GALLETITAS", description: "Chocolinas" },
      { article_id: 6, rubro: "Sin rubro", description: "Cosa sin rubro B" },
    ];

    const sorted = [...items].sort(compareByRubroAndProduct);
    expect(sorted.map((i) => i.description)).toEqual([
      "Aceite Cañuelas", // ALMACEN
      "Yerba Rosamonte", // ALMACEN
      "Chocolinas",      // GALLETITAS
      "Oreo",            // GALLETITAS
      "Cosa sin rubro A", // Sin rubro
      "Cosa sin rubro B", // Sin rubro
    ]);
  });
});

