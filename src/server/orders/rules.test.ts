import { describe, expect, it } from "vitest";
import { canEditOrder, isOperationalQuantityValid, isValidQuantity, transitionEvent } from "./rules";

describe("order rules", () => {
  it("permits only the defined lifecycle transitions", () => {
    expect(transitionEvent("DRAFT", "CONFIRMED")).toBe("ORDER_CONFIRMED");
    expect(transitionEvent("CONFIRMED", "IN_PREPARATION")).toBe("ORDER_IN_PREPARATION");
    expect(transitionEvent("DISPATCHED", "COMPLETED")).toBe("ORDER_COMPLETED");
    expect(transitionEvent("DRAFT", "DISPATCHED")).toBeNull();
    expect(transitionEvent("COMPLETED", "CANCELLED")).toBeNull();
  });
  it("allows cancellation only before preparation", () => {
    expect(transitionEvent("DRAFT", "CANCELLED")).toBe("ORDER_CANCELLED");
    expect(transitionEvent("CONFIRMED", "CANCELLED")).toBe("ORDER_CANCELLED");
    expect(transitionEvent("IN_PREPARATION", "CANCELLED")).toBeNull();
  });
  it("allows edits only in draft and validates quantities", () => {
    expect(canEditOrder("DRAFT")).toBe(true); expect(canEditOrder("CONFIRMED")).toBe(false);
    expect(isValidQuantity(0)).toBe(true); expect(isValidQuantity(2.5)).toBe(true);
    expect(isValidQuantity(-1)).toBe(false); expect(isValidQuantity(Number.NaN)).toBe(false);
  });
  it("enforces the approved, prepared, dispatched and received quantity limits", () => {
    expect(isOperationalQuantityValid(8, 10)).toBe(true);
    expect(isOperationalQuantityValid(10, 10)).toBe(true);
    expect(isOperationalQuantityValid(11, 10)).toBe(false);
    expect(isOperationalQuantityValid(-1, 10)).toBe(false);
  });
  it("rejects operational transitions outside the depot flow", () => {
    expect(transitionEvent("DRAFT", "IN_PREPARATION")).toBeNull();
    expect(transitionEvent("CONFIRMED", "DISPATCHED")).toBeNull();
    expect(transitionEvent("CONFIRMED", "COMPLETED")).toBeNull();
    expect(transitionEvent("IN_PREPARATION", "CANCELLED")).toBeNull();
    expect(transitionEvent("IN_PREPARATION", "DISPATCHED")).toBe("ORDER_DISPATCHED");
    expect(transitionEvent("DISPATCHED", "COMPLETED")).toBe("ORDER_COMPLETED");
  });
});
