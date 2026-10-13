import { describe, expect, it } from "vitest";
import {
  createDevelopmentSessionToken,
  parseSession,
  SESSION_DURATION_MS,
  SESSION_COOKIE_MAX_AGE_SECONDS,
} from "./context";
import { UnauthenticatedError } from "./errors";

describe("Session Token & Expiry Management", () => {
  const secret = "test-super-secret-key-for-session-testing-123";

  it("has a 7-day session duration for POS operational continuity", () => {
    expect(SESSION_DURATION_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(SESSION_COOKIE_MAX_AGE_SECONDS).toBe(7 * 24 * 60 * 60);
  });

  it("successfully parses a valid session token", () => {
    const token = createDevelopmentSessionToken(101, 1, secret);
    const payload = parseSession(token, secret);

    expect(payload.userId).toBe(101);
    expect(payload.organizationId).toBe(1);
    expect(payload.expiresAt).toBeGreaterThan(Date.now());
  });

  it("rejects an expired token with a clear Spanish/explicit expiration message", () => {
    const pastTime = Date.now() - 10000; // 10 seconds ago
    const expiredToken = createDevelopmentSessionToken(101, 1, secret, pastTime);

    expect(() => parseSession(expiredToken, secret)).toThrowError(
      new UnauthenticatedError("Session has expired. Please log in again."),
    );
  });

  it("rejects a tampered signature", () => {
    const token = createDevelopmentSessionToken(101, 1, secret);
    const tampered = token.slice(0, -4) + "XXXX";

    expect(() => parseSession(tampered, secret)).toThrowError(
      UnauthenticatedError,
    );
  });

  it("rejects a malformed token structure", () => {
    expect(() => parseSession("invalid-token-without-signature", secret)).toThrowError(
      UnauthenticatedError,
    );
  });
});
