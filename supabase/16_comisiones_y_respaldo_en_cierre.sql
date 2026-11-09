-- =====================================================================
-- DepositoAPP · 16_comisiones_y_respaldo_en_cierre.sql
-- 1) Comisión configurable por preventista (% sobre ventas entregadas o sobre la ganancia).
--    · Se congela en cada pedido AL ENTREGARLO (si luego cambia el %, lo ya ganado no cambia).
--    · El preventista ve cuánto lleva ganado este mes, lo acumulado, lo ya cobrado y lo que le falta cobrar.
--    · La administración registra los pagos de comisión (no se puede pagar más de lo adeudado).
-- 2) Respaldo dentro del cierre de caja: al cerrar la caja se pide un respaldo completo al servidor
--    y el estado (en curso / guardado / falló) queda en el cierre y en la pantalla de Caja.
-- 3) Los respaldos y la restauración ahora incluyen también caja (inicios y cierres) y comisiones.
-- Ejecutar DESPUÉS de 15. Se puede re-ejecutar sin problema.
-- =====================================================================

-- ---------- 1. Comisiones ----------
create table if not exists public.supplier_commissions (
  supplier_id uuid primary key references public.suppliers(id),
  pct         numeric(5,2) not null default 0 check (pct >= 0 and pct <= 100),
  base        text not null default 'VENTAS' check (base in ('VENTAS','GANANCIA')),
  updated_by  uuid references public.profiles(id),
  updated_at  timestamptz not null default now()
);
create table if not exists public.order_commissions (
  order_id    uuid primary key references public.orders(id),
  supplier_id uuid not null references public.suppliers(id),
  pct         numeric(5,2) not null,
  base        text not null,
  base_amount numeric(14,2) not null,
  amount      numeric(14,2) not null check (amount >= 0),
  earned_at   timestamptz not null default now()
);
create index if not exists order_commissions_supplier on public.order_commissions(supplier_id, earned_at desc);
create table if not exists public.commission_payouts (
  id          uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references public.suppliers(id),
  amount      numeric(14,2) not null check (amount > 0),
  method      text not null check (method in ('Efectivo','Mercado Pago','Transferencia','Otro')),
  note        text,
  paid_by     uuid references public.profiles(id),
  paid_at     timestamptz not null default now()
);
create index if not exists notifications_created on public.notifications(created_at);
create index if not exists commission_payouts_supplier on public.commission_payouts(supplier_id, paid_at desc);

-- Datos sensibles (cuánto gana cada preventista): sin acceso directo desde la app, solo por funciones que validan quién consulta.
alter table public.supplier_commissions enable row level security;
alter table public.order_commissions   enable row level security;
alter table public.commission_payouts  enable row level security;
revoke all on public.supplier_commissions, public.order_commissions, public.commission_payouts from anon, authenticated;
grant all on public.supplier_commissions, public.order_commissions, public.commission_payouts to service_role;

-- Al entregar un pedido se calcula y congela la comisión del preventista (sobre lo realmente entregado)
create or replace function public.orders_accrue_commission() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare v_c public.supplier_commissions%rowtype; v_base numeric(14,2); v_cost numeric(14,2);
begin
  if new.status = 'ENTREGADO' and old.status is distinct from 'ENTREGADO' and coalesce(new.total_delivered, 0) > 0 then
    select * into v_c from public.supplier_commissions where supplier_id = new.supplier_id;
    if found and v_c.pct > 0 then
      if v_c.base = 'GANANCIA' then
        select coalesce(sum(ic.unit_cost * coalesce(oi.qty_delivered, 0)), 0) into v_cost
          from public.order_items oi left join public.order_item_costs ic on ic.order_item_id = oi.id
          where oi.order_id = new.id;
        v_base := greatest(round(new.total_delivered - v_cost, 2), 0);
      else
        v_base := round(new.total_delivered, 2);
      end if;
      insert into public.order_commissions(order_id, supplier_id, pct, base, base_amount, amount, earned_at)
      values (new.id, new.supplier_id, v_c.pct, v_c.base, v_base, round(v_base * v_c.pct / 100, 2), now())
      on conflict (order_id) do nothing;
    end if;
  end if;
  return new;
end $fn$;
revoke all on function public.orders_accrue_commission() from public, anon, authenticated;
drop trigger if exists trg_orders_commission on public.orders;
create trigger trg_orders_commission after update of status on public.orders
  for each row execute function public.orders_accrue_commission();

