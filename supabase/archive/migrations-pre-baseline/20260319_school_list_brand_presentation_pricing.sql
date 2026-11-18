alter table public.school_list_item_brands
  add column if not exists pricing_rule_id uuid,
  add column if not exists pricing_unit_name text,
  add column if not exists pricing_label text,
  add column if not exists pricing_price_uom numeric(12,4),
  add column if not exists pricing_factor_to_base numeric(12,6);
