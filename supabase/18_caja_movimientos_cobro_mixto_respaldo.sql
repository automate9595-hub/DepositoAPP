-- =====================================================================
-- DepositoAPP · 18_caja_movimientos_cobro_mixto_respaldo.sql
-- 1) Movimientos de caja: varios ingresos y egresos por día, cada uno con su concepto, en efectivo,
--    Mercado Pago o cuenta (transferencia), solos o mezclados (hasta 3 medios en un mismo movimiento).
--    El arqueo de efectivo y de Mercado Pago los incluyen.
-- 2) Cobro mixto a clientes: al entregar un pedido y al registrar un pago de cuenta corriente se puede
--    cobrar con varios medios a la vez (efectivo + Mercado Pago + cuenta, etc.).
-- 3) Respaldo del cierre sin configurar nada en Vault: el administrador principal lo sube desde la app
--    y queda registrado como respaldo del cierre.
-- Ejecutar DESPUÉS de 16. Se puede re-ejecutar sin problema.
-- =====================================================================

-- ---------- 1. Movimientos de caja ----------
create table if not exists public.cash_movements (
  id          uuid primary key default gen_random_uuid(),
  day         date not null,
  kind        text not null check (kind in ('INGRESO', 'EGRESO')),
  concept     text not null check (char_length(concept) between 2 and 120),
  note        text check (note is null or char_length(note) <= 300),
  amount      numeric(14,2) not null check (amount > 0 and amount <= 1000000000),
  parts       jsonb not null,                     -- [{"method":"Efectivo","amount":1000}, ...]
  created_by  uuid references auth.users(id),
  created_at  timestamptz not null default now(),
  voided_at   timestamptz,
  voided_by   uuid references auth.users(id),
  void_reason text
);
create index if not exists cash_movements_day on public.cash_movements(day, created_at);

alter table public.cash_movements enable row level security;
drop policy if exists cash_movements_read on public.cash_movements;
create policy cash_movements_read on public.cash_movements for select to authenticated using ((select public.has_perm('cash')));
revoke all on public.cash_movements from anon;
revoke insert, update, delete, truncate, references, trigger on public.cash_movements from authenticated;
grant select on public.cash_movements to authenticated;

alter table public.cash_closings add column if not exists mov jsonb not null default '{}'::jsonb;

-- Valida y normaliza una lista de formas de pago: [{"method":"Efectivo","amount":100}, ...]
-- (medios permitidos, sin repetir, montos > 0). Devuelve la lista limpia.
create or replace function public._cash_parts(p_parts jsonb, p_allowed text[], p_max int default 4) returns jsonb
language plpgsql stable set search_path = public as $fn$
declare e jsonb; m text; a numeric; out jsonb := '[]'::jsonb; seen text[] := '{}';
begin
  if p_parts is null or jsonb_typeof(p_parts) <> 'array' or jsonb_array_length(p_parts) = 0 then
    raise exception 'DATOS_INVALIDOS: indique cómo se paga';
  end if;
  if jsonb_array_length(p_parts) > p_max then
    raise exception 'DATOS_INVALIDOS: como máximo % formas de pago', p_max;
  end if;
  for e in select x from jsonb_array_elements(p_parts) x loop
    if jsonb_typeof(e) <> 'object' then raise exception 'DATOS_INVALIDOS: forma de pago inválida'; end if;
    m := public._cash_method(e ->> 'method');
    -- _cash_method convierte cualquier texto desconocido en «Otro»: solo se acepta «Otro» si lo escribieron así
    if not (m = any(p_allowed)) or (m = 'Otro' and regexp_replace(lower(trim(coalesce(e ->> 'method', ''))), '[^a-z]', '', 'g') <> 'otro') then
      raise exception 'MEDIO_INVALIDO: medio de pago no permitido';
    end if;
    if m = any(seen) then raise exception 'MEDIO_REPETIDO: no repita el medio «%»; sume los montos en una sola línea', m; end if;
    begin a := (e ->> 'amount')::numeric; exception when others then a := null; end;
    if a is null or a <= 0 or a > 1000000000 then raise exception 'MONTO_INVALIDO: cada forma de pago debe tener un monto mayor a cero'; end if;
    seen := seen || m;
    out := out || jsonb_build_object('method', m, 'amount', round(a, 2));
  end loop;
  return out;
end $fn$;
revoke all on function public._cash_parts(jsonb, text[], int) from public, anon, authenticated;

