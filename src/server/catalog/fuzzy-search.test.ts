import { describe, expect, it } from "vitest";
import {
  calculateProductSimilarity,
  canonicalizeCommercialBrand,
  damerauLevenshteinDistance,
  ngramSimilarity,
  normalizeFuzzyText,
} from "./fuzzy-search";

describe("Catalog Tolerant Fuzzy Search & Commercial Aliases", () => {
  describe("normalizeFuzzyText", () => {
    it("lowercases, strips accents, removes punctuation and extra whitespace", () => {
      expect(normalizeFuzzyText("  ¡Bon o Bón!  ")).toBe("bon o bon");
      expect(normalizeFuzzyText("Coca-Cola Zero")).toBe("coca cola zero");
      expect(normalizeFuzzyText("CAFÉ CON LECHE 180G.")).toBe("cafe con leche 180g");
    });
  });

  describe("canonicalizeCommercialBrand", () => {
    it("maps common commercial variants and brand nicknames to canonical names", () => {
      expect(canonicalizeCommercialBrand("bonobon")).toBe("bon o bon");
      expect(canonicalizeCommercialBrand("bon o bon")).toBe("bon o bon");
      expect(canonicalizeCommercialBrand("coca")).toBe("coca cola");
      expect(canonicalizeCommercialBrand("cocacola")).toBe("coca cola");
      expect(canonicalizeCommercialBrand("malboro")).toBe("marlboro");
      expect(canonicalizeCommercialBrand("philip moris")).toBe("philip morris");
      expect(canonicalizeCommercialBrand("chocotorta")).toBe("chocolinas");
      expect(canonicalizeCommercialBrand("bagio")).toBe("baggio");
    });
  });

  describe("damerauLevenshteinDistance", () => {
    it("computes edit distance with single-character typo tolerance", () => {
      expect(damerauLevenshteinDistance("havanna", "havanna")).toBe(0);
      expect(damerauLevenshteinDistance("havana", "havanna")).toBe(1); // 1 letter omitted
      expect(damerauLevenshteinDistance("bonobon", "bon o bon")).toBe(2);
      expect(damerauLevenshteinDistance("bagio", "baggio")).toBe(1);
    });
  });

  describe("ngramSimilarity", () => {
    it("calculates bigram dice coefficient", () => {
      expect(ngramSimilarity("coca cola", "coca cola")).toBe(1);
      expect(ngramSimilarity("coca cola", "cocacola")).toBeGreaterThan(0.7);
      expect(ngramSimilarity("alfajor", "detergente")).toBe(0);
    });
  });

  describe("calculateProductSimilarity", () => {
    it("scores exact matches with 1.0", () => {
      const match = calculateProductSimilarity(
        "alfajor havanna",
        "Alfajor Havanna Chocolate",
        "Havanna"
      );
      expect(match.score).toBeGreaterThan(0.85);
      expect(match.confidence).toBe("HIGH");
    });

    it("matches brand typo with high confidence", () => {
      const match = calculateProductSimilarity(
        "alfajor havana",
        "Alfajor Havanna Chocolate",
        "Havanna"
      );
      expect(match.score).toBeGreaterThan(0.8);
      expect(match.confidence).toBe("HIGH");
    });

    it("matches Bonobon to Bon o Bon", () => {
      const match = calculateProductSimilarity(
        "bonobon leche",
        "Bombón Bon o Bon Leche 15g",
        "Arcor"
      );
      expect(match.score).toBeGreaterThan(0.7);
    });

    it("yields low confidence for completely different products", () => {
      const match = calculateProductSimilarity(
        "coca cola",
        "Pilas Energizer AA x4",
        "Energizer"
      );
      expect(match.score).toBeLessThan(0.3);
      expect(match.confidence).toBe("LOW");
    });
  });
});
