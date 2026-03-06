-- Migration: link_whatsapp_sessions_to_sales_orders
-- Created at: 2026-02-23

ALTER TABLE whatsapp_sessions ADD COLUMN IF NOT EXISTS current_order_id UUID REFERENCES sales_orders(id) ON DELETE SET NULL;
