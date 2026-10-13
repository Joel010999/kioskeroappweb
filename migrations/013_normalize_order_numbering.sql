-- Migration 013: Normalize visible order numbering and clean up test order #21
-- Creates sequence and order_number column for sequential, unique, atomic order numbering.

CREATE SEQUENCE IF NOT EXISTS order_number_seq;

ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_number bigint;

DO $$
BEGIN
  -- 1. Safely remove test order #21 (created during manual tests, no real stock/dispatch movements)
  IF EXISTS (SELECT 1 FROM orders WHERE id = 21) THEN
    DELETE FROM orders WHERE id = 21;
  END IF;

  -- 2. Backfill preserved historical orders with sequential visible numbers 1 and 2
  IF EXISTS (SELECT 1 FROM orders WHERE id = 19) THEN
    UPDATE orders SET order_number = 1 WHERE id = 19;
  END IF;

  IF EXISTS (SELECT 1 FROM orders WHERE id = 20) THEN
    UPDATE orders SET order_number = 2 WHERE id = 20;
  END IF;

  -- 3. In case any other orders exist without order_number (e.g. in other environments)
  WITH unassigned AS (
    SELECT id, ROW_NUMBER() OVER (ORDER BY created_at ASC, id ASC) as seq_offset
    FROM orders
    WHERE order_number IS NULL
  )
  UPDATE orders o
  SET order_number = (SELECT COALESCE(MAX(order_number), 0) FROM orders WHERE order_number IS NOT NULL) + unassigned.seq_offset
  FROM unassigned
  WHERE o.id = unassigned.id;

  -- 4. Advance sequence to match the highest assigned order_number, minimum 2 so next is 3
  PERFORM setval('order_number_seq', GREATEST(COALESCE((SELECT MAX(order_number) FROM orders), 0), 2), true);
END $$;

ALTER TABLE orders ALTER COLUMN order_number SET DEFAULT nextval('order_number_seq');

CREATE UNIQUE INDEX IF NOT EXISTS orders_order_number_unique ON orders (order_number);

-- Now that all existing rows are assigned and default is set, enforce NOT NULL
ALTER TABLE orders ALTER COLUMN order_number SET NOT NULL;
