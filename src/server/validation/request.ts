import type { Granularity, Period, Scope } from "@/server/analytics/types";

export class RequestValidationError extends Error {}

const datePattern = /^\d{4}-\d{2}-\d{2}$/;

function parsePositiveInteger(value: string | null, name: string): number | undefined {
  if (value === null || value === "") return undefined;
  if (!/^\d+$/.test(value)) throw new RequestValidationError(`${name} must be a positive integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new RequestValidationError(`${name} must be a positive integer.`);
  }
  return parsed;
}

export function parseOptionalPositiveInteger(value: string | null, name: string): number | undefined {
  return parsePositiveInteger(value, name);
}

function requireEnvironmentScope(name: string): string {
  const value = process.env[name];
  if (!value) throw new RequestValidationError(`${name} must be configured or sent as a request parameter.`);
  return value;
}

export function parseScope(searchParams: URLSearchParams): Scope {
  const sourceId = searchParams.get("source_id") || requireEnvironmentScope("DASHBOARD_SOURCE_ID");
  const branchId = parsePositiveInteger(searchParams.get("branch_id"), "branch_id")
    ?? parsePositiveInteger(process.env.DASHBOARD_BRANCH_ID ?? null, "DASHBOARD_BRANCH_ID");
  const organizationId = parsePositiveInteger(process.env.DASHBOARD_ORGANIZATION_ID ?? null, "DASHBOARD_ORGANIZATION_ID");

  if (!branchId) throw new RequestValidationError("DASHBOARD_BRANCH_ID must be configured or branch_id must be sent.");
  if (sourceId.length > 200) throw new RequestValidationError("source_id is too long.");

  return { sourceId, branchId, organizationId };
}

export function parseTrustedScope(searchParams: URLSearchParams): Scope {
  const scope = parseScope(searchParams);
  const configuredSource = process.env.DASHBOARD_SOURCE_ID;
  const configuredBranch = parsePositiveInteger(process.env.DASHBOARD_BRANCH_ID ?? null, "DASHBOARD_BRANCH_ID");
  if (configuredSource && scope.sourceId !== configuredSource) throw new RequestValidationError("source_id is outside the configured scope.");
  if (configuredBranch && scope.branchId !== configuredBranch) throw new RequestValidationError("branch_id is outside the configured scope.");
  return scope;
}

function calendarDate(value: string, name: string): Date {
  if (!datePattern.test(value)) throw new RequestValidationError(`${name} must use YYYY-MM-DD.`);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new RequestValidationError(`${name} is not a valid calendar date.`);
  }
  return parsed;
}

export function parseOptionalCalendarDate(value: string | null, name: string): string | undefined {
  if (!value) return undefined;
  calendarDate(value, name);
  return value;
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

export function parsePeriod(searchParams: URLSearchParams): Period {
  const fromValue = searchParams.get("from");
  const toValue = searchParams.get("to");
  if (!fromValue || !toValue) throw new RequestValidationError("from and to are required.");

  const fromDate = calendarDate(fromValue, "from");
  const toDate = calendarDate(toValue, "to");
  if (fromDate > toDate) throw new RequestValidationError("from must be on or before to.");

  const days = Math.round((toDate.getTime() - fromDate.getTime()) / 86_400_000) + 1;
  return {
    from: fromValue,
    to: toValue,
    toExclusive: formatDate(addDays(toDate, 1)),
    previousFrom: formatDate(addDays(fromDate, -days)),
    previousToExclusive: fromValue,
  };
}

export function parseGranularity(value: string | null): Granularity {
  if (value === "day" || value === "week" || value === "month") return value;
  if (value === null) return "day";
  throw new RequestValidationError("granularity must be day, week, or month.");
}

export function parsePagination(searchParams: URLSearchParams) {
  const limit = parsePositiveInteger(searchParams.get("limit"), "limit") ?? 50;
  const page = parsePositiveInteger(searchParams.get("page"), "page") ?? 1;
  if (limit > 100) throw new RequestValidationError("limit cannot exceed 100.");
  return { limit, page, offset: (page - 1) * limit };
}

export function parseSearch(value: string | null): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (trimmed.length > 100) throw new RequestValidationError("search cannot exceed 100 characters.");
  return trimmed || undefined;
}

export function parseOptionalNonNegativeNumber(value: string | null, name: string): number | undefined {
  if (value === null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new RequestValidationError(`${name} must be a non-negative number.`);
  return parsed;
}
