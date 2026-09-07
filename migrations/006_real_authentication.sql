ALTER TABLE users ADD COLUMN IF NOT EXISTS organization_id integer REFERENCES organizations(id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash text;

CREATE INDEX IF NOT EXISTS users_organization_active_email_idx ON users (organization_id, active, email);
