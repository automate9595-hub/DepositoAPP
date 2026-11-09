-- =====================================================================
-- DepositoAPP · pruebas de comisiones de preventistas y del respaldo en el cierre de caja
-- Ejecutar DESPUÉS de 16_comisiones_y_respaldo_en_cierre.sql (SQL Editor de Supabase o psql).
-- Termina en ROLLBACK: no deja ningún dato. Si algo falla, el mensaje dice qué prueba fue.
-- =====================================================================
begin;

create schema if not exists _t;
grant usage on schema _t to authenticated;
create or replace function _t.fails(q text, pat text) returns boolean
language plpgsql as $f$
begin execute q; return false;
exception when others then return sqlerrm ilike '%' || pat || '%';
end $f$;
grant execute on function _t.fails(text, text) to authenticated;
create or replace function _t.as_user(u uuid) returns void language sql as $f$
  select set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true) $f$;
grant execute on function _t.as_user(uuid) to authenticated;

do $t$
declare
  up uuid := gen_random_uuid();  -- principal
  u2 uuid := gen_random_uuid();  -- secundario SIN permisos
  u3 uuid := gen_random_uuid();  -- secundario con caja
  ua uuid := gen_random_uuid();  -- preventista A (5% ventas)
  ub uuid := gen_random_uuid();  -- preventista B (10% ganancia)
  uw uuid := gen_random_uuid();  -- depósito
  sa uuid; sb uuid; p1 uuid; p2 uuid; cust uuid; d0 date := (now() at time zone 'America/Argentina/Buenos_Aires')::date;
  o1 uuid; o2 uuid; o3 uuid; o4 uuid; o5 uuid; it record; j jsonb; n int; x numeric; st text; calls int;

