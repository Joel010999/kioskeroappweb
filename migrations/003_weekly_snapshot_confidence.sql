ALTER TABLE order_items DROP CONSTRAINT IF EXISTS order_items_confidence_at_creation_check;
ALTER TABLE order_items ADD CONSTRAINT order_items_confidence_at_creation_check CHECK (confidence_at_creation IN ('ALTA','MEDIA','BAJA','INSUFICIENTE','SEMANAL'));
