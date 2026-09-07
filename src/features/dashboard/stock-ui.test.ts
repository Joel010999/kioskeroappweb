import { describe, expect, it } from "vitest";
import { pageItems, stockState } from "./dashboard-client";

describe("stock presentation", () => {
  it("distinguishes negative, depleted, and available balances", () => {
    expect(stockState(-4693)).toEqual({ label: "Saldo negativo", tone: "negative" });
    expect(stockState(0)).toEqual({ label: "Agotado", tone: "depleted" });
    expect(stockState(12)).toEqual({ label: "Disponible", tone: "available" });
  });

  it("keeps long pagination compact", () => {
    expect(pageItems(1, 135)).toEqual([1, 2, 3, "ellipsis", 135]);
    expect(pageItems(68, 135)).toEqual([1, "ellipsis", 68, "ellipsis", 135]);
    expect(pageItems(135, 135)).toEqual([1, "ellipsis", 133, 134, 135]);
  });
});
