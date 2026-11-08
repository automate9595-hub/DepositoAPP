-- =====================================================================
-- DepositoAPP · 15_inicio_de_caja_y_mercado_pago.sql
-- 1) «Mercado Pago» como medio de pago (en la entrega del pedido y en los pagos de cuenta corriente).
-- 2) Inicio de caja del día: efectivo inicial, saldo inicial de Mercado Pago y % de retención de Mercado Pago.
-- 3) El informe y el cierre de caja incluyen Mercado Pago (cobrado − retención = saldo esperado).
-- Ejecutar DESPUÉS de 14. Se puede re-ejecutar sin problema.
-- =====================================================================

-- ---------- 1. Mercado Pago como medio de pago ----------
do $do$
declare r record;
begin
  for r in select conname from pg_constraint
           where conrelid = 'public.order_payments'::regclass and contype = 'c' and pg_get_constraintdef(oid) ilike '%method%' loop
    execute format('alter table public.order_payments drop constraint %I', r.conname);
  end loop;
  alter table public.order_payments add constraint order_payments_method_check
    check (method in ('Efectivo','Mercado Pago','Transferencia','Cheque','Tarjeta','Otro'));
end $do$;

create or replace function public.confirm_delivery_with_payment(
  p_order_id uuid,
  p_payment_amount numeric default 0,
  p_payment_method text default null
) returns void language plpgsql security definer set search_path = public as $fn$
declare v_order public.orders%rowtype; v_paid numeric(14,2);
begin
  if not (public.has_perm('orders') or public.is_worker()) then
    raise exception 'NO_AUTORIZADO: no tiene permiso para confirmar entregas';
  end if;
  if p_payment_amount is null or p_payment_amount < 0 then raise exception 'MONTO_INVALIDO: monto de pago inválido'; end if;
  if p_payment_amount > 0 and coalesce(p_payment_method,'') not in ('Efectivo','Mercado Pago','Transferencia','Cheque','Tarjeta','Otro') then
    raise exception 'MEDIO_INVALIDO: seleccione un medio de pago';
  end if;
  perform public.confirm_delivery(p_order_id);
  select * into v_order from public.orders where id = p_order_id for update;
  v_paid := round(coalesce(v_order.total_delivered,0),2);
  if p_payment_amount > v_paid then raise exception 'MONTO_EXCEDIDO: el pago no puede superar el total entregado'; end if;
  if p_payment_amount > 0 then
    insert into public.order_payments(order_id,amount,method,created_by)
    values (p_order_id,round(p_payment_amount,2),p_payment_method,auth.uid());
    -- La entrega ya generó el cargo automático a cuenta corriente; registrar el pago
    -- compensa ese cargo. El cliente público no tiene cuenta y solo conserva el comprobante.
    if v_order.customer_id is not null and exists (
      select 1 from public.customers c where c.id=v_order.customer_id and not c.is_public
    ) then
      insert into public.customer_movements(customer_id,kind,amount,order_id,method,note,created_by)
      values (v_order.customer_id,'PAGO',-round(p_payment_amount,2),p_order_id,p_payment_method,'Cobro al entregar pedido',auth.uid());
    end if;
  end if;
end $fn$;
revoke all on function public.confirm_delivery_with_payment(uuid, numeric, text) from public, anon;
grant execute on function public.confirm_delivery_with_payment(uuid, numeric, text) to authenticated;

create or replace function public._cash_method(p text) returns text
language sql immutable set search_path = public as $fn$
  select case regexp_replace(lower(trim(coalesce(p, ''))), '[^a-z]', '', 'g')
    when 'efectivo' then 'Efectivo' when 'mercadopago' then 'Mercado Pago' when 'mp' then 'Mercado Pago'
    when 'transferencia' then 'Transferencia' when 'cheque' then 'Cheque' when 'tarjeta' then 'Tarjeta' else 'Otro' end
$fn$;
revoke all on function public._cash_method(text) from public, anon, authenticated;

-- ---------- 2. Inicio de caja ----------
create table if not exists public.cash_openings (
  day              date primary key,
  opening_cash     numeric(14,2) not null default 0 check (opening_cash >= 0),
  opening_mp       numeric(14,2) not null default 0 check (opening_mp >= 0),
  mp_retention_pct numeric(5,2)  not null default 0 check (mp_retention_pct >= 0 and mp_retention_pct <= 100),
  opened_by        uuid references public.profiles(id),
  opened_at        timestamptz not null default now()
);
alter table public.cash_openings enable row level security;
revoke all on public.cash_openings from anon, authenticated;
grant all on public.cash_openings to service_role;

