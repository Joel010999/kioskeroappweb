import { describe, expect, it } from "vitest";
import { classifySupplyEvidence } from "./supply-evidence";

describe("supply evidence", () => {
  it("keeps candidates separate from the human supply rule", () => {
    expect(
      classifySupplyEvidence({ historicalDocuments: 12, depotStock: 4 }),
    ).toBe("POSSIBLE_DEPOT");
    expect(
      classifySupplyEvidence({ historicalDocuments: 12, depotStock: 0 }),
    ).toBe("POSSIBLE_DIRECT_SUPPLIER");
  });

  it("does not make a suggestion without recurring historical entries", () => {
    expect(
      classifySupplyEvidence({ historicalDocuments: 2, depotStock: 100 }),
    ).toBe("NO_EVIDENCE");
  });
});
