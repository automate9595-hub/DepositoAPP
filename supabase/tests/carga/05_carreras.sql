-- Carreras: muchas conexiones haciendo A LA VEZ lo que nunca debería duplicarse o pasarse de largo.
create table if not exists _load.race_log(id bigserial primary key, race text, outcome text, at timestamptz default clock_timestamp());
grant all on _load.race_log to authenticated; grant usage on sequence _load.race_log_id_seq to authenticated;
create table if not exists _load.race_ctx(k text primary key, v text);
grant select on _load.race_ctx to authenticated;

-- Prepara los escenarios (se ejecuta una vez, antes de lanzar las conexiones)
create or replace function _load.race_setup() returns void language plpgsql as $f$
declare v_o uuid; v_s numeric; i int; v_sup uuid;
begin
  delete from _load.race_ctx; delete from _load.race_log;
  -- idempotencia: un mismo identificador de solicitud usado por todas las conexiones
  insert into _load.race_ctx values ('idem_req', gen_random_uuid()::text);
  -- doble entrega y doble aprobación: dos pedidos listos para cada caso
  for i in 1 .. 2 loop
    v_o := _load.step_submit(2); reset role;     -- queda PENDIENTE: las conexiones competirán por aprobarlo
    insert into _load.race_ctx values ('approve_' || i, v_o::text);
  end loop;
  -- pago de comisión: el preventista 1 (3 % de ventas) debe tener saldo; cada pago es 1/10 del saldo, así 20 conexiones no alcanzan a pagarlo todo
  select supplier_id into v_sup from _load.actors where kind = 'prev' and n = 1;
  select coalesce(sum(amount), 0) - (select coalesce(sum(amount), 0) from public.commission_payouts where supplier_id = v_sup) into v_s from public.order_commissions where supplier_id = v_sup;
  if v_s < 10 then raise exception 'El preventista 1 no tiene saldo de comisión: ejecute antes la fase de volumen'; end if;
  insert into _load.race_ctx values ('pay_balance', v_s::text), ('pay_unit', ceil(v_s / 10)::text);
  for i in 1 .. 2 loop
    v_o := _load.step_submit(3); reset role; perform _load.as_(_load.actor('principal', 1)); perform public.approve_order(v_o); reset role;
    perform _load.prepare_order(v_o);
    insert into _load.race_ctx values ('deliver_' || i, v_o::text);
  end loop;
end $f$;

-- Prepara un pedido ESPECÍFICO (todo completo) como un operario de depósito
create or replace function _load.prepare_order(p_id uuid) returns void language plpgsql as $f$
declare it record;
begin
  perform _load.as_(_load.actor('deposito', 1));
  perform public.start_preparation(p_id);
  for it in select id, qty_approved from public.order_items where order_id = p_id and qty_approved > 0 loop perform public.report_item(it.id, it.qty_approved); end loop;
  perform public.finish_preparation(p_id);
  reset role;
end $f$;

create or replace function _load.race_idem() returns void language plpgsql as $f$
declare v_req uuid := (select v::uuid from _load.race_ctx where k = 'idem_req'); v_cust uuid; v_p uuid; v_id uuid;
begin
  select id into v_cust from public.customers where is_public; select product_id into v_p from public.inventory where available_stock > 50 limit 1;
  perform _load.as_(_load.actor('prev', 5));
  v_id := public.submit_order(v_req, jsonb_build_array(jsonb_build_object('product_id', v_p, 'qty', 1)), 'idem', v_cust);
  insert into _load.race_log(race, outcome) values ('idem', 'OK ' || v_id);
exception when others then insert into _load.race_log(race, outcome) values ('idem', 'ERR ' || left(sqlerrm, 60));
end $f$;

create or replace function _load.race_approve(p_n int) returns void language plpgsql as $f$
declare v_o uuid := (select v::uuid from _load.race_ctx where k = 'approve_' || p_n);
begin
  perform _load.as_(_load.actor('admin', 1 + floor(random() * 3)::int));
  perform public.approve_order(v_o);
  insert into _load.race_log(race, outcome) values ('approve_' || p_n, 'OK');
exception when others then insert into _load.race_log(race, outcome) values ('approve_' || p_n, 'ERR ' || left(sqlerrm, 60));
end $f$;

create or replace function _load.race_deliver(p_n int) returns void language plpgsql as $f$
declare v_o uuid := (select v::uuid from _load.race_ctx where k = 'deliver_' || p_n);
begin
  perform _load.as_(_load.actor('admin', 1 + floor(random() * 3)::int));
  perform public.confirm_delivery_with_payment(v_o, 0, null);
  insert into _load.race_log(race, outcome) values ('deliver_' || p_n, 'OK');
exception when others then insert into _load.race_log(race, outcome) values ('deliver_' || p_n, 'ERR ' || left(sqlerrm, 60));
end $f$;

create or replace function _load.race_pay(p_sup_n int) returns void language plpgsql as $f$
declare v_sup uuid := (select supplier_id from _load.actors where kind = 'prev' and n = p_sup_n);
begin
  perform _load.as_(_load.actor('admin', 1));
  perform public.commission_pay(v_sup, (select v::numeric from _load.race_ctx where k = 'pay_unit'), 'Efectivo', 'carrera');
  insert into _load.race_log(race, outcome) values ('pay', 'OK');
exception when others then insert into _load.race_log(race, outcome) values ('pay', 'ERR ' || left(sqlerrm, 60));
end $f$;

create or replace function _load.race_close() returns void language plpgsql as $f$
begin
  perform _load.as_(_load.actor('admin', 1 + floor(random() * 3)::int));
  perform public.cash_close((now() at time zone 'America/Argentina/Buenos_Aires')::date, 1000, 0, 0, 'carrera', null);
  insert into _load.race_log(race, outcome) values ('close', 'OK');
exception when others then insert into _load.race_log(race, outcome) values ('close', 'ERR ' || left(sqlerrm, 80));
end $f$;
grant execute on all functions in schema _load to authenticated;
