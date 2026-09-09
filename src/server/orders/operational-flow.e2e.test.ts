import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Scope } from "@/server/analytics/types";
import type { WeeklyReplenishmentItem } from "@/server/analytics/weekly-replenishment";
import type { SupplyMode } from "@/server/supply/branch-supply-rules";
import { depotArticleIds } from "@/server/supply/branch-supply-rules";
import {
  canDispatchOrder,
  canModifyOrder,
  canPrepareOrder,
  canReceiveOrder,
  canViewOrder,
} from "@/server/auth/policies";
import type { AuthorizationContext } from "@/server/auth/context";
import type { OrderEventType, OrderStatus } from "./rules";

const { getWeeklyReplenishment, query, withTransaction } = vi.hoisted(() => ({
  getWeeklyReplenishment: vi.fn(),
  query: vi.fn(),
  withTransaction: vi.fn(),
}));

vi.mock("@/server/analytics/weekly-replenishment", () => ({
  DEPOT_BRANCH_ID: 1,
  getWeeklyReplenishment,
}));
vi.mock("@/server/db/client", () => ({ query, withTransaction }));

import { confirmInternalReplenishment } from "./internal-replenishment";
import {
  changeStatus,
  fulfillOrder,
  updateOperationalQuantity,
} from "./repository";

const DEPOT_ARTICLE = 910001;
const DIRECT_ARTICLE = 910002;
const UNDEFINED_ARTICLE = 910003;
const PLANNING_DATE = "2026-10-03";
const PV1_ACTOR = "101";
const PV2_ACTOR = "102";
const WAREHOUSE_ACTOR = "103";
const pv1Scope: Scope = { organizationId: 1, sourceId: "pv1", branchId: 2 };
const pv2Scope: Scope = { organizationId: 1, sourceId: "pv2", branchId: 3 };
const warehouseScope: Scope = {
  organizationId: 1,
  sourceId: "depot",
  branchId: 1,
};

type StoredOrder = {
  id: number;
  organizationId: number;
  sourceId: string;
  branchId: number;
  status: OrderStatus;
  orderType: "GENERIC" | "INTERNAL_REPLENISHMENT";
  originBranchId: number | null;
  destinationBranchId: number | null;
  planningDate: string | null;
  idempotencyKey: string | null;
  createdBy: string | null;
  confirmedBy: string | null;
};
type StoredItem = {
  id: number;
  orderId: number;
  articleId: number;
  productNameSnapshot: string;
  suggestedQuantity: number | null;
  requestedQuantity: number;
  stockAtCreation: number;
  stockTargetAtCreation: number | null;
  weeklyDemandAtCreation: number | null;
  planningDateAtCreation: string | null;
  supplierCodeSnapshot: string | null;
  classificationCodeSnapshot: string | null;
  unitMeasureSnapshot: string | null;
  statusAtCreation: string;
  approvedQuantity: number | null;
  preparedQuantity: number | null;
  dispatchedQuantity: number | null;
  receivedQuantity: number | null;
};
type StoredEvent = {
  orderId: number;
  eventType: OrderEventType;
  metadata: Record<string, unknown>;
  userId: string | null;
};

function ruleKey(organizationId: number, branchId: number, articleId: number) {
  return `${organizationId}:${branchId}:${articleId}`;
}

function itemFor(articleId: number, supplyMode: SupplyMode): WeeklyReplenishmentItem {
  return {
    article_id: articleId,
    description: `TEST-E2E-${articleId}`,
    supplier_code: "TEST-SUPPLIER",
    classification_code: "TEST",
    unit_measure: "UN",
    stock_current: 10,
    stock_depot: 200,
    depot_stock_state: "DEPOT_STOCK_POSITIVE",
    weekly_demand: 100,
    weekly_average: 100,
    weekly_max: 100,
    weekly_min: 100,
    active_weeks: 6,
    target_stock: 100,
    suggested_quantity: 90,
    requested_quantity: 90,
    status: "SUGGESTION_AVAILABLE",
    supply_mode: supplyMode,
    warnings: [],
    fulfillment_type: "INTERNAL_REPLENISHMENT_CANDIDATE",
  };
}

