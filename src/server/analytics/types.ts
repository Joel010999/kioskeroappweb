export type Scope = {
  organizationId?: number;
  sourceId: string;
  branchId: number;
};

export type Period = {
  from: string;
  to: string;
  toExclusive: string;
  previousFrom: string;
  previousToExclusive: string;
};

export type Granularity = "day" | "week" | "month";

export type FreshnessStatus = "OK" | "WARNING" | "ERROR" | "UNCONFIGURED";
