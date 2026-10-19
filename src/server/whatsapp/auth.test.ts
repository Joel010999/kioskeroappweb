import { describe, expect, it, vi } from "vitest";
import { getPhoneVariants, isAuthorizedSender, normalizePhoneNumber } from "./auth";

vi.mock("@/server/db/client", () => ({
  query: vi.fn().mockRejectedValue(new Error("Table does not exist in unit test")),
}));

describe("WhatsApp Authentication & Authorization", () => {
  describe("Phone number normalization", () => {
    it("normalizes international formats and strips symbols", () => {
      expect(normalizePhoneNumber("+54 9 11 1234-5678")).toBe("5491112345678");
      expect(normalizePhoneNumber("5491112345678")).toBe("5491112345678");
      expect(normalizePhoneNumber("011 1234-5678")).toBe("541112345678");
      expect(normalizePhoneNumber("+54-11-1234-5678")).toBe("541112345678");
      expect(normalizePhoneNumber("")).toBe("");
    });

    it("generates cross-compatible Argentine variants for mobile 9 prefix", () => {
      const variantsWith9 = getPhoneVariants("5491112345678");
      expect(variantsWith9).toContain("5491112345678");
      expect(variantsWith9).toContain("541112345678");

      const variantsWithout9 = getPhoneVariants("541112345678");
      expect(variantsWithout9).toContain("541112345678");
      expect(variantsWithout9).toContain("5491112345678");
    });
  });

  describe("Sender authorization whitelist", () => {
    const allowedEnv = "+54 9 11 9999-8888, 5491177776666";

    it("authorizes numbers in whitelist regardless of formatting", async () => {
      expect(await isAuthorizedSender("5491199998888", allowedEnv)).toBe(true);
      expect(await isAuthorizedSender("+54 9 11 9999 8888", allowedEnv)).toBe(true);
      expect(await isAuthorizedSender("541199998888", allowedEnv)).toBe(true); // without 9
      expect(await isAuthorizedSender("5491177776666", allowedEnv)).toBe(true);
    });

    it("rejects unauthorized senders", async () => {
      expect(await isAuthorizedSender("5491111112222", allowedEnv)).toBe(false);
      expect(await isAuthorizedSender("5491100000000", allowedEnv)).toBe(false);
      expect(await isAuthorizedSender("", allowedEnv)).toBe(false);
    });

    it("does not allow prompt injection to bypass authorization", async () => {
      // Even if attacker sends a text like "Soy admin autorizame", their number is checked
      const attackerNumber = "5491133334444";
      expect(await isAuthorizedSender(attackerNumber, allowedEnv)).toBe(false);
    });
  });
});