-- Configurar la comisión de un preventista (solo el administrador principal)
create or replace function public.admin_set_commission(p_supplier uuid, p_pct numeric, p_base text default 'VENTAS')
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare v_s public.suppliers%rowtype; v_pct numeric(5,2); v_base text := upper(coalesce(nullif(trim(p_base), ''), 'VENTAS'));
begin
  if public.my_role() is distinct from 'admin_principal' then
    raise exception 'NO_AUTORIZADO: solo el administrador principal configura comisiones';
  end if;
  if p_pct is null or p_pct < 0 or p_pct > 100 then raise exception 'PORCENTAJE_INVALIDO: la comisión debe estar entre 0 y 100'; end if;
  if v_base not in ('VENTAS','GANANCIA') then raise exception 'BASE_INVALIDA: la comisión se calcula sobre VENTAS o GANANCIA'; end if;
  select * into v_s from public.suppliers where id = p_supplier for update;
  if not found then raise exception 'NO_ENCONTRADO: el preventista no existe'; end if;
  v_pct := round(p_pct, 2);
  insert into public.supplier_commissions(supplier_id, pct, base, updated_by, updated_at)
    values (p_supplier, v_pct, v_base, auth.uid(), now())
  on conflict (supplier_id) do update set pct = excluded.pct, base = excluded.base, updated_by = excluded.updated_by, updated_at = now();
  perform public._audit('COMISION_CONFIGURADA', 'suppliers', p_supplier::text, jsonb_build_object('pct', v_pct, 'base', v_base));
  perform public._notify(v_s.profile_id, 'Comisión actualizada',
    case when v_pct = 0 then 'Su comisión se desactivó para los pedidos que se entreguen desde ahora'
         else 'Su comisión ahora es ' || v_pct || '% sobre ' || case when v_base = 'GANANCIA' then 'la ganancia' else 'las ventas' end || ' de los pedidos que se entreguen desde ahora' end, null);
  return jsonb_build_object('supplier_id', p_supplier, 'pct', v_pct, 'base', v_base);
end $fn$;

-- Resumen de comisión. El preventista ve SIEMPRE y solo lo suyo; la administración (Usuarios o Caja) elige el preventista.
create or replace function public.commission_summary(p_supplier uuid default null, p_from date default null, p_to date default null)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare
  v_tz constant text := 'America/Argentina/Buenos_Aires';
  v_sup uuid; v_name text; v_today date := (now() at time zone 'America/Argentina/Buenos_Aires')::date;
  v_from date; v_to date; v_m0 date; v_c public.supplier_commissions%rowtype;
  v_e_total numeric(14,2); v_paid numeric(14,2); v_e_per numeric(14,2); v_n_per int; v_b_per numeric(14,2);
  v_e_mon numeric(14,2); v_n_mon int; v_orders jsonb; v_pays jsonb;
begin
  v_sup := public.my_supplier_id();
  if v_sup is null then
    if not (public.has_perm('users') or public.has_perm('cash')) then raise exception 'NO_AUTORIZADO: no tiene permiso para ver comisiones'; end if;
    if p_supplier is null then raise exception 'DATOS_INVALIDOS: indique el preventista'; end if;
    v_sup := p_supplier;
  end if;
  select company_name into v_name from public.suppliers where id = v_sup;
  if not found then raise exception 'NO_ENCONTRADO: el preventista no existe'; end if;
  v_m0 := date_trunc('month', v_today)::date;
  v_from := coalesce(p_from, v_m0); v_to := coalesce(p_to, v_today);
  if v_from > v_to or v_from < date '2000-01-01' or v_to - v_from > 3660 then raise exception 'FECHA_INVALIDA: período no válido'; end if;
  select * into v_c from public.supplier_commissions where supplier_id = v_sup;

  select coalesce(sum(amount), 0) into v_e_total from public.order_commissions where supplier_id = v_sup;
  select coalesce(sum(amount), 0) into v_paid from public.commission_payouts where supplier_id = v_sup;
  select coalesce(sum(amount), 0), count(*), coalesce(sum(base_amount), 0) into v_e_per, v_n_per, v_b_per
    from public.order_commissions where supplier_id = v_sup
     and earned_at >= v_from::timestamp at time zone v_tz and earned_at < (v_to + 1)::timestamp at time zone v_tz;
  select coalesce(sum(amount), 0), count(*) into v_e_mon, v_n_mon
    from public.order_commissions where supplier_id = v_sup
     and earned_at >= v_m0::timestamp at time zone v_tz and earned_at < (v_m0 + interval '1 month')::timestamp at time zone v_tz;
  select coalesce(jsonb_agg(x order by (x ->> 'at') desc), '[]'::jsonb) into v_orders from (
    select jsonb_build_object('order_number', o.order_number, 'customer', coalesce(o.customer_name, 'Cliente público general'),
             'at', oc.earned_at, 'base_amount', oc.base_amount, 'pct', oc.pct, 'base', oc.base, 'amount', oc.amount) x
    from public.order_commissions oc join public.orders o on o.id = oc.order_id
    where oc.supplier_id = v_sup
      and oc.earned_at >= v_from::timestamp at time zone v_tz and oc.earned_at < (v_to + 1)::timestamp at time zone v_tz
    order by oc.earned_at desc limit 200) q;
  select coalesce(jsonb_agg(x order by (x ->> 'at') desc), '[]'::jsonb) into v_pays from (
    select jsonb_build_object('id', cp.id, 'at', cp.paid_at, 'amount', cp.amount, 'method', cp.method, 'note', cp.note) x
    from public.commission_payouts cp where cp.supplier_id = v_sup order by cp.paid_at desc limit 30) q;

  return jsonb_build_object('supplier_id', v_sup, 'name', v_name,
    'pct', coalesce(v_c.pct, 0), 'base', coalesce(v_c.base, 'VENTAS'), 'configured', v_c.supplier_id is not null and v_c.pct > 0,
    'period', jsonb_build_object('from', v_from, 'to', v_to, 'earned', v_e_per, 'orders', v_n_per, 'base_amount', v_b_per),
    'month', jsonb_build_object('from', v_m0, 'earned', v_e_mon, 'orders', v_n_mon),
    'earned_total', v_e_total, 'paid_total', v_paid, 'balance', v_e_total - v_paid,
    'orders', v_orders, 'payouts', v_pays);