create or replace function public.cash_report(p_day date default null) returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  v_tz constant text := 'America/Argentina/Buenos_Aires';
  v_day date; v_today date; v_list jsonb; v_by jsonb; v_week jsonb; v_hours jsonb; v_close jsonb;
  v_total numeric(14,2); v_n integer; v_deliv numeric(14,2); v_deliv_n integer;
  v_open jsonb; v_last numeric; v_pct numeric; v_gross numeric; v_ret numeric; v_omp numeric; v_mp jsonb;
  v_bk jsonb; v_creq timestamptz; v_cbs text; v_run record;
  v_mov jsonb; v_mlist jsonb; v_mic numeric; v_moc numeric; v_mim numeric; v_mom numeric; v_stale boolean;
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

  -- Movimientos manuales de caja (ingresos y egresos con su concepto): lista y resumen por medio
  select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'at', m.created_at, 'kind', m.kind, 'concept', m.concept, 'note', m.note,
           'amount', m.amount, 'parts', m.parts, 'by', up.full_name, 'voided', m.voided_at is not null,
           'void_reason', m.void_reason, 'voided_by', vp.full_name) order by m.created_at), '[]'::jsonb)
    into v_mlist
    from public.cash_movements m
    left join public.profiles up on up.id = m.created_by
    left join public.profiles vp on vp.id = m.voided_by
    where m.day = v_day;
  with e as (
    select m.kind, x ->> 'method' as method, (x ->> 'amount')::numeric as amt
    from public.cash_movements m cross join lateral jsonb_array_elements(m.parts) x
    where m.day = v_day and m.voided_at is null)
  select jsonb_build_object(
      'in',  coalesce((select jsonb_object_agg(method, t) from (select method, round(sum(amt), 2) t from e where kind = 'INGRESO' group by method) a), '{}'::jsonb),
      'out', coalesce((select jsonb_object_agg(method, t) from (select method, round(sum(amt), 2) t from e where kind = 'EGRESO' group by method) b), '{}'::jsonb),
      'in_total',  coalesce((select round(sum(amt), 2) from e where kind = 'INGRESO'), 0),
      'out_total', coalesce((select round(sum(amt), 2) from e where kind = 'EGRESO'), 0),
      'count', (select count(*) from public.cash_movements where day = v_day and voided_at is null))
    into v_mov;
  v_mic := coalesce((v_mov -> 'in'  ->> 'Efectivo')::numeric, 0);        v_moc := coalesce((v_mov -> 'out' ->> 'Efectivo')::numeric, 0);
  v_mim := coalesce((v_mov -> 'in'  ->> 'Mercado Pago')::numeric, 0);    v_mom := coalesce((v_mov -> 'out' ->> 'Mercado Pago')::numeric, 0);

  select to_jsonb(cc) || jsonb_build_object('closed_by_name', p.full_name) into v_close
    from public.cash_closings cc left join public.profiles p on p.id = cc.closed_by where cc.day = v_day;

  select to_jsonb(o) || jsonb_build_object('opened_by_name', p.full_name) into v_open
    from public.cash_openings o left join public.profiles p on p.id = o.opened_by where o.day = v_day;
  select mp_retention_pct into v_last from public.cash_openings where day < v_day order by day desc limit 1;
  v_pct   := coalesce((v_open ->> 'mp_retention_pct')::numeric, v_last, 0);
  v_gross := coalesce((v_by ->> 'Mercado Pago')::numeric, 0);
  v_ret   := round(v_gross * v_pct / 100, 2);
  v_omp   := coalesce((v_open ->> 'opening_mp')::numeric, 0);
  v_mp    := jsonb_build_object('gross', v_gross, 'pct', v_pct, 'retention', v_ret, 'net', v_gross - v_ret, 'opening', v_omp,
                               'mov_in', v_mim, 'mov_out', v_mom, 'expected', v_omp + v_gross - v_ret + v_mim - v_mom);

  -- Estado del respaldo que se pidió al cerrar la caja de ese día
  select backup_requested_at, backup_status into v_creq, v_cbs from public.cash_closings where day = v_day;
  if (v_close is null) then v_bk := null;
  elsif v_creq is null then v_bk := jsonb_build_object('status', 'ninguno');
  else
    select status, size_bytes, created_at, error_message into v_run from public.backup_runs
      where closing_day = v_day and created_at >= v_creq order by created_at desc limit 1;
    if found then
      v_bk := jsonb_build_object('status', case when v_run.status = 'ok' then 'ok' else 'failed' end, 'size_bytes', v_run.size_bytes,
                                 'at', v_run.created_at, 'error', v_run.error_message, 'requested_at', v_creq);
    elsif now() - v_creq < interval '10 minutes' then
      v_bk := jsonb_build_object('status', 'pendiente', 'requested_at', v_creq);
    else
      v_bk := jsonb_build_object('status', 'sin_confirmar', 'requested_at', v_creq,
                                 'error', 'El servidor no confirmó el respaldo. Revise Respaldos o que la función deposito-backup esté desplegada.');
    end if;
  end if;

  -- ¿Cambió algo después del cierre? (cobros, medios de pago o movimientos)
  v_stale := v_close is not null and (
       abs(coalesce((v_close ->> 'total_income')::numeric, 0) - v_total) > 0.004
    or (v_close -> 'by_method') is distinct from v_by
    or case when coalesce(v_close -> 'mov', '{}'::jsonb) = '{}'::jsonb then (v_mov ->> 'count')::int > 0
            else (v_close -> 'mov') is distinct from v_mov end);

  return jsonb_build_object('day', v_day, 'today', v_today, 'payments', v_list, 'by_method', v_by, 'total', v_total, 'count', v_n,
    'week', v_week, 'hours', v_hours, 'delivered_total', v_deliv, 'delivered_count', v_deliv_n, 'closing', v_close, 'opening', v_open, 'last_pct', coalesce(v_last, 0), 'mp', v_mp, 'backup', v_bk,
    'movements', v_mlist, 'mov', v_mov, 'stale', v_stale);
