import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { acquireDedicatedAdvisoryLock, DEFAULT_WHATSAPP_ADVISORY_LOCK_ID } from "./lock";
import type pg from "pg";

function createMockPgClient(options?: {
  lockResult?: boolean;
  connectError?: Error;
  queryError?: Error;
}) {
  const emitter = new EventEmitter();
  const queries: Array<{ sql: string; values?: any[] }> = [];

  const mockClient = {
    connect: vi.fn().mockImplementation(async () => {
      if (options?.connectError) throw options.connectError;
    }),
    query: vi.fn().mockImplementation(async (sql: string, values?: any[]) => {
      queries.push({ sql, values });
      if (options?.queryError) throw options.queryError;
      if (sql.includes("pg_try_advisory_lock")) {
        return {
          rows: [{ acquired: options?.lockResult ?? true }],
        };
      }
      if (sql.includes("pg_advisory_unlock")) {
        return { rows: [{ pg_advisory_unlock: true }] };
      }
      return { rows: [] };
    }),
    end: vi.fn().mockResolvedValue(undefined),
    on: emitter.on.bind(emitter),
    emit: emitter.emit.bind(emitter),
  } as unknown as pg.Client & { emit: (event: string, ...args: any[]) => boolean };

  return { mockClient, queries, emitter };
}

describe("PostgreSQL Dedicated Advisory Lock", () => {
  it("successfully acquires advisory lock when available", async () => {
    const { mockClient } = createMockPgClient({ lockResult: true });
    const onLockLost = vi.fn();

    const handle = await acquireDedicatedAdvisoryLock({
      client: mockClient,
      onLockLost,
    });

    expect(handle.acquired).toBe(true);
    expect(handle.lockId).toBe(DEFAULT_WHATSAPP_ADVISORY_LOCK_ID);
    expect(mockClient.query).toHaveBeenCalledWith(
      "SELECT pg_try_advisory_lock($1) AS acquired",
      [DEFAULT_WHATSAPP_ADVISORY_LOCK_ID]
    );
  });

  it("prevents duplicate instances when another instance holds the lock", async () => {
    const { mockClient } = createMockPgClient({ lockResult: false });
    const onLockLost = vi.fn();

    const handle = await acquireDedicatedAdvisoryLock({
      client: mockClient,
      onLockLost,
    });

    expect(handle.acquired).toBe(false);
    expect(handle.lockId).toBe(DEFAULT_WHATSAPP_ADVISORY_LOCK_ID);
    expect(onLockLost).not.toHaveBeenCalled();
  });

  it("triggers onLockLost callback when PostgreSQL connection emits an error", async () => {
    const { mockClient } = createMockPgClient({ lockResult: true });
    const onLockLost = vi.fn();

    const handle = await acquireDedicatedAdvisoryLock({
      client: mockClient,
      onLockLost,
    });

    expect(handle.acquired).toBe(true);

    // Simulate unexpected TCP disconnect / Postgres restart
    mockClient.emit("error", new Error("Connection terminated unexpectedly"));

    expect(onLockLost).toHaveBeenCalledTimes(1);
    expect(onLockLost.mock.calls[0][0].message).toContain("Connection terminated unexpectedly");
  });

  it("triggers onLockLost callback when PostgreSQL connection ends", async () => {
    const { mockClient } = createMockPgClient({ lockResult: true });
    const onLockLost = vi.fn();

    const handle = await acquireDedicatedAdvisoryLock({
      client: mockClient,
      onLockLost,
    });

    expect(handle.acquired).toBe(true);

    // Simulate connection end
    mockClient.emit("end");

    expect(onLockLost).toHaveBeenCalledTimes(1);
    expect(onLockLost.mock.calls[0][0].message).toContain("closed");
  });

  it("releases advisory lock cleanly on shutdown", async () => {
    const { mockClient } = createMockPgClient({ lockResult: true });
    const onLockLost = vi.fn();

    const handle = await acquireDedicatedAdvisoryLock({
      client: mockClient,
      onLockLost,
    });

    await handle.release();

    expect(mockClient.query).toHaveBeenCalledWith(
      "SELECT pg_advisory_unlock($1)",
      [DEFAULT_WHATSAPP_ADVISORY_LOCK_ID]
    );
  });

  it("propagates database error during acquisition", async () => {
    const { mockClient } = createMockPgClient({
      queryError: new Error("Host unreachable"),
    });

    await expect(
      acquireDedicatedAdvisoryLock({
        client: mockClient,
        onLockLost: vi.fn(),
      })
    ).rejects.toThrow("Host unreachable");
  });
});