class IsolatedOperationalFixture {
  readonly orders: StoredOrder[] = [];
  readonly items: StoredItem[] = [];
  readonly events: StoredEvent[] = [];
  readonly rules = new Map<string, SupplyMode>();
  readonly reviewItems = [
    itemFor(DEPOT_ARTICLE, "DEPOT"),
    itemFor(DIRECT_ARTICLE, "DIRECT_SUPPLIER"),
    itemFor(UNDEFINED_ARTICLE, "UNDEFINED"),
  ];
  private nextOrderId = 1;
  private nextItemId = 1;

  constructor() {
    this.setRule(1, 2, DEPOT_ARTICLE, "DEPOT");
    this.setRule(1, 2, DIRECT_ARTICLE, "DIRECT_SUPPLIER");
    this.setRule(1, 2, UNDEFINED_ARTICLE, "UNDEFINED");
    this.setRule(1, 3, DEPOT_ARTICLE, "DIRECT_SUPPLIER");
  }

  setRule(
    organizationId: number,
    branchId: number,
    articleId: number,
    supplyMode: SupplyMode,
  ) {
    this.rules.set(ruleKey(organizationId, branchId, articleId), supplyMode);
  }

  modesFor(scope: Scope) {
    return new Map(
      this.reviewItems.map((item) => [
        item.article_id,
        this.rules.get(
          ruleKey(scope.organizationId ?? 0, scope.branchId, item.article_id),
        ) ?? "UNDEFINED",
      ]),
    );
  }

  seedDraft(scope: Scope) {
    const order: StoredOrder = {
      id: this.nextOrderId++,
      organizationId: scope.organizationId ?? 0,
      sourceId: scope.sourceId,
      branchId: scope.branchId,
      status: "DRAFT",
      orderType: "GENERIC",
      originBranchId: null,
      destinationBranchId: null,
      planningDate: null,
      idempotencyKey: null,
      createdBy: PV1_ACTOR,
      confirmedBy: null,
    };
    this.orders.push(order);
    return order;
  }

  order(id: number) {
    const order = this.orders.find((candidate) => candidate.id === id);
    if (!order) throw new Error(`Isolated order ${id} was not found.`);
    return order;
  }

  itemsFor(orderId: number) {
    return this.items.filter((item) => item.orderId === orderId);
  }

  eventsFor(orderId: number) {
    return this.events.filter((event) => event.orderId === orderId);
  }

  asClient() {
    return { query: this.query.bind(this) } as never;
  }

  private scopedOrder(
    sourceId: string,
    branchId: number,
    organizationId: number,
    orderId: number,
  ) {
    const order = this.orders.find((candidate) => candidate.id === orderId);
    if (!order) return undefined;
    const directScope =
      order.sourceId === sourceId &&
      order.branchId === branchId &&
      order.organizationId === organizationId;
    const warehouseScope =
      order.organizationId === 1 &&
      order.orderType === "INTERNAL_REPLENISHMENT" &&
      order.destinationBranchId === 1;
    return directScope || warehouseScope ? order : undefined;
  }

