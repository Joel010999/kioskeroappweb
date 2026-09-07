import { describe, expect, it } from "vitest";
import { signedQuantity } from "./signed-quantity";

describe("signedQuantity", () => {
  it("keeps sales positive", () => {
    expect(signedQuantity("VT", 10)).toBe(10);
  });

  it("makes inbound movements negative", () => {
    expect(signedQuantity("IN", 10)).toBe(-10);
  });

  it("ignores unsupported movement types", () => {
    expect(signedQuantity("AJUS", 10)).toBe(0);
  });
});
