-- Patch: pedidos y cobros (flujo POS en dos pasos)
-- 1) Registrar pedido (sin mover stock)
-- 2) Cobrar pedido (genera venta final y descuenta stock)

create table if not exists public.sales_orders (
  id uuid primary key default gen_random_uuid(),
  order_code text not null unique,
  status text not null default 'open' check (status in ('open', 'paid', 'cancelled')),
  customer_id uuid references public.customers on delete set null,
  payment_method text,
  notes text,
  total numeric(12,2) not null default 0,
  paid_sale_id uuid references public.sales on delete set null,
  paid_at timestamptz,
  created_by uuid references auth.users on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.sales_order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.sales_orders on delete cascade,
  product_id uuid not null references public.products on delete restrict,
  unit_name text not null,
  qty_uom numeric(12,3) not null check (qty_uom > 0),
  factor_to_base numeric(12,6) not null check (factor_to_base > 0),
  auto_price_unit numeric(12,4) not null default 0,
  price_unit_uom numeric(12,4) not null check (price_unit_uom >= 0),
  pricing_source text,
  pricing_detail jsonb not null default '{}'::jsonb,
  total numeric(12,2) not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists idx_sales_orders_status_created
  on public.sales_orders (status, created_at desc);
create index if not exists idx_sales_orders_order_code
  on public.sales_orders (order_code);
create index if not exists idx_sales_order_items_order
  on public.sales_order_items (order_id);
create index if not exists idx_sales_order_items_product
  on public.sales_order_items (product_id);

create or replace function public.generate_sales_order_code()
returns text
language sql
volatile
as $$
  select
    'PED-'
    || to_char(now(), 'YYYYMMDD-HH24MISS')
    || '-'
    || upper(substr(encode(gen_random_bytes(2), 'hex'), 1, 4));
$$;

create or replace function public.create_sales_order(
  p_customer_id uuid,
  p_payment_method text,
  p_items jsonb,
  p_notes text default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order_id uuid;
  v_item jsonb;
  v_product_id uuid;
  v_qty_input numeric;
  v_price_input numeric;
  v_unit_name text;
  v_base_unit text;
  v_factor numeric;
  v_line_total numeric;
  v_total numeric := 0;
  v_payment_method_code text;
  v_pricing jsonb;
  v_auto_price_uom numeric;
begin
  if auth.uid() is null then
    raise exception 'No autenticado';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'Items invalidos';
  end if;

  v_payment_method_code := coalesce(public.resolve_payment_method_code(p_payment_method), 'efectivo');

  insert into public.sales_orders (
    order_code,
    status,
    customer_id,
    payment_method,
    notes,
    total,
    created_by
  )
  values (
    public.generate_sales_order_code(),
    'open',
    p_customer_id,
    v_payment_method_code,
    nullif(trim(coalesce(p_notes, '')), ''),
    0,
    auth.uid()
  )
  returning id into v_order_id;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_product_id := (v_item->>'product_id')::uuid;
    v_qty_input := coalesce(nullif(v_item->>'qty', '')::numeric, 0);
    v_price_input := nullif(v_item->>'price_unit', '')::numeric;

    if v_qty_input <= 0 then
      raise exception 'Cantidad invalida';
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

    v_factor := public.resolve_product_uom_factor(v_product_id, v_unit_name);

    v_pricing := public.resolve_sale_item_pricing(
      p_product_id := v_product_id,
      p_unit_name := v_unit_name,
      p_qty_uom := v_qty_input,
      p_customer_id := p_customer_id,
      p_sale_at := now()
    );

    v_auto_price_uom := coalesce((v_pricing->>'price_uom')::numeric, 0);
    if v_price_input is null then
      v_price_input := v_auto_price_uom;
    end if;

    if v_price_input < 0 then
      raise exception 'Precio invalido';
    end if;

    v_line_total := round((v_qty_input * v_price_input)::numeric, 2);
    v_total := v_total + v_line_total;

    insert into public.sales_order_items (
      order_id,
      product_id,
      unit_name,
      qty_uom,
      factor_to_base,
      auto_price_unit,
      price_unit_uom,
      pricing_source,
      pricing_detail,
      total
    )
    values (
      v_order_id,
      v_product_id,
      v_unit_name,
      v_qty_input,
      v_factor,
      v_auto_price_uom,
      v_price_input,
      coalesce(v_pricing->>'source', 'base'),
      v_pricing,
      v_line_total
    );
  end loop;

  update public.sales_orders
    set total = round(v_total::numeric, 2),
        updated_at = now()
    where id = v_order_id;

  return v_order_id;
end;
$$;

create or replace function public.pay_sales_order(
  p_order_id uuid,
  p_payment_method text default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order record;
  v_item record;
  v_sale_id uuid;
  v_total numeric := 0;
  v_qty_base numeric;
  v_price_base numeric;
  v_old_stock numeric;
  v_old_avg numeric;
  v_min_stock numeric;
  v_payment_method_code text;
begin
  if auth.uid() is null then
    raise exception 'No autenticado';
  end if;

  select *
    into v_order
    from public.sales_orders
    where id = p_order_id
      and status = 'open'
    for update;

  if v_order.id is null then
    raise exception 'Pedido no disponible para cobro';
  end if;

  v_payment_method_code := coalesce(
    public.resolve_payment_method_code(p_payment_method),
    public.resolve_payment_method_code(v_order.payment_method),
    'efectivo'
  );

  insert into public.sales (customer_id, payment_method, created_by, total)
  values (v_order.customer_id, v_payment_method_code, auth.uid(), 0)
  returning id into v_sale_id;

  for v_item in
    select
      oi.*,
      p.name as product_name
    from public.sales_order_items oi
    join public.products p on p.id = oi.product_id
    where oi.order_id = p_order_id
    order by oi.created_at, oi.id
  loop
    v_qty_base := v_item.qty_uom * v_item.factor_to_base;
    if v_qty_base <= 0 then
      raise exception 'Cantidad invalida en pedido';
    end if;

    v_price_base := case
      when v_item.factor_to_base = 0 then 0
      else round((v_item.price_unit_uom / v_item.factor_to_base)::numeric, 4)
    end;

    insert into public.inventory_balances (product_id, stock_on_hand, avg_cost, min_stock, updated_at)
    values (
      v_item.product_id,
      coalesce((select p.stock_on_hand from public.products p where p.id = v_item.product_id), 0),
      coalesce((select p.avg_cost from public.products p where p.id = v_item.product_id), 0),
      coalesce((select p.min_stock from public.products p where p.id = v_item.product_id), 0),
      now()
    )
    on conflict (product_id) do nothing;

    select ib.stock_on_hand, ib.avg_cost, ib.min_stock
      into v_old_stock, v_old_avg, v_min_stock
      from public.inventory_balances ib
      where ib.product_id = v_item.product_id
      for update;

    if v_old_stock < v_qty_base then
      raise exception 'Stock insuficiente para %', v_item.product_name;
    end if;

    update public.inventory_balances
      set stock_on_hand = v_old_stock - v_qty_base,
          updated_at = now()
      where product_id = v_item.product_id;

    update public.products
      set stock_on_hand = v_old_stock - v_qty_base,
          avg_cost = v_old_avg,
          min_stock = coalesce(v_min_stock, min_stock),
          updated_at = now()
      where id = v_item.product_id;

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
      v_item.product_id,
      v_item.unit_name,
      v_item.qty_uom,
      v_item.factor_to_base,
      v_item.price_unit_uom,
      v_qty_base,
      v_price_base,
      v_item.auto_price_unit,
      coalesce(v_item.pricing_source, 'pedido'),
      coalesce(v_item.pricing_detail, '{}'::jsonb),
      0,
      0,
      'Cobro de pedido',
      v_item.total
    );

    insert into public.stock_movements (product_id, movement_type, qty, cost_unit, ref_table, ref_id, created_by)
    values (v_item.product_id, 'sale', -v_qty_base, v_old_avg, 'sales', v_sale_id, auth.uid());

    v_total := v_total + v_item.total;
  end loop;

  update public.sales
    set total = round(v_total::numeric, 2)
    where id = v_sale_id;

  update public.sales_orders
    set status = 'paid',
        paid_sale_id = v_sale_id,
        paid_at = now(),
        payment_method = v_payment_method_code,
        updated_at = now()
    where id = p_order_id;

  return v_sale_id;
end;
$$;

grant select, insert, update, delete on public.sales_orders to authenticated;
grant select, insert, update, delete on public.sales_order_items to authenticated;
grant execute on function public.create_sales_order(uuid, text, jsonb, text) to authenticated;
grant execute on function public.pay_sales_order(uuid, text) to authenticated;

alter table public.sales_orders enable row level security;
drop policy if exists "sales_orders_all_auth" on public.sales_orders;
create policy "sales_orders_all_auth" on public.sales_orders
  for all using (auth.uid() is not null)
  with check (auth.uid() is not null);

alter table public.sales_order_items enable row level security;
drop policy if exists "sales_order_items_all_auth" on public.sales_order_items;
create policy "sales_order_items_all_auth" on public.sales_order_items
  for all using (auth.uid() is not null)
  with check (auth.uid() is not null);
