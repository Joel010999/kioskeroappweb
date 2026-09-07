CREATE TABLE IF NOT EXISTS suppliers (
  id bigserial PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations(id),
  external_code text NOT NULL,
  name text,
  tax_id text,
  contact_name text,
  phone text,
  email text,
  address text,
  notes text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, external_code)
);

CREATE TABLE IF NOT EXISTS product_suppliers (
  id bigserial PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations(id),
  article_id integer NOT NULL,
  supplier_id bigint NOT NULL REFERENCES suppliers(id),
  supplier_article_code text,
  purchase_enabled boolean NOT NULL DEFAULT false,
  supply_mode text NOT NULL DEFAULT 'UNDEFINED' CHECK (supply_mode IN ('UNDEFINED', 'DEPOT', 'DIRECT_TO_POS')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, article_id)
);

CREATE INDEX IF NOT EXISTS product_suppliers_supplier_idx ON product_suppliers (supplier_id);

INSERT INTO suppliers (organization_id, external_code, name, active)
SELECT DISTINCT p.organization_id, btrim(p.payload->>'Proveedor'), NULL, true
FROM products_raw p
WHERE p.is_present
  AND NULLIF(btrim(p.payload->>'Proveedor'), '') IS NOT NULL
ON CONFLICT (organization_id, external_code) DO NOTHING;

WITH source_products AS (
  SELECT DISTINCT ON (p.organization_id, p.article_id)
    p.organization_id,
    p.article_id,
    btrim(p.payload->>'Proveedor') AS supplier_code,
    NULLIF(btrim(p.payload->>'ArticuloProveedor'), '') AS supplier_article_code,
    CASE WHEN lower(COALESCE(p.payload->>'HabilitadoCompra', 'false')) IN ('true', 't', '1', 'yes') THEN true ELSE false END AS purchase_enabled
  FROM products_raw p
  WHERE p.is_present
    AND NULLIF(btrim(p.payload->>'Proveedor'), '') IS NOT NULL
  ORDER BY p.organization_id, p.article_id, p.branch_id
)
INSERT INTO product_suppliers (organization_id, article_id, supplier_id, supplier_article_code, purchase_enabled, supply_mode)
SELECT sp.organization_id, sp.article_id, s.id, sp.supplier_article_code, sp.purchase_enabled, 'UNDEFINED'
FROM source_products sp
JOIN suppliers s ON s.organization_id = sp.organization_id AND s.external_code = sp.supplier_code
ON CONFLICT (organization_id, article_id) DO UPDATE
SET supplier_id = EXCLUDED.supplier_id,
    supplier_article_code = EXCLUDED.supplier_article_code,
    purchase_enabled = EXCLUDED.purchase_enabled,
    updated_at = now();