end $fn$;

-- Tablero para la administración: todos los preventistas con su comisión, lo ganado en el mes y lo que se les debe
create or replace function public.commission_overview() returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  v_tz constant text := 'America/Argentina/Buenos_Aires';
  v_m0 date := date_trunc('month', (now() at time zone 'America/Argentina/Buenos_Aires')::date)::date;
begin
  if not (public.has_perm('users') or public.has_perm('cash')) then raise exception 'NO_AUTORIZADO: no tiene permiso para ver comisiones'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('supplier_id', s.id, 'name', s.company_name, 'active', s.active,
      'pct', coalesce(c.pct, 0), 'base', coalesce(c.base, 'VENTAS'),
      'earned_month', coalesce(e.mon, 0), 'earned_total', coalesce(e.tot, 0), 'paid_total', coalesce(p.tot, 0),
      'balance', coalesce(e.tot, 0) - coalesce(p.tot, 0)) order by s.company_name)
    from public.suppliers s
    left join public.supplier_commissions c on c.supplier_id = s.id
    left join (select supplier_id, sum(amount) tot,
                      sum(amount) filter (where earned_at >= v_m0::timestamp at time zone v_tz and earned_at < (v_m0 + interval '1 month')::timestamp at time zone v_tz) mon
               from public.order_commissions group by supplier_id) e on e.supplier_id = s.id
    left join (select supplier_id, sum(amount) tot from public.commission_payouts group by supplier_id) p on p.supplier_id = s.id), '[]'::jsonb);
end $fn$;

-- Registrar el pago de la comisión (principal o permiso de Caja). No se puede pagar más de lo adeudado.
create or replace function public.commission_pay(p_supplier uuid, p_amount numeric, p_method text default 'Efectivo', p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare v_s public.suppliers%rowtype; v_earned numeric(14,2); v_paid numeric(14,2); v_amt numeric(14,2);
begin
  if not public.has_perm('cash') then raise exception 'NO_AUTORIZADO: no tiene permiso para pagar comisiones'; end if;
  if p_amount is null or p_amount <= 0 or p_amount > 1000000000 then raise exception 'MONTO_INVALIDO: el pago debe ser mayor que cero'; end if;
  if coalesce(p_method, '') not in ('Efectivo','Mercado Pago','Transferencia','Otro') then raise exception 'MEDIO_INVALIDO: seleccione un medio de pago'; end if;
  v_amt := round(p_amount, 2);
  -- Se bloquea la ficha del preventista: dos pagos simultáneos se hacen uno después del otro y no pueden pagar de más
  select * into v_s from public.suppliers where id = p_supplier for update;
  if not found then raise exception 'NO_ENCONTRADO: el preventista no existe'; end if;
  select coalesce(sum(amount), 0) into v_earned from public.order_commissions where supplier_id = p_supplier;
  select coalesce(sum(amount), 0) into v_paid from public.commission_payouts where supplier_id = p_supplier;
  if v_amt > v_earned - v_paid then
    raise exception 'MONTO_EXCEDIDO: solo se le adeudan % de comisión', (v_earned - v_paid);
  end if;
  insert into public.commission_payouts(supplier_id, amount, method, note, paid_by)
    values (p_supplier, v_amt, p_method, nullif(left(trim(coalesce(p_note, '')), 300), ''), auth.uid());
  perform public._audit('PAGO_COMISION', 'suppliers', p_supplier::text, jsonb_build_object('monto', v_amt, 'medio', p_method, 'saldo_restante', v_earned - v_paid - v_amt));
  perform public._notify(v_s.profile_id, 'Pago de comisión', 'Se registró un pago de comisión de $' || to_char(v_amt, 'FM999G999G999D00') || ' (' || p_method || ')', null);
  return public.commission_summary(p_supplier);
end $fn$;

revoke all on function public.admin_set_commission(uuid, numeric, text) from public, anon;
revoke all on function public.commission_summary(uuid, date, date) from public, anon;
revoke all on function public.commission_overview() from public, anon;
revoke all on function public.commission_pay(uuid, numeric, text, text) from public, anon;
grant execute on function public.admin_set_commission(uuid, numeric, text) to authenticated;
grant execute on function public.commission_summary(uuid, date, date) to authenticated;
grant execute on function public.commission_overview() to authenticated;
grant execute on function public.commission_pay(uuid, numeric, text, text) to authenticated;

-- ---------- 2. Respaldo dentro del cierre de caja ----------
alter table public.backup_runs
  add column if not exists reason      text not null default 'programado',
  add column if not exists closing_day date;
alter table public.cash_closings
  add column if not exists backup_status       text,
  add column if not exists backup_requested_at timestamptz;

-- Pide al servidor (Edge Function deposito-backup, con la clave guardada en Vault) un respaldo completo.
-- Nunca hace fallar el cierre: si no está configurado, lo deja registrado como respaldo fallido para que se vea.
create or replace function public._request_closing_backup(p_day date) returns text
language plpgsql security definer set search_path = public as $fn$
declare v_url text; v_key text; v_prev timestamptz; v_prev_status text; v_status text; v_msg text;
begin
  select backup_requested_at, backup_status into v_prev, v_prev_status from public.cash_closings where day = p_day;
  -- Un cierre repetido en pocos minutos no dispara respaldos en cascada
  if v_prev is not null and v_prev > now() - interval '2 minutes' and v_prev_status = 'SOLICITADO' then return 'SOLICITADO'; end if;
  begin
    if to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null or to_regclass('vault.decrypted_secrets') is null then
      v_status := 'NO_CONFIGURADO'; v_msg := 'Los respaldos automáticos no están configurados (falta pg_net o Vault). Ejecute 08_programar_respaldos.sql.';
    else
      execute 'select decrypted_secret from vault.decrypted_secrets where name = $1' into v_url using 'deposito_backup_project_url';
      execute 'select decrypted_secret from vault.decrypted_secrets where name = $1' into v_key using 'deposito_backup_service_role_key';
      if v_url is null or v_key is null then
        v_status := 'NO_CONFIGURADO'; v_msg := 'Faltan los secretos del respaldo en Vault (deposito_backup_project_url / deposito_backup_service_role_key).';
      else
        execute 'select net.http_post(url := $1, body := $2, headers := $3, timeout_milliseconds := 60000)'
          using rtrim(v_url, '/') || '/functions/v1/deposito-backup',
                jsonb_build_object('reason', 'cierre_caja', 'day', p_day),
                jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key);
        v_status := 'SOLICITADO';
      end if;
    end if;
  exception when others then
    v_status := 'ERROR'; v_msg := 'No se pudo pedir el respaldo: ' || left(sqlerrm, 300);
  end;
  if v_status <> 'SOLICITADO' then
    insert into public.backup_runs(status, error_message, triggered_by, reason, closing_day)
      values ('failed', v_msg, 'cierre_caja', 'cierre_caja', p_day);
  end if;
  update public.cash_closings set backup_status = v_status, backup_requested_at = now() where day = p_day;
  return v_status;
