import type { Period } from "@/server/analytics/types";

export type IntentType =
  | "STOCK_PRODUCT"
  | "STOCK_OUT_ALERT"
  | "REPLENISHMENT"
  | "ORDERS_RECENT"
  | "ORDER_DETAIL"
  | "ORDERS_PENDING"
  | "SUPPLIER_PRODUCTS"
  | "PRODUCT_SUPPLIER"
  | "METRICS_SUMMARY"
  | "METRICS_COMPARISON"
  | "METRICS_TOP_PRODUCTS"
  | "SYSTEM_HEALTH"
  | "HELP"
  | "GREETING"
  | "UNKNOWN";

export type BranchTarget = "CENTRO" | "JARDIN" | "DEPOSITO" | "ALL";

export type ParsedSlots = {
  branchTarget: BranchTarget;
  branchId?: number; // 1: Depósito, 2: Centro, 3: Jardín
  productSearch?: string;
  articleId?: number;
  orderNumber?: number;
  supplierSearch?: string;
  rubroSearch?: string;
  periodType?: "today" | "yesterday" | "this_week" | "this_month" | "last_month" | "named_month" | "custom";
  period?: Period;
  periodLabel?: string;
  needsClarification?: boolean;
  clarificationMessage?: string;
};

export type ParsedIntent = {
  type: IntentType;
  rawText: string;
  slots: ParsedSlots;
  confidence: number;
};

export type WhatsAppSenderContext = {
  phone: string;
  normalizedPhone: string;
  isAuthorized: boolean;
  role: "SUPERVISOR" | "PV_OPERATOR" | "WAREHOUSE_OPERATOR";
  name?: string;
  branchId?: number;
};

export type MetaWebhookPayload = {
  object: string;
  entry?: Array<{
    id: string;
    changes?: Array<{
      value: {
        messaging_product: string;
        metadata?: {
          display_phone_number?: string;
          phone_number_id?: string;
        };
        contacts?: Array<{
          profile?: { name?: string };
          wa_id: string;
        }>;
        messages?: Array<{
          from: string;
          id: string;
          timestamp: string;
          type: string;
          text?: { body: string };
        }>;
        statuses?: Array<{
          id: string;
          status: string;
          timestamp: string;
          recipient_id: string;
        }>;
      };
      field: string;
    }>;
  }>;
};

export type SendMessageResult = {
  success: boolean;
  messageId?: string;
  error?: string;
};
