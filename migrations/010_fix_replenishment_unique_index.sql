DROP INDEX IF EXISTS orders_internal_replenishment_period_unique;
CREATE UNIQUE INDEX orders_internal_replenishment_period_unique 
ON orders (COALESCE(organization_id, -1), origin_branch_id, destination_branch_id, planning_date) 
WHERE order_type='INTERNAL_REPLENISHMENT' AND status <> 'CANCELLED' AND status <> 'COMPLETED';
