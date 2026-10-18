-- Migration 015: Clean test order #3 (id 22) and reset sequence so next order is #3

DO $$
BEGIN
  -- 1. Safely remove test order (id 22 / order_number 3)
  IF EXISTS (SELECT 1 FROM orders WHERE id = 22 OR order_number = 3) THEN
    DELETE FROM orders WHERE id = 22 OR order_number = 3;
  END IF;

  -- 2. Reset order_number_seq to max existing order_number (minimum 2), so next nextval is 3
  PERFORM setval('order_number_seq', GREATEST(COALESCE((SELECT MAX(order_number) FROM orders), 0), 2), true);
END $$;
