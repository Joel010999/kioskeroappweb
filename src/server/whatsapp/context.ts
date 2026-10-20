import type { IntentType, ParsedSlots, ParsedIntent } from "./types";
import { normalizePhoneNumber } from "./auth";
import {
  extractBranch,
  extractProductSearch,
  formatRubroLabel,
  parseUserMessage,
  resolveCanonicalRubroFromText,
} from "./router";

export type PendingClarification = {
  intentType: IntentType;
  slots: ParsedSlots;
  clarificationType: "BRANCH" | "PRODUCT" | "ORDER" | "AMBIGUOUS_PENDING" | "RUBRO";
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
    clarificationType: "BRANCH" | "PRODUCT" | "ORDER" | "AMBIGUOUS_PENDING" | "RUBRO";
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
    const isReplenishmentType =
      pending.intentType === "REPLENISHMENT_EXCEL" || pending.intentType === "REPLENISHMENT";

    // 1. Check if user changed or specified a rubro during branch clarification
    const newRubroInfo = resolveCanonicalRubroFromText(text);
    const targetRubro = newRubroInfo.canonical || pending.slots.targetRubro;

    const branchInfo = extractBranch(clean);

    if (branchInfo.target === "CENTRO" || branchInfo.target === "JARDIN") {
      clearPendingClarification(senderPhone);

      const updatedSlots: ParsedSlots = {
        ...pending.slots,
        targetRubro,
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

    if (branchInfo.target === "DEPOSITO") {
      if (isReplenishmentType) {
        if (newRubroInfo.canonical) {
          setPendingClarification(senderPhone, {
            ...pending,
            slots: { ...pending.slots, targetRubro },
          });
        }
        const rubroLabel = targetRubro ? formatRubroLabel(targetRubro) : "este rubro";
        return {
          type: "RE_PROMPT",
          message: `La reposición semanal se calcula para las sucursales de venta (*Centro* o *Jardín*) que se abastecen desde el Depósito Central. ¿Para cuál de las dos querés generar el Excel de *${rubroLabel}*?`,
        };
      }

      // For non-replenishment queries (e.g. STOCK_LOW), Depósito is a valid target
      clearPendingClarification(senderPhone);
      const updatedSlots: ParsedSlots = {
        ...pending.slots,
        branchTarget: "DEPOSITO",
        branchId: 1,
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

    // 2. User switched rubro without giving branch yet
    if (newRubroInfo.canonical && newRubroInfo.canonical !== pending.slots.targetRubro) {
      setPendingClarification(senderPhone, {
        ...pending,
        slots: { ...pending.slots, targetRubro: newRubroInfo.canonical },
      });
      const rubroLabel = formatRubroLabel(newRubroInfo.canonical);
      return {
        type: "RE_PROMPT",
        message: `Entendido, cambiamos al rubro *${rubroLabel}*. Por favor indicame si lo necesitás para *Centro*, *Jardín* o *Depósito*.`,
      };
    }

    // 3. Check if user entered an explicit fresh command
    const freshIntent = parseUserMessage(text);
    if (
      freshIntent.type !== "UNKNOWN" &&
      freshIntent.type !== "HELP" &&
      freshIntent.type !== "GREETING" &&
      freshIntent.type !== "STOCK_PRODUCT"
    ) {
      clearPendingClarification(senderPhone);
      return { type: "NEW_INTENT" };
    }
    if (freshIntent.type === "STOCK_PRODUCT") {
      const isExplicitStock =
        Boolean(freshIntent.slots.articleId) ||
        /^(stock|cuanto|cuantos|hay|tengo|busca|buscar|art|articulo)\b/i.test(clean) ||
        clean.split(/\s+/).length > 2;
      if (isExplicitStock) {
        clearPendingClarification(senderPhone);
        return { type: "NEW_INTENT" };
      }
    }

    // 4. Invalid branch input
    const rubroLabel = targetRubro ? formatRubroLabel(targetRubro) : "";
    const rubroSuffix = rubroLabel ? ` de *${rubroLabel}*` : "";
    return {
      type: "RE_PROMPT",
      message: `No reconozco esa sucursal. Las opciones disponibles son *Centro* o *Jardín* (abastecidas por el *Depósito Central*). ¿Para cuál querés el Excel de reposición${rubroSuffix}? (o escribí 'cancelar' para salir).`,
    };
  }

  if (pending.clarificationType === "RUBRO") {
    // 1. Check if user also provided or updated branch in this reply
    const branchInfo = extractBranch(clean);
    const updatedBranchTarget = branchInfo.target !== "ALL" ? branchInfo.target : pending.slots.branchTarget;
    const updatedBranchId = branchInfo.branchId ?? pending.slots.branchId;

    const rubroInfo = resolveCanonicalRubroFromText(text);

    if (rubroInfo.canonical) {
      const finalRubro = rubroInfo.canonical;

      if (updatedBranchTarget === "CENTRO" || updatedBranchTarget === "JARDIN") {
        clearPendingClarification(senderPhone);
        const updatedSlots: ParsedSlots = {
          ...pending.slots,
          targetRubro: finalRubro,
          branchTarget: updatedBranchTarget,
          branchId: updatedBranchId,
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

      if (updatedBranchTarget === "DEPOSITO") {
        const rubroLabel = formatRubroLabel(finalRubro);
        setPendingClarification(senderPhone, {
          intentType: pending.intentType,
          slots: {
            ...pending.slots,
            targetRubro: finalRubro,
            branchTarget: "DEPOSITO",
            branchId: 1,
          },
          clarificationType: "BRANCH",
        });
        return {
          type: "RE_PROMPT",
          message: `La reposición semanal se calcula para las sucursales de venta (*Centro* o *Jardín*) que se abastecen desde el Depósito Central. ¿Para cuál querés generar el Excel de *${rubroLabel}*?`,
        };
      }

      // Branch still missing: transition to BRANCH clarification
      const rubroLabel = formatRubroLabel(finalRubro);
      setPendingClarification(senderPhone, {
        intentType: pending.intentType,
        slots: {
          ...pending.slots,
          targetRubro: finalRubro,
        },
        clarificationType: "BRANCH",
      });

      return {
        type: "RE_PROMPT",
        message: `Para generar el Excel de reposición de *${rubroLabel}*, por favor indicame si lo necesitás para *Centro*, *Jardín* o *Depósito*.`,
      };
    }

    // 2. User provided only a branch (e.g. "Centro" or "para Jardín")
    if (branchInfo.target === "CENTRO" || branchInfo.target === "JARDIN") {
      setPendingClarification(senderPhone, {
        ...pending,
        slots: {
          ...pending.slots,
          branchTarget: branchInfo.target,
          branchId: branchInfo.branchId,
        },
      });
      const bLabel = branchInfo.target === "CENTRO" ? "Centro" : "Jardín";
      return {
        type: "RE_PROMPT",
        message: `Para generar el Excel de reposición de *${bLabel}*, ¿de qué rubro lo necesitás? Podés elegir entre: *Chocolates*, *Caramelos*, *Galletitas*, *Bebidas*, *Almacén*, *Cigarrillos*, *Copetín*, *Limpieza*, *Perfumería*, *Pilas*, entre otros.`,
      };
    }

    // 3. User entered an explicit other command
    const freshIntent = parseUserMessage(text);
    if (
      freshIntent.type !== "UNKNOWN" &&
      freshIntent.type !== "HELP" &&
      freshIntent.type !== "GREETING" &&
      freshIntent.type !== "STOCK_PRODUCT"
    ) {
      clearPendingClarification(senderPhone);
      return { type: "NEW_INTENT" };
    }
    if (freshIntent.type === "STOCK_PRODUCT") {
      const isExplicitStock =
        Boolean(freshIntent.slots.articleId) ||
        /^(stock|cuanto|cuantos|hay|tengo|busca|buscar|art|articulo)\b/i.test(clean) ||
        clean.split(/\s+/).length > 2;
      if (isExplicitStock) {
        clearPendingClarification(senderPhone);
        return { type: "NEW_INTENT" };
      }
    }

    // 4. Invalid or unrecognized rubro
    const candidateName =
      rubroInfo.unknownRubro ||
      (clean.length >= 3 && clean.length <= 25 ? text.trim() : "");
    const unknownNotice = candidateName
      ? `No encontré el rubro *${candidateName}*. `
      : "No reconocí el rubro ingresado. ";

    return {
      type: "RE_PROMPT",
      message: `${unknownNotice}Los rubros disponibles en el catálogo son: *Chocolates*, *Caramelos*, *Galletitas*, *Bebidas*, *Almacén*, *Cigarrillos*, *Copetín*, *Limpieza*, *Perfumería*, *Pilas*, entre otros (o escribí 'cancelar' para salir).`,
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