alter table public.cash_closings
  add column if not exists opening_mp numeric(14,2) not null default 0,
  add column if not exists mp_gross numeric(14,2) not null default 0,
  add column if not exists mp_retention_pct numeric(5,2) not null default 0,
  add column if not exists mp_retention numeric(14,2) not null default 0,
  add column if not exists mp_expected numeric(14,2) not null default 0,
  add column if not exists counted_mp numeric(14,2),
  add column if not exists mp_difference numeric(14,2);

-- ---------- 3. Informe de caja (ahora con inicio de caja y Mercado Pago) ----------
create or replace function public.cash_report(p_day date default null) returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  v_tz constant text := 'America/Argentina/Buenos_Aires';
  v_day date; v_today date; v_list jsonb; v_by jsonb; v_week jsonb; v_hours jsonb; v_close jsonb;
  v_total numeric(14,2); v_n integer; v_deliv numeric(14,2); v_deliv_n integer;
  v_open jsonb; v_last numeric; v_pct numeric; v_gross numeric; v_ret numeric; v_omp numeric; v_mp jsonb;
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

  select to_jsonb(o) || jsonb_build_object('opened_by_name', p.full_name) into v_open
    from public.cash_openings o left join public.profiles p on p.id = o.opened_by where o.day = v_day;
  select mp_retention_pct into v_last from public.cash_openings where day < v_day order by day desc limit 1;
  v_pct   := coalesce((v_open ->> 'mp_retention_pct')::numeric, v_last, 0);
  v_gross := coalesce((v_by ->> 'Mercado Pago')::numeric, 0);
  v_ret   := round(v_gross * v_pct / 100, 2);
  v_omp   := coalesce((v_open ->> 'opening_mp')::numeric, 0);
  v_mp    := jsonb_build_object('gross', v_gross, 'pct', v_pct, 'retention', v_ret, 'net', v_gross - v_ret, 'opening', v_omp, 'expected', v_omp + v_gross - v_ret);

  return jsonb_build_object('day', v_day, 'today', v_today, 'payments', v_list, 'by_method', v_by, 'total', v_total, 'count', v_n,
    'week', v_week, 'hours', v_hours, 'delivered_total', v_deliv, 'delivered_count', v_deliv_n, 'closing', v_close, 'opening', v_open, 'last_pct', coalesce(v_last, 0), 'mp', v_mp);
end $fn$;

create or replace function public.cash_open(p_day date, p_cash numeric, p_mp numeric, p_pct numeric) returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare v_today date := (now() at time zone 'America/Argentina/Buenos_Aires')::date;
begin
  if not public.has_perm('cash') then raise exception 'NO_AUTORIZADO: no tiene permiso para iniciar la caja'; end if;
  if p_day is null or p_day > v_today or p_day < date '2000-01-01' then raise exception 'FECHA_INVALIDA: indique un día válido'; end if;
  if coalesce(p_cash, 0) < 0 or coalesce(p_mp, 0) < 0 or coalesce(p_cash, 0) > 1000000000 or coalesce(p_mp, 0) > 1000000000 then
    raise exception 'MONTO_INVALIDO: los montos no pueden ser negativos';
  end if;
  if coalesce(p_pct, 0) < 0 or coalesce(p_pct, 0) > 100 then raise exception 'PORCENTAJE_INVALIDO: la retención debe estar entre 0 y 100'; end if;
  if exists (select 1 from public.cash_closings where day = p_day) then
    raise exception 'CAJA_CERRADA: la caja de ese día ya está cerrada; actualice el cierre en lugar de cambiar el inicio';
  end if;
  insert into public.cash_openings(day, opening_cash, opening_mp, mp_retention_pct, opened_by, opened_at)
    values (p_day, round(coalesce(p_cash, 0), 2), round(coalesce(p_mp, 0), 2), round(coalesce(p_pct, 0), 2), auth.uid(), now())
  on conflict (day) do update set opening_cash = excluded.opening_cash, opening_mp = excluded.opening_mp,
    mp_retention_pct = excluded.mp_retention_pct, opened_by = excluded.opened_by;
  perform public._audit('INICIAR_CAJA', 'cash_openings', p_day::text,
    jsonb_build_object('efectivo', p_cash, 'mercado_pago', p_mp, 'retencion_pct', p_pct));
  return public.cash_report(p_day);
end $fn$;

