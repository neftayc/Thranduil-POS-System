create or replace function public.purchase_items_sync_base_fields()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_base_unit text;
  v_unit_name text;
  v_factor numeric;
  v_qty_uom numeric;
  v_cost_uom numeric;
begin
  if new.product_id is null then
    raise exception 'Producto no encontrado';
  end if;

  select coalesce(nullif(trim(unit), ''), 'unidad')
    into v_base_unit
    from public.products
    where id = new.product_id
    limit 1;

  if v_base_unit is null then
    raise exception 'Producto no encontrado';
  end if;

  v_base_unit := public.require_uom_code(v_base_unit);
  if coalesce(trim(new.unit_name), '') = '' then
    v_unit_name := v_base_unit;
  else
    v_unit_name := public.require_uom_code(new.unit_name);
  end if;

  if v_unit_name = v_base_unit then
    v_factor := 1;
  else
    select puc.factor_to_base
      into v_factor
      from public.product_unit_conversions puc
      where puc.product_id = new.product_id
        and lower(puc.unit_name) = v_unit_name
        and puc.is_active = true
      limit 1;

    if coalesce(v_factor, 0) <= 0 then
      v_factor := nullif(new.factor_to_base, 0);
    end if;
    if coalesce(v_factor, 0) <= 0 then
      raise exception 'Unidad "%" no configurada para este producto', v_unit_name;
    end if;
  end if;

  v_qty_uom := greatest(coalesce(new.qty_uom, 0), 0);
  if v_qty_uom = 0 then
    if coalesce(new.qty, 0) > 0 and v_factor > 0 then
      v_qty_uom := new.qty / v_factor;
    else
      raise exception 'Cantidad invalida';
    end if;
  end if;

  v_cost_uom := coalesce(new.cost_unit_uom, 0);
  if v_cost_uom < 0 then
    raise exception 'Costo invalido';
  end if;
  if v_cost_uom = 0 and coalesce(new.cost_unit, 0) > 0 then
    v_cost_uom := new.cost_unit * v_factor;
  end if;

  new.unit_name := v_unit_name;
  new.factor_to_base := round(v_factor::numeric, 6);
  new.qty_uom := round(v_qty_uom::numeric, 3);
  new.cost_unit_uom := round(v_cost_uom::numeric, 4);

  new.qty := round((v_qty_uom * v_factor)::numeric, 3);
  if new.qty <= 0 then
    raise exception 'Cantidad base invalida';
  end if;
  new.cost_unit := round((v_cost_uom / v_factor)::numeric, 4);
  new.total_cost := round((v_qty_uom * v_cost_uom)::numeric, 2);

  return new;
end;
$$;

drop trigger if exists trg_purchase_items_sync_base_fields on public.purchase_items;
-- Trigger desactivado: compras se preservan tal como se registran.
