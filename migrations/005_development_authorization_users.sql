INSERT INTO users (name, email, active)
VALUES
  ('Development PV1', 'pv1@development.local', true),
  ('Development PV2', 'pv2@development.local', true),
  ('Development Warehouse', 'deposito@development.local', true)
ON CONFLICT (email) DO NOTHING;

INSERT INTO memberships (user_id, organization_id, branch_id, role, active)
SELECT users.id, assignments.organization_id, assignments.branch_id, assignments.role, true
FROM (
  VALUES
    ('pv1@development.local', 1, 2, 'PV_OPERATOR'),
    ('pv2@development.local', 1, 3, 'PV_OPERATOR'),
    ('deposito@development.local', 1, 1, 'WAREHOUSE_OPERATOR')
) AS assignments(email, organization_id, branch_id, role)
JOIN users ON users.email = assignments.email
ON CONFLICT (user_id, organization_id, branch_id, role) DO NOTHING;
