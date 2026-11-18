-- Rollback de 20261116_sales_attribution.sql.
-- Restaura create_sale(uuid, text, jsonb) tal como estaba (20260223_fifo_cost_layers.sql).
-- Las columnas sold_by / approved_by se CONSERVAN (son opcionales y no molestan): borrarlas perdería la
-- atribución de las ventas registradas mientras tanto. Si de verdad se quieren quitar, descomentar al final.

begin;

drop function if exists public.create_sale(uuid, text, jsonb, uuid, uuid);

create or replace function public.create_sale(
  p_customer_id uuid,
  p_payment_method text,
  p_items jsonb
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sale_id uuid;
  v_item jsonb;
  v_product_id uuid;
  v_qty_input numeric;
  v_price_input numeric;
  v_qty_base numeric;
  v_price_base numeric;
  v_unit_name text;
  v_base_unit text;
  v_factor numeric;
  v_old_stock numeric;
  v_old_avg numeric;
  v_min_stock numeric;
  v_product_name text;
  v_total numeric := 0;
  v_payment_method_code text;
  v_pricing jsonb;
  v_auto_price_uom numeric;
  v_final_price_uom numeric;
  v_manual_discount_pct numeric;
  v_manual_discount_amount numeric;
  v_manual_discount_reason text;
  v_role text;
  v_can_manual_discount boolean := false;
  v_sale_item_id uuid;
  v_fifo_remaining numeric;
  v_fifo_take numeric;
  v_fifo_cost_total numeric;
  v_sale_cost_unit numeric;
  v_layer record;
  v_layer_fallback_id uuid;
  v_alloc jsonb;
  v_alloc_item jsonb;
begin
  if auth.uid() is null then
    raise exception 'No autenticado';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'Items invalidos';
  end if;

  v_payment_method_code := coalesce(public.resolve_payment_method_code(p_payment_method), 'efectivo');
  v_role := coalesce(public.user_role(), 'cashier');
  v_can_manual_discount := v_role in ('owner', 'manager');

  insert into public.sales (customer_id, payment_method, created_by, total)
  values (p_customer_id, v_payment_method_code, auth.uid(), 0)
  returning id into v_sale_id;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_product_id := (v_item->>'product_id')::uuid;
    v_qty_input := coalesce(nullif(v_item->>'qty', '')::numeric, 0);
    v_price_input := nullif(v_item->>'price_unit', '')::numeric;
    v_manual_discount_pct := greatest(coalesce(nullif(v_item->>'manual_discount_pct', '')::numeric, 0), 0);
    v_manual_discount_amount := greatest(coalesce(nullif(v_item->>'manual_discount_amount', '')::numeric, 0), 0);
    v_manual_discount_reason := nullif(trim(coalesce(v_item->>'manual_discount_reason', '')), '');

    if v_qty_input <= 0 then
      raise exception 'Cantidad invalida';
    end if;

    if v_price_input is not null and v_price_input < 0 then
      raise exception 'Precio invalido';
    end if;

    select coalesce(nullif(trim(unit), ''), 'unidad')
      into v_base_unit
      from public.products
      where id = v_product_id;

    if v_base_unit is null then
      raise exception 'Producto no encontrado';
    end if;

    v_base_unit := public.require_uom_code(v_base_unit);
    if coalesce(trim(v_item->>'unit_name'), '') = '' then
      v_unit_name := v_base_unit;
    else
      v_unit_name := public.require_uom_code(v_item->>'unit_name');
    end if;

    v_pricing := public.resolve_sale_item_pricing(
      p_product_id := v_product_id,
      p_unit_name := v_unit_name,
      p_qty_uom := v_qty_input,
      p_customer_id := p_customer_id,
      p_sale_at := now()
    );

    v_factor := coalesce((v_pricing->>'factor')::numeric, 1);
    v_qty_base := coalesce((v_pricing->>'qty_base')::numeric, v_qty_input * v_factor);
    v_auto_price_uom := coalesce((v_pricing->>'price_uom')::numeric, 0);
    v_final_price_uom := v_auto_price_uom;

    if (
      v_manual_discount_pct > 0
      or v_manual_discount_amount > 0
      or (v_price_input is not null and abs(v_price_input - v_auto_price_uom) > 0.0001)
    ) then
      if not v_can_manual_discount then
        raise exception 'Tu rol no permite descuento o ajuste manual de precio';
      end if;
      if v_manual_discount_reason is null then
        raise exception 'Motivo obligatorio para descuento o ajuste manual';
      end if;
    end if;

    if v_manual_discount_pct > 0 then
      v_final_price_uom := v_final_price_uom * (1 - (v_manual_discount_pct / 100));
    end if;

    if v_manual_discount_amount > 0 then
      v_final_price_uom := v_final_price_uom - v_manual_discount_amount;
    end if;

    if v_price_input is not null and abs(v_price_input - v_auto_price_uom) > 0.0001 then
      v_final_price_uom := v_price_input;
    end if;

    v_final_price_uom := round(v_final_price_uom::numeric, 4);
    if v_final_price_uom < 0 then
      raise exception 'Precio final inválido para %', v_product_id;
    end if;

    v_price_base := case when v_factor = 0 then 0 else round((v_final_price_uom / v_factor)::numeric, 4) end;

    insert into public.inventory_balances (product_id, stock_on_hand, avg_cost, min_stock, updated_at)
    values (
      v_product_id,
      coalesce((select p.stock_on_hand from public.products p where p.id = v_product_id), 0),
      coalesce((select p.avg_cost from public.products p where p.id = v_product_id), 0),
      coalesce((select p.min_stock from public.products p where p.id = v_product_id), 0),
      now()
    )
    on conflict (product_id) do nothing;

    select ib.stock_on_hand, ib.avg_cost, ib.min_stock, p.name
      into v_old_stock, v_old_avg, v_min_stock, v_product_name
      from public.inventory_balances ib
      join public.products p on p.id = ib.product_id
      where ib.product_id = v_product_id
      for update;

    if v_old_stock < v_qty_base then
      raise exception 'Stock insuficiente para %', v_product_name;
    end if;

    v_fifo_remaining := v_qty_base;
    v_fifo_cost_total := 0;
    v_alloc := '[]'::jsonb;

    for v_layer in
      select
        scl.id,
        scl.qty_remaining,
        scl.cost_unit
      from public.stock_cost_layers scl
      where scl.product_id = v_product_id
        and scl.qty_remaining > 0
      order by scl.layer_date asc, scl.fifo_order asc
      for update
    loop
      exit when v_fifo_remaining <= 0;

      v_fifo_take := least(v_fifo_remaining, v_layer.qty_remaining);
      if v_fifo_take <= 0 then
        continue;
      end if;

      update public.stock_cost_layers
      set qty_remaining = qty_remaining - v_fifo_take,
          updated_at = now()
      where id = v_layer.id;

      v_fifo_cost_total := v_fifo_cost_total + (v_fifo_take * v_layer.cost_unit);
      v_fifo_remaining := v_fifo_remaining - v_fifo_take;

      v_alloc := v_alloc || jsonb_build_array(
        jsonb_build_object(
          'layer_id', v_layer.id,
          'qty', v_fifo_take,
          'cost_unit', v_layer.cost_unit
        )
      );
    end loop;

    if v_fifo_remaining > 0 then
      insert into public.stock_cost_layers (
        product_id,
        source,
        layer_date,
        qty_in,
        qty_remaining,
        cost_unit,
        note,
        created_by,
        updated_at
      )
      values (
        v_product_id,
        'auto-balance',
        now(),
        v_fifo_remaining,
        0,
        coalesce(v_old_avg, 0),
        'Capa automatica para cuadrar venta sin capas FIFO previas',
        auth.uid(),
        now()
      )
      returning id into v_layer_fallback_id;

      v_fifo_cost_total := v_fifo_cost_total + (v_fifo_remaining * coalesce(v_old_avg, 0));
      v_alloc := v_alloc || jsonb_build_array(
        jsonb_build_object(
          'layer_id', v_layer_fallback_id,
          'qty', v_fifo_remaining,
          'cost_unit', coalesce(v_old_avg, 0)
        )
      );
      v_fifo_remaining := 0;
    end if;

    v_sale_cost_unit := case
      when v_qty_base > 0 then round((v_fifo_cost_total / v_qty_base)::numeric, 4)
      else coalesce(v_old_avg, 0)
    end;

    update public.inventory_balances
      set stock_on_hand = v_old_stock - v_qty_base,
          updated_at = now()
      where product_id = v_product_id;

    update public.products
      set stock_on_hand = v_old_stock - v_qty_base,
          avg_cost = v_old_avg,
          min_stock = coalesce(v_min_stock, min_stock),
          updated_at = now()
      where id = v_product_id;

    insert into public.sale_items (
      sale_id,
      product_id,
      unit_name,
      qty_uom,
      factor_to_base,
      price_unit_uom,
      qty,
      price_unit,
      auto_price_unit,
      pricing_source,
      pricing_detail,
      manual_discount_pct,
      manual_discount_amount,
      manual_discount_reason,
      total
    )
    values (
      v_sale_id,
      v_product_id,
      v_unit_name,
      v_qty_input,
      v_factor,
      v_final_price_uom,
      v_qty_base,
      v_price_base,
      v_auto_price_uom,
      coalesce(v_pricing->>'source', 'base'),
      v_pricing,
      v_manual_discount_pct,
      v_manual_discount_amount,
      v_manual_discount_reason,
      v_qty_input * v_final_price_uom
    )
    returning id into v_sale_item_id;

    for v_alloc_item in
      select * from jsonb_array_elements(v_alloc)
    loop
      insert into public.sale_cost_allocations (
        sale_id,
        sale_item_id,
        product_id,
        layer_id,
        qty,
        cost_unit,
        total_cost,
        created_by
      )
      values (
        v_sale_id,
        v_sale_item_id,
        v_product_id,
        (v_alloc_item->>'layer_id')::uuid,
        coalesce((v_alloc_item->>'qty')::numeric, 0),
        coalesce((v_alloc_item->>'cost_unit')::numeric, 0),
        coalesce((v_alloc_item->>'qty')::numeric, 0) * coalesce((v_alloc_item->>'cost_unit')::numeric, 0),
        auth.uid()
      );
    end loop;

    insert into public.stock_movements (product_id, movement_type, qty, cost_unit, ref_table, ref_id, created_by)
    values (v_product_id, 'sale', -v_qty_base, v_sale_cost_unit, 'sales', v_sale_id, auth.uid());

    v_total := v_total + (v_qty_input * v_final_price_uom);
  end loop;

  update public.sales
    set total = v_total
    where id = v_sale_id;

  return v_sale_id;
end;
$$;

grant execute on function public.create_sale(uuid, text, jsonb) to authenticated;

-- alter table public.sales drop column if exists approved_by;
-- alter table public.sales drop column if exists sold_by;

commit;
