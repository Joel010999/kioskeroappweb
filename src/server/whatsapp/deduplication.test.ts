import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearMemoryDeduplicationCache, registerIncomingMessage } from "./deduplication";

vi.mock("@/server/db/client", () => ({
  query: vi.fn().mockRejectedValue(new Error("Table does not exist in unit test")),
}));

describe("WhatsApp Message Deduplication", () => {
  beforeEach(() => {
    clearMemoryDeduplicationCache();
  });

  it("accepts a new message for the first time", async () => {
    const isNew = await registerIncomingMessage("wamid.ABC12345", "5491112345678");
    expect(isNew).toBe(true);
  });

  it("detects and rejects duplicate messages by messageId", async () => {
    const msgId = "wamid.DUPLICATE_TEST_001";
    const phone = "5491112345678";

    const firstAttempt = await registerIncomingMessage(msgId, phone);
    expect(firstAttempt).toBe(true);

    const secondAttempt = await registerIncomingMessage(msgId, phone);
    expect(secondAttempt).toBe(false);

    const thirdAttempt = await registerIncomingMessage(msgId, phone);
    expect(thirdAttempt).toBe(false);
  });

  it("differentiates between distinct message IDs from the same sender", async () => {
    const phone = "5491112345678";
    const first = await registerIncomingMessage("wamid.MSG_1", phone);
    const second = await registerIncomingMessage("wamid.MSG_2", phone);

    expect(first).toBe(true);
    expect(second).toBe(true);
  });
});
