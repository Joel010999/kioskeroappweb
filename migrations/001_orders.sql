CREATE TABLE IF NOT EXISTS renderbyte_schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS orders (
  id bigserial PRIMARY KEY,
  organization_id integer,
  source_id text NOT NULL,
  branch_id integer NOT NULL,
  status text NOT NULL CHECK (status IN ('DRAFT', 'CONFIRMED', 'IN_PREPARATION', 'DISPATCHED', 'COMPLETED', 'CANCELLED')),
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  confirmed_by text,
  confirmed_at timestamptz,
  completed_at timestamptz,
  notes text NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS orders_scope_status_created_idx ON orders (source_id, branch_id, organization_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS order_items (
  id bigserial PRIMARY KEY,
  order_id bigint NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  article_id integer NOT NULL,
  product_name_snapshot text NOT NULL,
  suggested_quantity numeric,
  requested_quantity numeric NOT NULL CHECK (requested_quantity >= 0),
  stock_at_creation numeric NOT NULL,
  stock_target_at_creation numeric,
  confidence_at_creation text NOT NULL CHECK (confidence_at_creation IN ('ALTA', 'MEDIA', 'BAJA', 'INSUFICIENTE')),
  status_at_creation text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, article_id)
);

CREATE INDEX IF NOT EXISTS order_items_order_id_idx ON order_items (order_id);

CREATE TABLE IF NOT EXISTS order_events (
  id bigserial PRIMARY KEY,
  order_id bigint NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN ('ORDER_CREATED', 'ITEM_ADDED', 'ITEM_REMOVED', 'ITEM_QUANTITY_CHANGED', 'ORDER_CONFIRMED', 'ORDER_CANCELLED', 'ORDER_IN_PREPARATION', 'ORDER_DISPATCHED', 'ORDER_COMPLETED')),
  user_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS order_events_order_id_created_idx ON order_events (order_id, created_at);
