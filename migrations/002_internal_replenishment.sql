ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_type text NOT NULL DEFAULT 'GENERIC';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS origin_branch_id integer;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS destination_branch_id integer;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS planning_date date;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS idempotency_key text;
ALTER TABLE orders ADD CONSTRAINT orders_order_type_check CHECK (order_type IN ('GENERIC','INTERNAL_REPLENISHMENT','INTER_BRANCH_TRANSFER','SUPPLIER_PURCHASE'));
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_status_check CHECK (status IN ('DRAFT','CONFIRMED','RECEIVED_BY_WAREHOUSE','IN_PREPARATION','PARTIALLY_PREPARED','PREPARED','DISPATCHED','PARTIALLY_RECEIVED','COMPLETED','CANCELLED'));

ALTER TABLE order_items ADD COLUMN IF NOT EXISTS weekly_demand_at_creation numeric;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS planning_date_at_creation date;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS supplier_code_snapshot text;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS classification_code_snapshot text;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS unit_measure_snapshot text;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS approved_quantity numeric CHECK (approved_quantity IS NULL OR approved_quantity >= 0);
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS prepared_quantity numeric CHECK (prepared_quantity IS NULL OR prepared_quantity >= 0);
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS dispatched_quantity numeric CHECK (dispatched_quantity IS NULL OR dispatched_quantity >= 0);
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS received_quantity numeric CHECK (received_quantity IS NULL OR received_quantity >= 0);

ALTER TABLE order_events DROP CONSTRAINT IF EXISTS order_events_event_type_check;
ALTER TABLE order_events ADD CONSTRAINT order_events_event_type_check CHECK (event_type IN ('ORDER_CREATED','ITEM_ADDED','ITEM_REMOVED','ITEM_QUANTITY_CHANGED','ORDER_CONFIRMED','ORDER_CANCELLED','ORDER_IN_PREPARATION','ORDER_DISPATCHED','ORDER_COMPLETED','ORDER_RECEIVED_BY_WAREHOUSE','PREPARATION_STARTED','ITEM_APPROVED_QUANTITY_CHANGED','ITEM_PREPARED_QUANTITY_CHANGED','ORDER_PARTIALLY_PREPARED','ORDER_PREPARED','ITEM_DISPATCHED_QUANTITY_CHANGED','ITEM_RECEIVED_QUANTITY_CHANGED','ORDER_PARTIALLY_RECEIVED'));

CREATE UNIQUE INDEX IF NOT EXISTS orders_idempotency_key_unique ON orders (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS orders_internal_replenishment_period_unique ON orders (COALESCE(organization_id, -1), origin_branch_id, destination_branch_id, planning_date) WHERE order_type='INTERNAL_REPLENISHMENT' AND status <> 'CANCELLED';
CREATE INDEX IF NOT EXISTS orders_replenishment_destination_idx ON orders (destination_branch_id,status,planning_date DESC) WHERE order_type='INTERNAL_REPLENISHMENT';
