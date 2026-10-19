import { describe, expect, it, vi } from "vitest";
import { getPhoneVariants, isAuthorizedSender, normalizePhoneNumber, maskPhone } from "./auth";

vi.mock("@/server/db/client", () => ({
  query: vi.fn().mockRejectedValue(new Error("Table does not exist in unit test")),
}));

describe("WhatsApp Authentication & Authorization", () => {
  describe("Phone number masking", () => {
    it("safely masks phones and JIDs without exposing sensitive digits", () => {
      expect(maskPhone("5493885196480")).toBe("549***6480");
      expect(maskPhone("5491112345678@s.whatsapp.net")).toBe("549***5678@s.whatsapp.net");
      expect(maskPhone("241852951711822@lid")).toBe("241***1822@lid");
      expect(maskPhone("123")).toBe("***");
      expect(maskPhone("")).toBe("unknown");
    });
  });

  describe("Phone number normalization", () => {
    it("normalizes international formats and strips symbols", () => {
      expect(normalizePhoneNumber("+54 9 11 1234-5678")).toBe("5491112345678");
      expect(normalizePhoneNumber("5491112345678")).toBe("5491112345678");
      expect(normalizePhoneNumber("011 1234-5678")).toBe("541112345678");
      expect(normalizePhoneNumber("+54-11-1234-5678")).toBe("541112345678");
      expect(normalizePhoneNumber("")).toBe("");
    });

    it("normalizes Argentine regional numbers outside Buenos Aires (e.g. 388 Jujuy, 351 Córdoba)", () => {
      // Jujuy (388)
      expect(normalizePhoneNumber("+54 9 388 519-6480")).toBe("5493885196480");
      expect(normalizePhoneNumber("0388 15 519-6480")).toBe("543885196480");
      expect(normalizePhoneNumber("388 15 5196480")).toBe("543885196480");
      expect(normalizePhoneNumber("3885196480")).toBe("543885196480");

      // Córdoba (351)
      expect(normalizePhoneNumber("+54 9 351 987-6543")).toBe("5493519876543");
      expect(normalizePhoneNumber("0351 15 987-6543")).toBe("543519876543");
    });

    it("generates cross-compatible Argentine variants for mobile 9 prefix and national format", () => {
      const variantsWith9 = getPhoneVariants("5491112345678");
      expect(variantsWith9).toContain("5491112345678");
      expect(variantsWith9).toContain("541112345678");
      expect(variantsWith9).toContain("1112345678");

      const variantsWithout9 = getPhoneVariants("541112345678");
      expect(variantsWithout9).toContain("541112345678");
      expect(variantsWithout9).toContain("5491112345678");
      expect(variantsWithout9).toContain("1112345678");

      const regionalVariants = getPhoneVariants("5493885196480");
      expect(regionalVariants).toContain("5493885196480");
      expect(regionalVariants).toContain("543885196480");
      expect(regionalVariants).toContain("3885196480");
    });
  });

  describe("Sender authorization whitelist", () => {
    const allowedEnv = "+54 9 11 9999-8888, 5493885196480; 0351-15-9876543";

    it("authorizes numbers in whitelist regardless of formatting and region", async () => {
      expect(await isAuthorizedSender("5491199998888", allowedEnv)).toBe(true);
      expect(await isAuthorizedSender("+54 9 11 9999 8888", allowedEnv)).toBe(true);
      expect(await isAuthorizedSender("541199998888", allowedEnv)).toBe(true); // without 9
      // Jujuy regional number
      expect(await isAuthorizedSender("5493885196480", allowedEnv)).toBe(true);
      expect(await isAuthorizedSender("543885196480", allowedEnv)).toBe(true);
      expect(await isAuthorizedSender("3885196480", allowedEnv)).toBe(true);
      // Córdoba regional number with 15
      expect(await isAuthorizedSender("5493519876543", allowedEnv)).toBe(true);
    });

    it("authorizes any sender when whitelist is wildcard *", async () => {
      expect(await isAuthorizedSender("5491155554444", "*")).toBe(true);
      expect(await isAuthorizedSender("5493881112222", "*")).toBe(true);
    });

    it("rejects unauthorized senders", async () => {
      expect(await isAuthorizedSender("5491111112222", allowedEnv)).toBe(false);
      expect(await isAuthorizedSender("5491100000000", allowedEnv)).toBe(false);
      expect(await isAuthorizedSender("", allowedEnv)).toBe(false);
    });

    it("does not allow prompt injection to bypass authorization", async () => {
      const attackerNumber = "5491133334444";
      expect(await isAuthorizedSender(attackerNumber, allowedEnv)).toBe(false);
    });
  });
});
