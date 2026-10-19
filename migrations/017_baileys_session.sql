-- Migration 017: Baileys authenticated session persistence
-- Stores encrypted credentials and Signal keys in PostgreSQL

CREATE TABLE IF NOT EXISTS whatsapp_baileys_session (
  session_id text NOT NULL DEFAULT 'default',
  key_id text NOT NULL,
  ciphertext text NOT NULL,
  iv text NOT NULL,
  tag text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, key_id)
);

CREATE INDEX IF NOT EXISTS whatsapp_baileys_session_lookup_idx
  ON whatsapp_baileys_session (session_id, key_id);