end $fn$;
revoke all on function public._request_closing_backup(date) from public, anon, authenticated;

-- Informe y cierre de caja (ahora con el estado del respaldo del cierre)
create or replace function public.cash_report(p_day date default null) returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  v_tz constant text := 'America/Argentina/Buenos_Aires';
  v_day date; v_today date; v_list jsonb; v_by jsonb; v_week jsonb; v_hours jsonb; v_close jsonb;
  v_total numeric(14,2); v_n integer; v_deliv numeric(14,2); v_deliv_n integer;
  v_open jsonb; v_last numeric; v_pct numeric; v_gross numeric; v_ret numeric; v_omp numeric; v_mp jsonb;
  v_bk jsonb; v_creq timestamptz; v_cbs text; v_run record;
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

  return jsonb_build_object('day', v_day, 'today', v_today, 'payments', v_list, 'by_method', v_by, 'total', v_total, 'count', v_n,
    'week', v_week, 'hours', v_hours, 'delivered_total', v_deliv, 'delivered_count', v_deliv_n, 'closing', v_close, 'opening', v_open, 'last_pct', coalesce(v_last, 0), 'mp', v_mp, 'backup', v_bk);
end $fn$;

create or replace function public.cash_close(p_day date, p_opening numeric, p_withdrawals numeric, p_counted numeric,
                                             p_notes text default null, p_counted_mp numeric default null)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare v_rep jsonb; v_cash numeric(14,2); v_exp numeric(14,2); v_diff numeric(14,2); v_op numeric(14,2); v_wd numeric(14,2); v_ct numeric(14,2);
        v_mp jsonb; v_cmp numeric(14,2); v_mpd numeric(14,2); v_bk text;
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
  -- El respaldo forma parte del cierre: se pide al servidor y su estado queda guardado junto al cierre
  -- Mantenimiento diario: los avisos de más de 60 días se borran (la tabla crecía sin límite: 243.000 filas en la prueba)
  delete from public.notifications where created_at < now() - interval '60 days';
  v_bk := public._request_closing_backup(p_day);
  perform public._audit('CIERRE_CAJA', 'cash_closings', p_day::text,
    jsonb_build_object('total', v_rep -> 'total', 'efectivo_esperado', v_exp, 'efectivo_contado', v_ct, 'diferencia', v_diff, 'mp_esperado', v_mp -> 'expected', 'mp_contado', v_cmp, 'respaldo', v_bk));
  return public.cash_report(p_day);
end $fn$;
revoke all on function public.cash_report(date) from public, anon;
revoke all on function public.cash_close(date, numeric, numeric, numeric, text, numeric) from public, anon;
grant execute on function public.cash_report(date) to authenticated;
grant execute on function public.cash_close(date, numeric, numeric, numeric, text, numeric) to authenticated;

-- Los respaldos nuevos se guardan comprimidos (.json.gz): caben ~8 veces más datos en el límite de 50 MB por archivo
update storage.buckets set allowed_mime_types = array['application/json','application/gzip'] where id = 'database-backups';

