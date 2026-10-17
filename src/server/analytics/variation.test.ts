import { describe, expect, it } from "vitest";
import { calculateVariationPercent } from "./dashboard";

describe("calculateVariationPercent", () => {
  it("returns null when previous net units is zero (avoid divide-by-zero)", () => {
    expect(calculateVariationPercent(100, 0)).toBeNull();
    expect(calculateVariationPercent(0, 0)).toBeNull();
    expect(calculateVariationPercent(-50, 0)).toBeNull();
  });

  it("calculates positive variation correctly", () => {
    expect(calculateVariationPercent(150, 100)).toBe(50);
    expect(calculateVariationPercent(200, 100)).toBe(100);
  });

  it("calculates negative variation correctly", () => {
    expect(calculateVariationPercent(50, 100)).toBe(-50);
    expect(calculateVariationPercent(0, 100)).toBe(-100);
  });

  it("handles high percentage variations as observed in real sales periods", () => {
    // Example: previous period 354 units, current period 3217 units
    const result = calculateVariationPercent(3217, 354);
    expect(result).not.toBeNull();
    expect(Number(result?.toFixed(2))).toBe(808.76);
  });

  it("handles zero current units with non-zero previous units", () => {
    expect(calculateVariationPercent(0, 250)).toBe(-100);
  });

  it("handles identical periods", () => {
    expect(calculateVariationPercent(500, 500)).toBe(0);
  });

  it("uses absolute value in denominator for negative previous units", () => {
    // If previous was net -10 and current is +10: (10 - (-10)) / 10 * 100 = 200%
    expect(calculateVariationPercent(10, -10)).toBe(200);
  });
});
