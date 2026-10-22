import { query } from "@/server/db/client";

export const SERVER_TIMEZONE = "America/Argentina/Buenos_Aires";
export const DEFAULT_POS_FRESHNESS_HOURS = 24;
export const DEFAULT_DEPOT_SNAPSHOT_HOURS = 48;

export type FreshnessLevel = "CURRENT" | "OUTDATED" | "NO_DATA" | "UNAVAILABLE";
export type SourceType = "LIVE_SYNC" | "EXCEL_SNAPSHOT";

export type HistoricalSnapshotMeta = {
  snapshotId: number;
  uploadedAt: string;
  originalFilename: string;
  ageHours: number | null;
};

export type BranchProvenance = {
  branchId: number;
  branchName: "Centro" | "Jardín" | "Depósito Central";
  sourceType: SourceType;
  lastUpdatedAt: string | null;
  freshnessLevel: FreshnessLevel;
  ageHours: number | null;
  totalItems?: number;
  queriedAt: string;
  // Optional historical snapshot metadata for Depósito (reference only, never live stock)
  historicalSnapshot?: HistoricalSnapshotMeta | null;
  // Deprecated backwards-compatibility fields (pointing to historical snapshot if any)
  originalFilename?: string | null;
  snapshotId?: number;
};

export type StockVerificationStatus =
  | "VERIFIED_CURRENT"
  | "VERIFIED_ZERO"
  | "VERIFIED_NEGATIVE"
  | "HISTORICAL_RECORD"
  | "NOT_REGISTERED"
  | "SOURCE_UNAVAILABLE"
  | "NOT_APPLICABLE";

/**
 * Returns current server time. In production this represents the exact real-time clock.
 */
export function getServerTime(override?: Date): Date {
  return override ?? new Date();
}

/**
 * Formats a date string or object into Argentina locale date (DD/MM/YYYY)
 * using the consistent server timezone America/Argentina/Buenos_Aires.
 */
export function formatBuenosAiresDate(date: string | Date | null | undefined): string {
  if (!date) return "No registrada";
  try {
    const d = typeof date === "string" ? new Date(date) : date;
    if (Number.isNaN(d.getTime())) return String(date).slice(0, 10);
    return d.toLocaleDateString("es-AR", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      timeZone: SERVER_TIMEZONE,
    });
  } catch {
    return String(date).slice(0, 10);
  }
}

/**
 * Formats a date string or object into Argentina locale date + time (DD/MM/YYYY HH:mm hs)
 * using America/Argentina/Buenos_Aires.
 */
export function formatBuenosAiresDateTime(date: string | Date | null | undefined): string {
  if (!date) return "No registrada";
  try {
    const d = typeof date === "string" ? new Date(date) : date;
    if (Number.isNaN(d.getTime())) return String(date).slice(0, 16);
    const datePart = d.toLocaleDateString("es-AR", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      timeZone: SERVER_TIMEZONE,
    });
    const timePart = d.toLocaleTimeString("es-AR", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: SERVER_TIMEZONE,
    });
    return `${datePart} ${timePart} hs`;
  } catch {
    return String(date).slice(0, 16);
  }
}

/**
 * Calculates elapsed age in hours between source timestamp and current server reference time.
 */
export function calculateAgeHours(
  updatedAt: string | Date | null | undefined,
  now: Date = getServerTime()
): number | null {
  if (!updatedAt) return null;
  const d = typeof updatedAt === "string" ? new Date(updatedAt) : updatedAt;
  if (Number.isNaN(d.getTime())) return null;
  const elapsedMs = now.getTime() - d.getTime();
  return Math.max(0, elapsedMs / (1000 * 60 * 60));
}

/**
 * Formats an age in hours into a human-friendly Spanish duration.
 */
export function formatAgeHuman(ageHours: number | null): string {
  if (ageHours === null) return "antigüedad desconocida";
  if (ageHours < 1) {
    const mins = Math.max(1, Math.round(ageHours * 60));
    return `hace ${mins} min`;
  }
  if (ageHours < 24) {
    const hours = Math.round(ageHours);
    return `hace ${hours} hora${hours === 1 ? "" : "s"}`;
  }
  const days = Math.round(ageHours / 24);
  return `hace ${days} día${days === 1 ? "" : "s"}`;
}

export function getBranchName(branchId: number): "Centro" | "Jardín" | "Depósito Central" {
  if (branchId === 2) return "Centro";
  if (branchId === 3) return "Jardín";
  return "Depósito Central";
}

/**
 * Queries and evaluates the true source of truth and data freshness for a given branch.
 * ALL branches (Depósito = 1, Centro = 2, Jardín = 3) are connected via real-time synchronization
 * into stock_levels_raw.
 * For Depósito (branch 1), historical Excel snapshots are also tracked as informational metadata,
 * but NEVER replace or override the live connection.
 */