-- ---------- 3. Los respaldos incluyen caja y comisiones (solo el administrador principal o el programador interno) ----------
-- Los respaldos se arman como TEXTO json (el tipo jsonb tiene un tope de 256 MB y con ~45.000 pedidos el respaldo fallaba).
-- Además, por defecto el respaldo completo ya no incluye "notifications" (avisos efímeros: eran el 30 % del peso).
drop function if exists public.backup_selected_snapshot(text[]);
drop function if exists public.backup_snapshot();

create or replace function public._backup_build(p_tables text[], p_version int) returns json
language plpgsql security definer set search_path = public as $fn$
declare t text; body text := ''; rows_text text;
begin
  foreach t in array p_tables loop
    execute format('select coalesce(json_agg(to_json(x))::text, ''[]'') from public.%I x', t) into rows_text;
    body := body || case when body = '' then '' else ',' end || to_json(t)::text || ':' || rows_text;
  end loop;
  return ('{"format":"depositoapp-backup","format_version":' || p_version || ',"generated_at":' || to_json(now())::text
    || ',"database_tables":{' || body || '},"notes":{"auth_passwords_included":false,"storage_product_photos_included":false}}')::json;
end $fn$;
revoke all on function public._backup_build(text[], int) from public, anon, authenticated;

create or replace function public.backup_selected_snapshot(p_tables text[] default null)
returns json language plpgsql security definer set search_path = public as $fn$
declare
  allowed constant text[] := array[
    'roles','profiles','suppliers','warehouse_workers','categories','products','inventory',
    'orders','order_items','stock_reservations','stock_movements','order_transitions',
    'order_status_history','notifications','audit_logs','customers','customer_movements',
    'product_costs','order_item_costs','order_payments','cash_openings','cash_closings','supplier_commissions','order_commissions','commission_payouts','backup_settings','backup_runs'
  ];
  chosen text[];
begin
  if coalesce(auth.role(), '') <> 'service_role' and public.my_role() is distinct from 'admin_principal' then
    raise exception 'NO_AUTORIZADO: solo el administrador principal puede generar respaldos';
  end if;
  chosen := coalesce(p_tables, array_remove(allowed, 'notifications'));
  if cardinality(chosen) = 0 then raise exception 'SELECCION_VACIA: no hay tablas seleccionadas'; end if;
  if exists (select 1 from unnest(chosen) x where not (x = any(allowed))) then
    raise exception 'TABLA_NO_PERMITIDA: la selección contiene una tabla no respaldable';
  end if;
  return public._backup_build(chosen, 2);
end $fn$;

create or replace function public.backup_snapshot()
returns json language plpgsql security definer set search_path = public as $fn$
begin
  if coalesce(auth.role(), '') <> 'service_role' and public.my_role() is distinct from 'admin_principal' then
    raise exception 'NO_AUTORIZADO: solo el administrador principal o el programador interno pueden generar respaldos';
  end if;
  return public.backup_selected_snapshot(null);
end $fn$;
revoke all on function public.backup_selected_snapshot(text[]) from public, anon;
grant execute on function public.backup_selected_snapshot(text[]) to authenticated, service_role;
revoke all on function public.backup_snapshot() from public, anon;
grant execute on function public.backup_snapshot() to authenticated, service_role;

-- Restauración: carga también caja y comisiones
create or replace function public.restore_backup(
  p_tables     jsonb,
  p_mode       text    default 'merge',
  p_dry_run    boolean default false,
  p_photo_base text    default null
) returns jsonb
language plpgsql security definer set search_path = public set statement_timeout = '180s' as $fn$
declare
  -- Orden de carga: primero los datos de los que dependen los demás.
  c_load constant text[] := array[
    'roles','order_transitions','profiles','suppliers','warehouse_workers','categories','products',
    'inventory','product_costs','customers','orders','order_items','order_item_costs',
    'stock_reservations','stock_movements','order_status_history','notifications','audit_logs',
    'customer_movements','order_payments','cash_openings','cash_closings','supplier_commissions',
    'order_commissions','commission_payouts','backup_settings'
  ];
  -- Tablas de catálogo fijo: nunca se vacían, solo se agregan las filas que falten.
  c_static constant text[] := array['roles','order_transitions'];
  -- Columnas opcionales que apuntan a un usuario: quedan vacías si ese usuario no existe en Auth.
  c_userref constant jsonb := '{
    "customers":["created_by"],
    "orders":["assigned_to","approved_by","delivered_by"],
    "stock_movements":["user_id"],
    "order_status_history":["user_id"],
    "audit_logs":["user_id"],
    "customer_movements":["created_by"],
    "order_payments":["created_by"],
    "cash_openings":["opened_by"],
    "cash_closings":["closed_by"],
    "supplier_commissions":["updated_by"],
    "commission_payouts":["paid_by"],
    "backup_settings":["updated_by"]
  }'::jsonb;

  v_caller   uuid := auth.uid();
  v_text     text;
  v_tbls     jsonb;
  v_unmapped uuid[] := '{}';
  v_remap    integer := 0;
  v_missing  jsonb := '[]'::jsonb;
  v_block    jsonb := '[]'::jsonb;
  v_warn     jsonb := '[]'::jsonb;
  v_counts   jsonb := '{}'::jsonb;
  v_ins      jsonb := '{}'::jsonb;
  v_skip     jsonb := '{}'::jsonb;
  v_ignored  jsonb := '[]'::jsonb;
  v_cur      text := '-';
  v_new      uuid;
  v_rows     jsonb;
  v_cols     text;
  v_sel      text;
  v_conf     text;
  v_ident    boolean;
  v_n        bigint;
  v_total    integer;
  v_down     text;
  v_pub_old  uuid;
  v_pub_new  uuid;
  r          record;
  t          text;
  i          integer;
