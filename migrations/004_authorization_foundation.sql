CREATE TABLE IF NOT EXISTS branches (
  id integer PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations(id),
  name text NOT NULL,
  type text NOT NULL CHECK (type IN ('WAREHOUSE', 'POS')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, organization_id)
);

CREATE TABLE IF NOT EXISTS users (
  id bigserial PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memberships (
  id bigserial PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id),
  organization_id integer NOT NULL REFERENCES organizations(id),
  branch_id integer NOT NULL,
  role text NOT NULL CHECK (role IN ('PV_OPERATOR', 'WAREHOUSE_OPERATOR')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT memberships_branch_organization_fk FOREIGN KEY (branch_id, organization_id) REFERENCES branches(id, organization_id),
  CONSTRAINT memberships_user_branch_role_unique UNIQUE (user_id, organization_id, branch_id, role)
);

CREATE INDEX IF NOT EXISTS branches_organization_active_idx ON branches (organization_id, active);
CREATE INDEX IF NOT EXISTS memberships_user_active_idx ON memberships (user_id, active);
CREATE INDEX IF NOT EXISTS memberships_organization_branch_active_idx ON memberships (organization_id, branch_id, active);

INSERT INTO branches (id, organization_id, name, type, active)
VALUES
  (1, 1, 'DEPOSITO', 'WAREHOUSE', true),
  (2, 1, 'PV1', 'POS', true),
  (3, 1, 'PV2', 'POS', true)
ON CONFLICT (id) DO NOTHING;
