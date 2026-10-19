import { describe, expect, it } from "vitest";
import { parseUserMessage, resolvePeriodFromText } from "./router";

describe("WhatsApp NLP Router & Intent Parsing", () => {
  const refDate = new Date("2026-10-18T12:00:00.000Z");

  describe("Greetings & Help", () => {
    it("recognizes greetings in Argentine Spanish", () => {
      expect(parseUserMessage("Hola", refDate).type).toBe("GREETING");
      expect(parseUserMessage("Buenas tardes", refDate).type).toBe("GREETING");
      expect(parseUserMessage("Che qué tal", refDate).type).toBe("GREETING");
      expect(parseUserMessage("Buen día", refDate).type).toBe("GREETING");
    });

    it("recognizes help requests", () => {
      expect(parseUserMessage("Ayuda", refDate).type).toBe("HELP");
      expect(parseUserMessage("¿Qué podés hacer?", refDate).type).toBe("HELP");
      expect(parseUserMessage("Comandos disponibles", refDate).type).toBe("HELP");
      expect(parseUserMessage("Menu de opciones", refDate).type).toBe("HELP");
    });
  });

  describe("Stock Queries", () => {
    it("parses stock by product name and branch", () => {
      const res = parseUserMessage("¿Cuánto stock de alfajor havanna hay en Centro?", refDate);
      expect(res.type).toBe("STOCK_PRODUCT");
      expect(res.slots.productSearch).toBe("alfajor havanna");
      expect(res.slots.branchTarget).toBe("CENTRO");
      expect(res.slots.branchId).toBe(2);
    });

    it("parses stock in Jardín", () => {
      const res = parseUserMessage("Stock pepitos en Jardín", refDate);
      expect(res.type).toBe("STOCK_PRODUCT");
      expect(res.slots.productSearch).toBe("pepitos");
      expect(res.slots.branchTarget).toBe("JARDIN");
      expect(res.slots.branchId).toBe(3);
    });

    it("parses stock in Depósito", () => {
      const res = parseUserMessage("¿Cuánto stock de este producto hay en el depósito?", refDate);
      expect(res.type).toBe("STOCK_PRODUCT");
      expect(res.slots.branchTarget).toBe("DEPOSITO");
      expect(res.slots.branchId).toBe(1);
    });

    it("parses stock by article ID", () => {
      const res = parseUserMessage("Stock artículo 1052", refDate);
      expect(res.type).toBe("STOCK_PRODUCT");
      expect(res.slots.articleId).toBe(1052);
    });

    it("defaults branch target to ALL when not specified", () => {
      const res = parseUserMessage("Stock alfajor marplatense", refDate);
      expect(res.type).toBe("STOCK_PRODUCT");
      expect(res.slots.branchTarget).toBe("ALL");
      expect(res.slots.productSearch).toBe("alfajor marplatense");
    });

    it("recognizes stock out alerts and quiebres", () => {
      const res1 = parseUserMessage("¿Qué productos están sin stock en Jardín?", refDate);
      expect(res1.type).toBe("STOCK_OUT_ALERT");
      expect(res1.slots.branchTarget).toBe("JARDIN");

      const res2 = parseUserMessage("Quiebres de stock Centro", refDate);
      expect(res2.type).toBe("STOCK_OUT_ALERT");
      expect(res2.slots.branchTarget).toBe("CENTRO");

      const res3 = parseUserMessage("Stock negativo", refDate);
      expect(res3.type).toBe("STOCK_OUT_ALERT");
    });
  });

  describe("Replenishment Queries", () => {
    it("parses replenishment for a specific branch", () => {
      const res = parseUserMessage("¿Qué productos necesitan reposición en Jardín?", refDate);
      expect(res.type).toBe("REPLENISHMENT");
      expect(res.slots.branchTarget).toBe("JARDIN");
      expect(res.slots.branchId).toBe(3);
      expect(res.slots.needsClarification).toBeFalsy();
    });

    it("requests clarification when branch is missing for replenishment", () => {
      const res = parseUserMessage("Sugerencias de reposición", refDate);
      expect(res.type).toBe("REPLENISHMENT");
      expect(res.slots.needsClarification).toBe(true);
      expect(res.slots.clarificationMessage).toContain("Centro");
      expect(res.slots.clarificationMessage).toContain("Jardín");
    });
  });

  describe("Orders Queries", () => {
    it("parses order detail by visible order number (#3)", () => {
      const res1 = parseUserMessage("Pedido #3", refDate);
      expect(res1.type).toBe("ORDER_DETAIL");
      expect(res1.slots.orderNumber).toBe(3);

      const res2 = parseUserMessage("Detalle del pedido 2", refDate);
      expect(res2.type).toBe("ORDER_DETAIL");
      expect(res2.slots.orderNumber).toBe(2);

      const res3 = parseUserMessage("Orden #15", refDate);
      expect(res3.type).toBe("ORDER_DETAIL");
      expect(res3.slots.orderNumber).toBe(15);
    });

    it("parses pending orders", () => {
      const res1 = parseUserMessage("¿Qué pedidos siguen pendientes?", refDate);
      expect(res1.type).toBe("ORDERS_PENDING");

      const res2 = parseUserMessage("Pedidos pendientes de preparación", refDate);
      expect(res2.type).toBe("ORDERS_PENDING");
    });

    it("parses recent orders query", () => {
      const res = parseUserMessage("¿Cuál fue el último pedido de Centro?", refDate);
      expect(res.type).toBe("ORDERS_RECENT");
      expect(res.slots.branchTarget).toBe("CENTRO");
      expect(res.slots.branchId).toBe(2);
    });
  });

  describe("Suppliers & Products", () => {
    it("identifies supplier of a product", () => {
      const res = parseUserMessage("¿De qué proveedor es este artículo 1052?", refDate);
      expect(res.type).toBe("PRODUCT_SUPPLIER");
      expect(res.slots.articleId).toBe(1052);
    });

    it("searches products of a supplier", () => {
      const res = parseUserMessage("Productos del proveedor Arcor", refDate);
      expect(res.type).toBe("SUPPLIER_PRODUCTS");
      expect(res.slots.supplierSearch).toContain("arcor");
    });
  });

  describe("Metrics & Historical Periods", () => {
    it("parses named month 'septiembre'", () => {
      const res = parseUserMessage("¿Qué pasó durante septiembre?", refDate);
      expect(res.type).toBe("METRICS_SUMMARY");
      expect(res.slots.periodType).toBe("named_month");
      expect(res.slots.period?.from).toBe("2026-09-01");
      expect(res.slots.period?.to).toBe("2026-09-30");
    });

    it("parses 'hoy', 'ayer', 'esta semana'", () => {
      const resHoy = parseUserMessage("Resumen de hoy", refDate);
      expect(resHoy.type).toBe("METRICS_SUMMARY");
      expect(resHoy.slots.periodType).toBe("today");
      expect(resHoy.slots.period?.from).toBe("2026-10-18");

      const resAyer = parseUserMessage("Resumen de ayer", refDate);
      expect(resAyer.type).toBe("METRICS_SUMMARY");
      expect(resAyer.slots.periodType).toBe("yesterday");
      expect(resAyer.slots.period?.from).toBe("2026-10-17");

      const resSemana = parseUserMessage("Resumen esta semana", refDate);
      expect(resSemana.type).toBe("METRICS_SUMMARY");
      expect(resSemana.slots.periodType).toBe("this_week");
    });

    it("parses period comparison", () => {
      const res = parseUserMessage("Comparame este mes con el anterior", refDate);
      expect(res.type).toBe("METRICS_COMPARISON");
    });

    it("parses top products", () => {
      const res = parseUserMessage("Artículos más vendidos del mes", refDate);
      expect(res.type).toBe("METRICS_TOP_PRODUCTS");
    });

    it("parses system health & data freshness", () => {
      const res = parseUserMessage("Estado de sincronización del sistema", refDate);
      expect(res.type).toBe("SYSTEM_HEALTH");
    });
  });
});
