-- Staging-only idempotent bootstrap DDL for external Alegon / source tables.
-- NEVER run against production. Enforces staging marker check before any data insertion.

CREATE TABLE IF NOT EXISTS organizations (
  id integer PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sources (
  id bigserial PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  branch_id integer NOT NULL,
  source_id text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, branch_id, source_id)
);

CREATE INDEX IF NOT EXISTS sources_lookup_idx
  ON sources (organization_id, branch_id, is_active);

CREATE TABLE IF NOT EXISTS products_raw (
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  source_id text NOT NULL,
  branch_id integer NOT NULL,
  article_id integer NOT NULL,
  is_present boolean NOT NULL DEFAULT true,
  source_seen_at timestamptz NOT NULL DEFAULT now(),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (organization_id, source_id, branch_id, article_id)
);

CREATE INDEX IF NOT EXISTS products_raw_scope_present_idx
  ON products_raw (organization_id, source_id, branch_id, is_present, article_id);

CREATE INDEX IF NOT EXISTS products_raw_article_idx
  ON products_raw (organization_id, article_id, branch_id);

CREATE TABLE IF NOT EXISTS stock_levels_raw (
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  source_id text NOT NULL,
  branch_id integer NOT NULL,
  article_id integer NOT NULL,
  depo integer NOT NULL DEFAULT 1,
  bulto text NOT NULL DEFAULT '1',
  saldo numeric(12, 3) NOT NULL DEFAULT 0,
  piezas numeric(12, 3) NOT NULL DEFAULT 0,
  source_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, source_id, branch_id, article_id, depo)
);

CREATE INDEX IF NOT EXISTS stock_levels_raw_scope_idx
  ON stock_levels_raw (organization_id, source_id, branch_id, article_id);

CREATE TABLE IF NOT EXISTS stock_movements_raw (
  id bigserial PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  source_id text NOT NULL,
  branch_id integer NOT NULL,
  idarti text NOT NULL,
  fedepo text NOT NULL,
  tipomov text NOT NULL,
  cantidad numeric(12, 3) NOT NULL DEFAULT 0,
  codcom text,
  numero text,
  received_at timestamptz NOT NULL DEFAULT now(),
  external_key text UNIQUE
);

CREATE INDEX IF NOT EXISTS stock_movements_raw_scope_date_idx
  ON stock_movements_raw (organization_id, source_id, branch_id, tipomov, codcom, fedepo);

-- Hard safety check: refuse to initialize if this database contains non-staging records.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM organizations
    WHERE id = 1 AND name <> 'La Casa del Kioskero [STAGING SYNTHETIC]'
  ) THEN
    RAISE EXCEPTION 'ABORT: target database has non-staging organization id=1. Refusing staging bootstrap.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM sources WHERE source_id NOT LIKE 'staging_%'
  ) THEN
    RAISE EXCEPTION 'ABORT: target database contains non-staging sources. Refusing staging bootstrap.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM products_raw WHERE source_id NOT LIKE 'staging_%'
  ) THEN
    RAISE EXCEPTION 'ABORT: target database contains non-staging products_raw rows. Refusing staging bootstrap.';
  END IF;
END $$;

INSERT INTO organizations (id, name)
VALUES (1, 'La Casa del Kioskero [STAGING SYNTHETIC]')
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name,
    updated_at = now();

INSERT INTO sources (organization_id, branch_id, source_id, is_active, last_seen_at)
VALUES
  (1, 1, 'staging_deposito', true, now()),
  (1, 2, 'staging_centro', true, now()),
  (1, 3, 'staging_jardin', true, now())
ON CONFLICT (organization_id, branch_id, source_id) DO UPDATE
SET is_active = true,
    last_seen_at = now(),
    updated_at = now();

