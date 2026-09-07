export const supplyModes = ["UNDEFINED", "DEPOT", "DIRECT_SUPPLIER"] as const;
export type SupplyMode = (typeof supplyModes)[number];

export function isDepotSupplyMode(mode: SupplyMode) {
  return mode === "DEPOT";
}

export function depotArticleIds<T extends { article_id: number }>(items: T[], modesByArticle: ReadonlyMap<number, SupplyMode>) {
  return items.filter((item) => isDepotSupplyMode(modesByArticle.get(item.article_id) ?? "UNDEFINED"));
}