begin
  insert into auth.users(id, instance_id, aud, role, email, raw_user_meta_data) select u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'c_' || left(u::text, 8) || '@t.local', '{}'
    from unnest(array[up, u2, u3, ua, ub, uw]) u;
  update public.profiles set role = 'admin_principal', active = true, full_name = 'Principal' where id = up;
  update public.profiles set role = 'admin_secundario', active = true, full_name = 'Sec sin permisos', permissions = '{"orders":true}' where id = u2;
  update public.profiles set role = 'admin_secundario', active = true, full_name = 'Sec caja', permissions = '{"orders":true,"cash":true}' where id = u3;
  perform _t.as_user(up); execute 'set local role authenticated';
  perform public.admin_set_user(ua, 'proveedor', 'Ana Preventista', null, true, null, 'Ana');
  perform public.admin_set_user(ub, 'proveedor', 'Beto Preventista', null, true, null, 'Beto');
  perform public.admin_set_user(uw, 'deposito', 'Operario', null, true);
  execute 'reset role';
  select id into sa from public.suppliers where profile_id = ua;
  select id into sb from public.suppliers where profile_id = ub;
  select id into cust from public.customers where is_public;
  insert into public.products(code, name, price) values ('C-1', 'Prod C1', 100) returning id into p1;
  insert into public.products(code, name, price) values ('C-2', 'Prod C2', 200) returning id into p2;
  insert into public.product_costs(product_id, cost_price) values (p1, 60), (p2, 150);
  update public.inventory set physical_stock = 1000 where product_id in (p1, p2);

  -- ============ 1. Quién puede configurar la comisión ============
  execute 'set local role authenticated';
  perform _t.as_user(u3);
  if not _t.fails(format('select public.admin_set_commission(%L, 5)', sa), 'NO_AUTORIZADO') then raise exception 'FALLO C1: un secundario configuró comisión'; end if;
  perform _t.as_user(ua);
  if not _t.fails(format('select public.admin_set_commission(%L, 50)', sa), 'NO_AUTORIZADO') then raise exception 'FALLO C1: el preventista se puso su propia comisión'; end if;
  perform _t.as_user(uw);
  if not _t.fails(format('select public.admin_set_commission(%L, 5)', sa), 'NO_AUTORIZADO') then raise exception 'FALLO C1: el depósito configuró comisión'; end if;
  perform _t.as_user(up);
  if not _t.fails(format('select public.admin_set_commission(%L, 101)', sa), 'PORCENTAJE_INVALIDO') then raise exception 'FALLO C1: aceptó 101%%'; end if;
  if not _t.fails(format('select public.admin_set_commission(%L, -1)', sa), 'PORCENTAJE_INVALIDO') then raise exception 'FALLO C1: aceptó -1%%'; end if;
  if not _t.fails(format('select public.admin_set_commission(%L, null)', sa), 'PORCENTAJE_INVALIDO') then raise exception 'FALLO C1: aceptó null'; end if;
  if not _t.fails(format('select public.admin_set_commission(%L, 5, ''OTRA'')', sa), 'BASE_INVALIDA') then raise exception 'FALLO C1: aceptó una base inválida'; end if;
  if not _t.fails('select public.admin_set_commission(gen_random_uuid(), 5)', 'NO_ENCONTRADO') then raise exception 'FALLO C1: aceptó un preventista inexistente'; end if;
  perform public.admin_set_commission(sa, 5, 'VENTAS');
  perform public.admin_set_commission(sb, 10, 'GANANCIA');
  select pct into x from public.commission_overview() o, jsonb_to_recordset(o) as r(supplier_id uuid, pct numeric) where r.supplier_id = sa;
  if x <> 5 then raise exception 'FALLO C1: la comisión de A quedó en %', x; end if;
  execute 'reset role';
  if (select count(*) from public.notifications where user_id = ua and title = 'Comisión actualizada') <> 1 then raise exception 'FALLO C1: el preventista no fue avisado'; end if;
  if (select count(*) from public.audit_logs where action = 'COMISION_CONFIGURADA') <> 2 then raise exception 'FALLO C1: falta auditoría'; end if;

  -- ============ 2. Pedido de A: 10 x $100 + 5 x $200 = $2000, entregado completo -> 5% = $100 ============
  execute 'set local role authenticated';
  perform _t.as_user(ua);
  o1 := public.submit_order(gen_random_uuid(), jsonb_build_array(jsonb_build_object('product_id', p1, 'qty', 10), jsonb_build_object('product_id', p2, 'qty', 5)), null, cust);
  perform _t.as_user(up); perform public.approve_order(o1);
  perform _t.as_user(uw); perform public.start_preparation(o1);
  for it in select id, qty_approved from public.order_items where order_id = o1 loop perform public.report_item(it.id, it.qty_approved); end loop;
  perform public.finish_preparation(o1); perform public.confirm_delivery(o1);
  execute 'reset role';
  select amount into x from public.order_commissions where order_id = o1;
  if x is distinct from 100 then raise exception 'FALLO C2: comisión de A = % (esperado 100)', x; end if;

  -- ============ 3. Pedido de B (10% sobre GANANCIA): 10 x $100 (costo 60), entrega parcial de 8 ============
  execute 'set local role authenticated';
  perform _t.as_user(ub);
  o2 := public.submit_order(gen_random_uuid(), jsonb_build_array(jsonb_build_object('product_id', p1, 'qty', 10)), null, cust);
  perform _t.as_user(up); perform public.approve_order(o2);
  perform _t.as_user(uw); perform public.start_preparation(o2);
  for it in select id from public.order_items where order_id = o2 loop perform public.report_item(it.id, 8, 'faltan 2'); end loop;
  perform public.finish_preparation(o2); perform public.confirm_delivery(o2);
  execute 'reset role';
  -- entregado 8 x 100 = 800; costo 8 x 60 = 480; ganancia 320; 10% = 32
  select jsonb_build_object('b', base_amount, 'a', amount) into j from public.order_commissions where order_id = o2;
  if (j ->> 'b')::numeric <> 320 or (j ->> 'a')::numeric <> 32 then raise exception 'FALLO C3: base/comisión de B = %', j; end if;

  -- ============ 4. Cambiar el % no altera lo ya ganado (se congela al entregar) ============
  execute 'set local role authenticated'; perform _t.as_user(up);
  perform public.admin_set_commission(sa, 20, 'VENTAS');
  execute 'reset role';
  select amount into x from public.order_commissions where order_id = o1;
  if x <> 100 then raise exception 'FALLO C4: el cambio de %% alteró una comisión ya ganada (%)', x; end if;
  execute 'set local role authenticated'; perform _t.as_user(ua);
  o3 := public.submit_order(gen_random_uuid(), jsonb_build_array(jsonb_build_object('product_id', p2, 'qty', 5)), null, cust);   -- $1000
  perform _t.as_user(up); perform public.approve_order(o3);
  perform _t.as_user(uw); perform public.start_preparation(o3);
  for it in select id, qty_approved from public.order_items where order_id = o3 loop perform public.report_item(it.id, it.qty_approved); end loop;
  perform public.finish_preparation(o3); perform public.confirm_delivery(o3);
  execute 'reset role';
  select amount into x from public.order_commissions where order_id = o3;
  if x <> 200 then raise exception 'FALLO C4: el pedido nuevo debía ganar 20%% = 200 y ganó %', x; end if;

  -- ============ 5. Con 0% no se genera comisión; pedidos cancelados/rechazados no generan ============
  execute 'set local role authenticated'; perform _t.as_user(up);
  perform public.admin_set_commission(sa, 0, 'VENTAS');
  perform _t.as_user(ua);
  o4 := public.submit_order(gen_random_uuid(), jsonb_build_array(jsonb_build_object('product_id', p1, 'qty', 1)), null, cust);
  perform _t.as_user(up); perform public.approve_order(o4);
  perform _t.as_user(uw); perform public.start_preparation(o4);
  for it in select id, qty_approved from public.order_items where order_id = o4 loop perform public.report_item(it.id, it.qty_approved); end loop;
  perform public.finish_preparation(o4); perform public.confirm_delivery(o4);
  perform _t.as_user(ua);
  o5 := public.submit_order(gen_random_uuid(), jsonb_build_array(jsonb_build_object('product_id', p1, 'qty', 3)), null, cust);
  perform public.cancel_order(o5, 'prueba');
  execute 'reset role';
  if exists (select 1 from public.order_commissions where order_id in (o4, o5)) then raise exception 'FALLO C5: se generó comisión con 0%% o en un pedido cancelado'; end if;
  if (select count(*) from public.order_commissions) <> 3 then raise exception 'FALLO C5: se esperaban 3 comisiones'; end if;

  -- ============ 6. Lo que ve cada uno ============
  execute 'set local role authenticated';
  perform _t.as_user(ua);
  j := public.commission_summary();
  if (j ->> 'earned_total')::numeric <> 300 or (j ->> 'paid_total')::numeric <> 0 or (j ->> 'balance')::numeric <> 300
     or (j -> 'month' ->> 'earned')::numeric <> 300 or jsonb_array_length(j -> 'orders') <> 2 then raise exception 'FALLO C6: resumen de A = %', j; end if;
  -- A intenta ver a B pasando su identificador: recibe SOLO lo suyo
  j := public.commission_summary(sb);
  if j ->> 'supplier_id' <> sa::text then raise exception 'FALLO C6: A pudo ver la comisión de B'; end if;
  perform _t.as_user(ub);
  j := public.commission_summary();
  if (j ->> 'earned_total')::numeric <> 32 or j ->> 'base' <> 'GANANCIA' then raise exception 'FALLO C6: resumen de B = %', j; end if;
  perform _t.as_user(uw);
  if not _t.fails('select public.commission_summary()', 'NO_AUTORIZADO') then raise exception 'FALLO C6: el depósito vio comisiones'; end if;
  if not _t.fails('select public.commission_overview()', 'NO_AUTORIZADO') then raise exception 'FALLO C6: el depósito vio el tablero'; end if;
  perform _t.as_user(ua);
  if not _t.fails('select public.commission_overview()', 'NO_AUTORIZADO') then raise exception 'FALLO C6: un preventista vio el tablero de todos'; end if;
  perform _t.as_user(u2);
  if not _t.fails(format('select public.commission_summary(%L)', sa), 'NO_AUTORIZADO') then raise exception 'FALLO C6: secundario sin permiso vio comisiones'; end if;
  perform _t.as_user(u3);
  j := public.commission_summary(sa);
  if (j ->> 'balance')::numeric <> 300 then raise exception 'FALLO C6: secundario con caja no ve el saldo'; end if;
  perform _t.as_user(up);
  if not _t.fails(format('select public.commission_summary(%L, ''2026-12-31'', ''2026-01-01'')', sa), 'FECHA_INVALIDA') then raise exception 'FALLO C6: aceptó un período invertido'; end if;
  -- Acceso directo a las tablas: cerrado para todos los usuarios de la app
  foreach st in array array['supplier_commissions','order_commissions','commission_payouts'] loop
    perform _t.as_user(ua);
    if not _t.fails(format('select count(*) from public.%I', st), 'permission denied') then raise exception 'FALLO C6: % legible por un preventista', st; end if;
    perform _t.as_user(up);
    if not _t.fails(format('select count(*) from public.%I', st), 'permission denied') then raise exception 'FALLO C6: % legible directo incluso por el principal', st; end if;
    if not _t.fails(format('delete from public.%I where true', st), 'permission denied') then raise exception 'FALLO C6: % se puede borrar', st; end if;
  end loop;

  -- ============ 7. Pagos de comisión ============
  perform _t.as_user(ua);
  if not _t.fails(format('select public.commission_pay(%L, 10, ''Efectivo'')', sa), 'NO_AUTORIZADO') then raise exception 'FALLO C7: el preventista se pagó solo'; end if;
  perform _t.as_user(u2);
  if not _t.fails(format('select public.commission_pay(%L, 10, ''Efectivo'')', sa), 'NO_AUTORIZADO') then raise exception 'FALLO C7: secundario sin caja pagó'; end if;
  perform _t.as_user(up);
  if not _t.fails(format('select public.commission_pay(%L, 0, ''Efectivo'')', sa), 'MONTO_INVALIDO') then raise exception 'FALLO C7: aceptó pago 0'; end if;
  if not _t.fails(format('select public.commission_pay(%L, -5, ''Efectivo'')', sa), 'MONTO_INVALIDO') then raise exception 'FALLO C7: aceptó pago negativo'; end if;
  if not _t.fails(format('select public.commission_pay(%L, 10, ''Bitcoin'')', sa), 'MEDIO_INVALIDO') then raise exception 'FALLO C7: aceptó un medio inválido'; end if;
  if not _t.fails(format('select public.commission_pay(%L, 300.01, ''Efectivo'')', sa), 'MONTO_EXCEDIDO') then raise exception 'FALLO C7: dejó pagar de más'; end if;
  j := public.commission_pay(sa, 120.50, 'Efectivo', 'adelanto');
  if (j ->> 'balance')::numeric <> 179.50 or (j ->> 'paid_total')::numeric <> 120.50 then raise exception 'FALLO C7: saldo tras pagar = %', j; end if;
  perform _t.as_user(u3);
  j := public.commission_pay(sa, 79.50, 'Transferencia');
  perform _t.as_user(up);
  if not _t.fails(format('select public.commission_pay(%L, 100.01, ''Efectivo'')', sa), 'MONTO_EXCEDIDO') then raise exception 'FALLO C7: pagó 100,01 con 100 de saldo'; end if;
  j := public.commission_pay(sa, 100, 'Mercado Pago');
  if (j ->> 'balance')::numeric <> 0 then raise exception 'FALLO C7: saldo final = %', j ->> 'balance'; end if;
  perform _t.as_user(ua);
  j := public.commission_summary();
  if (j ->> 'balance')::numeric <> 0 or (j ->> 'paid_total')::numeric <> 300 or jsonb_array_length(j -> 'payouts') <> 3 then raise exception 'FALLO C7: lo que ve A tras cobrar = %', j; end if;
  execute 'reset role';
  if (select count(*) from public.notifications where user_id = ua and title = 'Pago de comisión') <> 3 then raise exception 'FALLO C7: faltan avisos de pago'; end if;
  if (select count(*) from public.audit_logs where action = 'PAGO_COMISION') <> 3 then raise exception 'FALLO C7: falta auditoría de pagos'; end if;

  -- ============ 8. Respaldo dentro del cierre de caja ============
  -- 8a. Sin pg_net/Vault (caso típico de quien aún no los configuró): el cierre funciona y queda constancia visible
  execute 'set local role authenticated'; perform _t.as_user(up);
  j := public.cash_close(d0, 0, 0, 0, 'cierre de prueba', null);
  execute 'reset role';
  if j -> 'closing' is null then raise exception 'FALLO B1: no se cerró la caja'; end if;
  if j -> 'backup' ->> 'status' <> 'failed' or (select backup_status from public.cash_closings where day = d0) <> 'NO_CONFIGURADO' then
    raise exception 'FALLO B1: sin configuración debía figurar como fallido: %', j -> 'backup'; end if;
  if (select count(*) from public.backup_runs where closing_day = d0 and status = 'failed' and reason = 'cierre_caja') <> 1 then raise exception 'FALLO B1: no quedó registro del fallo'; end if;

  -- 8b. Con pg_net + Vault configurados (se simulan): se pide el respaldo al servidor con la clave interna
  create schema net;
  create table net._calls(id serial, url text, body jsonb, headers jsonb);
  create function net.http_post(url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds integer default 5000)
    returns bigint language sql as $f$ insert into net._calls(url, body, headers) values (url, body, headers) returning id::bigint $f$;
  create schema vault;
  create table vault.decrypted_secrets(name text, decrypted_secret text);
  insert into vault.decrypted_secrets values ('deposito_backup_project_url', 'https://proyecto.supabase.co/'), ('deposito_backup_service_role_key', 'SERVICE-KEY-SECRETA');
  delete from public.backup_runs where closing_day = d0;   -- (pasó el tiempo: el fallo anterior es más viejo que el nuevo pedido)
  update public.cash_closings set backup_requested_at = now() - interval '1 hour', backup_status = 'NO_CONFIGURADO' where day = d0;
  execute 'set local role authenticated'; perform _t.as_user(u3);   -- el cierre lo hace un secundario con permiso de caja
  j := public.cash_close(d0, 0, 0, 0, 'cierre 2', null);
  execute 'reset role';
  select count(*) into calls from net._calls;
  if calls <> 1 then raise exception 'FALLO B2: se esperaba 1 pedido de respaldo y hubo %', calls; end if;
  if (select url from net._calls) <> 'https://proyecto.supabase.co/functions/v1/deposito-backup' then raise exception 'FALLO B2: URL incorrecta: %', (select url from net._calls); end if;
  if (select headers ->> 'Authorization' from net._calls) <> 'Bearer SERVICE-KEY-SECRETA' then raise exception 'FALLO B2: no usa la clave interna'; end if;
  if (select body ->> 'reason' from net._calls) <> 'cierre_caja' or (select (body ->> 'day')::date from net._calls) <> d0 then raise exception 'FALLO B2: cuerpo incorrecto'; end if;
  if j -> 'backup' ->> 'status' <> 'pendiente' then raise exception 'FALLO B2: debía figurar pendiente: %', j -> 'backup'; end if;
  -- el secundario nunca recibe la clave
  if j::text like '%SERVICE-KEY%' then raise exception 'FALLO B2: la clave se filtró en la respuesta'; end if;

  -- 8c. Cierres repetidos en pocos minutos no disparan respaldos en cascada
  execute 'set local role authenticated'; perform _t.as_user(up);
  for n in 1..5 loop perform public.cash_close(d0, 0, 0, 0, 'otra vez', null); end loop;
  execute 'reset role';
  if (select count(*) from net._calls) <> 1 then raise exception 'FALLO B3: cierres repetidos generaron % respaldos', (select count(*) from net._calls); end if;

  -- 8d. El servidor termina el respaldo -> el cierre lo muestra como guardado
  insert into public.backup_runs(status, size_bytes, storage_path, triggered_by, reason, closing_day) values ('ok', 123456, '2026/11/x.json', 'cierre_caja', 'cierre_caja', d0);
  execute 'set local role authenticated'; perform _t.as_user(up);
  j := public.cash_report(d0);
  execute 'reset role';
  if j -> 'backup' ->> 'status' <> 'ok' or (j -> 'backup' ->> 'size_bytes')::bigint <> 123456 then raise exception 'FALLO B4: el respaldo guardado no figura: %', j -> 'backup'; end if;

  -- 8e. Si el servidor no responde en 10 minutos se informa, no se calla
  delete from public.backup_runs where closing_day = d0;
  update public.cash_closings set backup_requested_at = now() - interval '30 minutes', backup_status = 'SOLICITADO' where day = d0;
  execute 'set local role authenticated'; perform _t.as_user(up);
  j := public.cash_report(d0);
  execute 'reset role';
  if j -> 'backup' ->> 'status' <> 'sin_confirmar' then raise exception 'FALLO B5: debía avisar que no hubo confirmación: %', j -> 'backup'; end if;

  -- 8f. Si pg_net falla, el cierre igual se guarda
  create or replace function net.http_post(url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds integer default 5000)
    returns bigint language plpgsql as $f$ begin raise exception 'red caída'; end $f$;
  delete from public.backup_runs where closing_day = d0;
  update public.cash_closings set backup_requested_at = now() - interval '1 hour' where day = d0;
  execute 'set local role authenticated'; perform _t.as_user(up);
  j := public.cash_close(d0, 0, 0, 0, 'con red caída', null);
  execute 'reset role';
  if j -> 'closing' is null or j -> 'backup' ->> 'status' <> 'failed' then raise exception 'FALLO B6: el cierre debía guardarse aun con la red caída: %', j -> 'backup'; end if;

  -- ============ 9. El respaldo incluye caja y comisiones, y se puede restaurar ============
  execute 'set local role authenticated'; perform _t.as_user(up);
  j := public.backup_snapshot();
  execute 'reset role';
  foreach st in array array['cash_closings','cash_openings','supplier_commissions','order_commissions','commission_payouts'] loop
    if not (j -> 'database_tables' ? st) then raise exception 'FALLO R1: el respaldo no incluye %', st; end if;
  end loop;
  if jsonb_array_length(j -> 'database_tables' -> 'order_commissions') <> 3 or jsonb_array_length(j -> 'database_tables' -> 'commission_payouts') <> 3 then raise exception 'FALLO R1: filas incompletas en el respaldo'; end if;
  -- se pierde todo y se restaura
  delete from public.commission_payouts where true; delete from public.order_commissions where true; delete from public.supplier_commissions where true; delete from public.cash_closings where true;
  execute 'set local role authenticated'; perform _t.as_user(up);
  perform public.restore_backup(j -> 'database_tables', 'merge', false, null);
  execute 'reset role';
  if (select count(*) from public.order_commissions) <> 3 or (select count(*) from public.commission_payouts) <> 3 or (select count(*) from public.supplier_commissions) <> 2
     or (select count(*) from public.cash_closings) <> 1 then raise exception 'FALLO R2: la restauración no recuperó caja/comisiones'; end if;
  if (select sum(amount) from public.order_commissions) <> 332 then raise exception 'FALLO R2: importes restaurados incorrectos'; end if;

  -- ============ 10. Los respaldos siguen siendo solo del administrador principal ============
  execute 'set local role authenticated'; perform _t.as_user(u3);
  if not _t.fails('select public.backup_snapshot()', 'NO_AUTORIZADO') then raise exception 'FALLO R3: un secundario obtuvo el respaldo completo'; end if;
  perform _t.as_user(ua);
  if not _t.fails('select public.backup_snapshot()', 'NO_AUTORIZADO') then raise exception 'FALLO R3: un preventista obtuvo el respaldo completo'; end if;
  execute 'reset role';

  raise notice 'TODAS LAS PRUEBAS DE COMISIONES Y RESPALDO EN EL CIERRE PASARON';
end $t$;

rollback;
