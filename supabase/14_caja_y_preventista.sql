-- =====================================================================
-- DepositoAPP · 14_caja_y_preventista.sql
-- 1) Arqueo de caja: informe del día por medio de pago, cierre de caja y comprobante.
--    Nuevo permiso «cash» (Caja y arqueo): el administrador principal siempre; el segundo administrador si se lo habilita.
-- 2) Los avisos de pedidos hablan de «preventista».
-- Ejecutar DESPUÉS de 13. Se puede re-ejecutar sin problema.
-- =====================================================================

-- ---------- Cierres de caja ----------
create table if not exists public.cash_closings (
  day           date primary key,
  opening_cash  numeric(14,2) not null default 0 check (opening_cash >= 0),
  withdrawals   numeric(14,2) not null default 0 check (withdrawals >= 0),
  cash_income   numeric(14,2) not null default 0,
  expected_cash numeric(14,2) not null default 0,
  counted_cash  numeric(14,2) not null check (counted_cash >= 0),
  difference    numeric(14,2) not null default 0,
  total_income  numeric(14,2) not null default 0,
  by_method     jsonb not null default '{}'::jsonb,
  payments_count integer not null default 0,
  notes         text,
  closed_by     uuid references public.profiles(id),
  closed_at     timestamptz not null default now(),
  revisions     integer not null default 1
);
alter table public.cash_closings enable row level security;
revoke all on public.cash_closings from anon, authenticated;
grant all on public.cash_closings to service_role;

-- Medio de pago normalizado (los pagos a cuenta corriente traen texto libre)
create or replace function public._cash_method(p text) returns text
language sql immutable set search_path = public as $fn$
  select case lower(trim(coalesce(p, '')))
    when 'efectivo' then 'Efectivo' when 'transferencia' then 'Transferencia' when 'cheque' then 'Cheque'
    when 'tarjeta' then 'Tarjeta' else 'Otro' end
$fn$;
revoke all on function public._cash_method(text) from public, anon, authenticated;

-- Informe de caja de un día (hora de Argentina): cobros, totales por medio, últimos 7 días, horas y cierre
create or replace function public.cash_report(p_day date default null) returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  v_tz constant text := 'America/Argentina/Buenos_Aires';
  v_day date; v_today date; v_list jsonb; v_by jsonb; v_week jsonb; v_hours jsonb; v_close jsonb;
  v_total numeric(14,2); v_n integer; v_deliv numeric(14,2); v_deliv_n integer;
begin
  if not public.has_perm('cash') then raise exception 'NO_AUTORIZADO: no tiene permiso para ver la caja'; end if;
  v_today := (now() at time zone v_tz)::date;
  v_day := coalesce(p_day, v_today);
  if v_day > v_today then raise exception 'FECHA_INVALIDA: no se puede consultar un día futuro'; end if;
  if v_day < date '2000-01-01' then raise exception 'FECHA_INVALIDA: fecha fuera de rango'; end if;

  create temp table if not exists _cash_rows (id text, at timestamptz, d date, hr integer, kind text, method text, amount numeric, order_number bigint, customer text, preventista text, by_name text) on commit drop;
  truncate _cash_rows;
  insert into _cash_rows
    select op.id::text, op.created_at, (op.created_at at time zone v_tz)::date, extract(hour from op.created_at at time zone v_tz)::int,
           'COBRO_PEDIDO', public._cash_method(op.method), op.amount, o.order_number,
           coalesce(o.customer_name, 'Cliente público general'), s.company_name, up.full_name
    from public.order_payments op
    join public.orders o on o.id = op.order_id
    left join public.suppliers s on s.id = o.supplier_id
    left join public.profiles up on up.id = op.created_by
    where op.created_at >= (v_day - 6)::timestamp at time zone v_tz and op.created_at < (v_day + 1)::timestamp at time zone v_tz;
  insert into _cash_rows
    select 'm' || cm.id::text, cm.created_at, (cm.created_at at time zone v_tz)::date, extract(hour from cm.created_at at time zone v_tz)::int,
           'PAGO_CUENTA', public._cash_method(cm.method), -cm.amount, null, c.name, null, up.full_name
    from public.customer_movements cm
    join public.customers c on c.id = cm.customer_id
    left join public.profiles up on up.id = cm.created_by
    where cm.kind = 'PAGO' and cm.order_id is null
      and cm.created_at >= (v_day - 6)::timestamp at time zone v_tz and cm.created_at < (v_day + 1)::timestamp at time zone v_tz;

  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'at', at, 'kind', kind, 'method', method, 'amount', amount,
           'order_number', order_number, 'customer', customer, 'preventista', preventista, 'by', by_name) order by at), '[]'::jsonb)
    into v_list from _cash_rows where d = v_day;
  select coalesce(jsonb_object_agg(method, t), '{}'::jsonb) into v_by
    from (select method, sum(amount) t from _cash_rows where d = v_day group by method) x;
  select coalesce(sum(amount), 0), count(*) into v_total, v_n from _cash_rows where d = v_day;
  select jsonb_agg(jsonb_build_object('day', v_day - 6 + i, 'total', coalesce((select sum(amount) from _cash_rows r where r.d = v_day - 6 + i), 0)) order by i)
    into v_week from generate_series(0, 6) i;
  select coalesce(jsonb_agg(jsonb_build_object('hour', hr, 'total', t) order by hr), '[]'::jsonb) into v_hours
    from (select hr, sum(amount) t from _cash_rows where d = v_day group by hr) h;

  select coalesce(sum(o.total_delivered), 0), count(*) into v_deliv, v_deliv_n
    from public.orders o where o.status = 'ENTREGADO' and (o.delivered_at at time zone v_tz)::date = v_day;

  select to_jsonb(cc) || jsonb_build_object('closed_by_name', p.full_name) into v_close
    from public.cash_closings cc left join public.profiles p on p.id = cc.closed_by where cc.day = v_day;

  return jsonb_build_object('day', v_day, 'today', v_today, 'payments', v_list, 'by_method', v_by, 'total', v_total, 'count', v_n,
    'week', v_week, 'hours', v_hours, 'delivered_total', v_deliv, 'delivered_count', v_deliv_n, 'closing', v_close);