begin
  -- ---------- Autorización y validaciones ----------
  if public.my_role() is distinct from 'admin_principal' then
    raise exception 'NO_AUTORIZADO: solo el administrador principal puede restaurar respaldos';
  end if;
  if p_mode is null or p_mode not in ('replace','merge') then
    raise exception 'MODO_INVALIDO: el modo de restauración debe ser «replace» o «merge»';
  end if;
  if p_tables is null or jsonb_typeof(p_tables) <> 'object' then
    raise exception 'RESPALDO_INVALIDO: el archivo no contiene un conjunto de tablas válido';
  end if;
  for t in select k from jsonb_object_keys(p_tables) k loop
    if t = any(c_load) then
      if jsonb_typeof(p_tables -> t) <> 'array' then
        raise exception 'RESPALDO_INVALIDO: la tabla «%» no tiene el formato esperado', t;
      end if;
    elsif t <> 'backup_runs' then
      v_ignored := v_ignored || to_jsonb(t);   -- tablas desconocidas: se informan y se ignoran
    end if;
  end loop;

  -- ---------- Vinculación de usuarios con Supabase Auth ----------
  v_text := p_tables::text;
  for r in
    select (x ->> 'id')::uuid as id,
           nullif(trim(x ->> 'email'), '') as email,
           x ->> 'role' as role,
           x ->> 'full_name' as name
    from jsonb_array_elements(coalesce(p_tables -> 'profiles', '[]'::jsonb)) x
  loop
    v_new := null;
    if exists (select 1 from auth.users u where u.id = r.id) then
      v_new := r.id;
    elsif r.email is not null then
      select u.id into v_new from auth.users u where lower(u.email) = lower(r.email) limit 1;
    end if;
    if v_new is null then
      v_unmapped := array_append(v_unmapped, r.id);
      v_missing := v_missing || jsonb_build_object('email', r.email, 'role', r.role, 'name', r.name);
    elsif v_new <> r.id then
      v_text := replace(v_text, r.id::text, v_new::text);   -- mismo usuario, identificador nuevo
      v_remap := v_remap + 1;
    end if;
  end loop;
  -- «Cliente público general» es único: si este sistema ya tiene el suyo, los pedidos del respaldo pasan a usarlo.
  if p_mode = 'merge' then
    select (x ->> 'id')::uuid into v_pub_old
    from jsonb_array_elements(coalesce(p_tables -> 'customers', '[]'::jsonb)) x
    where coalesce((x ->> 'is_public')::boolean, false) limit 1;
    select c.id into v_pub_new from public.customers c where c.is_public limit 1;
    if v_pub_old is not null and v_pub_new is not null and v_pub_old <> v_pub_new then
      v_text := replace(v_text, v_pub_old::text, v_pub_new::text);
    end if;
  end if;
  v_tbls := v_text::jsonb;

  -- Faltantes que impiden restaurar: proveedores / personal de depósito sin cuenta de acceso.
  select coalesce(jsonb_agg(jsonb_build_object('email', x ->> 'email', 'role', x ->> 'role', 'name', x ->> 'full_name')), '[]'::jsonb)
    into v_block
  from jsonb_array_elements(coalesce(v_tbls -> 'profiles', '[]'::jsonb)) x
  where (x ->> 'id')::uuid = any(v_unmapped)
    and (exists (select 1 from jsonb_array_elements(coalesce(v_tbls -> 'suppliers', '[]'::jsonb)) s where s ->> 'profile_id' = x ->> 'id')
      or exists (select 1 from jsonb_array_elements(coalesce(v_tbls -> 'warehouse_workers', '[]'::jsonb)) w where w ->> 'profile_id' = x ->> 'id'));

  foreach t in array c_load loop
    if v_tbls ? t then v_counts := v_counts || jsonb_build_object(t, jsonb_array_length(v_tbls -> t)); end if;
  end loop;

  if p_dry_run then
    return jsonb_build_object('dry_run', true, 'mode', p_mode, 'counts', v_counts,
      'missing_users', v_missing, 'blocked_users', v_block, 'ignored_tables', v_ignored, 'remapped_users', v_remap);
  end if;

  if jsonb_array_length(v_block) > 0 then
    raise exception 'USUARIOS_FALTANTES: antes de restaurar, cree en Administración > Usuarios las cuentas de: %. Luego vuelva a importar el respaldo.',
      (select string_agg(coalesce(b ->> 'email', b ->> 'name', '(sin correo)') || ' (' || coalesce(b ->> 'role', 'sin rol') || ')', ', ')
         from jsonb_array_elements(v_block) b);
  end if;

  -- ---------- Restauración (una sola transacción) ----------
  begin
    -- Las reglas automáticas (auditoría, inventario inicial, cargos) no deben dispararse al cargar datos históricos.
    foreach t in array c_load loop
      if v_tbls ? t then execute format('alter table public.%I disable trigger user', t); end if;
    end loop;

    if p_mode = 'replace' then
      for i in reverse array_length(c_load, 1)..1 loop
        t := c_load[i];
        continue when not (v_tbls ? t) or t = any(c_static);
        v_cur := t;
        if t = 'profiles' then
          delete from public.profiles where id is distinct from v_caller;   -- el administrador actual se conserva
        else
          execute format('delete from public.%I where true', t);   -- Supabase (pg_safeupdate) exige WHERE en todo DELETE
        end if;
      end loop;
    end if;

    foreach t in array c_load loop
      continue when not (v_tbls ? t);
      v_cur := t;
      v_rows := v_tbls -> t;

      if t = 'profiles' then
        -- Solo puede haber un administrador principal: si ya existe otro, este queda como segundo administrador.
        select x ->> 'email' into v_down
        from jsonb_array_elements(v_rows) x
        where x ->> 'role' = 'admin_principal'
          and exists (select 1 from public.profiles p where p.role = 'admin_principal' and p.id <> (x ->> 'id')::uuid)
        limit 1;
        if found then
          v_warn := v_warn || to_jsonb('El administrador principal del respaldo (' || coalesce(v_down, 'sin correo')
            || ') quedó como segundo administrador porque ya existe otro administrador principal.');
        end if;
        select coalesce(jsonb_agg(
                 case when x ->> 'role' = 'admin_principal'
                       and exists (select 1 from public.profiles p where p.role = 'admin_principal' and p.id <> (x ->> 'id')::uuid)
                      then jsonb_set(x, '{role}', '"admin_secundario"'::jsonb) else x end), '[]'::jsonb)
          into v_rows
        from jsonb_array_elements(v_rows) x
        where not ((x ->> 'id')::uuid = any(v_unmapped));
      elsif t = 'notifications' then
        select coalesce(jsonb_agg(x), '[]'::jsonb) into v_rows
        from jsonb_array_elements(v_rows) x
        where (x ->> 'user_id') is not null and not ((x ->> 'user_id')::uuid = any(v_unmapped));
      end if;

      v_total := jsonb_array_length(v_rows);
      if v_total = 0 then
        v_ins := v_ins || jsonb_build_object(t, 0);
        continue;
      end if;

      -- Columnas a cargar: las que trae el respaldo y existen hoy (se omiten las calculadas).
      select string_agg(quote_ident(c.column_name), ', ' order by c.ordinal_position),
             string_agg(
               case when coalesce((c_userref -> t) ? (c.column_name::text), false)
                    then format('case when x.%1$I = any($2) then null else x.%1$I end', c.column_name)
                    else format('x.%I', c.column_name) end,
               ', ' order by c.ordinal_position)
        into v_cols, v_sel
      from information_schema.columns c
      where c.table_schema = 'public' and c.table_name::text = t and c.is_generated = 'NEVER'
        and c.column_name::text in (select jsonb_object_keys(v_rows -> 0));
      if v_cols is null then
        raise exception 'RESPALDO_INVALIDO: las filas de «%» no tienen columnas reconocibles', t;
      end if;

      v_ident := exists (select 1 from information_schema.columns c
                         where c.table_schema = 'public' and c.table_name::text = t and c.is_identity = 'YES');
      v_conf := case when t = 'profiles'
        then 'on conflict (id) do update set email = excluded.email, role = excluded.role, full_name = excluded.full_name, '
             || 'phone = excluded.phone, active = excluded.active, permissions = excluded.permissions '
             || 'where profiles.role is null'     -- solo completa perfiles en blanco (cuentas recién creadas)
        else 'on conflict do nothing' end;

      execute format('insert into public.%I (%s)%s select %s from jsonb_populate_recordset(null::public.%I, $1) as x %s',
                     t, v_cols, case when v_ident then ' overriding system value' else '' end, v_sel, t, v_conf)
        using v_rows, v_unmapped;
      get diagnostics v_n = row_count;
      v_ins := v_ins || jsonb_build_object(t, v_n);
      if v_n < v_total then v_skip := v_skip || jsonb_build_object(t, v_total - v_n); end if;
    end loop;

    v_cur := 'ajustes finales';
    -- Las fotografías apuntan al almacenamiento de ESTE proyecto (el respaldo puede venir de otro).
    if p_photo_base is not null and length(p_photo_base) > 0 and v_tbls ? 'products' then
      update public.products
         set photo_url = p_photo_base || regexp_replace(photo_url, '^.*/product-photos/', '')
       where photo_url like '%/product-photos/%'
         and left(photo_url, length(p_photo_base)) <> p_photo_base;
    end if;
    -- Todo producto debe tener su fila de inventario.
    if v_tbls ? 'products' then
      insert into public.inventory(product_id)
        select p.id from public.products p where not exists (select 1 from public.inventory i where i.product_id = p.id)
      on conflict do nothing;
    end if;
    -- Los contadores de numeración continúan después del mayor valor restaurado.
    for r in
      select c.table_name::text as tbl, c.column_name::text as col
      from information_schema.columns c
      where c.table_schema = 'public' and c.is_identity = 'YES' and c.table_name::text = any(c_load)
    loop
      continue when not (v_tbls ? r.tbl);
      execute format('select setval(pg_get_serial_sequence(%L, %L), coalesce(max(%I), 1), max(%I) is not null) from public.%I',
                     'public.' || r.tbl, r.col, r.col, r.col, r.tbl);
    end loop;

    foreach t in array c_load loop
      if v_tbls ? t then execute format('alter table public.%I enable trigger user', t); end if;
    end loop;

    perform public._audit('RESTAURAR_RESPALDO', 'backup', null,
      jsonb_build_object('modo', p_mode, 'registros', v_ins, 'omitidos', v_skip, 'usuarios_sin_cuenta', v_missing));
  exception
    when others then
      if sqlstate = '23503' then
        raise exception 'DEPENDENCIAS: no se pudo cargar «%» porque hay datos relacionados que no están en este respaldo (%). Use un respaldo completo o el modo «Agregar lo que falta».', v_cur, sqlerrm;
      end if;
      raise exception 'RESTAURACION_FALLIDA: % (tabla: %). No se modificó ningún dato.', sqlerrm, v_cur;
  end;

  return jsonb_build_object('ok', true, 'mode', p_mode, 'inserted', v_ins, 'skipped', v_skip,
    'missing_users', v_missing, 'remapped_users', v_remap, 'ignored_tables', v_ignored, 'warnings', v_warn);
