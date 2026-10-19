import { getAuthorizedContext } from "@/server/auth/scope";
import { apiResponse } from "@/app/api/dashboard/_shared";
import { getEncryptedPairingCode } from "@/server/whatsapp/baileys/pairing-store";
import { query } from "@/server/db/client";

export const runtime = "nodejs";

/**
 * Protected administrative endpoint to retrieve the temporary pairing code.
 * Requires active authenticated session. Rejects unauthenticated or unauthorized users.
 * Does NOT expose session credentials, private keys, or tokens.
 */
export async function GET() {
  return apiResponse(async () => {
    // 1. Verify caller has authenticated access
    const context = await getAuthorizedContext();
    if (!context || !context.userActive) {
      throw new Error("Unauthorized");
    }

    // 2. Fetch pending encrypted pairing code (if active and not expired)
    const pairing = await getEncryptedPairingCode("default");
    if (pairing) {
      return {
        status: "pending",
        code: pairing.code,
        expiresAt: pairing.expiresAt,
      };
    }

    // 3. Check if session is already established
    try {
      const res = await query<{ count: string }>(
        "SELECT count(*) as count FROM whatsapp_baileys_session WHERE session_id = 'default' AND key_id = 'creds'"
      );
      const hasCreds = parseInt(res.rows?.[0]?.count ?? "0", 10) > 0;
      return {
        status: hasCreds ? "connected" : "unlinked",
      };
    } catch {
      return {
        status: "unknown",
      };
    }
  });
}
