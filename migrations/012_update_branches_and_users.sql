UPDATE branches SET name = 'CENTRO' WHERE id = 2 AND organization_id = 1;
UPDATE branches SET name = 'JARDÍN' WHERE id = 3 AND organization_id = 1;
UPDATE branches SET name = 'DEPÓSITO' WHERE id = 1 AND organization_id = 1;

UPDATE users SET email = 'centro@gmail.com' WHERE email = 'pv1@development.local';
UPDATE users SET email = 'jardin@gmail.com' WHERE email = 'pv2@development.local';
UPDATE users SET email = 'deposito@gmail.com' WHERE email = 'deposito@development.local';
