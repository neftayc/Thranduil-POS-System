-- Migration: add_preferences_to_whatsapp_sessions
-- Created at: 2026-02-23

ALTER TABLE whatsapp_sessions ADD COLUMN IF NOT EXISTS preferences JSONB DEFAULT '{}'::jsonb;