end $fn$;

-- Cierra (o actualiza el cierre de) la caja de un día. El servidor recalcula los totales: no confía en el cliente.
create or replace function public.cash_close(p_day date, p_opening numeric, p_withdrawals numeric, p_counted numeric, p_notes text default null)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare v_rep jsonb; v_cash numeric(14,2); v_exp numeric(14,2); v_diff numeric(14,2); v_op numeric(14,2); v_wd numeric(14,2); v_ct numeric(14,2);
begin
  if not public.has_perm('cash') then raise exception 'NO_AUTORIZADO: no tiene permiso para cerrar la caja'; end if;
  if p_day is null then raise exception 'FECHA_INVALIDA: indique el día'; end if;
  if coalesce(p_opening, 0) < 0 or coalesce(p_withdrawals, 0) < 0 or p_counted is null or p_counted < 0
     or coalesce(p_opening, 0) > 1000000000 or coalesce(p_withdrawals, 0) > 1000000000 or p_counted > 1000000000 then
    raise exception 'MONTO_INVALIDO: los montos no pueden ser negativos';
  end if;
  v_op := round(coalesce(p_opening, 0), 2); v_wd := round(coalesce(p_withdrawals, 0), 2); v_ct := round(p_counted, 2);
  v_rep := public.cash_report(p_day);
  v_cash := coalesce((v_rep -> 'by_method' ->> 'Efectivo')::numeric, 0);
  v_exp := v_op + v_cash - v_wd;
  v_diff := v_ct - v_exp;
  insert into public.cash_closings(day, opening_cash, withdrawals, cash_income, expected_cash, counted_cash, difference, total_income,
                                   by_method, payments_count, notes, closed_by, closed_at)
  values (p_day, v_op, v_wd, v_cash, v_exp, v_ct, v_diff, (v_rep ->> 'total')::numeric, v_rep -> 'by_method', (v_rep ->> 'count')::int,
          nullif(left(trim(coalesce(p_notes, '')), 500), ''), auth.uid(), now())
  on conflict (day) do update set opening_cash = excluded.opening_cash, withdrawals = excluded.withdrawals, cash_income = excluded.cash_income,
    expected_cash = excluded.expected_cash, counted_cash = excluded.counted_cash, difference = excluded.difference, total_income = excluded.total_income,
    by_method = excluded.by_method, payments_count = excluded.payments_count, notes = excluded.notes, closed_by = excluded.closed_by,
    closed_at = now(), revisions = public.cash_closings.revisions + 1;
  perform public._audit('CIERRE_CAJA', 'cash_closings', p_day::text,
    jsonb_build_object('total', v_rep -> 'total', 'efectivo_esperado', v_exp, 'efectivo_contado', v_ct, 'diferencia', v_diff));
  return public.cash_report(p_day);
end $fn$;

revoke all on function public.cash_report(date) from public, anon;
revoke all on function public.cash_close(date, numeric, numeric, numeric, text) from public, anon;
grant execute on function public.cash_report(date) to authenticated;
grant execute on function public.cash_close(date, numeric, numeric, numeric, text) to authenticated;

-- ---------- Avisos con «preventista» ----------
create or replace function public.submit_order(p_client_request_id uuid, p_items jsonb, p_notes text default null, p_customer_id uuid default null)
returns uuid language plpgsql security definer set search_path = public as $fn$
declare
  v_sup uuid; v_order uuid; v_row record; v_prod record; v_total numeric(14,2) := 0; v_name text; v_cust public.customers%rowtype;
