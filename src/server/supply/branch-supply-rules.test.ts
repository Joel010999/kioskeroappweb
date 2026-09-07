import { describe, expect, it } from "vitest";
import { depotArticleIds } from "./branch-supply-rules";

describe("branch supply rules", () => {
  it("includes only DEPOT items in an internal replenishment", () => {
    const items = [{ article_id: 10 }, { article_id: 20 }, { article_id: 30 }];
    const modes = new Map([[10, "DEPOT" as const], [20, "DIRECT_SUPPLIER" as const], [30, "UNDEFINED" as const]]);
    expect(depotArticleIds(items, modes)).toEqual([{ article_id: 10 }]);
  });

  it("allows the same article to have a different route in each point of sale", () => {
    const pv1 = new Map([[10, "DEPOT" as const]]);
    const pv2 = new Map([[10, "DIRECT_SUPPLIER" as const]]);
    expect(depotArticleIds([{ article_id: 10 }], pv1)).toHaveLength(1);
    expect(depotArticleIds([{ article_id: 10 }], pv2)).toHaveLength(0);
  });

  it("does not create an internal selection when no article is routed through the depot", () => {
    const modes = new Map([[10, "DIRECT_SUPPLIER" as const], [20, "UNDEFINED" as const]]);
    expect(depotArticleIds([{ article_id: 10 }, { article_id: 20 }], modes)).toEqual([]);
  });
});
