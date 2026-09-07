import { describe, expect, it } from "vitest";
import {
  branchDisplayName,
  isNavigationActive,
  navigationForRole,
} from "./operations-navigation";

describe("operational navigation", () => {
  it("shows PV screens without warehouse-only navigation", () => {
    const links = navigationForRole("PV").map((item) => item.href);
    expect(links).toContain("/replenishment/review");
    expect(links).toContain("/supply-rules");
    expect(links).toContain("/orders/suggestions");
    expect(links).not.toContain("/orders/warehouse");
    expect(links.every((href) => !href.startsWith("/api/"))).toBe(true);
    expect(links.every((href) => !href.includes("branch_id"))).toBe(true);
  });

  it("shows the warehouse inbox without PV-only navigation", () => {
    const links = navigationForRole("WAREHOUSE").map((item) => item.href);
    expect(links).toContain("/orders/warehouse");
    expect(links).not.toContain("/replenishment");
    expect(links).not.toContain("/supply-rules");
  });

  it("keeps orders active for a PV detail and identifies each location", () => {
    expect(isNavigationActive("/orders/42", "/orders")).toBe(true);
    expect(isNavigationActive("/orders/warehouse/42", "/orders")).toBe(false);
    expect(
      isNavigationActive("/orders/warehouse/42", "/orders/warehouse"),
    ).toBe(true);
    expect(isNavigationActive("/replenishment/review", "/replenishment")).toBe(false);
    expect(isNavigationActive("/replenishment/review", "/replenishment/review")).toBe(true);
    expect(branchDisplayName(2, "PV")).toBe("PV1");
    expect(branchDisplayName(3, "PV")).toBe("PV2");
    expect(branchDisplayName(1, "WAREHOUSE")).toBe("DEPÓSITO");
  });
});