begin
  v_sup := public.my_supplier_id();
  if v_sup is null then raise exception 'NO_AUTORIZADO: solo los proveedores activos pueden enviar pedidos'; end if;
  if p_client_request_id is null then raise exception 'DATOS_INVALIDOS: falta el identificador de la solicitud'; end if;
  if p_customer_id is null then raise exception 'CLIENTE_REQUERIDO: elija un cliente o "Cliente público general"'; end if;
  select * into v_cust from public.customers c
    where c.id = p_customer_id and c.active and (c.is_public or c.supplier_id is null or c.supplier_id = v_sup);
  if not found then raise exception 'CLIENTE_INVALIDO: el cliente no existe o no está disponible para usted'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'DATOS_INVALIDOS: el pedido no tiene productos';
  end if;
  if jsonb_array_length(p_items) > 300 then raise exception 'DATOS_INVALIDOS: demasiados productos en un pedido'; end if;
  if exists (select 1 from jsonb_array_elements(p_items) e
             where (e->>'product_id') is null or (e->>'qty') is null or (e->>'qty') !~ '^[0-9]{1,6}$' or (e->>'qty')::int <= 0) then
    raise exception 'DATOS_INVALIDOS: producto o cantidad no válidos';
  end if;

  insert into public.orders(supplier_id, client_request_id, supplier_notes, customer_id, customer_name)
  values (v_sup, p_client_request_id, nullif(left(trim(coalesce(p_notes, '')), 500), ''), v_cust.id, v_cust.name)
  on conflict (supplier_id, client_request_id) do nothing
  returning id into v_order;
  if v_order is null then
    select id into v_order from public.orders where supplier_id = v_sup and client_request_id = p_client_request_id;
    return v_order;
  end if;

  for v_row in
    select (e->>'product_id')::uuid as pid, sum((e->>'qty')::int)::int as qty
    from jsonb_array_elements(p_items) e group by 1 order by 1
  loop
    select p.id, p.code, p.name, p.price, i.available_stock into v_prod
    from public.products p join public.inventory i on i.product_id = p.id
    where p.id = v_row.pid and p.active;
    if not found then raise exception 'PRODUCTO_NO_DISPONIBLE: uno de los productos ya no está disponible'; end if;
    if v_row.qty > v_prod.available_stock then
      raise exception 'STOCK_INSUFICIENTE: "%" tiene % unidades disponibles y pidió %', v_prod.name, v_prod.available_stock, v_row.qty;
    end if;
    insert into public.order_items(order_id, product_id, product_code, product_name, unit_price, qty_requested)
    values (v_order, v_prod.id, v_prod.code, v_prod.name, v_prod.price, v_row.qty);
    v_total := v_total + v_prod.price * v_row.qty;
  end loop;

  update public.orders set total_requested = v_total where id = v_order;
  insert into public.order_status_history(order_id, from_status, to_status, user_id, note)
  values (v_order, null, 'PENDIENTE_APROBACION', auth.uid(), 'Pedido enviado');
  select company_name into v_name from public.suppliers where id = v_sup;
  perform public._notify_admins('Nuevo pedido', public._order_label(v_order) || ' · el preventista ' || v_name || ' hizo el pedido, pendiente de aprobación', v_order);
  perform public._audit('ENVIAR_PEDIDO', 'orders', v_order::text, jsonb_build_object('total', v_total, 'cliente', v_cust.name));
  return v_order;
end $fn$;
revoke all on function public.submit_order(uuid, jsonb, text, uuid) from public, anon;
grant execute on function public.submit_order(uuid, jsonb, text, uuid) to authenticated;

create or replace function public.cancel_order(p_order_id uuid, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $fn$
declare v_o public.orders%rowtype; v_sup uuid; v_sup_profile uuid;
begin
  select * into v_o from public.orders where id = p_order_id for update;
  if not found then raise exception 'NO_ENCONTRADO: el pedido no existe'; end if;
  v_sup := public.my_supplier_id();
  if v_sup is not null and v_o.supplier_id = v_sup then
    if v_o.status <> 'PENDIENTE_APROBACION' then
      raise exception 'ESTADO_INVALIDO: solo puede cancelar pedidos pendientes; contacte al administrador';
    end if;
  elsif not public.has_perm('orders') then
    raise exception 'NO_AUTORIZADO: no tiene permiso para cancelar este pedido';
  end if;
  perform public._release_reservations(p_order_id);
  update public.orders set admin_notes = coalesce(nullif(trim(p_reason), ''), admin_notes) where id = p_order_id;
  perform public._set_status(p_order_id, 'CANCELADO', nullif(trim(p_reason), ''));
  if v_sup is null then
    select profile_id into v_sup_profile from public.suppliers where id = v_o.supplier_id;
    perform public._notify(v_sup_profile, 'Pedido cancelado', public._order_label(v_o.id) || ' fue cancelado', p_order_id);
  else
    perform public._notify_admins('Pedido cancelado', 'El preventista canceló: ' || public._order_label(v_o.id), p_order_id);
  end if;
  perform public._audit('CANCELAR_PEDIDO', 'orders', p_order_id::text, jsonb_build_object('motivo', p_reason));
end $fn$;
revoke all on function public.cancel_order(uuid, text) from public, anon;
grant execute on function public.cancel_order(uuid, text) to authenticated;

