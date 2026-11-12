-- Migration 018: Configurable per-branch base stock ("Stock base") per product
-- Absence of row = unconfigured (NULL). Row with base_stock = 0 = explicitly configured as 0.
-- NOTE: Does NOT modify Alegon synced tables (products_raw / stock_levels_raw / stock_movements_raw).

CREATE TABLE IF NOT EXISTS branch_product_base_stock (
  id bigserial PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  branch_id integer NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  article_id integer NOT NULL,
  base_stock numeric(12, 3) NOT NULL CHECK (base_stock >= 0),
  notes text,
  updated_by_user_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, branch_id, article_id)
);

CREATE INDEX IF NOT EXISTS branch_product_base_stock_branch_idx
  ON branch_product_base_stock (organization_id, branch_id, article_id);

CREATE INDEX IF NOT EXISTS branch_product_base_stock_article_idx
  ON branch_product_base_stock (organization_id, article_id);

