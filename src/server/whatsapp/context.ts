import type { IntentType, ParsedSlots, ParsedIntent, ClarificationType } from "./types";
import { normalizePhoneNumber } from "./auth";
import {
  cleanText,
  extractBranch,
  extractInvalidBranch,
  extractProductSearch,
  extractSupplierCandidate,
  formatRubroLabel,
  parseUserMessage,
  resolveCanonicalRubroFromText,
} from "./router";
import { resolveSupplier } from "@/server/catalog/suppliers";

export type PendingClarification = {
  intentType: IntentType;
  slots: ParsedSlots;
  clarificationType: ClarificationType;
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
    clarificationType: ClarificationType;
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

export type LastFulfilledContext = {
  intentType: IntentType;
  slots: ParsedSlots;
  completedAt: number;
};

// In-memory fulfilled context store keyed by normalized phone number
const lastFulfilledContexts = new Map<string, LastFulfilledContext>();
const FULFILLED_TTL_MS = 15 * 60 * 1000; // 15 minutes TTL

export function setLastFulfilledContext(
  senderPhone: string,
  context: {
    intentType: IntentType;
    slots: ParsedSlots;
  }
): void {
  const key = normalizePhoneNumber(senderPhone);
  if (!key) return;
  lastFulfilledContexts.set(key, {
    ...context,
    completedAt: Date.now(),
  });
}

export function getLastFulfilledContext(
  senderPhone: string
): LastFulfilledContext | null {
  const key = normalizePhoneNumber(senderPhone);
  if (!key) return null;
  const item = lastFulfilledContexts.get(key);
  if (!item) return null;
  if (Date.now() - item.completedAt > FULFILLED_TTL_MS) {
    lastFulfilledContexts.delete(key);
    return null;
  }
  return item;
}

export function clearLastFulfilledContext(senderPhone: string): void {
  const key = normalizePhoneNumber(senderPhone);
  if (key) {
    lastFulfilledContexts.delete(key);
  }
}

export function clearAllLastFulfilledContexts(): void {
  lastFulfilledContexts.clear();
}

export type ClarificationResolutionResult =
  | { type: "RESOLVED"; intent: ParsedIntent }
  | { type: "CANCELLED"; message: string }
  | { type: "RE_PROMPT"; message: string }
  | { type: "NEW_INTENT" };

/**
 * Parses user input for numerical disambiguation choices: 1, 2, "el primero", "el segundo", "el otro", etc.
 */
function parseDisambiguationChoice(text: string, count: number): number | null {
  const clean = cleanText(text);
  if (
    /^(?:opcion|opción|el|la|el\s+numero|el\s+número|numero|número)?\s*1\b/i.test(clean) ||
    /^(primero|primera|el primero|la primera)$/i.test(clean)
  ) {
    return 0;
  }
  if (
    /^(?:opcion|opción|el|la|el\s+numero|el\s+número|numero|número)?\s*2\b/i.test(clean) ||
    /^(segundo|segunda|el segundo|la segunda|el otro|la otra|el otro proveedor|otro)$/i.test(clean)
  ) {
    return count > 1 ? 1 : null;
  }
  if (
    /^(?:opcion|opción|el|la|el\s+numero|el\s+número|numero|número)?\s*3\b/i.test(clean) ||
    /^(tercero|tercera|el tercero|la tercera)$/i.test(clean)
  ) {
    return count > 2 ? 2 : null;
  }
  if (
    /^(?:opcion|opción|el|la|el\s+numero|el\s+número|numero|número)?\s*4\b/i.test(clean) ||
    /^(cuarto|cuarta|el cuarto|la cuarta)$/i.test(clean)
  ) {
    return count > 3 ? 3 : null;
  }
  return null;
}

/**
 * Checks if user asks to switch from Excel document to direct chat message.
 */
function isSwitchToChatRequest(text: string): boolean {
  const clean = cleanText(text);
  return /(?:no quiero\s+(?:el\s+)?excel|no quiero\s+(?:la\s+)?planilla|sin\s+(?:el\s+)?excel|sin\s+(?:la\s+)?planilla|decime(?:lo)?\s+(?:los\s+productos\s+)?por\s+ac[aá]|mostrame(?:lo)?\s+(?:los\s+productos\s+)?por\s+ac[aá]|por\s+ac[aá]|en\s+el\s+chat|por\s+chat|no\s+excel)/i.test(
    clean
  );
}

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

  const clean = cleanText(text);

  // 1. Explicit cancellation
  if (
    /^(cancelar|cancela|salir|volver|menu|menú|olvidalo|olvídalo|no importa|chau|adios|adiós)$/i.test(
      clean
    )
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
  if (
    /(?:#|pedido\s*(?:n[°ºo]\s*|numero\s*|número\s*)?|orden\s*(?:n[°ºo]\s*|numero\s*|número\s*)?)\s*\d+/i.test(
      clean
    )
  ) {
    clearPendingClarification(senderPhone);
    return { type: "NEW_INTENT" };
  }

  // 4. Resolve by clarification type
  if (pending.clarificationType === "BRANCH") {
    const isReplenishmentType =
      pending.intentType === "REPLENISHMENT_EXCEL" || pending.intentType === "REPLENISHMENT";

    // A. User wants to switch to text response instead of Excel
    if (isSwitchToChatRequest(text)) {
      pending.intentType = "REPLENISHMENT";
      pending.slots.wantsExcel = false;
      const branchInfo = extractBranch(clean);
      const effectiveBranch =
        branchInfo.target === "CENTRO" || branchInfo.target === "JARDIN"
          ? branchInfo.target
          : pending.slots.branchTarget;
      const effectiveBranchId =
        branchInfo.target === "CENTRO" || branchInfo.target === "JARDIN"
          ? branchInfo.branchId
          : pending.slots.branchId;

      if (effectiveBranch === "CENTRO" || effectiveBranch === "JARDIN") {
        clearPendingClarification(senderPhone);
        return {
          type: "RESOLVED",
          intent: {
            type: "REPLENISHMENT",
            rawText: text,
            slots: {
              ...pending.slots,
              wantsExcel: false,
              branchTarget: effectiveBranch,
              branchId: effectiveBranchId,
              needsClarification: false,
              clarificationMessage: undefined,
            },
            confidence: 0.95,
          },
        };
      }
      setPendingClarification(senderPhone, {
        intentType: "REPLENISHMENT",
        slots: { ...pending.slots, wantsExcel: false },
        clarificationType: "BRANCH",
      });
      return {
        type: "RE_PROMPT",
        message:
          "Entendido, te muestro los productos sugeridos directamente por acá. Por favor indicame para qué sucursal querés ver la reposición: *Centro* o *Jardín*.",
      };
    }

    // B. User changes or selects supplier: "No, el otro proveedor" or specifies another supplier
    if (
      /^(?:no,?\s*)?(?:el\s+otro\s+proveedor|el\s+otro|el\s+segundo|la\s+otra|otro)$/i.test(clean) &&
      pending.slots.disambiguationCandidates &&
      pending.slots.disambiguationCandidates.length >= 2
    ) {
      const altCandidate = pending.slots.disambiguationCandidates[1];
      const branchInfo = extractBranch(clean);
      const updatedSlots: ParsedSlots = {
        ...pending.slots,
        supplierCode: altCandidate.code,
        supplierName: altCandidate.label,
        disambiguationCandidates: undefined,
      };

      if (branchInfo.target === "CENTRO" || branchInfo.target === "JARDIN") {
        clearPendingClarification(senderPhone);
        return {
          type: "RESOLVED",
          intent: {
            type: pending.intentType,
            rawText: text,
            slots: {
              ...updatedSlots,
              branchTarget: branchInfo.target,
              branchId: branchInfo.branchId,
              needsClarification: false,
              clarificationMessage: undefined,
            },
            confidence: 0.95,
          },
        };
      }

      setPendingClarification(senderPhone, {
        ...pending,
        slots: updatedSlots,
      });

      return {
        type: "RE_PROMPT",
        message: `Entendido, cambiamos a *${altCandidate.label}*. Por favor indicame si lo necesitás para *Centro* o *Jardín*.`,
      };
    }

    // Check if user specified a new supplier name or code (e.g. "mejor Arcor", "cambialo a Mondelez", "proveedor 50350")
    const supplierExtraction = extractSupplierCandidate(text);
    if (supplierExtraction.candidate) {
      const resSupplier = resolveSupplier(supplierExtraction.candidate);
      if (resSupplier.status === "EXACT") {
        const branchInfo = extractBranch(clean);
        const updatedSlots: ParsedSlots = {
          ...pending.slots,
          supplierCode: resSupplier.supplier.code,
          supplierName: resSupplier.supplier.name,
        };

        if (branchInfo.target === "CENTRO" || branchInfo.target === "JARDIN") {
          clearPendingClarification(senderPhone);
          return {
            type: "RESOLVED",
            intent: {
              type: pending.intentType,
              rawText: text,
              slots: {
                ...updatedSlots,
                branchTarget: branchInfo.target,
                branchId: branchInfo.branchId,
                needsClarification: false,
                clarificationMessage: undefined,
              },
              confidence: 0.95,
            },
          };
        }

        setPendingClarification(senderPhone, {
          ...pending,
          slots: updatedSlots,
        });

        return {
          type: "RE_PROMPT",
          message: `Entendido, cambiamos al proveedor *${resSupplier.supplier.name}*. Por favor indicame si lo necesitás para *Centro* o *Jardín*.`,
        };
      }
    }

    // C. User changed or specified a rubro during branch clarification (e.g. "Solo los cigarrillos")
    const newRubroInfo = resolveCanonicalRubroFromText(text);
    const targetRubro = newRubroInfo.canonical || pending.slots.targetRubro;

    const branchInfo = extractBranch(clean);
    const effectiveBranch =
      branchInfo.target === "CENTRO" || branchInfo.target === "JARDIN"
        ? branchInfo.target
        : pending.slots.branchTarget;
    const effectiveBranchId =
      branchInfo.target === "CENTRO" || branchInfo.target === "JARDIN"
        ? branchInfo.branchId
        : pending.slots.branchId;

    if (effectiveBranch === "CENTRO" || effectiveBranch === "JARDIN") {
      clearPendingClarification(senderPhone);

      const updatedSlots: ParsedSlots = {
        ...pending.slots,
        targetRubro,
        branchTarget: effectiveBranch,
        branchId: effectiveBranchId,
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
        const targetDesc =
          pending.slots.supplierName && targetRubro
            ? `de *${formatRubroLabel(targetRubro)}* del proveedor *${pending.slots.supplierName}*`
            : pending.slots.supplierName
            ? `del proveedor *${pending.slots.supplierName}*`
            : targetRubro
            ? `de *${formatRubroLabel(targetRubro)}*`
            : "de reposición";

        return {
          type: "RE_PROMPT",
          message: `La reposición semanal se calcula para las sucursales de venta (*Centro* o *Jardín*) que se abastecen desde el Depósito Central. ¿Para cuál de las dos querés generar el Excel ${targetDesc}?`,
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

    // User confirmed or provided affirmative response ("Sí", "Dale", "Ok")
    if (/^(si|sí|dale|ok|bueno|por favor|confirmo|dale si)$/i.test(clean)) {
      const targetDesc =
        pending.slots.supplierName && targetRubro
          ? `de *${formatRubroLabel(targetRubro)}* (${pending.slots.supplierName})`
          : pending.slots.supplierName
          ? `del proveedor *${pending.slots.supplierName}*`
          : targetRubro
          ? `de *${formatRubroLabel(targetRubro)}*`
          : "de reposición";
      return {
        type: "RE_PROMPT",
        message: `¡Genial! Por favor indicame para cuál sucursal querés la reposición ${targetDesc}: *Centro* o *Jardín*.`,
      };
    }

    // User filtered: "Solo los que faltan"
    if (/^(solo\s+los\s+que\s+faltan|los\s+que\s+faltan|solo\s+faltantes|faltantes)$/i.test(clean)) {
      return {
        type: "RE_PROMPT",
        message: `Entendido, se incluirán únicamente los productos que requieran reposición. Por favor indicame para qué sucursal: *Centro* o *Jardín*.`,
      };
    }

    // User specified a rubro without giving branch yet (e.g. "Cigarrillos")
    if (newRubroInfo.canonical) {
      setPendingClarification(senderPhone, {
        ...pending,
        slots: { ...pending.slots, targetRubro: newRubroInfo.canonical },
      });
      const rubroLabel = formatRubroLabel(newRubroInfo.canonical);
      return {
        type: "RE_PROMPT",
        message: `Para generar el Excel de reposición de *${rubroLabel}*, por favor indicame si lo necesitás para *Centro* o *Jardín*.`,
      };
    }

    // Check invalid branch mention: e.g. "Mejor de la sucursal Norte"
    const invalidBranch = extractInvalidBranch(text);
    if (invalidBranch || /^(?:sucursal\s+)?(?:norte|sur|oeste|este)\b/i.test(clean)) {
      const targetDesc =
        pending.slots.supplierName && targetRubro
          ? `de *${formatRubroLabel(targetRubro)}* del proveedor *${pending.slots.supplierName}*`
          : pending.slots.supplierName
          ? `del proveedor *${pending.slots.supplierName}*`
          : targetRubro
          ? `de *${formatRubroLabel(targetRubro)}*`
          : "de reposición";
      const branchNotice = invalidBranch ? ` *${invalidBranch}*` : "";
      return {
        type: "RE_PROMPT",
        message: `No reconozco la sucursal${branchNotice}. Las opciones disponibles son *Centro* o *Jardín* (abastecidas por el *Depósito Central*). ¿Para cuál querés el Excel ${targetDesc}? (o escribí 'cancelar' para salir).`,
      };
    }

    // Check if user entered an explicit fresh command
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

    // Invalid branch input fallback
    const rubroLabel = targetRubro ? formatRubroLabel(targetRubro) : "";
    const rubroSuffix = rubroLabel ? ` de *${rubroLabel}*` : "";
    return {
      type: "RE_PROMPT",
      message: `No reconozco esa sucursal. Las opciones disponibles son *Centro* o *Jardín* (abastecidas por el *Depósito Central*). ¿Para cuál querés el Excel de reposición${rubroSuffix}? (o escribí 'cancelar' para salir).`,
    };
  }

  if (pending.clarificationType === "SUPPLIER") {
    // 1. Check if user wants to switch to chat / no excel
    if (isSwitchToChatRequest(text)) {
      pending.intentType = "REPLENISHMENT";
      pending.slots.wantsExcel = false;
    }

    // 2. Check if user selected one of disambiguation candidates (e.g. "1", "2", "el primero", "el segundo", "el otro")
    if (
      pending.slots.disambiguationCandidates &&
      pending.slots.disambiguationCandidates.length > 0
    ) {
      const choiceIdx = parseDisambiguationChoice(
        clean,
        pending.slots.disambiguationCandidates.length
      );
      if (choiceIdx !== null) {
        const chosen = pending.slots.disambiguationCandidates[choiceIdx];
        const branchInfo = extractBranch(clean);
        const branchTarget =
          branchInfo.target !== "ALL" ? branchInfo.target : pending.slots.branchTarget;
        const branchId = branchInfo.branchId ?? pending.slots.branchId;

        const updatedSlots: ParsedSlots = {
          ...pending.slots,
          supplierCode: chosen.code,
          supplierName: chosen.label,
          branchTarget,
          branchId,
          needsClarification: false,
          clarificationMessage: undefined,
          disambiguationCandidates: undefined,
        };

        if (branchTarget === "CENTRO" || branchTarget === "JARDIN") {
          clearPendingClarification(senderPhone);
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

        // Branch still missing: transition to BRANCH clarification
        setPendingClarification(senderPhone, {
          intentType: pending.intentType,
          slots: updatedSlots,
          clarificationType: "BRANCH",
        });

        return {
          type: "RE_PROMPT",
          message: `Para generar el Excel de reposición de *${chosen.label}*, por favor indicame si lo necesitás para *Centro* o *Jardín*.`,
        };
      }
    }

    // 3. User typed a supplier name or code
    const supplierExtraction = extractSupplierCandidate(text);
    const candidateStr =
      supplierExtraction.candidate ||
      (clean.length >= 2 && !/^(centro|jardin|deposito)$/i.test(clean) ? text.trim() : undefined);

    if (candidateStr) {
      const res = resolveSupplier(candidateStr);
      if (res.status === "EXACT") {
        const branchInfo = extractBranch(clean);
        const branchTarget =
          branchInfo.target !== "ALL" ? branchInfo.target : pending.slots.branchTarget;
        const branchId = branchInfo.branchId ?? pending.slots.branchId;

        const updatedSlots: ParsedSlots = {
          ...pending.slots,
          supplierCode: res.supplier.code,
          supplierName: res.supplier.name,
          branchTarget,
          branchId,
          needsClarification: false,
          clarificationMessage: undefined,
        };

        if (branchTarget === "CENTRO" || branchTarget === "JARDIN") {
          clearPendingClarification(senderPhone);
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

        setPendingClarification(senderPhone, {
          intentType: pending.intentType,
          slots: updatedSlots,
          clarificationType: "BRANCH",
        });

        return {
          type: "RE_PROMPT",
          message: `Para generar el Excel de reposición del proveedor *${res.supplier.name}*, por favor indicame si lo necesitás para *Centro* o *Jardín*.`,
        };
      } else if (res.status === "AMBIGUOUS") {
        const optionsList = res.candidates
          .map((c, i) => `*${i + 1}. ${c.name}* (cód. ${c.code})`)
          .join(", ");
        setPendingClarification(senderPhone, {
          ...pending,
          slots: {
            ...pending.slots,
            disambiguationCandidates: res.candidates.map((c) => ({
              code: c.code,
              label: c.name,
            })),
          },
        });
        return {
          type: "RE_PROMPT",
          message: `Encontré varios proveedores posibles para *${candidateStr}*: ${optionsList}. ¿Cuál querés consultar?`,
        };
      }
    }

    // 4. Check if user actually specified a rubro instead
    const rubroInfo = resolveCanonicalRubroFromText(text);
    if (rubroInfo.canonical) {
      const branchInfo = extractBranch(clean);
      const branchTarget =
        branchInfo.target !== "ALL" ? branchInfo.target : pending.slots.branchTarget;
      const branchId = branchInfo.branchId ?? pending.slots.branchId;

      const updatedSlots: ParsedSlots = {
        ...pending.slots,
        targetRubro: rubroInfo.canonical,
        branchTarget,
        branchId,
        needsClarification: false,
        clarificationMessage: undefined,
      };

      if (branchTarget === "CENTRO" || branchTarget === "JARDIN") {
        clearPendingClarification(senderPhone);
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

      setPendingClarification(senderPhone, {
        intentType: pending.intentType,
        slots: updatedSlots,
        clarificationType: "BRANCH",
      });

      return {
        type: "RE_PROMPT",
        message: `Para generar el Excel de reposición de *${formatRubroLabel(
          rubroInfo.canonical
        )}*, por favor indicame si lo necesitás para *Centro* o *Jardín*.`,
      };
    }

    // 5. User gave branch only
    const branchInfo = extractBranch(clean);
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
        message: `Para generar el Excel de reposición de *${bLabel}*, ¿de qué proveedor lo necesitás? Podés ingresar el nombre (ej. *Arcor*, *Baggio*, *Coca-Cola*) o el código numérico.`,
      };
    }

    return {
      type: "RE_PROMPT",
      message: `No encontré ese proveedor. Podés ingresar el nombre de la empresa o marca (ej. *Arcor*, *Baggio*, *Coca-Cola*, *Marlboro*) o su código numérico (ej. *50350*), o escribir 'cancelar' para salir.`,
    };
  }

  if (pending.clarificationType === "RUBRO") {
    // A. Switch to chat
    if (isSwitchToChatRequest(text)) {
      pending.intentType = "REPLENISHMENT";
      pending.slots.wantsExcel = false;
    }

    // B. Check if user also provided or updated branch in this reply
    const branchInfo = extractBranch(clean);
    const updatedBranchTarget =
      branchInfo.target !== "ALL" ? branchInfo.target : pending.slots.branchTarget;
    const updatedBranchId = branchInfo.branchId ?? pending.slots.branchId;

    // C. Check rubro
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
        message: `Para generar el Excel de reposición de *${rubroLabel}*, por favor indicame si lo necesitás para *Centro* o *Jardín*.`,
      };
    }

    // D. User provided a SUPPLIER instead of a rubro
    const supplierExtraction = extractSupplierCandidate(text);
    const supplierCand =
      supplierExtraction.candidate ||
      (clean.length >= 2 && !/^(centro|jardin|deposito)$/i.test(clean) ? text.trim() : undefined);

    if (supplierCand) {
      const res = resolveSupplier(supplierCand);
      if (res.status === "EXACT") {
        const updatedSlots: ParsedSlots = {
          ...pending.slots,
          supplierCode: res.supplier.code,
          supplierName: res.supplier.name,
          branchTarget: updatedBranchTarget,
          branchId: updatedBranchId,
          needsClarification: false,
          clarificationMessage: undefined,
        };

        if (updatedBranchTarget === "CENTRO" || updatedBranchTarget === "JARDIN") {
          clearPendingClarification(senderPhone);
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

        setPendingClarification(senderPhone, {
          intentType: pending.intentType,
          slots: updatedSlots,
          clarificationType: "BRANCH",
        });

        return {
          type: "RE_PROMPT",
          message: `Para generar el Excel de reposición de *${res.supplier.name}*, por favor indicame si lo necesitás para *Centro* o *Jardín*.`,
        };
      } else if (res.status === "AMBIGUOUS") {
        const optionsList = res.candidates
          .map((c, i) => `*${i + 1}. ${c.name}* (cód. ${c.code})`)
          .join(", ");
        setPendingClarification(senderPhone, {
          intentType: pending.intentType,
          slots: {
            ...pending.slots,
            disambiguationCandidates: res.candidates.map((c) => ({
              code: c.code,
              label: c.name,
            })),
          },
          clarificationType: "SUPPLIER",
        });
        return {
          type: "RE_PROMPT",
          message: `Encontré varios proveedores posibles para *${supplierCand}*: ${optionsList}. ¿Cuál querés consultar?`,
        };
      }
    }

    // E. User confirmed or provided affirmative response ("Sí", "Dale", "Ok")
    if (/^(si|sí|dale|ok|bueno|por favor|confirmo|dale si)$/i.test(clean)) {
      const bLabel = pending.slots.branchTarget === "JARDIN" ? "Jardín" : "Centro";
      return {
        type: "RE_PROMPT",
        message: `Para preparar la reposición de *${bLabel}*, indicame el rubro (ej. *Cigarrillos*, *Galletitas*, *Bebidas*) o el proveedor (ej. *Arcor*).`,
      };
    }

    // User filtered: "Solo los que faltan"
    if (/^(solo\s+los\s+que\s+faltan|los\s+que\s+faltan|solo\s+faltantes|faltantes)$/i.test(clean)) {
      const bLabel = pending.slots.branchTarget === "JARDIN" ? "Jardín" : "Centro";
      return {
        type: "RE_PROMPT",
        message: `Entendido, se incluirán solo los productos con faltantes en *${bLabel}*. ¿De qué rubro o proveedor lo necesitás? (ej. *Cigarrillos*, *Galletitas*, *Arcor*).`,
      };
    }

    // F. User provided only a branch (e.g. "Centro" or "para Jardín")
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
        message: `Para generar el Excel de reposición de *${bLabel}*, podés indicarme el rubro (ej. *Chocolates*, *Galletitas*, *Bebidas*, *Cigarrillos*) o el proveedor (ej. *Arcor*, *Baggio*, *50350*).`,
      };
    }

    // G. User entered an explicit other command
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

    // G. Invalid or unrecognized rubro
    const candidateName =
      rubroInfo.unknownRubro ||
      (clean.length >= 3 && clean.length <= 25 ? text.trim() : "");
    const unknownNotice = candidateName
      ? `No encontré el rubro o proveedor *${candidateName}*. `
      : "No reconocí el rubro o proveedor ingresado. ";

    return {
      type: "RE_PROMPT",
      message: `${unknownNotice}Podés elegir un rubro (ej: *Chocolates*, *Caramelos*, *Galletitas*, *Bebidas*, *Almacén*, *Cigarrillos*) o un proveedor (ej: *Arcor*, *Baggio*, *Coca-Cola*, *50350*), o escribir 'cancelar' para salir.`,
    };
  }

  if (pending.clarificationType === "PRODUCT_DISAMBIGUATION") {
    if (
      pending.slots.disambiguationCandidates &&
      pending.slots.disambiguationCandidates.length > 0
    ) {
      const choiceIdx = parseDisambiguationChoice(
        clean,
        pending.slots.disambiguationCandidates.length
      );
      if (choiceIdx !== null) {
        const chosen = pending.slots.disambiguationCandidates[choiceIdx];
        clearPendingClarification(senderPhone);
        return {
          type: "RESOLVED",
          intent: {
            type: pending.intentType,
            rawText: text,
            slots: {
              ...pending.slots,
              articleId: chosen.id,
              productSearch: undefined,
              needsClarification: false,
              clarificationMessage: undefined,
              disambiguationCandidates: undefined,
            },
            confidence: 0.95,
          },
        };
      }
    }

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

/**
 * Resolves conversational continuation or correction of the last fulfilled context.
 * For example:
 * - "Mejor haceme el Excel de Jardín, no el de Centro" (switches branch, retains rubro/supplier)
 * - "Ahora hacelo para Jardín" / "En Jardín" / "Jardín"
 * - "En Excel" / "Hacelo en Excel" / "Generá el Excel" / "Sí"
 * - "Cigarrillos" / "Arcor"
 * - "Solo los que faltan"
 */
export function resolveContextualCorrection(
  senderPhone: string,
  text: string,
  initialIntent: ParsedIntent
): ParsedIntent | null {
  const last = getLastFulfilledContext(senderPhone);
  if (!last) return null;

  const clean = cleanText(text);

  // If user asked for an explicit other command, do not hijack it
  if (
    initialIntent.type === "GREETING" ||
    initialIntent.type === "HELP" ||
    initialIntent.type === "ORDER_DETAIL" ||
    initialIntent.type === "ORDERS_RECENT" ||
    initialIntent.type === "METRICS_SUMMARY" ||
    initialIntent.type === "SYSTEM_HEALTH"
  ) {
    return null;
  }

  const branchInfo = extractBranch(text);
  const mentionsBranch = branchInfo.target === "CENTRO" || branchInfo.target === "JARDIN";
  const isCorrectionPhrase =
    /\b(mejor|cambialo|cambia|ahora|no el de|no para|en vez de|para|y para)\b/i.test(clean);

  const isExcelSwitch =
    /^(?:en\s+excel|hacelo\s+en\s+excel|generame\s+el\s+excel|generar\s+excel|pasame\s+el\s+excel|excel|en\s+planilla|la\s+planilla|planilla|si|sí|dale|ok|bueno)$/i.test(
      clean
    ) ||
    (/\b(excel|planilla)\b/i.test(clean) && !/\b(ventas|pedidos)\b/i.test(clean));

  const isOnlyFaltantes = /^(solo\s+los\s+que\s+faltan|los\s+que\s+faltan|solo\s+faltantes|faltantes)$/i.test(clean);

  const isLastReplenish =
    last.intentType === "REPLENISHMENT" || last.intentType === "REPLENISHMENT_EXCEL";

  if (isLastReplenish) {
    // A. User wants Excel format of previous replenishment: "En Excel", "Hacelo en Excel", "Sí"
    if (isExcelSwitch && !mentionsBranch && !initialIntent.slots.targetRubro && !initialIntent.slots.supplierCode) {
      return {
        type: "REPLENISHMENT_EXCEL",
        rawText: text,
        slots: {
          ...last.slots,
          wantsExcel: true,
          needsClarification: false,
          clarificationMessage: undefined,
        },
        confidence: 0.95,
      };
    }

    // B. User changes or specifies branch: "Mejor haceme el Excel de Jardín, no el de Centro", "Ahora para Jardín", "Jardín"
    if (
      mentionsBranch &&
      (initialIntent.type === "REPLENISHMENT_EXCEL" ||
        initialIntent.type === "REPLENISHMENT" ||
        initialIntent.type === "UNKNOWN" ||
        /^(centro|jardin|jardín)$/i.test(clean) ||
        isCorrectionPhrase)
    ) {
      const newRubro = initialIntent.slots.targetRubro || last.slots.targetRubro;
      const newSupplierCode = initialIntent.slots.supplierCode || last.slots.supplierCode;
      const newSupplierName = initialIntent.slots.supplierName || last.slots.supplierName;
      const wantsExcel =
        initialIntent.slots.wantsExcel ??
        (last.slots.wantsExcel || /\b(excel|planilla)\b/i.test(clean));

      const effectiveIntentType: IntentType = wantsExcel ? "REPLENISHMENT_EXCEL" : "REPLENISHMENT";

      return {
        type: effectiveIntentType,
        rawText: text,
        slots: {
          ...last.slots,
          ...initialIntent.slots,
          branchTarget: branchInfo.target,
          branchId: branchInfo.branchId,
          targetRubro: newRubro,
          supplierCode: newSupplierCode,
          supplierName: newSupplierName,
          wantsExcel,
          needsClarification: false,
          clarificationMessage: undefined,
        },
        confidence: 0.95,
      };
    }

    // C. User gave a rubro (e.g. "Cigarrillos") or supplier (e.g. "Arcor")
    if (
      (/^(cigarrillos|galletitas|golosinas|chocolates|bebidas|almacen|almacén)$/i.test(clean) ||
        /^(arcor|baggio|mondelez|coca|coca cola|massalin|philip morris)$/i.test(clean)) &&
      (initialIntent.type === "UNKNOWN" || initialIntent.type === "STOCK_PRODUCT")
    ) {
      const rubroInfo = resolveCanonicalRubroFromText(clean);
      const supplierInfo = extractSupplierCandidate(clean);
      const resSup = supplierInfo.candidate ? resolveSupplier(supplierInfo.candidate) : null;

      const effectiveRubro = rubroInfo.canonical || (resSup?.status !== "EXACT" ? last.slots.targetRubro : undefined);
      const effectiveSupplierCode = resSup?.status === "EXACT" ? resSup.supplier.code : last.slots.supplierCode;
      const effectiveSupplierName = resSup?.status === "EXACT" ? resSup.supplier.name : last.slots.supplierName;

      return {
        type: last.intentType,
        rawText: text,
        slots: {
          ...last.slots,
          targetRubro: effectiveRubro,
          supplierCode: effectiveSupplierCode,
          supplierName: effectiveSupplierName,
          needsClarification: false,
          clarificationMessage: undefined,
        },
        confidence: 0.95,
      };
    }

    // D. "Solo los que faltan"
    if (isOnlyFaltantes) {
      return {
        type: last.intentType,
        rawText: text,
        slots: {
          ...last.slots,
          needsClarification: false,
          clarificationMessage: undefined,
        },
        confidence: 0.95,
      };
    }
  }

  return null;
}