-- Cierre de caja: efectivo y Mercado Pago. El servidor recalcula todo con los datos guardados.
drop function if exists public.cash_close(date, numeric, numeric, numeric, text);
create or replace function public.cash_close(p_day date, p_opening numeric, p_withdrawals numeric, p_counted numeric,
                                             p_notes text default null, p_counted_mp numeric default null)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare v_rep jsonb; v_cash numeric(14,2); v_exp numeric(14,2); v_diff numeric(14,2); v_op numeric(14,2); v_wd numeric(14,2); v_ct numeric(14,2);
        v_mp jsonb; v_cmp numeric(14,2); v_mpd numeric(14,2);
begin
  if not public.has_perm('cash') then raise exception 'NO_AUTORIZADO: no tiene permiso para cerrar la caja'; end if;
  if p_day is null then raise exception 'FECHA_INVALIDA: indique el día'; end if;
  if coalesce(p_opening, 0) < 0 or coalesce(p_withdrawals, 0) < 0 or p_counted is null or p_counted < 0 or coalesce(p_counted_mp, 0) < 0
     or coalesce(p_opening, 0) > 1000000000 or coalesce(p_withdrawals, 0) > 1000000000 or p_counted > 1000000000 or coalesce(p_counted_mp, 0) > 1000000000 then
    raise exception 'MONTO_INVALIDO: los montos no pueden ser negativos';
  end if;
  v_rep := public.cash_report(p_day);
  v_op := coalesce((v_rep -> 'opening' ->> 'opening_cash')::numeric, round(coalesce(p_opening, 0), 2));   -- el inicio guardado manda
  v_wd := round(coalesce(p_withdrawals, 0), 2); v_ct := round(p_counted, 2);
  v_cash := coalesce((v_rep -> 'by_method' ->> 'Efectivo')::numeric, 0);
  v_exp := v_op + v_cash - v_wd; v_diff := v_ct - v_exp;
  v_mp := v_rep -> 'mp';
  v_cmp := case when p_counted_mp is null then null else round(p_counted_mp, 2) end;
  v_mpd := case when v_cmp is null then null else v_cmp - (v_mp ->> 'expected')::numeric end;
  insert into public.cash_closings(day, opening_cash, withdrawals, cash_income, expected_cash, counted_cash, difference, total_income, by_method, payments_count,
                                   notes, closed_by, closed_at, opening_mp, mp_gross, mp_retention_pct, mp_retention, mp_expected, counted_mp, mp_difference)
  values (p_day, v_op, v_wd, v_cash, v_exp, v_ct, v_diff, (v_rep ->> 'total')::numeric, v_rep -> 'by_method', (v_rep ->> 'count')::int,
          nullif(left(trim(coalesce(p_notes, '')), 500), ''), auth.uid(), now(),
          (v_mp ->> 'opening')::numeric, (v_mp ->> 'gross')::numeric, (v_mp ->> 'pct')::numeric, (v_mp ->> 'retention')::numeric, (v_mp ->> 'expected')::numeric, v_cmp, v_mpd)
  on conflict (day) do update set opening_cash = excluded.opening_cash, withdrawals = excluded.withdrawals, cash_income = excluded.cash_income,
    expected_cash = excluded.expected_cash, counted_cash = excluded.counted_cash, difference = excluded.difference, total_income = excluded.total_income,
    by_method = excluded.by_method, payments_count = excluded.payments_count, notes = excluded.notes, closed_by = excluded.closed_by, closed_at = now(),
    revisions = public.cash_closings.revisions + 1, opening_mp = excluded.opening_mp, mp_gross = excluded.mp_gross, mp_retention_pct = excluded.mp_retention_pct,
    mp_retention = excluded.mp_retention, mp_expected = excluded.mp_expected, counted_mp = excluded.counted_mp, mp_difference = excluded.mp_difference;
  perform public._audit('CIERRE_CAJA', 'cash_closings', p_day::text,
    jsonb_build_object('total', v_rep -> 'total', 'efectivo_esperado', v_exp, 'efectivo_contado', v_ct, 'diferencia', v_diff, 'mp_esperado', v_mp -> 'expected', 'mp_contado', v_cmp));
  return public.cash_report(p_day);
end $fn$;

revoke all on function public.cash_report(date) from public, anon;
revoke all on function public.cash_open(date, numeric, numeric, numeric) from public, anon;
revoke all on function public.cash_close(date, numeric, numeric, numeric, text, numeric) from public, anon;
grant execute on function public.cash_report(date) to authenticated;
grant execute on function public.cash_open(date, numeric, numeric, numeric) to authenticated;
grant execute on function public.cash_close(date, numeric, numeric, numeric, text, numeric) to authenticated;