  async query<T extends Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<{ rows: T[] }> {
    const statement = text.replace(/\s+/g, " ").trim();
    const rows = <Row extends Record<string, unknown>>(result: Row[]) =>
      ({ rows: result as unknown as T[] });

    if (
      statement.startsWith(
        "SELECT article_id, supply_mode FROM branch_product_supply_rules",
      )
    ) {
      const [organizationId, branchId, articleIds] = values as [
        number,
        number,
        number[],
      ];
      return rows(
        articleIds.flatMap((articleId) => {
          const supplyMode = this.rules.get(
            ruleKey(organizationId, branchId, articleId),
          );
          return supplyMode === "DEPOT" ? [{ article_id: articleId, supply_mode: supplyMode }] : [];
        }),
      );
    }

    if (
      statement.startsWith(
        "SELECT id FROM orders WHERE order_type='INTERNAL_REPLENISHMENT'",
      )
    ) {
      const [organizationId, originBranchId, destinationBranchId, planningDate] =
        values as [number, number, number, string];
      const existing = this.orders.find(
        (order) =>
          order.organizationId === organizationId &&
          order.orderType === "INTERNAL_REPLENISHMENT" &&
          order.originBranchId === originBranchId &&
          order.destinationBranchId === destinationBranchId &&
          order.planningDate === planningDate &&
          order.status !== "CANCELLED",
      );
      return rows(existing ? [{ id: String(existing.id) }] : []);
    }

    if (
      statement.startsWith(
        "INSERT INTO orders (organization_id,source_id,branch_id,status,order_type",
      )
    ) {
      const [
        organizationId,
        sourceId,
        branchId,
        destinationBranchId,
        planningDate,
        idempotencyKey,
        actorId,
      ] = values as [number, string, number, number, string, string, string];
      const order: StoredOrder = {
        id: this.nextOrderId++,
        organizationId,
        sourceId,
        branchId,
        status: "CONFIRMED",
        orderType: "INTERNAL_REPLENISHMENT",
        originBranchId: branchId,
        destinationBranchId,
        planningDate,
        idempotencyKey,
        createdBy: actorId,
        confirmedBy: actorId,
      };
      this.orders.push(order);
      return rows([{ id: String(order.id) }]);
    }

    if (statement.startsWith("INSERT INTO order_events")) {
      if (statement.includes("'ORDER_CREATED'")) {
        const [orderId, createdMetadata, confirmedMetadata, actorId] = values as [
          number,
          string,
          string,
          string,
        ];
        this.events.push(
          {
            orderId,
            eventType: "ORDER_CREATED",
            metadata: JSON.parse(createdMetadata) as Record<string, unknown>,
            userId: actorId,
          },
          {
            orderId,
            eventType: "ORDER_CONFIRMED",
            metadata: JSON.parse(confirmedMetadata) as Record<string, unknown>,
            userId: actorId,
          },
        );
      } else {
        const [orderId, eventType, metadata, actorId] = values as [
          number,
          OrderEventType,
          string,
          string | null,
        ];
        this.events.push({
          orderId,
          eventType,
          metadata: JSON.parse(metadata) as Record<string, unknown>,
          userId: actorId,
        });
      }
      return rows([]);
    }

    if (statement.startsWith("INSERT INTO order_items")) {
      const [
        orderId,
        articleId,
        productNameSnapshot,
        suggestedQuantity,
        requestedQuantity,
        stockAtCreation,
        stockTargetAtCreation,
        statusAtCreation,
        weeklyDemandAtCreation,
        planningDateAtCreation,
        supplierCodeSnapshot,
        classificationCodeSnapshot,
        unitMeasureSnapshot,
      ] = values as [
        number,
        number,
        string,
        number | null,
        number,
        number,
        number | null,
        string,
        number | null,
        string | null,
        string | null,
        string | null,
        string | null,
      ];
      this.items.push({
        id: this.nextItemId++,
        orderId,
        articleId,
        productNameSnapshot,
        suggestedQuantity,
        requestedQuantity,
        stockAtCreation,
        stockTargetAtCreation,
        weeklyDemandAtCreation,
        planningDateAtCreation,
        supplierCodeSnapshot,
        classificationCodeSnapshot,
        unitMeasureSnapshot,
        statusAtCreation,
        approvedQuantity: null,
        preparedQuantity: null,
        dispatchedQuantity: null,
        receivedQuantity: null,
      });
      return rows([]);
    }

    if (statement.startsWith("SELECT o.status FROM orders o WHERE")) {
      const [sourceId, branchId, organizationId, orderId] = values as [
        string,
        number,
        number,
        number,
      ];
      const order = this.scopedOrder(sourceId, branchId, organizationId, orderId);
      return rows(order ? [{ status: order.status }] : []);
    }

    if (statement.startsWith("SELECT COUNT(*) AS count FROM order_items")) {
      const [orderId] = values as [number];
      return rows([{ count: String(this.itemsFor(orderId).length) }]);
    }

    if (
      statement.startsWith(
        "SELECT requested_quantity, approved_quantity, prepared_quantity FROM order_items",
      )
    ) {
      const [itemId, orderId] = values as [number, number];
      const item = this.items.find(
        (candidate) => candidate.id === itemId && candidate.orderId === orderId,
      );
      return rows(
        item
          ? [
              {
                requested_quantity: String(item.requestedQuantity),
                approved_quantity:
                  item.approvedQuantity === null
                    ? null
                    : String(item.approvedQuantity),
                prepared_quantity:
                  item.preparedQuantity === null
                    ? null
                    : String(item.preparedQuantity),
              },
            ]
          : [],
      );
    }

    if (
      statement.startsWith(
        "SELECT id, approved_quantity, prepared_quantity, dispatched_quantity FROM order_items",
      )
    ) {
      const [orderId] = values as [number];
      return rows(
        this.itemsFor(orderId).map((item) => ({
          id: String(item.id),
          approved_quantity:
            item.approvedQuantity === null ? null : String(item.approvedQuantity),
          prepared_quantity:
            item.preparedQuantity === null ? null : String(item.preparedQuantity),
          dispatched_quantity:
            item.dispatchedQuantity === null
              ? null
              : String(item.dispatchedQuantity),
        })),
      );
    }

    if (statement.startsWith("UPDATE order_items SET")) {
      const field = statement.match(
        /UPDATE order_items SET (approved_quantity|prepared_quantity|dispatched_quantity|received_quantity)=\$1/,
      )?.[1];
      if (!field) throw new Error(`Unsupported isolated item update: ${statement}`);
      const [quantity, itemId] = values as [number, number | string];
      const item = this.items.find((candidate) => candidate.id === Number(itemId));
      if (!item) throw new Error(`Isolated item ${itemId} was not found.`);
      if (field === "approved_quantity") item.approvedQuantity = quantity;
      if (field === "prepared_quantity") item.preparedQuantity = quantity;
      if (field === "dispatched_quantity") item.dispatchedQuantity = quantity;
      if (field === "received_quantity") item.receivedQuantity = quantity;
      return rows([]);
    }

    if (statement.startsWith("UPDATE orders SET status=$1")) {
      const [status, orderId, actorId] = values as [OrderStatus, number, string | null];
      const order = this.order(orderId);
      order.status = status;
      if (status === "CONFIRMED") order.confirmedBy = actorId;
      return rows([]);
    }

    throw new Error(`Unsupported isolated test query: ${statement}`);
  }
}

