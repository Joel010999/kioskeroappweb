import { beforeEach, describe, expect, it, vi } from "vitest";
import * as xlsx from "xlsx";
import { query } from "@/server/db/client";
import { parseUserMessage } from "./router";
import { processIncomingMessage } from "./processor";
import { formatGreetingMessage, formatHelpMessage, formatUnknownMessage } from "./formatters";
import { clearMemoryDeduplicationCache } from "./deduplication";
import {
  clearAllLastFulfilledContexts,
  clearAllPaginatedLists,
  clearAllPendingClarifications,
} from "./context";
import type { SendDocumentOptions, SendMessageResult } from "./types";

vi.mock("@/server/db/client", () => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
}));

describe("WhatsApp Bot — Menú Inicial y Solicitud de Excel de Inventario Completo", () => {
  const testPhone = "5491199990000";
  const refDate = new Date("2026-11-13T12:00:00Z");

  let sentMessages: string[] = [];
  let sentDocuments: Array<{ target: string; options: SendDocumentOptions }> = [];

  const mockSendMessage = async (_to: string, text: string): Promise<SendMessageResult> => {
    sentMessages.push(text);
    return { success: true, messageId: `msg_${Date.now()}_${sentMessages.length}` };
  };

  const mockSendDocument = async (to: string, options: SendDocumentOptions): Promise<SendMessageResult> => {
    sentDocuments.push({ target: to, options });
    return { success: true, messageId: `doc_${Date.now()}_${sentDocuments.length}` };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    clearMemoryDeduplicationCache();
    clearAllPendingClarifications();
    clearAllLastFulfilledContexts();
    clearAllPaginatedLists();
    sentMessages = [];
    sentDocuments = [];
  });

  describe("1. Menú inicial (saludo y ayuda)", () => {
    it("muestra claramente las opciones 6 (inventario por rubro) y 7 (inventario por proveedor)", () => {
      const greeting = formatGreetingMessage("Mónica");

      // Opciones originales 1 a 5
      expect(greeting).toContain("📦 *1. Stock de productos*");
      expect(greeting).toContain("🧾 *2. Pedidos registrados*");
      expect(greeting).toContain("🚚 *3. Reposición semanal*");
      expect(greeting).toContain("📊 *4. Resúmenes del negocio*");
      expect(greeting).toContain("📑 *5. Excel de reposición por rubro y sucursal*");

      // Nuevas opciones 6 y 7
      expect(greeting).toContain("📋 *6. Inventario completo por rubro (Excel)*");
      expect(greeting).toContain("Inventario de Cigarrillos");
      expect(greeting).toContain("Excel rubro Bebidas");

      expect(greeting).toContain("🏭 *7. Inventario completo por proveedor (Excel)*");
      expect(greeting).toContain("Inventario de Arcor");
      expect(greeting).toContain("Excel proveedor 50350");
      expect(greeting).toContain("Planilla Coca Cola");
    });

    it("el menú de ayuda (formatHelpMessage) replica el saludo con las 7 opciones", () => {
      const help = formatHelpMessage("Mónica");
      expect(help).toContain("📋 *6. Inventario completo por rubro (Excel)*");
      expect(help).toContain("🏭 *7. Inventario completo por proveedor (Excel)*");
    });

    it("el mensaje de fallback (formatUnknownMessage) sugiere cómo pedir inventario completo", () => {
      const unknown = formatUnknownMessage();
      expect(unknown).toContain("📋 *Descargar inventario completo (Excel)*");
      expect(unknown).toContain("Inventario de cigarrillos en Excel");
      expect(unknown).toContain("Excel completo del proveedor 50350");
    });
  });

  describe("2. Atajos numéricos y consultas directas en router", () => {
    it("opción '6' y 'opcion 6' solicitan rubro sin pedir sucursal", () => {
      const r6 = parseUserMessage("6", refDate);
      expect(r6.type).toBe("INVENTORY_EXCEL");
      expect(r6.slots.wantsExcel).toBe(true);
      expect(r6.slots.needsClarification).toBe(true);
      expect(r6.slots.clarificationType).toBe("RUBRO");
      expect(r6.slots.pendingIntentType).toBe("INVENTORY_EXCEL");
      expect(r6.slots.clarificationMessage).toContain("Chocolates");

      const r6Text = parseUserMessage("opción 6", refDate);
      expect(r6Text.type).toBe("INVENTORY_EXCEL");
      expect(r6Text.slots.clarificationType).toBe("RUBRO");
    });

    it("opción '7' y 'opcion 7' solicitan proveedor sin pedir sucursal", () => {
      const r7 = parseUserMessage("7", refDate);
      expect(r7.type).toBe("INVENTORY_EXCEL");
      expect(r7.slots.wantsExcel).toBe(true);
      expect(r7.slots.needsClarification).toBe(true);
      expect(r7.slots.clarificationType).toBe("SUPPLIER");
      expect(r7.slots.pendingIntentType).toBe("INVENTORY_EXCEL");
      expect(r7.slots.clarificationMessage).toContain("Arcor");
      expect(r7.slots.clarificationMessage).toContain("50350");

      const r7Text = parseUserMessage("opcion 7", refDate);
      expect(r7Text.type).toBe("INVENTORY_EXCEL");
      expect(r7Text.slots.clarificationType).toBe("SUPPLIER");
    });

    it("consultas directas con rubro o proveedor van directo a INVENTORY_EXCEL sin clarificación", () => {
      const q1 = parseUserMessage("Excel completo de cigarrillos", refDate);
      expect(q1.type).toBe("INVENTORY_EXCEL");
      expect(q1.slots.targetRubro).toBe("CIGARRILLOS");
      expect(q1.slots.needsClarification).toBe(false);

      const q2 = parseUserMessage("Excel de inventario de bebidas", refDate);
      expect(q2.type).toBe("INVENTORY_EXCEL");
      expect(q2.slots.targetRubro).toBe("BEBIDAS");
      expect(q2.slots.needsClarification).toBe(false);

      const q3 = parseUserMessage("Excel completo de Arcor", refDate);
      expect(q3.type).toBe("INVENTORY_EXCEL");
      expect(q3.slots.supplierName).toBe("Arcor");
      expect(q3.slots.needsClarification).toBe(false);

      const q4 = parseUserMessage("Excel del proveedor 50350", refDate);
      expect(q4.type).toBe("INVENTORY_EXCEL");
      expect(q4.slots.supplierCode).toBe("50350");
      expect(q4.slots.needsClarification).toBe(false);

      const q5 = parseUserMessage("Planilla de inventario proveedor 50350", refDate);
      expect(q5.type).toBe("INVENTORY_EXCEL");
      expect(q5.slots.supplierCode).toBe("50350");
      expect(q5.slots.needsClarification).toBe(false);
    });
  });

  describe("3. Flujo conversacional completo End-to-End con Processor", () => {
    const mockDbForInventory = () => {
      vi.mocked(query).mockImplementation(async (sql: string) => {
        if (sql.includes("INSERT INTO whatsapp_processed_messages")) {
          return { rows: [{ id: "m_processed" }] } as any;
        }
        if (sql.includes("WITH catalog AS")) {
          return {
            rows: [
              {
                article_id: 101,
                description: "Marlboro Box 20",
                brand: "Marlboro",
                rubro: "Cigarrillos",
                supplier_code: "50350",
                supplier_name: "Massalin",
                unit_measure: "AT",
                bulto: "10",
                is_active: true,
                stock_centro: "15",
                stock_jardin: "8",
                stock_depot: "200",
                base_stock_centro: "20",
                base_stock_jardin: "10",
              },
              {
                article_id: 102,
                description: "Philip Morris Box 20",
                brand: "Philip Morris",
                rubro: "Cigarrillos",
                supplier_code: "50350",
                supplier_name: "Massalin",
                unit_measure: "AT",
                bulto: "10",
                is_active: true,
                stock_centro: "12",
                stock_jardin: "5",
                stock_depot: "150",
                base_stock_centro: "15",
                base_stock_jardin: "10",
              },
            ],
          } as any;
        }
        return { rows: [] } as any;
      });
    };

    it("Flujo A: Hola -> 6 -> Cigarrillos -> Recibe Excel completo por rubro", async () => {
      mockDbForInventory();

      // Turno 1: Saludo
      const turn1 = await processIncomingMessage({
        messageId: "turn_1",
        senderPhone: testPhone,
        textBody: "Hola",
        configuredAllowedEnv: testPhone,
        sendMessageFn: mockSendMessage,
        sendDocumentFn: mockSendDocument,
      });
      expect(turn1.processed).toBe(true);
      expect(turn1.intent).toBe("GREETING");
      expect(sentMessages[0]).toContain("¡Hola, Mónica!");
      expect(sentMessages[0]).toContain("📋 *6. Inventario completo por rubro (Excel)*");
      expect(sentMessages[0]).toContain("🏭 *7. Inventario completo por proveedor (Excel)*");

      // Turno 2: Opción 6
      const turn2 = await processIncomingMessage({
        messageId: "turn_2",
        senderPhone: testPhone,
        textBody: "6",
        configuredAllowedEnv: testPhone,
        sendMessageFn: mockSendMessage,
        sendDocumentFn: mockSendDocument,
      });
      expect(turn2.processed).toBe(true);
      expect(turn2.intent).toBe("INVENTORY_EXCEL");
      expect(sentMessages[1]).toContain("¿De qué rubro querés descargar el inventario completo en Excel?");

      // Turno 3: Cigarrillos
      const turn3 = await processIncomingMessage({
        messageId: "turn_3",
        senderPhone: testPhone,
        textBody: "Cigarrillos",
        configuredAllowedEnv: testPhone,
        sendMessageFn: mockSendMessage,
        sendDocumentFn: mockSendDocument,
      });
      expect(turn3.processed).toBe(true);
      expect(turn3.intent).toBe("INVENTORY_EXCEL");

      // Verificamos que envió el documento Excel sin pedir sucursal
      expect(sentDocuments.length).toBe(1);
      const doc = sentDocuments[0];
      expect(doc.options.fileName).toContain("INVENTARIO_CIGARRILLOS");
      expect(doc.options.caption).toContain("Planilla de Inventario — Cigarrillos");
      expect(doc.options.caption).toContain("Centro, Jardín y Depósito");

      // Verificamos el contenido del Excel generado
      const wb = xlsx.read(doc.options.document, { type: "buffer" });
      expect(wb.SheetNames).toContain("Inventario");
      const sheet = wb.Sheets["Inventario"];
      const rows = xlsx.utils.sheet_to_json(sheet, { header: 1 }) as any[][];

      // Cabeceras esperadas (Fila 4 en Excel, índice 3)
      expect(rows[3]).toEqual([
        "Código",
        "Descripción",
        "Marca",
        "Rubro",
        "Proveedor",
        "Estado",
        "Presentación",
        "Stock Centro",
        "Stock Base Centro",
        "Stock Jardín",
        "Stock Base Jardín",
        "Stock Depósito Central",
      ]);

      // Datos incluidos
      const r1 = rows.find((r) => r[0] === 101);
      expect(r1).toBeDefined();
      expect(r1![1]).toBe("Marlboro Box 20");
      expect(r1![7]).toBe(15); // Stock Centro
      expect(r1![8]).toBe(20); // Base Centro
      expect(r1![9]).toBe(8); // Stock Jardín
      expect(r1![10]).toBe(10); // Base Jardín
      expect(r1![11]).toBe(200); // Stock Depósito
    });

    it("Flujo B: Hola -> 7 -> 50350 -> Recibe Excel completo por proveedor", async () => {
      mockDbForInventory();

      // Turno 1: Opción 7
      const turn1 = await processIncomingMessage({
        messageId: "turn_p1",
        senderPhone: testPhone,
        textBody: "7",
        configuredAllowedEnv: testPhone,
        sendMessageFn: mockSendMessage,
        sendDocumentFn: mockSendDocument,
      });
      expect(turn1.processed).toBe(true);
      expect(turn1.intent).toBe("INVENTORY_EXCEL");
      expect(sentMessages[0]).toContain("¿De qué proveedor querés descargar el inventario completo en Excel?");

      // Turno 2: Proveedor 50350
      const turn2 = await processIncomingMessage({
        messageId: "turn_p2",
        senderPhone: testPhone,
        textBody: "50350",
        configuredAllowedEnv: testPhone,
        sendMessageFn: mockSendMessage,
        sendDocumentFn: mockSendDocument,
      });
      expect(turn2.processed).toBe(true);
      expect(turn2.intent).toBe("INVENTORY_EXCEL");

      expect(sentDocuments.length).toBe(1);
      const doc = sentDocuments[0];
      expect(doc.options.fileName).toContain("INVENTARIO_ARCOR");
      expect(doc.options.caption).toContain("Arcor");
    });

    it("Flujo C: Solicitud directa 'Excel completo de cigarrillos' despacha documento en un solo turno", async () => {
      mockDbForInventory();

      const turn = await processIncomingMessage({
        messageId: "turn_direct",
        senderPhone: testPhone,
        textBody: "Excel completo de cigarrillos",
        configuredAllowedEnv: testPhone,
        sendMessageFn: mockSendMessage,
        sendDocumentFn: mockSendDocument,
      });
      expect(turn.processed).toBe(true);
      expect(turn.intent).toBe("INVENTORY_EXCEL");
      expect(sentDocuments.length).toBe(1);
      expect(sentDocuments[0].options.fileName).toContain("INVENTARIO_CIGARRILLOS");
    });

    it("Flujo D: Solicitud '6' y respuesta 'todos' genera el catálogo completo sin filtro de rubro", async () => {
      mockDbForInventory();

      await processIncomingMessage({
        messageId: "turn_all_1",
        senderPhone: testPhone,
        textBody: "6",
        configuredAllowedEnv: testPhone,
        sendMessageFn: mockSendMessage,
        sendDocumentFn: mockSendDocument,
      });

      await processIncomingMessage({
        messageId: "turn_all_2",
        senderPhone: testPhone,
        textBody: "todos",
        configuredAllowedEnv: testPhone,
        sendMessageFn: mockSendMessage,
        sendDocumentFn: mockSendDocument,
      });

      expect(sentDocuments.length).toBe(1);
      expect(sentDocuments[0].options.caption).toContain("Catálogo completo");
    });

    it("Flujo E: El usuario selecciona opción 6 pero cambia a un proveedor ('Arcor')", async () => {
      mockDbForInventory();

      await processIncomingMessage({
        messageId: "turn_switch_1",
        senderPhone: testPhone,
        textBody: "6",
        configuredAllowedEnv: testPhone,
        sendMessageFn: mockSendMessage,
        sendDocumentFn: mockSendDocument,
      });

      await processIncomingMessage({
        messageId: "turn_switch_2",
        senderPhone: testPhone,
        textBody: "Arcor",
        configuredAllowedEnv: testPhone,
        sendMessageFn: mockSendMessage,
        sendDocumentFn: mockSendDocument,
      });

      expect(sentDocuments.length).toBe(1);
      expect(sentDocuments[0].options.caption).toContain("Arcor");
    });
  });
});