export async function getBranchProvenance(
  branchId: number,
  orgId = 1,
  now: Date = getServerTime()
): Promise<BranchProvenance> {
  const branchName = getBranchName(branchId);
  const queriedAt = now.toISOString();
  const thresholdHours =
    Number(process.env.POS_FRESHNESS_MAX_HOURS) || DEFAULT_POS_FRESHNESS_HOURS;

  // For Depósito (branch 1), check if there is an informational historical Excel snapshot
  let historicalSnapshot: HistoricalSnapshotMeta | null = null;
  if (branchId === 1) {
    try {
      const snapRes = await query<{
        id: string;
        uploaded_at: string;
        original_filename: string;
      }>(
        `SELECT id, uploaded_at, original_filename
         FROM stock_snapshots
         WHERE organization_id = $1 AND status = 'PROCESSED'
         ORDER BY uploaded_at DESC
         LIMIT 1`,
        [orgId]
      );
      if (snapRes.rows && snapRes.rows.length > 0) {
        const snap = snapRes.rows[0];
        historicalSnapshot = {
          snapshotId: Number(snap.id),
          uploadedAt: snap.uploaded_at,
          originalFilename: snap.original_filename,
          ageHours: calculateAgeHours(snap.uploaded_at, now),
        };
      }
    } catch {
      // Non-blocking: snapshot metadata is strictly secondary
    }
  }

  // Primary source of truth for ALL branches: live sync in stock_levels_raw
  try {
    const levelRes = await query<{
      last_seen: string | null;
      row_count: string;
    }>(
      `SELECT MAX(sl.source_seen_at) AS last_seen, COUNT(*) AS row_count
       FROM stock_levels_raw sl
       WHERE sl.organization_id = $1 AND sl.branch_id = $2`,
      [orgId, branchId]
    );

    let lastSeen = levelRes.rows[0]?.last_seen;

    // Fallback 1: check sources table for active connection last_seen_at
    if (!lastSeen) {
      try {
        const srcRes = await query<{ last_seen_at: string | null }>(
          `SELECT last_seen_at
           FROM sources
           WHERE organization_id = $1 AND branch_id = $2 AND is_active = true
           LIMIT 1`,
          [orgId, branchId]
        );
        lastSeen = srcRes.rows[0]?.last_seen_at;
      } catch {
        // Fallback continues
      }
    }

    // Fallback 2: stock_movements_raw received_at
    if (!lastSeen) {
      try {
        const movRes = await query<{ last_received: string | null }>(
          `SELECT MAX(received_at) AS last_received
           FROM stock_movements_raw
           WHERE organization_id = $1 AND branch_id = $2`,
          [orgId, branchId]
        );
        lastSeen = movRes.rows[0]?.last_received;
      } catch {
        // Fallback continues
      }
    }

    if (!lastSeen) {
      return {
        branchId,
        branchName,
        sourceType: "LIVE_SYNC",
        lastUpdatedAt: null,
        freshnessLevel: "NO_DATA",
        ageHours: null,
        queriedAt,
        historicalSnapshot,
        originalFilename: historicalSnapshot?.originalFilename,
        snapshotId: historicalSnapshot?.snapshotId,
      };
    }

    const ageHours = calculateAgeHours(lastSeen, now);
    const isCurrent = ageHours !== null && ageHours <= thresholdHours;

    return {
      branchId,
      branchName,
      sourceType: "LIVE_SYNC",
      lastUpdatedAt: lastSeen,
      freshnessLevel: isCurrent ? "CURRENT" : "OUTDATED",
      ageHours,
      totalItems: Number(levelRes.rows[0]?.row_count || 0),
      queriedAt,
      historicalSnapshot,
      originalFilename: historicalSnapshot?.originalFilename,
      snapshotId: historicalSnapshot?.snapshotId,
    };
  } catch {
    return {
      branchId,
      branchName,
      sourceType: "LIVE_SYNC",
      lastUpdatedAt: null,
      freshnessLevel: "UNAVAILABLE",
      ageHours: null,
      queriedAt,
      historicalSnapshot,
      originalFilename: historicalSnapshot?.originalFilename,
      snapshotId: historicalSnapshot?.snapshotId,
    };
  }
}

/**
 * Fetches the provenance and freshness state of all 3 branches in parallel.
 */
export async function getAllBranchesProvenance(
  orgId = 1,
  now: Date = getServerTime()
): Promise<Record<number, BranchProvenance>> {
  const [depot, centro, jardin] = await Promise.all([
    getBranchProvenance(1, orgId, now),
    getBranchProvenance(2, orgId, now),
    getBranchProvenance(3, orgId, now),
  ]);

  return {
    1: depot,
    2: centro,
    3: jardin,
  };
}

/**
 * Emits an internal structured audit log with the exact query time,
 * server timezone, and actual source update timestamps for data governance.
 */
export function logInventoryAudit(params: {
  queryType: string;
  articleIds?: number[];
  searchQuery?: string;
  sources: Record<
    string,
    {
      status: string;
      sourceUpdatedAt?: string | null;
      isCurrent: boolean;
      originalFilename?: string | null;
    }
  >;
  queriedAt?: string;
}): void {
  const payload = {
    event: "INVENTORY_QUERY_AUDIT",
    queriedAt: params.queriedAt ?? getServerTime().toISOString(),
    serverTimezone: SERVER_TIMEZONE,
    queryType: params.queryType,
    searchQuery: params.searchQuery,
    articleIds: params.articleIds,
    sources: params.sources,
  };

  console.log(`[INVENTORY AUDIT] ${JSON.stringify(payload)}`);
}
