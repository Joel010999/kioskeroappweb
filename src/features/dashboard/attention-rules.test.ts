import { describe, expect, it } from "vitest";
import { stockState } from "./dashboard-client";

function movementState(movements: number) {
  return movements > 0 ? "with-movement" : "without-movement";
}

describe("operational attention rules", () => {
  it("keeps negative, zero, and positive balances distinct", () => {
    expect(stockState(-4_693).label).toBe("Saldo negativo");
    expect(stockState(0).label).toBe("Agotado");
    expect(stockState(1).label).toBe("Disponible");
  });

  it("distinguishes a product with movement from one without movement", () => {
    expect(movementState(8)).toBe("with-movement");
    expect(movementState(0)).toBe("without-movement");
  });

  it("keeps an empty period as an absence of activity", () => {
    expect(movementState(0)).toBe("without-movement");
  });
});
