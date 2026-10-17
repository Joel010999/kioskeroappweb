import { describe, expect, it } from "vitest";
import { normalizeSupplierCodes } from "./replenishment-review-client";

describe("normalizeSupplierCodes", () => {
  it("normalizes array of raw string codes from ERP", () => {
    const raw = ["60642", "1001", "50350", "1001"];
    const result = normalizeSupplierCodes(raw);
    expect(result).toEqual(["1001", "50350", "60642"]);
  });

  it("normalizes array of object records if present", () => {
    const raw = [
      { code: "60642", name: "Arcor" },
      { code: "1001", name: "Baggio" },
    ];
    const result = normalizeSupplierCodes(raw);
    expect(result).toEqual(["1001", "60642"]);
  });

  it("filters out undefined, null, empty and special placeholders", () => {
    const raw = ["undefined", "null", "", "   ", "__SIN_PROVEEDOR__", "60642"];
    const result = normalizeSupplierCodes(raw);
    expect(result).toEqual(["60642"]);
  });

  it("handles undefined or empty input gracefully", () => {
    expect(normalizeSupplierCodes(undefined)).toEqual([]);
    expect(normalizeSupplierCodes([])).toEqual([]);
  });

  it("sorts codes numerically/alphabetically", () => {
    const raw = ["10", "2", "1", "20"];
    const result = normalizeSupplierCodes(raw);
    expect(result).toEqual(["1", "2", "10", "20"]);
  });
});
