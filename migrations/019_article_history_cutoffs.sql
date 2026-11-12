-- Migration 019: Article code reuse / history cutoff protection per branch
-- Preserves stock_movements_raw untouched while excluding pre-cutoff history from demand calculations.

CREATE TABLE IF NOT EXISTS branch_product_history_cutoffs (
  id bigserial PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  branch_id integer NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  article_id integer NOT NULL,
  cutoff_date date NOT NULL,
  previous_description text,
  reason text,
  detection_source text NOT NULL DEFAULT 'MANUAL' CHECK (detection_source IN ('MANUAL', 'ORDER_SNAPSHOT_DIFF', 'GAP_REVIEW')),
  created_by_user_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, branch_id, article_id)
);

CREATE INDEX IF NOT EXISTS branch_product_history_cutoffs_lookup_idx
  ON branch_product_history_cutoffs (organization_id, branch_id, article_id);