function setupFixture() {
  const fixture = new IsolatedOperationalFixture();
  getWeeklyReplenishment.mockResolvedValue({ items: fixture.reviewItems });
  withTransaction.mockImplementation(async (handler) =>
    handler(fixture.asClient()),
  );
  return fixture;
}

async function confirmDepotOrder(
  scope: Scope,
  actorId: string,
  planningDate = PLANNING_DATE,
  articleId = DEPOT_ARTICLE,
) {
  return confirmInternalReplenishment({
    scope,
    depotSourceId: "depot",
    planningDate,
    items: [{ article_id: articleId, requested_quantity: 90 }],
    actorId,
  });
}

async function runFulfillment(
  fixture: IsolatedOperationalFixture,
  receivedQuantity: number,
) {
  const created = await confirmDepotOrder(pv1Scope, PV1_ACTOR);
  const order = fixture.order(created.id);
  const [item] = fixture.itemsFor(order.id);
  await changeStatus(
    warehouseScope,
    order.id,
    "IN_PREPARATION",
    WAREHOUSE_ACTOR,
  );
  await updateOperationalQuantity(
    warehouseScope,
    order.id,
    item.id,
    "approved_quantity",
    90,
    WAREHOUSE_ACTOR,
  );
  await updateOperationalQuantity(
    warehouseScope,
    order.id,
    item.id,
    "prepared_quantity",
    90,
    WAREHOUSE_ACTOR,
  );
  await fulfillOrder(
    warehouseScope,
    order.id,
    "dispatched_quantity",
    [{ itemId: item.id, quantity: 90 }],
    WAREHOUSE_ACTOR,
  );
  await fulfillOrder(
    pv1Scope,
    order.id,
    "received_quantity",
    [{ itemId: item.id, quantity: receivedQuantity }],
    PV1_ACTOR,
  );
  return { order, item };
}

