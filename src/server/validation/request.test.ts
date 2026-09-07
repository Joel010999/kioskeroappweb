import { describe, expect, it } from "vitest";
import { parseOptionalCalendarDate, parsePagination, parsePeriod, parseScope, RequestValidationError } from "./request";

describe("parsePeriod", () => {
  it("creates an equal-length prior comparison interval", () => {
    const period = parsePeriod(new URLSearchParams({ from: "2026-08-01", to: "2026-08-30" }));
    expect(period.toExclusive).toBe("2026-08-31");
    expect(period.previousFrom).toBe("2026-07-02");
    expect(period.previousToExclusive).toBe("2026-08-01");
  });

  it("rejects invalid calendar dates", () => {
    expect(() => parsePeriod(new URLSearchParams({ from: "2026-02-30", to: "2026-03-01" }))).toThrow(RequestValidationError);
  });

  it("rejects reversed periods", () => {
    expect(() => parsePeriod(new URLSearchParams({ from: "2026-08-02", to: "2026-08-01" }))).toThrow(RequestValidationError);
  });
});

describe("request filters", () => {
  it("caps pagination and computes its offset", () => {
    expect(parsePagination(new URLSearchParams({ limit: "25", page: "3" }))).toEqual({ limit: 25, page: 3, offset: 50 });
    expect(() => parsePagination(new URLSearchParams({ limit: "101" }))).toThrow(RequestValidationError);
  });

  it("uses supplied source and branch filters without requiring database access", () => {
    expect(parseScope(new URLSearchParams({ source_id: "source-a", branch_id: "2" }))).toMatchObject({ sourceId: "source-a", branchId: 2 });
  });

  it("validates optional order date filters", () => {
    expect(parseOptionalCalendarDate("2026-08-26", "from")).toBe("2026-08-26");
    expect(() => parseOptionalCalendarDate("2026-02-30", "from")).toThrow(RequestValidationError);
  });
});