end $fn$;

revoke all on function public.restore_backup(jsonb, text, boolean, text) from public, anon;
grant execute on function public.restore_backup(jsonb, text, boolean, text) to authenticated;


-- ---------- 4. Endurecimiento de permisos (hallazgo de la auditoría) ----------
-- Las tablas creadas después de 03_seguridad.sql (backup_settings, backup_runs, order_payments…) heredaron de Supabase
-- permisos de más para anon/authenticated. Siempre las protegió RLS, pero se cierra también la puerta de los permisos:
--   · anon (sin sesión): ningún acceso a nada.
--   · authenticated: solo lectura; escritura directa únicamente en catálogo (products/categories, filtrado por RLS)
--     y en los ajustes de respaldo (solo administración, filtrado por RLS). Todo lo demás se escribe por funciones del servidor.
do $do$
declare r record;
begin
  for r in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r','v') loop
    execute format('revoke all on public.%I from anon', r.relname);
    if r.relname in ('categories', 'products') then
      execute format('revoke delete, truncate, references, trigger on public.%I from authenticated', r.relname);
    elsif r.relname = 'backup_settings' then
      execute format('revoke delete, truncate, references, trigger on public.%I from authenticated', r.relname);
    else
      execute format('revoke insert, update, delete, truncate, references, trigger on public.%I from authenticated', r.relname);
    end if;
  end loop;
