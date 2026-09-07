INSERT INTO branch_product_supply_rules (organization_id, branch_id, article_id, supply_mode)
SELECT DISTINCT p.organization_id, p.branch_id, p.article_id, 'UNDEFINED'
FROM products_raw p
JOIN branches b ON b.organization_id = p.organization_id AND b.id = p.branch_id AND b.type = 'POS'
WHERE p.is_present
ON CONFLICT (organization_id, branch_id, article_id) DO NOTHING;
