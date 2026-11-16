-- Migration: whatsapp_sessions
-- Created at: 2026-02-22

CREATE TABLE IF NOT EXISTS whatsapp_sessions (
    phone_number TEXT PRIMARY KEY,
    state TEXT NOT NULL DEFAULT 'WAITING_LIST',
    draft_cart JSONB DEFAULT '{}'::jsonb,
    last_interaction TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Function to automatically update last_interaction
CREATE OR REPLACE FUNCTION update_whatsapp_last_interaction()
RETURNS trigger AS $$
BEGIN
    NEW.last_interaction = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to execute the function on update
DROP TRIGGER IF EXISTS trg_update_whatsapp_last_interaction ON whatsapp_sessions;
CREATE TRIGGER trg_update_whatsapp_last_interaction
    BEFORE UPDATE ON whatsapp_sessions
    FOR EACH ROW
    EXECUTE FUNCTION update_whatsapp_last_interaction();

-- Add RLS policies (optional but good practice for Supabase)
ALTER TABLE whatsapp_sessions ENABLE ROW LEVEL SECURITY;

-- Allow service role full access
CREATE POLICY "Service role can do all on whatsapp_sessions" 
ON whatsapp_sessions
FOR ALL 
TO service_role
USING (true)
WITH CHECK (true);