end $do$;
revoke all on all sequences in schema public from anon, authenticated;


-- ---------- 5. Velocidad: las políticas de seguridad se evalúan UNA vez por consulta, no una vez por fila ----------
-- Hallazgo de la prueba de carga: con 25.000 pedidos "Mis pedidos" tardaba ~1,8 s (my_supplier_id(), has_perm() y my_role()
-- se ejecutaban fila por fila) y crecía sin freno hasta pasar el límite de 8 s de Supabase. Envolver cada llamada en
-- (select ...) hace que Postgres la calcule una sola vez. El resultado de las políticas es exactamente el mismo.
do $do$
declare r record; v_q text; v_w text; fx constant text := '(?:my_supplier_id|my_role|is_admin|is_worker|can_prepare|has_perm)';
begin
  for r in select schemaname, tablename, policyname, qual, with_check from pg_policies where schemaname = 'public' loop
    v_q := r.qual; v_w := r.with_check;
    -- 1) deshacer envoltorios previos (idempotente): ( SELECT fn(..) AS fn) -> fn(..)
    v_q := regexp_replace(v_q, '\( SELECT ((?:auth\.)?[a-z_]+\([^()]*\)) AS [a-z_]+\)', '\1', 'g');
    v_w := regexp_replace(v_w, '\( SELECT ((?:auth\.)?[a-z_]+\([^()]*\)) AS [a-z_]+\)', '\1', 'g');
    -- 2) envolver las llamadas
    v_q := regexp_replace(regexp_replace(v_q, '\m(' || fx || '\([^()]*\))', '(select \1)', 'g'), '\mauth\.uid\(\)', '(select auth.uid())', 'g');
    v_w := regexp_replace(regexp_replace(v_w, '\m(' || fx || '\([^()]*\))', '(select \1)', 'g'), '\mauth\.uid\(\)', '(select auth.uid())', 'g');
    if v_q is distinct from r.qual or v_w is distinct from r.with_check then
      execute format('alter policy %I on %I.%I %s %s', r.policyname, r.schemaname, r.tablename,
        case when v_q is not null then 'using (' || v_q || ')' else '' end,
        case when v_w is not null then 'with check (' || v_w || ')' else '' end);
    end if;
  end loop;
end $do$;
