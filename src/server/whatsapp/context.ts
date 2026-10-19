import type { IntentType, ParsedSlots, ParsedIntent } from "./types";
import { normalizePhoneNumber } from "./auth";
import { extractBranch, extractProductSearch, parseUserMessage } from "./router";

export type PendingClarification = {
  intentType: IntentType;
  slots: ParsedSlots;
  clarificationType: "BRANCH" | "PRODUCT" | "ORDER" | "AMBIGUOUS_PENDING";
  createdAt: number;
};

// In-memory conversation state store keyed by normalized phone number
const pendingClarifications = new Map<string, PendingClarification>();

// Context expiration TTL: 10 minutes (600_000 ms)
const CLARIFICATION_TTL_MS = 10 * 60 * 1000;

export function setPendingClarification(
  senderPhone: string,
  clarification: {
    intentType: IntentType;
    slots: ParsedSlots;
    clarificationType: "BRANCH" | "PRODUCT" | "ORDER" | "AMBIGUOUS_PENDING";
  }
): void {
  const key = normalizePhoneNumber(senderPhone);
  if (!key) return;

  pendingClarifications.set(key, {
    ...clarification,
    createdAt: Date.now(),
  });
}

export function getPendingClarification(
  senderPhone: string
): PendingClarification | null {
  const key = normalizePhoneNumber(senderPhone);
  if (!key) return null;

  const item = pendingClarifications.get(key);
  if (!item) return null;

  // Check TTL
  if (Date.now() - item.createdAt > CLARIFICATION_TTL_MS) {
    pendingClarifications.delete(key);
    return null;
  }

  return item;
}

export function clearPendingClarification(senderPhone: string): void {
  const key = normalizePhoneNumber(senderPhone);
  if (key) {
    pendingClarifications.delete(key);
  }
}

export function clearAllPendingClarifications(): void {
  pendingClarifications.clear();
}

export type ClarificationResolutionResult =
  | { type: "RESOLVED"; intent: ParsedIntent }
  | { type: "CANCELLED"; message: string }
  | { type: "RE_PROMPT"; message: string }
  | { type: "NEW_INTENT" };

/**
 * Resolves an incoming message against an existing pending clarification, if any.
 * Prioritizes the pending clarification before interpreting the message as a brand-new intent.
 */
export function resolvePendingClarification(
  senderPhone: string,
  text: string
): ClarificationResolutionResult {
  const pending = getPendingClarification(senderPhone);
  if (!pending) {
    return { type: "NEW_INTENT" };
  }

  const clean = text.trim().toLowerCase();

  // 1. Explicit cancellation
  if (
    /^(cancelar|cancela|salir|volver|menu|menú|olvidalo|olvídalo|no importa|chau|adios|adiós)$/i.test(clean)
  ) {
    clearPendingClarification(senderPhone);
    return {
      type: "CANCELLED",
      message: "Operación cancelada. ¿En qué más te puedo ayudar?",
    };
  }

  // 2. Explicit Greeting / Help -> cancel clarification and let router show menu
  if (/^(hola|buenas|buen dia|buenas tardes|buenas noches|ayuda|comandos)$/i.test(clean)) {
    clearPendingClarification(senderPhone);
    return { type: "NEW_INTENT" };
  }

  // 3. Explicit specific order detail: "#3", "pedido 3" -> cancel clarification and process order
  if (/(?:#|pedido\s*(?:n[°ºo]\s*|numero\s*|número\s*)?|orden\s*(?:n[°ºo]\s*|numero\s*|número\s*)?)\s*\d+/i.test(clean)) {
    clearPendingClarification(senderPhone);
    return { type: "NEW_INTENT" };
  }

  // 4. Resolve by clarification type
  if (pending.clarificationType === "BRANCH") {
    const branchInfo = extractBranch(clean);
    if (branchInfo.target !== "ALL") {
      // User responded with a valid branch (Centro, Jardín, Depósito Central)
      clearPendingClarification(senderPhone);

      const updatedSlots: ParsedSlots = {
        ...pending.slots,
        branchTarget: branchInfo.target,
        branchId: branchInfo.branchId,
        needsClarification: false,
        clarificationMessage: undefined,
      };

      return {
        type: "RESOLVED",
        intent: {
          type: pending.intentType,
          rawText: text,
          slots: updatedSlots,
          confidence: 0.95,
        },
      };
    }

    // Check if the user entered a fresh full query instead of answering the clarification
    const freshIntent = parseUserMessage(text);
    if (freshIntent.type !== "UNKNOWN" && freshIntent.type !== "HELP" && freshIntent.type !== "GREETING") {
      if (freshIntent.type === "STOCK_PRODUCT") {
        const isExplicitStock =
          Boolean(freshIntent.slots.articleId) ||
          /^(stock|cuanto|cuantos|hay|tengo|busca|buscar|art|articulo)\b/i.test(clean) ||
          clean.split(/\s+/).length > 2;
        if (isExplicitStock) {
          clearPendingClarification(senderPhone);
          return { type: "NEW_INTENT" };
        }
      } else {
        clearPendingClarification(senderPhone);
        return { type: "NEW_INTENT" };
      }
    }

    // If the response is not a recognized branch and not a new query:
    return {
      type: "RE_PROMPT",
      message:
        "Por favor indicá para qué sucursal querés consultar: *Centro*, *Jardín* o *Depósito Central* (o escribí 'cancelar' para salir).",
    };
  }

  if (pending.clarificationType === "AMBIGUOUS_PENDING") {
    if (/\b(pedido|pedidos|orden|ordenes)\b/i.test(clean)) {
      clearPendingClarification(senderPhone);
      return {
        type: "RESOLVED",
        intent: {
          type: "ORDERS_PENDING",
          rawText: text,
          slots: {
            ...pending.slots,
            needsClarification: false,
            clarificationMessage: undefined,
          },
          confidence: 0.95,
        },
      };
    }
    if (/\b(reposicion|reponer|sugerencias|stock)\b/i.test(clean)) {
      clearPendingClarification(senderPhone);
      return {
        type: "RESOLVED",
        intent: {
          type: "REPLENISHMENT",
          rawText: text,
          slots: {
            ...pending.slots,
            needsClarification: true,
            clarificationType: "BRANCH",
            clarificationMessage:
              "Para consultar la reposición semanal sugerida, por favor indicame para qué sucursal querés verla: *Centro* o *Jardín*.",
          },
          confidence: 0.95,
        },
      };
    }
  }

  if (pending.clarificationType === "PRODUCT") {
    const productExtraction = extractProductSearch(text);
    if (productExtraction.articleId || productExtraction.productSearch) {
      clearPendingClarification(senderPhone);
      return {
        type: "RESOLVED",
        intent: {
          type: pending.intentType,
          rawText: text,
          slots: {
            ...pending.slots,
            ...productExtraction,
            needsClarification: false,
            clarificationMessage: undefined,
          },
          confidence: 0.95,
        },
      };
    }
  }

  // Fallback: if user writes something totally unrelated, allow fresh interpretation
  return { type: "NEW_INTENT" };
}