describe("isolated operational replenishment flow", () => {
  beforeEach(() => {
    getWeeklyReplenishment.mockReset();
    query.mockReset();
    withTransaction.mockReset();
  });

  it("completes the PV1 to depot to PV1 happy path with immutable snapshots and actors", async () => {
    const fixture = setupFixture();
    const selectable = depotArticleIds(
      fixture.reviewItems,
      fixture.modesFor(pv1Scope),
    );
    expect(selectable.map((item) => item.article_id)).toEqual([DEPOT_ARTICLE]);
    expect(selectable[0]).toMatchObject({
      supply_mode: "DEPOT",
      suggested_quantity: 90,
      requested_quantity: 90,
    });

    const { order, item } = await runFulfillment(fixture, 90);

    expect(order).toMatchObject({
      organizationId: 1,
      orderType: "INTERNAL_REPLENISHMENT",
      originBranchId: 2,
      destinationBranchId: 1,
      planningDate: PLANNING_DATE,
      status: "COMPLETED",
      createdBy: PV1_ACTOR,
      confirmedBy: PV1_ACTOR,
    });
    expect(item).toMatchObject({
      articleId: DEPOT_ARTICLE,
      suggestedQuantity: 90,
      requestedQuantity: 90,
      stockAtCreation: 10,
      stockTargetAtCreation: 100,
      dispatchedQuantity: 90,
      receivedQuantity: 90,
    });
    expect(fixture.eventsFor(order.id)).toEqual([
      expect.objectContaining({ eventType: "ORDER_CREATED", userId: PV1_ACTOR }),
      expect.objectContaining({ eventType: "ORDER_CONFIRMED", userId: PV1_ACTOR }),
      expect.objectContaining({ eventType: "ORDER_IN_PREPARATION", userId: WAREHOUSE_ACTOR }),
      expect.objectContaining({ eventType: "ITEM_APPROVED_QUANTITY_CHANGED", userId: WAREHOUSE_ACTOR }),
      expect.objectContaining({ eventType: "ITEM_PREPARED_QUANTITY_CHANGED", userId: WAREHOUSE_ACTOR }),
      expect.objectContaining({ eventType: "ITEM_DISPATCHED_QUANTITY_CHANGED", userId: WAREHOUSE_ACTOR }),
      expect.objectContaining({ eventType: "ORDER_DISPATCHED", userId: WAREHOUSE_ACTOR }),
      expect.objectContaining({ eventType: "ITEM_RECEIVED_QUANTITY_CHANGED", userId: PV1_ACTOR }),
      expect.objectContaining({ eventType: "ORDER_COMPLETED", userId: PV1_ACTOR }),
    ]);
  });

  it("records a completed partial receipt and the exact difference", async () => {
    const fixture = setupFixture();
    const { order, item } = await runFulfillment(fixture, 80);
    const events = fixture.eventsFor(order.id);

    expect(order.status).toBe("COMPLETED");
    expect(item.dispatchedQuantity).toBe(90);
    expect(item.receivedQuantity).toBe(80);
    if (item.dispatchedQuantity === null || item.receivedQuantity === null)
      throw new Error("The isolated partial receipt did not persist quantities.");
    expect(item.dispatchedQuantity - item.receivedQuantity).toBe(10);
    expect(events).toContainEqual(
      expect.objectContaining({
        eventType: "ITEM_RECEIVED_QUANTITY_CHANGED",
        metadata: expect.objectContaining({
          dispatched_quantity: 90,
          received_quantity: 80,
          difference: 10,
        }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        eventType: "ORDER_COMPLETED",
        metadata: {
          received_with_difference: true,
          total_difference: 10,
        },
      }),
    );
  });

  it("rejects invalid operational quantities without changing the isolated order", async () => {
    const fixture = setupFixture();
    const created = await confirmDepotOrder(pv1Scope, PV1_ACTOR);
    const order = fixture.order(created.id);
    const [item] = fixture.itemsFor(order.id);
    await changeStatus(
      warehouseScope,
      order.id,
      "IN_PREPARATION",
      WAREHOUSE_ACTOR,
    );

    await expect(
      updateOperationalQuantity(
        warehouseScope,
        order.id,
        item.id,
        "approved_quantity",
        91,
        WAREHOUSE_ACTOR,
      ),
    ).rejects.toThrow("approved_quantity must be between 0 and 90");
    await expect(
      updateOperationalQuantity(
        warehouseScope,
        order.id,
        item.id,
        "approved_quantity",
        -1,
        WAREHOUSE_ACTOR,
      ),
    ).rejects.toThrow("approved_quantity must be between 0 and 90");

    await updateOperationalQuantity(
      warehouseScope,
      order.id,
      item.id,
      "approved_quantity",
      90,
      WAREHOUSE_ACTOR,
    );
    await expect(
      updateOperationalQuantity(
        warehouseScope,
        order.id,
        item.id,
        "prepared_quantity",
        91,
        WAREHOUSE_ACTOR,
      ),
    ).rejects.toThrow("prepared_quantity must be between 0 and 90");
    await updateOperationalQuantity(
      warehouseScope,
      order.id,
      item.id,
      "prepared_quantity",
      90,
      WAREHOUSE_ACTOR,
    );
    await expect(
      fulfillOrder(
        warehouseScope,
        order.id,
        "dispatched_quantity",
        [{ itemId: item.id, quantity: 91 }],
        WAREHOUSE_ACTOR,
      ),
    ).rejects.toThrow("dispatched_quantity must be between 0 and 90");

    await fulfillOrder(
      warehouseScope,
      order.id,
      "dispatched_quantity",
      [{ itemId: item.id, quantity: 90 }],
      WAREHOUSE_ACTOR,
    );
    await expect(
      fulfillOrder(
        pv1Scope,
        order.id,
        "received_quantity",
        [{ itemId: item.id, quantity: 91 }],
        PV1_ACTOR,
      ),
    ).rejects.toThrow("received_quantity must be between 0 and 90");

    expect(order.status).toBe("DISPATCHED");
    expect(item.receivedQuantity).toBeNull();
  });

  it("creates an internal order only for the DEPOT rule and keeps rules scoped per PV", async () => {
    const fixture = setupFixture();

    await expect(
      confirmDepotOrder(pv1Scope, PV1_ACTOR, PLANNING_DATE, DIRECT_ARTICLE),
    ).rejects.toThrow("No hay artículos habilitados");
    await expect(
      confirmDepotOrder(pv1Scope, PV1_ACTOR, PLANNING_DATE, UNDEFINED_ARTICLE),
    ).rejects.toThrow("No hay artículos habilitados");
    await expect(
      confirmDepotOrder(pv2Scope, PV2_ACTOR, PLANNING_DATE, DEPOT_ARTICLE),
    ).rejects.toThrow("No hay artículos habilitados");
    expect(fixture.orders).toHaveLength(0);

    await expect(confirmDepotOrder(pv1Scope, PV1_ACTOR)).resolves.toMatchObject({
      created: true,
    });
    expect(fixture.itemsFor(fixture.orders[0].id)[0].articleId).toBe(
      DEPOT_ARTICLE,
    );
  });

  it("keeps duplicate confirmation idempotent and lets cancelled orders be recreated", async () => {
    const fixture = setupFixture();
    const first = await confirmDepotOrder(pv1Scope, PV1_ACTOR);
    const duplicate = await confirmDepotOrder(pv1Scope, PV1_ACTOR);

    expect(duplicate).toEqual({ id: first.id, created: false });
    expect(fixture.orders).toHaveLength(1);

    await changeStatus(pv1Scope, first.id, "CANCELLED", PV1_ACTOR);
    expect(fixture.order(first.id).status).toBe("CANCELLED");
    const recreated = await confirmDepotOrder(pv1Scope, PV1_ACTOR);
    expect(recreated).toMatchObject({ created: true });
    expect(recreated.id).not.toBe(first.id);
    expect(fixture.orders).toHaveLength(2);

    const draft = fixture.seedDraft(pv1Scope);
    await changeStatus(pv1Scope, draft.id, "CANCELLED", PV1_ACTOR);
    expect(draft.status).toBe("CANCELLED");
  });

  it("keeps PV1, PV2 and warehouse operational permissions isolated", () => {
    const pv1: AuthorizationContext = {
      userId: 101,
      organizationId: 1,
      userActive: true,
      memberships: [{ branchId: 2, role: "PV_OPERATOR", active: true }],
    };
    const pv2: AuthorizationContext = {
      userId: 102,
      organizationId: 1,
      userActive: true,
      memberships: [{ branchId: 3, role: "PV_OPERATOR", active: true }],
    };
    const warehouse: AuthorizationContext = {
      userId: 103,
      organizationId: 1,
      userActive: true,
      memberships: [{ branchId: 1, role: "WAREHOUSE_OPERATOR", active: true }],
    };
    const pv1Order = {
      organizationId: 1,
      originBranchId: 2,
      destinationBranchId: 1,
    };

    expect(canViewOrder(pv1, pv1Order)).toBe(true);
    expect(canModifyOrder(pv2, pv1Order)).toBe(false);
    expect(canPrepareOrder(pv1, pv1Order)).toBe(false);
    expect(canDispatchOrder(pv1, pv1Order)).toBe(false);
    expect(canPrepareOrder(warehouse, pv1Order)).toBe(true);
    expect(canDispatchOrder(warehouse, pv1Order)).toBe(true);
    expect(canReceiveOrder(warehouse, pv1Order)).toBe(false);
    expect(canReceiveOrder(pv1, pv1Order)).toBe(true);
  });
});
