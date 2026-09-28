CREATE TABLE IF NOT EXISTS stock_snapshots (
  id bigserial PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations(id),
  uploaded_by text NOT NULL,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  original_filename text NOT NULL,
  status text NOT NULL DEFAULT 'PROCESSED' CHECK (status IN ('PROCESSING', 'PROCESSED', 'FAILED')),
  total_items integer NOT NULL DEFAULT 0,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS stock_snapshot_items (
  id bigserial PRIMARY KEY,
  snapshot_id bigint NOT NULL REFERENCES stock_snapshots(id) ON DELETE CASCADE,
  article_id integer,
  article_code text,
  description text,
  stock_quantity numeric NOT NULL,
  category text
);

CREATE INDEX IF NOT EXISTS stock_snapshot_items_snapshot_idx ON stock_snapshot_items (snapshot_id);
CREATE INDEX IF NOT EXISTS stock_snapshot_items_article_idx ON stock_snapshot_items (article_id);

CREATE TABLE IF NOT EXISTS order_workspaces (
  id bigserial PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations(id),
  branch_id integer NOT NULL,
  stock_snapshot_id bigint REFERENCES stock_snapshots(id),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'READY_TO_DOWNLOAD', 'DOWNLOADED', 'FINALIZED')),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  downloaded_at timestamptz,
  finalized_at timestamptz,
  notes text NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS order_workspaces_branch_idx ON order_workspaces (branch_id, status);

CREATE TABLE IF NOT EXISTS order_workspace_items (
  id bigserial PRIMARY KEY,
  workspace_id bigint NOT NULL REFERENCES order_workspaces(id) ON DELETE CASCADE,
  article_id integer NOT NULL,
  stock_deposito_snapshot numeric,
  stock_real_at_creation numeric,
  requested_quantity numeric NOT NULL CHECK (requested_quantity >= 0),
  category text,
  UNIQUE(workspace_id, article_id)
);

CREATE INDEX IF NOT EXISTS order_workspace_items_workspace_idx ON order_workspace_items (workspace_id);
