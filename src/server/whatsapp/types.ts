import type { Period } from "@/server/analytics/types";

export type IntentType =
  | "STOCK_PRODUCT"
  | "STOCK_LOW"
  | "STOCK_OUT_ALERT"
  | "REPLENISHMENT"
  | "REPLENISHMENT_EXCEL"
  | "ORDERS_RECENT"
  | "ORDER_DETAIL"
  | "ORDERS_PENDING"
  | "SUPPLIER_PRODUCTS"
  | "PRODUCT_SUPPLIER"
  | "METRICS_SUMMARY"
  | "METRICS_COMPARISON"
  | "METRICS_TOP_PRODUCTS"
  | "SYSTEM_HEALTH"
  | "NEXT_DELIVERY"
  | "AMBIGUOUS_PENDING"
  | "PURCHASE_QUERY"
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
  targetRubro?: string;
  wantsExcel?: boolean;
  periodType?: "today" | "yesterday" | "this_week" | "this_month" | "last_month" | "named_month" | "custom";
  period?: Period;
  periodLabel?: string;
  needsClarification?: boolean;
  clarificationType?: "BRANCH" | "PRODUCT" | "ORDER" | "AMBIGUOUS_PENDING" | "RUBRO";
  clarificationMessage?: string;
  pendingIntentType?: IntentType;
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

export type SendMessageResult = {
  success: boolean;
  messageId?: string;
  error?: string;
};

export type SendDocumentOptions = {
  document: Buffer;
  fileName: string;
  mimetype?: string;
  caption?: string;
};

export type MessageSender = (
  to: string,
  text: string
) => Promise<SendMessageResult>;

export type DocumentSender = (
  to: string,
  doc: SendDocumentOptions
) => Promise<SendMessageResult>;
