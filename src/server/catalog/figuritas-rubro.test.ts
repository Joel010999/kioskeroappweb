import { describe, expect, it } from "vitest";
import {
  CANONICAL_RUBROS,
  resolveRubroName,
  compareRubros,
  compareByRubroAndProduct,
  isSinRubro,
  SQL_RUBRO_EXPRESSION,
} from "./rubros";
import {
  resolveCanonicalRubroFromText,
  formatRubroLabel,
} from "@/server/whatsapp/router";

describe("Rubro Figuritas - Corrección y validaciones", () => {
  it("1. Rubro existente y canónico: FIGURITAS está en CANONICAL_RUBROS y no es Sin rubro", () => {
    expect(CANONICAL_RUBROS).toContain("FIGURITAS");
    expect(isSinRubro("FIGURITAS")).toBe(false);
    expect(isSinRubro("Figuritas")).toBe(false);
  });

  it("2. Asociación de productos: prefijo 017 y códigos reales se asocian a FIGURITAS", () => {
    // Subclasificación 017001: Figus y sobres (ej. FIG. FUTBOL ARGENTINO, FIG. POKEMON)
    expect(resolveRubroName("0170012")).toBe("FIGURITAS");
    // Subclasificación 017002: Álbumes (ej. ALBUM MUNDIAL, ALBUM DRAGON BALL)
    expect(resolveRubroName("0170022")).toBe("FIGURITAS");
    // Subclasificación 017363: Cartas y mazos de colección (ej. CARTAS AMONG US, MAZOS)
    expect(resolveRubroName("0173632")).toBe("FIGURITAS");
    // Código genérico con prefijo 017
    expect(resolveRubroName("0179999")).toBe("FIGURITAS");
  });

  it("3. Preservación del nombre si ya viene explícito como FIGURITAS", () => {
    expect(resolveRubroName(null, "FIGURITAS")).toBe("FIGURITAS");
    expect(resolveRubroName(null, "Figuritas")).toBe("FIGURITAS");
    expect(resolveRubroName("0170012", "FIGURITAS")).toBe("FIGURITAS");
  });

  it("4. Ordenamiento alfabético: FIGURITAS se ubica entre ENCENDIDOS y GALLETITAS", () => {
    expect(compareRubros("ENCENDIDOS", "FIGURITAS")).toBeLessThan(0);
    expect(compareRubros("FIGURITAS", "GALLETITAS")).toBeLessThan(0);
    expect(compareRubros("FIGURITAS", "Sin rubro")).toBeLessThan(0);

    const rubros = ["GALLETITAS", "VARIOS", "FIGURITAS", "ALMACEN", "ENCENDIDOS"];
    const sorted = [...rubros].sort(compareRubros);
    expect(sorted).toEqual(["ALMACEN", "ENCENDIDOS", "FIGURITAS", "GALLETITAS", "VARIOS"]);
  });

  it("5. Ordenamiento de productos por rubro y descripción", () => {
    const items = [
      { article_id: 1, rubro: "GALLETITAS", description: "Oreo" },
      { article_id: 2, rubro: "FIGURITAS", description: "Fig. Pokemon x20" },
      { article_id: 3, rubro: "FIGURITAS", description: "Álbum Mundial 2026" },
      { article_id: 4, rubro: "ENCENDIDOS", description: "Fósforos Fragata" },
    ];
    const sorted = [...items].sort(compareByRubroAndProduct);
    expect(sorted.map((i) => i.description)).toEqual([
      "Fósforos Fragata",
      "Álbum Mundial 2026",
      "Fig. Pokemon x20",
      "Oreo",
    ]);
  });

  it("6. SQL_RUBRO_EXPRESSION contiene mapeo explícito de 017% a FIGURITAS y en lista IN", () => {
    expect(SQL_RUBRO_EXPRESSION).toContain("'FIGURITAS'");
    expect(SQL_RUBRO_EXPRESSION).toContain("WHEN p.payload->>'Clasificacion' LIKE '017%' THEN 'FIGURITAS'");
  });

  it("7. Reconocimiento en lenguaje natural (WhatsApp Router y búsqueda)", () => {
    expect(resolveCanonicalRubroFromText("pasame el excel de figuritas")).toEqual({
      canonical: "FIGURITAS",
    });
    expect(resolveCanonicalRubroFromText("necesito figus para centro")).toEqual({
      canonical: "FIGURITAS",
    });
    expect(resolveCanonicalRubroFromText("reponer albumes")).toEqual({
      canonical: "FIGURITAS",
    });
    expect(resolveCanonicalRubroFromText("rubro figuritas")).toEqual({
      canonical: "FIGURITAS",
    });
    expect(formatRubroLabel("FIGURITAS")).toBe("Figuritas");
  });

  it("8. Filtro ausente/exclusión: productos de Figuritas no coinciden con otros rubros", () => {
    const itemFigu = { classification_code: "0170012", rubro: resolveRubroName("0170012") };
    expect(itemFigu.rubro).toBe("FIGURITAS");
    expect(itemFigu.rubro === "VARIOS").toBe(false);
    expect(itemFigu.rubro === "GALLETITAS").toBe(false);
  });
});
