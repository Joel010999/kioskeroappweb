-- Migration 014: Add package_units_snapshot to order_items for package equivalence persistence
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS package_units_snapshot numeric;