end $fn$;

create or replace function public.cash_close(p_day date, p_opening numeric, p_withdrawals numeric, p_counted numeric,
                                             p_notes text default null, p_counted_mp numeric default null)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare v_rep jsonb; v_cash numeric(14,2); v_exp numeric(14,2); v_diff numeric(14,2); v_op numeric(14,2); v_wd numeric(14,2); v_ct numeric(14,2);
        v_mp jsonb; v_cmp numeric(14,2); v_mpd numeric(14,2); v_bk text; v_mov jsonb; v_mic numeric; v_moc numeric;
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
  v_mov := coalesce(v_rep -> 'mov', '{}'::jsonb);
  v_mic := coalesce((v_mov -> 'in'  ->> 'Efectivo')::numeric, 0);
  v_moc := coalesce((v_mov -> 'out' ->> 'Efectivo')::numeric, 0);
  -- Efectivo esperado = fondo + cobros en efectivo + ingresos en efectivo − egresos en efectivo − otros retiros sin anotar
  v_exp := v_op + v_cash + v_mic - v_moc - v_wd; v_diff := v_ct - v_exp;
  v_mp := v_rep -> 'mp';
  v_cmp := case when p_counted_mp is null then null else round(p_counted_mp, 2) end;
  v_mpd := case when v_cmp is null then null else v_cmp - (v_mp ->> 'expected')::numeric end;
  insert into public.cash_closings(day, opening_cash, withdrawals, cash_income, expected_cash, counted_cash, difference, total_income, by_method, payments_count,
                                   notes, closed_by, closed_at, opening_mp, mp_gross, mp_retention_pct, mp_retention, mp_expected, counted_mp, mp_difference, mov)
  values (p_day, v_op, v_wd, v_cash, v_exp, v_ct, v_diff, (v_rep ->> 'total')::numeric, v_rep -> 'by_method', (v_rep ->> 'count')::int,
          nullif(left(trim(coalesce(p_notes, '')), 500), ''), auth.uid(), now(),
          (v_mp ->> 'opening')::numeric, (v_mp ->> 'gross')::numeric, (v_mp ->> 'pct')::numeric, (v_mp ->> 'retention')::numeric, (v_mp ->> 'expected')::numeric, v_cmp, v_mpd, v_mov)
  on conflict (day) do update set opening_cash = excluded.opening_cash, withdrawals = excluded.withdrawals, cash_income = excluded.cash_income,
    expected_cash = excluded.expected_cash, counted_cash = excluded.counted_cash, difference = excluded.difference, total_income = excluded.total_income,
    by_method = excluded.by_method, payments_count = excluded.payments_count, notes = excluded.notes, closed_by = excluded.closed_by, closed_at = now(),
    revisions = public.cash_closings.revisions + 1, opening_mp = excluded.opening_mp, mp_gross = excluded.mp_gross, mp_retention_pct = excluded.mp_retention_pct,
    mp_retention = excluded.mp_retention, mp_expected = excluded.mp_expected, counted_mp = excluded.counted_mp, mp_difference = excluded.mp_difference, mov = excluded.mov;
  -- El respaldo forma parte del cierre: se pide al servidor y su estado queda guardado junto al cierre
  -- Mantenimiento diario: los avisos de más de 60 días se borran (la tabla crecía sin límite: 243.000 filas en la prueba)
  delete from public.notifications where created_at < now() - interval '60 days';
  v_bk := public._request_closing_backup(p_day);
  perform public._audit('CIERRE_CAJA', 'cash_closings', p_day::text,
    jsonb_build_object('total', v_rep -> 'total', 'efectivo_esperado', v_exp, 'ingresos_efectivo', v_mic, 'egresos_efectivo', v_moc, 'efectivo_contado', v_ct, 'diferencia', v_diff, 'mp_esperado', v_mp -> 'expected', 'mp_contado', v_cmp, 'respaldo', v_bk));
  return public.cash_report(p_day);
