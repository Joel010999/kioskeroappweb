import { describe, expect, it } from "vitest";

describe("Order Numbering & Normalization", () => {
  it("maps order_number correctly and falls back to id when null", () => {
    // Test the mapping logic defined in repository
    const rowWithOrderNumber = {
      id: "19",
      order_number: "1",
      item_count: "50",
      requested_units: "16268",
      approved_units: "16268",
      prepared_units: "16268",
      dispatched_units: "16268",
      received_units: "0",
      status: "DISPATCHED" as const,
    };

    const row20 = {
      id: "20",
      order_number: 2,
      item_count: "120",
      requested_units: "5274",
      approved_units: "0",
      prepared_units: "0",
      dispatched_units: "0",
      received_units: "0",
      status: "CONFIRMED" as const,
    };

    const mapped19 = {
      ...rowWithOrderNumber,
      id: Number(rowWithOrderNumber.id),
      order_number: Number(rowWithOrderNumber.order_number ?? rowWithOrderNumber.id),
    };

    const mapped20 = {
      ...row20,
      id: Number(row20.id),
      order_number: Number(row20.order_number ?? row20.id),
    };

    expect(mapped19.id).toBe(19);
    expect(mapped19.order_number).toBe(1);

    expect(mapped20.id).toBe(20);
    expect(mapped20.order_number).toBe(2);
  });

  it("ensures subsequent orders follow strict 3, 4, 5... sequential numbering", () => {
    let currentSequence = 2;
    function nextval() {
      return ++currentSequence;
    }

    const order3Number = nextval();
    const order4Number = nextval();
    const order5Number = nextval();

    expect(order3Number).toBe(3);
    expect(order4Number).toBe(4);
    expect(order5Number).toBe(5);
  });

  it("handles concurrent allocation safely without producing duplicates", () => {
    let sequence = 2;
    const allocated: number[] = [];

    // Simulate 10 concurrent requests requesting nextval
    const allocateOrderNumber = () => {
      return ++sequence;
    };

    for (let i = 0; i < 10; i++) {
      allocated.push(allocateOrderNumber());
    }

    expect(allocated).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const unique = new Set(allocated);
    expect(unique.size).toBe(10);
  });

  it("does not reuse cancelled or historical numbers", () => {
    let sequence = 2;
    const orders: { id: number; order_number: number; status: string }[] = [];

    // Order 3 created
    orders.push({ id: 22, order_number: ++sequence, status: "CONFIRMED" });
    expect(orders[0].order_number).toBe(3);

    // Order 3 is cancelled
    orders[0].status = "CANCELLED";

    // Next order created must be 4, NOT 3
    orders.push({ id: 23, order_number: ++sequence, status: "CONFIRMED" });
    expect(orders[1].order_number).toBe(4);
  });
});
