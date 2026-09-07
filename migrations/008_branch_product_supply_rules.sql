CREATE TABLE IF NOT EXISTS branch_product_supply_rules (
  id bigserial PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations(id),
  branch_id integer NOT NULL,
  article_id integer NOT NULL,
  supply_mode text NOT NULL DEFAULT 'UNDEFINED' CHECK (supply_mode IN ('UNDEFINED', 'DEPOT', 'DIRECT_SUPPLIER')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, branch_id, article_id),
  FOREIGN KEY (branch_id, organization_id) REFERENCES branches(id, organization_id)
);

CREATE INDEX IF NOT EXISTS branch_product_supply_rules_branch_article_idx
  ON branch_product_supply_rules (organization_id, branch_id, article_id);