end $fn$;

create or replace function public.cash_movement_add(p_day date, p_kind text, p_concept text, p_parts jsonb, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare
  v_tz constant text := 'America/Argentina/Buenos_Aires';
  v_today date := (now() at time zone v_tz)::date; v_day date; v_parts jsonb; v_total numeric(14,2); v_c text; v_id uuid;
begin
  if not public.has_perm('cash') then raise exception 'NO_AUTORIZADO: no tiene permiso para registrar movimientos de caja'; end if;
  v_day := coalesce(p_day, v_today);
  if v_day > v_today or v_day < date '2000-01-01' then raise exception 'FECHA_INVALIDA: indique un día válido (no futuro)'; end if;
  if p_kind is null or p_kind not in ('INGRESO', 'EGRESO') then raise exception 'DATOS_INVALIDOS: indique si es un ingreso o un egreso'; end if;
  v_c := left(trim(regexp_replace(coalesce(p_concept, ''), '\s+', ' ', 'g')), 120);
  if char_length(v_c) < 2 then raise exception 'CONCEPTO_REQUERIDO: escriba de qué es el movimiento (ej.: flete, proveedor, retiro)'; end if;
  v_parts := public._cash_parts(p_parts, array['Efectivo', 'Mercado Pago', 'Transferencia'], 3);
  select round(sum((x ->> 'amount')::numeric), 2) into v_total from jsonb_array_elements(v_parts) x;
  if v_total > 1000000000 then raise exception 'MONTO_INVALIDO: el monto es demasiado grande'; end if;
  if (select count(*) from public.cash_movements where day = v_day) >= 500 then
    raise exception 'LIMITE: ya hay 500 movimientos ese día';
  end if;
  insert into public.cash_movements(day, kind, concept, note, amount, parts, created_by)
  values (v_day, p_kind, v_c, nullif(left(trim(coalesce(p_note, '')), 300), ''), v_total, v_parts, auth.uid())
  returning id into v_id;
  perform public._audit('MOVIMIENTO_CAJA', 'cash_movements', v_id::text,
    jsonb_build_object('dia', v_day, 'tipo', p_kind, 'concepto', v_c, 'monto', v_total, 'medios', v_parts));
  return public.cash_report(v_day);
end $fn$;

create or replace function public.cash_movement_void(p_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare v_m public.cash_movements%rowtype; v_r text;
begin
  if not public.has_perm('cash') then raise exception 'NO_AUTORIZADO: no tiene permiso para anular movimientos de caja'; end if;
  v_r := left(trim(coalesce(p_reason, '')), 200);
  if char_length(v_r) < 3 then raise exception 'MOTIVO_REQUERIDO: escriba el motivo de la anulación'; end if;
  select * into v_m from public.cash_movements where id = p_id for update;
  if not found then raise exception 'NO_ENCONTRADO: el movimiento no existe'; end if;
  if v_m.voided_at is not null then raise exception 'YA_ANULADO: ese movimiento ya estaba anulado'; end if;
  update public.cash_movements set voided_at = now(), voided_by = auth.uid(), void_reason = v_r where id = p_id;
  perform public._audit('ANULAR_MOVIMIENTO_CAJA', 'cash_movements', p_id::text,
    jsonb_build_object('dia', v_m.day, 'tipo', v_m.kind, 'concepto', v_m.concept, 'monto', v_m.amount, 'motivo', v_r));
  return public.cash_report(v_m.day);
end $fn$;

revoke all on function public.cash_report(date) from public, anon;
revoke all on function public.cash_close(date, numeric, numeric, numeric, text, numeric) from public, anon;
revoke all on function public.cash_movement_add(date, text, text, jsonb, text) from public, anon;
revoke all on function public.cash_movement_void(uuid, text) from public, anon;
grant execute on function public.cash_report(date) to authenticated;
grant execute on function public.cash_close(date, numeric, numeric, numeric, text, numeric) to authenticated;
grant execute on function public.cash_movement_add(date, text, text, jsonb, text) to authenticated;
grant execute on function public.cash_movement_void(uuid, text) to authenticated;

-- ---------- 2. Cobro mixto a clientes ----------
-- Entrega un pedido y registra el cobro con uno o varios medios (lista vacía = todo a cuenta corriente).
create or replace function public.confirm_delivery_with_payments(p_order_id uuid, p_parts jsonb default '[]'::jsonb)
returns void language plpgsql security definer set search_path = public as $fn$
declare
  v_order public.orders%rowtype; v_total numeric(14,2); v_paid numeric(14,2) := 0; v_parts jsonb := '[]'::jsonb;
  v_acct boolean; v_n int; e jsonb; i int := 0; v_note text;
begin
  if not (public.has_perm('orders') or public.is_worker()) then
    raise exception 'NO_AUTORIZADO: no tiene permiso para confirmar entregas';
  end if;
  if p_parts is not null and jsonb_typeof(p_parts) <> 'array' then raise exception 'DATOS_INVALIDOS: formas de pago inválidas'; end if;
  if p_parts is not null and jsonb_array_length(p_parts) > 0 then
    v_parts := public._cash_parts(p_parts, array['Efectivo', 'Mercado Pago', 'Transferencia', 'Tarjeta', 'Cheque', 'Otro'], 6);
    select round(sum((x ->> 'amount')::numeric), 2) into v_paid from jsonb_array_elements(v_parts) x;
  end if;
  perform public.confirm_delivery(p_order_id);
  select * into v_order from public.orders where id = p_order_id for update;
  v_total := round(coalesce(v_order.total_delivered, 0), 2);
  if v_paid > v_total + 0.004 then raise exception 'MONTO_EXCEDIDO: el cobro (%) supera el total entregado (%)', v_paid, v_total; end if;
  v_acct := v_order.customer_id is not null and exists (select 1 from public.customers c where c.id = v_order.customer_id and not c.is_public);
  if not v_acct and v_paid < v_total - 0.004 then
    raise exception 'COBRO_INCOMPLETO: este cliente no tiene cuenta corriente, hay que cobrar el total entregado';
  end if;
  v_n := jsonb_array_length(v_parts);
  for e in select x from jsonb_array_elements(v_parts) x loop
    i := i + 1;
    insert into public.order_payments(order_id, amount, method, created_by)
    values (p_order_id, (e ->> 'amount')::numeric, e ->> 'method', auth.uid());
    if v_acct then
      v_note := 'Cobro al entregar pedido' || case when v_n > 1 then format(' (mixto %s/%s)', i, v_n) else '' end;
      insert into public.customer_movements(customer_id, kind, amount, order_id, method, note, created_by)
      values (v_order.customer_id, 'PAGO', -(e ->> 'amount')::numeric, p_order_id, e ->> 'method', v_note, auth.uid());
    end if;
  end loop;
end $fn$;
revoke all on function public.confirm_delivery_with_payments(uuid, jsonb) from public, anon;
grant execute on function public.confirm_delivery_with_payments(uuid, jsonb) to authenticated;

-- Pago de cuenta corriente con varios medios a la vez
create or replace function public.customer_register_payment_split(p_customer uuid, p_parts jsonb, p_note text default null)
returns void language plpgsql security definer set search_path = public as $fn$
declare v_parts jsonb; v_n int; i int := 0; e jsonb; v_nt text; v_total numeric(14,2);
begin
  if not public.has_perm('customers') then raise exception 'NO_AUTORIZADO: no tiene permiso para registrar pagos'; end if;
  if not exists (select 1 from public.customers where id = p_customer and not is_public) then
    raise exception 'NO_ENCONTRADO: el cliente no existe o no lleva cuenta corriente';
  end if;
  v_parts := public._cash_parts(p_parts, array['Efectivo', 'Mercado Pago', 'Transferencia', 'Tarjeta', 'Cheque', 'Otro'], 6);
  v_n := jsonb_array_length(v_parts);
  select round(sum((x ->> 'amount')::numeric), 2) into v_total from jsonb_array_elements(v_parts) x;
  if v_total > 1000000000 then raise exception 'DATOS_INVALIDOS: el monto del pago no es válido'; end if;
  for e in select x from jsonb_array_elements(v_parts) x loop
    i := i + 1;
    v_nt := nullif(left(trim(coalesce(p_note, '')), 280), '');
    if v_n > 1 then v_nt := trim(coalesce(v_nt || ' ', '') || format('(pago mixto %s/%s)', i, v_n)); end if;
    insert into public.customer_movements(customer_id, kind, amount, method, note, created_by)
    values (p_customer, 'PAGO', -(e ->> 'amount')::numeric, e ->> 'method', v_nt, auth.uid());
  end loop;
  perform public._audit('PAGO_CLIENTE', 'customers', p_customer::text, jsonb_build_object('monto', v_total, 'medios', v_parts));
end $fn$;
revoke all on function public.customer_register_payment_split(uuid, jsonb, text) from public, anon;
grant execute on function public.customer_register_payment_split(uuid, jsonb, text) to authenticated;

-- ---------- 3. Respaldo del cierre guardado desde la app (sin Vault) ----------
-- El administrador principal puede subir archivos a la carpeta «cierre/» del almacenamiento de respaldos.
drop policy if exists database_backups_principal_insert on storage.objects;
create policy database_backups_principal_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'database-backups' and name like 'cierre/%' and (select public.my_role()) = 'admin_principal');

-- Confirma que el archivo llegó al almacenamiento y lo deja registrado como respaldo del cierre de ese día.
create or replace function public.cash_backup_register(p_day date, p_path text, p_size bigint default null)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare v_size bigint;
begin
  if public.my_role() is distinct from 'admin_principal' then raise exception 'NO_AUTORIZADO: solo el administrador principal puede registrar el respaldo'; end if;
  if p_path is null or p_path !~ '^cierre/[A-Za-z0-9._-]{1,150}$' then raise exception 'DATOS_INVALIDOS: ruta de respaldo inválida'; end if;
  if not exists (select 1 from public.cash_closings where day = p_day) then raise exception 'NO_ENCONTRADO: ese día no tiene cierre de caja'; end if;
  select coalesce((o.metadata ->> 'size')::bigint, p_size) into v_size from storage.objects o where o.bucket_id = 'database-backups' and o.name = p_path;
  if not found then raise exception 'RESPALDO_NO_ENCONTRADO: el archivo no llegó al almacenamiento'; end if;
  insert into public.backup_runs(status, storage_path, size_bytes, triggered_by, reason, closing_day, created_at)
  values ('ok', p_path, v_size, 'cierre_caja_app', 'cierre_caja', p_day, clock_timestamp());   -- siempre posterior al intento fallido del servidor
  update public.cash_closings set backup_status = 'OK_APP' where day = p_day;
  perform public._audit('RESPALDO_CIERRE_APP', 'cash_closings', p_day::text, jsonb_build_object('archivo', p_path, 'bytes', v_size));
  return public.cash_report(p_day);
end $fn$;
revoke all on function public.cash_backup_register(date, text, bigint) from public, anon;
grant execute on function public.cash_backup_register(date, text, bigint) to authenticated;

-- ---------- 4. Los respaldos incluyen y restauran los movimientos de caja ----------
do $do$
declare r record; v_def text; v_new text;
begin
  for r in select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in ('backup_selected_snapshot', 'restore_backup') loop
    v_def := pg_get_functiondef(r.oid);
    continue when position('cash_movements' in v_def) > 0;
    v_new := replace(v_def, '''cash_closings'',''supplier_commissions''', '''cash_closings'',''cash_movements'',''supplier_commissions''');
    v_new := replace(v_new, '"cash_closings":["closed_by"],', '"cash_closings":["closed_by"], "cash_movements":["created_by","voided_by"],');
    if v_new is distinct from v_def then execute v_new; end if;
  end loop;
end $do$;
