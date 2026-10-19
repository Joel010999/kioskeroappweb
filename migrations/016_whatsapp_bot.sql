-- Migration 016: WhatsApp Bot deduplication and authorized numbers persistence
-- Created for La Casa del Kioskero - WhatsApp Bot integration

CREATE TABLE IF NOT EXISTS whatsapp_processed_messages (
  id bigserial PRIMARY KEY,
  message_id text NOT NULL UNIQUE,
  sender_phone text NOT NULL,
  status text NOT NULL DEFAULT 'PROCESSING' CHECK (status IN ('PROCESSING', 'PROCESSED', 'FAILED')),
  intent text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);

CREATE INDEX IF NOT EXISTS whatsapp_processed_messages_sender_idx
  ON whatsapp_processed_messages (sender_phone, created_at DESC);

CREATE TABLE IF NOT EXISTS whatsapp_authorized_numbers (
  id bigserial PRIMARY KEY,
  phone text NOT NULL UNIQUE,
  name text NOT NULL,
  role text NOT NULL DEFAULT 'SUPERVISOR' CHECK (role IN ('SUPERVISOR', 'PV_OPERATOR', 'WAREHOUSE_OPERATOR')),
  branch_id integer,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS whatsapp_authorized_numbers_active_idx
  ON whatsapp_authorized_numbers (phone, active);
