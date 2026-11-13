-- =====================================================================
-- DepositoAPP · pruebas de movimientos de caja, cobro mixto y respaldo del cierre desde la app
-- Ejecutar DESPUÉS de 18_caja_movimientos_cobro_mixto_respaldo.sql (SQL Editor de Supabase o psql).
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
  u2 uuid := gen_random_uuid();  -- secundario SIN permiso de caja
  u3 uuid := gen_random_uuid();  -- secundario con caja
  ua uuid := gen_random_uuid();  -- preventista
  uw uuid := gen_random_uuid();  -- depósito
  sa uuid; p2 uuid; pub uuid; acct uuid; d0 date := (now() at time zone 'America/Argentina/Buenos_Aires')::date;
  o1 uuid; o2 uuid; o3 uuid; it record; j jsonb; x numeric; mid uuid; mid2 uuid; n int; path text := 'cierre/prueba-' || gen_random_uuid() || '.json.gz';
begin
  insert into auth.users(id, instance_id, aud, role, email, raw_user_meta_data) select u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'm_' || left(u::text, 8) || '@t.local', '{}'
    from unnest(array[up, u2, u3, ua, uw]) u;
  update public.profiles set role = 'admin_principal', active = true, full_name = 'Principal' where id = up;
  update public.profiles set role = 'admin_secundario', active = true, full_name = 'Sec sin caja', permissions = '{"orders":true}' where id = u2;
  update public.profiles set role = 'admin_secundario', active = true, full_name = 'Sec caja', permissions = '{"orders":true,"cash":true,"customers":true}' where id = u3;
  perform _t.as_user(up); execute 'set local role authenticated';
  perform public.admin_set_user(ua, 'proveedor', 'Ana Preventista', null, true, null, 'Ana');
  perform public.admin_set_user(uw, 'deposito', 'Operario', null, true);
  execute 'reset role';
  select id into sa from public.suppliers where profile_id = ua;
  select id into pub from public.customers where is_public;
  insert into public.customers(name, is_public, active) values ('Cliente con cuenta', false, true) returning id into acct;
  insert into public.products(code, name, price) values ('M-2', 'Prod M2', 200) returning id into p2;
  insert into public.product_costs(product_id, cost_price) values (p2, 150);
  update public.inventory set physical_stock = 1000 where product_id = p2;

  -- ============ 1. Quién puede anotar movimientos ============
  execute 'set local role authenticated';
  perform _t.as_user(u2);
  if not _t.fails(format('select public.cash_movement_add(%L, ''EGRESO'', ''Flete'', ''[{"method":"Efectivo","amount":10}]'')', d0), 'NO_AUTORIZADO') then raise exception 'FALLO M1: un secundario sin caja anotó un movimiento'; end if;
  perform _t.as_user(ua);
  if not _t.fails(format('select public.cash_movement_add(%L, ''INGRESO'', ''Aporte'', ''[{"method":"Efectivo","amount":10}]'')', d0), 'NO_AUTORIZADO') then raise exception 'FALLO M1: un preventista anotó un movimiento'; end if;
  if not _t.fails('select count(*) from public.cash_movements', 'permission') and (select count(*) from public.cash_movements) <> 0 then raise exception 'FALLO M1: un preventista lee los movimientos'; end if;
  perform _t.as_user(uw);
  if not _t.fails(format('select public.cash_movement_add(%L, ''EGRESO'', ''Flete'', ''[{"method":"Efectivo","amount":10}]'')', d0), 'NO_AUTORIZADO') then raise exception 'FALLO M1: el depósito anotó un movimiento'; end if;
  execute 'reset role';

  -- ============ 2. Validaciones ============
  execute 'set local role authenticated'; perform _t.as_user(u3);
  if not _t.fails(format('select public.cash_movement_add(%L, ''OTRO'', ''Flete'', ''[{"method":"Efectivo","amount":10}]'')', d0), 'DATOS_INVALIDOS') then raise exception 'FALLO M2: aceptó un tipo inválido'; end if;
  if not _t.fails(format('select public.cash_movement_add(%L, ''EGRESO'', '' '', ''[{"method":"Efectivo","amount":10}]'')', d0), 'CONCEPTO_REQUERIDO') then raise exception 'FALLO M2: aceptó concepto vacío'; end if;
  if not _t.fails(format('select public.cash_movement_add(%L, ''EGRESO'', ''Flete'', ''[]'')', d0), 'DATOS_INVALIDOS') then raise exception 'FALLO M2: aceptó sin medios'; end if;
  if not _t.fails(format('select public.cash_movement_add(%L, ''EGRESO'', ''Flete'', ''[{"method":"Efectivo","amount":0}]'')', d0), 'MONTO_INVALIDO') then raise exception 'FALLO M2: aceptó monto 0'; end if;
  if not _t.fails(format('select public.cash_movement_add(%L, ''EGRESO'', ''Flete'', ''[{"method":"Efectivo","amount":-5}]'')', d0), 'MONTO_INVALIDO') then raise exception 'FALLO M2: aceptó monto negativo'; end if;
  if not _t.fails(format('select public.cash_movement_add(%L, ''EGRESO'', ''Flete'', ''[{"method":"Efectivo","amount":"abc"}]'')', d0), 'MONTO_INVALIDO') then raise exception 'FALLO M2: aceptó monto no numérico'; end if;
  if not _t.fails(format('select public.cash_movement_add(%L, ''EGRESO'', ''Flete'', ''[{"method":"Cheque","amount":10}]'')', d0), 'MEDIO_INVALIDO') then raise exception 'FALLO M2: aceptó Cheque en un movimiento'; end if;
  if not _t.fails(format('select public.cash_movement_add(%L, ''EGRESO'', ''Flete'', ''[{"method":"Bitcoin","amount":10}]'')', d0), 'MEDIO_INVALIDO') then raise exception 'FALLO M2: aceptó un medio inventado'; end if;
  if not _t.fails(format('select public.cash_movement_add(%L, ''EGRESO'', ''Flete'', ''[{"method":"Efectivo","amount":5},{"method":"efectivo","amount":5}]'')', d0), 'MEDIO_REPETIDO') then raise exception 'FALLO M2: aceptó el mismo medio dos veces'; end if;
  if not _t.fails(format('select public.cash_movement_add(%L, ''EGRESO'', ''Flete'', ''[{"method":"Efectivo","amount":1},{"method":"Mercado Pago","amount":1},{"method":"Transferencia","amount":1},{"method":"Tarjeta","amount":1}]'')', d0), 'DATOS_INVALIDOS') then raise exception 'FALLO M2: aceptó 4 medios'; end if;
  if not _t.fails(format('select public.cash_movement_add(%L, ''EGRESO'', ''Flete'', ''[{"method":"Efectivo","amount":10}]'')', d0 + 1), 'FECHA_INVALIDA') then raise exception 'FALLO M2: aceptó un día futuro'; end if;
  if not _t.fails(format('select public.cash_movement_add(%L, ''EGRESO'', ''Flete'', ''{"method":"Efectivo","amount":10}'')', d0), 'DATOS_INVALIDOS') then raise exception 'FALLO M2: aceptó un objeto en lugar de una lista'; end if;
  if not _t.fails(format('select public.cash_movement_add(%L, ''EGRESO'', ''Flete'', ''[{"method":"Efectivo","amount":2000000000}]'')', d0), 'MONTO_INVALIDO') then raise exception 'FALLO M2: aceptó un monto gigante'; end if;
  execute 'reset role';
  if (select count(*) from public.cash_movements) <> 0 then raise exception 'FALLO M2: quedó algún movimiento inválido guardado'; end if;

  -- ============ 3. Movimientos válidos (incluye mixtos) y su efecto en el informe ============
  execute 'set local role authenticated'; perform _t.as_user(u3);
  perform public.cash_open(d0, 1000, 500, 10);                                    -- efectivo 1000, MP 500, retención 10 %
  j := public.cash_movement_add(d0, 'EGRESO', '  Flete   a Córdoba ', '[{"method":"Efectivo","amount":300}]', 'camión');
  j := public.cash_movement_add(d0, 'EGRESO', 'Pago a proveedor', '[{"method":"Efectivo","amount":200},{"method":"Mercado Pago","amount":100},{"method":"Transferencia","amount":50}]');
  j := public.cash_movement_add(d0, 'INGRESO', 'Aporte del dueño', '[{"method":"Efectivo","amount":1000},{"method":"Mercado Pago","amount":400}]');
  j := public.cash_movement_add(d0, 'INGRESO', 'Venta de bolsas', '[{"method":"Mercado Pago","amount":70.50}]');
  if jsonb_array_length(j -> 'movements') <> 4 then raise exception 'FALLO M3: la lista tiene % movimientos', jsonb_array_length(j -> 'movements'); end if;
  if (j -> 'movements' -> 0 ->> 'concept') <> 'Flete a Córdoba' then raise exception 'FALLO M3: el concepto no se normalizó: %', j -> 'movements' -> 0 ->> 'concept'; end if;
  -- Efectivo: ingresos 1000, egresos 500 | MP: ingresos 470.50, egresos 100 | Cuenta: egresos 50
  if (j -> 'mov' -> 'in' ->> 'Efectivo')::numeric <> 1000 or (j -> 'mov' -> 'out' ->> 'Efectivo')::numeric <> 500
     or (j -> 'mov' -> 'in' ->> 'Mercado Pago')::numeric <> 470.50 or (j -> 'mov' -> 'out' ->> 'Mercado Pago')::numeric <> 100
     or (j -> 'mov' -> 'out' ->> 'Transferencia')::numeric <> 50 or (j -> 'mov' ->> 'count')::int <> 4
     or (j -> 'mov' ->> 'in_total')::numeric <> 1470.50 or (j -> 'mov' ->> 'out_total')::numeric <> 650 then
    raise exception 'FALLO M3: resumen de movimientos = %', j -> 'mov'; end if;
  -- MP esperado = 500 (inicio) + 0 cobrado − 0 retención + 470,50 − 100 = 870,50
  if (j -> 'mp' ->> 'expected')::numeric <> 870.50 then raise exception 'FALLO M3: MP esperado = %', j -> 'mp' ->> 'expected'; end if;
  if (j ->> 'total')::numeric <> 0 or (j ->> 'count')::int <> 0 then raise exception 'FALLO M3: los movimientos no deben contarse como cobros a clientes'; end if;
  perform _t.as_user(u3);
  if (select count(*) from public.cash_movements) <> 4 then raise exception 'FALLO M3: el usuario con caja no ve los movimientos'; end if;
  execute 'reset role';

  -- ============ 4. Anular ============
  select id into mid from public.cash_movements where concept = 'Venta de bolsas';
  execute 'set local role authenticated'; perform _t.as_user(u3);
  if not _t.fails(format('select public.cash_movement_void(%L, '''')', mid), 'MOTIVO_REQUERIDO') then raise exception 'FALLO M4: anuló sin motivo'; end if;
  if not _t.fails('select public.cash_movement_void(gen_random_uuid(), ''error de carga'')', 'NO_ENCONTRADO') then raise exception 'FALLO M4: anuló uno inexistente'; end if;
  perform _t.as_user(u2);
  if not _t.fails(format('select public.cash_movement_void(%L, ''error de carga'')', mid), 'NO_AUTORIZADO') then raise exception 'FALLO M4: un secundario sin caja anuló'; end if;
  perform _t.as_user(u3);
  j := public.cash_movement_void(mid, 'error de carga');
  if (j -> 'mov' ->> 'count')::int <> 3 or (j -> 'mov' -> 'in' ->> 'Mercado Pago')::numeric <> 400 or (j -> 'mp' ->> 'expected')::numeric <> 800 then
    raise exception 'FALLO M4: tras anular, resumen = % / MP = %', j -> 'mov', j -> 'mp' ->> 'expected'; end if;
  if jsonb_array_length(j -> 'movements') <> 4 or not exists (select 1 from jsonb_array_elements(j -> 'movements') m where (m ->> 'voided')::boolean) then
    raise exception 'FALLO M4: el movimiento anulado debía seguir en la lista marcado'; end if;
  if not _t.fails(format('select public.cash_movement_void(%L, ''otra vez'')', mid), 'YA_ANULADO') then raise exception 'FALLO M4: anuló dos veces'; end if;
  execute 'reset role';
  if (select count(*) from public.audit_logs where action = 'MOVIMIENTO_CAJA') <> 4 or (select count(*) from public.audit_logs where action = 'ANULAR_MOVIMIENTO_CAJA') <> 1 then
    raise exception 'FALLO M4: falta auditoría'; end if;
  -- Nadie puede tocar la tabla directamente
  execute 'set local role authenticated'; perform _t.as_user(up);
  if not _t.fails(format('update public.cash_movements set amount = 1 where id = %L', mid), 'permission denied') then raise exception 'FALLO M4: se pudo editar un movimiento directo'; end if;
  if not _t.fails('delete from public.cash_movements where true', 'permission denied') then raise exception 'FALLO M4: se pudo borrar un movimiento directo'; end if;
  if not _t.fails('insert into public.cash_movements(day, kind, concept, amount, parts) values (current_date, ''INGRESO'', ''x1'', 5, ''[]'')', 'permission denied') then raise exception 'FALLO M4: se pudo insertar un movimiento directo'; end if;
  execute 'reset role';

  -- ============ 5. Cierre de caja: el arqueo incluye los movimientos ============
  -- Efectivo esperado = 1000 (fondo) + 0 cobros + 1000 ingresos − 500 egresos − 25 otros retiros = 1475
  execute 'set local role authenticated'; perform _t.as_user(u3);
  j := public.cash_close(d0, 0, 25, 1475, 'cierre con movimientos', 800);
  execute 'reset role';
  if (j -> 'closing' ->> 'expected_cash')::numeric <> 1475 or (j -> 'closing' ->> 'difference')::numeric <> 0 then raise exception 'FALLO M5: arqueo = %', j -> 'closing'; end if;
  if (j -> 'closing' ->> 'mp_expected')::numeric <> 800 or (j -> 'closing' ->> 'mp_difference')::numeric <> 0 then raise exception 'FALLO M5: arqueo MP = %', j -> 'closing'; end if;
  if (j ->> 'stale')::boolean then raise exception 'FALLO M5: recién cerrada no debía figurar desactualizada'; end if;
  -- Un movimiento posterior deja el cierre desactualizado; anularlo lo vuelve a dejar al día no, porque cambió el resumen
  execute 'set local role authenticated'; perform _t.as_user(u3);
  j := public.cash_movement_add(d0, 'EGRESO', 'Gasto olvidado', '[{"method":"Efectivo","amount":40}]');
  if not (j ->> 'stale')::boolean then raise exception 'FALLO M5: un movimiento nuevo debía marcar el cierre como desactualizado'; end if;
  j := public.cash_close(d0, 0, 25, 1435, null, 800);
  if (j ->> 'stale')::boolean or (j -> 'closing' ->> 'expected_cash')::numeric <> 1435 then raise exception 'FALLO M5: re-cierre = %', j -> 'closing'; end if;
  execute 'reset role';
  -- Un cierre antiguo (sin movimientos guardados) no aparece como desactualizado si no hay movimientos
  delete from public.cash_movements where true;
  update public.cash_closings set mov = '{}'::jsonb where day = d0;
  execute 'set local role authenticated'; perform _t.as_user(u3);
  j := public.cash_report(d0);
  if (j ->> 'stale')::boolean then raise exception 'FALLO M5: un cierre antiguo sin movimientos figura desactualizado'; end if;
  execute 'reset role';

  -- ============ 6. Cobro mixto al entregar (cliente con cuenta corriente) ============
  execute 'set local role authenticated';
  perform _t.as_user(ua);
  o1 := public.submit_order(gen_random_uuid(), jsonb_build_array(jsonb_build_object('product_id', p2, 'qty', 5)), null, acct);   -- $1000
  perform _t.as_user(up); perform public.approve_order(o1);
  perform _t.as_user(uw); perform public.start_preparation(o1);
  for it in select id, qty_approved from public.order_items where order_id = o1 loop perform public.report_item(it.id, it.qty_approved); end loop;
  perform public.finish_preparation(o1);
  perform _t.as_user(up);
  if not _t.fails(format('select public.confirm_delivery_with_payments(%L, ''[{"method":"Efectivo","amount":1000.01}]'')', o1), 'MONTO_EXCEDIDO') then raise exception 'FALLO P1: cobró de más'; end if;
  if not _t.fails(format('select public.confirm_delivery_with_payments(%L, ''[{"method":"Efectivo","amount":500},{"method":"Efectivo","amount":500}]'')', o1), 'MEDIO_REPETIDO') then raise exception 'FALLO P1: aceptó medio repetido'; end if;
  if not _t.fails(format('select public.confirm_delivery_with_payments(%L, ''[{"method":"Bitcoin","amount":100}]'')', o1), 'MEDIO_INVALIDO') then raise exception 'FALLO P1: aceptó un medio inventado'; end if;
  execute 'reset role';
  if (select status from public.orders where id = o1) = 'ENTREGADO' then raise exception 'FALLO P1: un cobro inválido dejó el pedido entregado'; end if;
  execute 'set local role authenticated'; perform _t.as_user(up);
  perform public.confirm_delivery_with_payments(o1, '[{"method":"Efectivo","amount":400},{"method":"Mercado Pago","amount":350},{"method":"Transferencia","amount":150}]'::jsonb);   -- queda debiendo 100
  execute 'reset role';
  if (select status from public.orders where id = o1) <> 'ENTREGADO' then raise exception 'FALLO P1: el pedido no quedó entregado'; end if;
  if (select count(*) from public.order_payments where order_id = o1) <> 3 or (select sum(amount) from public.order_payments where order_id = o1) <> 900 then raise exception 'FALLO P1: pagos del pedido mal registrados'; end if;
  select sum(amount) into x from public.customer_movements where customer_id = acct;
  if x <> 100 then raise exception 'FALLO P1: el saldo del cliente debía ser 100 y es %', x; end if;
  if (select count(*) from public.customer_movements where customer_id = acct and kind = 'PAGO' and note like '%mixto%') <> 3 then raise exception 'FALLO P1: faltan las notas de cobro mixto'; end if;
  execute 'set local role authenticated'; perform _t.as_user(u3);
  j := public.cash_report(d0);
  if (j -> 'by_method' ->> 'Efectivo')::numeric <> 400 or (j -> 'by_method' ->> 'Mercado Pago')::numeric <> 350 or (j -> 'by_method' ->> 'Transferencia')::numeric <> 150 or (j ->> 'total')::numeric <> 900 or (j ->> 'count')::int <> 3 then
    raise exception 'FALLO P1: la caja no muestra el cobro mixto: %', j -> 'by_method'; end if;
  if not (j ->> 'stale')::boolean then raise exception 'FALLO P1: cobrar después del cierre debía marcarlo desactualizado'; end if;
  execute 'reset role';

  -- ============ 7. Todo a cuenta corriente, y cliente SIN cuenta (debe cobrarse completo) ============
  execute 'set local role authenticated';
  perform _t.as_user(ua);
  o2 := public.submit_order(gen_random_uuid(), jsonb_build_array(jsonb_build_object('product_id', p2, 'qty', 2)), null, acct);   -- $400
  o3 := public.submit_order(gen_random_uuid(), jsonb_build_array(jsonb_build_object('product_id', p2, 'qty', 3)), null, pub);    -- $600
  perform _t.as_user(up); perform public.approve_order(o2); perform public.approve_order(o3);
  perform _t.as_user(uw);
  foreach mid in array array[o2, o3] loop
    perform public.start_preparation(mid);
    for it in select id, qty_approved from public.order_items where order_id = mid loop perform public.report_item(it.id, it.qty_approved); end loop;
    perform public.finish_preparation(mid);
  end loop;
  perform _t.as_user(up);
  perform public.confirm_delivery_with_payments(o2, '[]'::jsonb);
  if not _t.fails(format('select public.confirm_delivery_with_payments(%L, ''[{"method":"Efectivo","amount":599.99}]'')', o3), 'COBRO_INCOMPLETO') then raise exception 'FALLO P2: cliente sin cuenta con cobro incompleto'; end if;
  if not _t.fails(format('select public.confirm_delivery_with_payments(%L, ''[]'')', o3), 'COBRO_INCOMPLETO') then raise exception 'FALLO P2: cliente sin cuenta sin cobro'; end if;
  perform public.confirm_delivery_with_payments(o3, '[{"method":"Efectivo","amount":300},{"method":"Mercado Pago","amount":300}]'::jsonb);
  execute 'reset role';
  if (select status from public.orders where id = o2) <> 'ENTREGADO' or (select status from public.orders where id = o3) <> 'ENTREGADO' then raise exception 'FALLO P2: pedidos sin entregar'; end if;
  select sum(amount) into x from public.customer_movements where customer_id = acct;
  if x <> 500 then raise exception 'FALLO P2: saldo a cuenta = % (esperado 500)', x; end if;
  if exists (select 1 from public.customer_movements where customer_id = pub) then raise exception 'FALLO P2: el cliente público no debe tener cuenta'; end if;
  -- Sin permiso de pedidos no se puede cobrar
  execute 'set local role authenticated'; perform _t.as_user(ua);
  if not _t.fails(format('select public.confirm_delivery_with_payments(%L, ''[]'')', o1), 'NO_AUTORIZADO') then raise exception 'FALLO P2: un preventista usó el cobro mixto'; end if;
  execute 'reset role';

  -- ============ 8. Pago de cuenta corriente con varios medios ============
  execute 'set local role authenticated'; perform _t.as_user(u3);
  perform public.customer_register_payment_split(acct, '[{"method":"Efectivo","amount":200},{"method":"Transferencia","amount":100.50}]'::jsonb, 'cuota');
  if not _t.fails(format('select public.customer_register_payment_split(%L, ''[{"method":"Efectivo","amount":0}]'')', acct), 'MONTO_INVALIDO') then raise exception 'FALLO P3: aceptó monto 0'; end if;
  if not _t.fails(format('select public.customer_register_payment_split(%L, ''[]'')', acct), 'DATOS_INVALIDOS') then raise exception 'FALLO P3: aceptó lista vacía'; end if;
  if not _t.fails(format('select public.customer_register_payment_split(%L, ''[{"method":"Efectivo","amount":5}]'')', pub), 'NO_ENCONTRADO') then raise exception 'FALLO P3: registró pago en el cliente público'; end if;
  perform _t.as_user(ua);
  if not _t.fails(format('select public.customer_register_payment_split(%L, ''[{"method":"Efectivo","amount":5}]'')', acct), 'NO_AUTORIZADO') then raise exception 'FALLO P3: un preventista registró un pago'; end if;
  execute 'reset role';
  select sum(amount) into x from public.customer_movements where customer_id = acct;
  if x <> 199.50 then raise exception 'FALLO P3: saldo tras el pago mixto = % (esperado 199,50)', x; end if;
  execute 'set local role authenticated'; perform _t.as_user(u3);
  j := public.cash_report(d0);
  -- cobros del día: 400+350+150 (pedido 1) + 300+300 (pedido 3) + 200+100,50 (pago de cuenta) = 1800,50
  if (j ->> 'total')::numeric <> 1800.50 or (j ->> 'count')::int <> 7 then raise exception 'FALLO P3: total de cobros = % (%)', j ->> 'total', j ->> 'count'; end if;
  execute 'reset role';

  -- ============ 9. Respaldo del cierre guardado desde la app ============
  execute 'set local role authenticated'; perform _t.as_user(u3);
  if not _t.fails(format('select public.cash_backup_register(%L, %L, 10)', d0, path), 'NO_AUTORIZADO') then raise exception 'FALLO B1: un secundario registró un respaldo'; end if;
  if not _t.fails(format('insert into storage.objects(bucket_id, name) values (''database-backups'', %L)', path), 'row-level security') then raise exception 'FALLO B1: un secundario subió un archivo al bucket de respaldos'; end if;
  perform _t.as_user(up);
  if not _t.fails(format('select public.cash_backup_register(%L, %L, 10)', d0, path), 'RESPALDO_NO_ENCONTRADO') then raise exception 'FALLO B1: registró un archivo que no existe'; end if;
  if not _t.fails(format('select public.cash_backup_register(%L, %L, 10)', d0, 'otra/ruta.json.gz'), 'DATOS_INVALIDOS') then raise exception 'FALLO B1: aceptó una ruta fuera de cierre/'; end if;
  if not _t.fails(format('select public.cash_backup_register(%L, %L, 10)', d0, 'cierre/../x.json.gz'), 'DATOS_INVALIDOS') then raise exception 'FALLO B1: aceptó una ruta con ..'; end if;
  if not _t.fails(format('insert into storage.objects(bucket_id, name) values (''database-backups'', %L)', 'otra/x.json.gz'), 'row-level security') then raise exception 'FALLO B1: el principal subió fuera de cierre/'; end if;
  execute format('insert into storage.objects(bucket_id, name, metadata) values (''database-backups'', %L, ''{"size": 4321}'')', path);
  j := public.cash_backup_register(d0, path, 1);
  execute 'reset role';
  if j -> 'backup' ->> 'status' <> 'ok' or (j -> 'backup' ->> 'size_bytes')::bigint <> 4321 then raise exception 'FALLO B1: el respaldo no quedó como ok: %', j -> 'backup'; end if;
  if (select backup_status from public.cash_closings where day = d0) <> 'OK_APP' then raise exception 'FALLO B1: estado del cierre'; end if;
  if not exists (select 1 from public.backup_runs where storage_path = path and status = 'ok' and closing_day = d0) then raise exception 'FALLO B1: falta el registro del respaldo'; end if;

  -- ============ 10. El respaldo y la restauración incluyen los movimientos ============
  execute 'set local role authenticated'; perform _t.as_user(u3);
  perform public.cash_movement_add(d0, 'INGRESO', 'Para respaldo', '[{"method":"Efectivo","amount":77}]');
  execute 'reset role';
  execute 'set local role authenticated'; perform _t.as_user(up);
  j := public.backup_snapshot()::jsonb;
  if jsonb_array_length(j -> 'database_tables' -> 'cash_movements') <> 1 then raise exception 'FALLO R1: el respaldo no incluye los movimientos'; end if;
  execute 'reset role';
  execute 'alter table public.cash_movements disable trigger user';
  delete from public.cash_movements where true;
  execute 'set local role authenticated'; perform _t.as_user(up);
  perform public.restore_backup(jsonb_build_object('cash_movements', j -> 'database_tables' -> 'cash_movements'), 'merge', false, null);
  execute 'reset role';
  select count(*) into n from public.cash_movements where concept = 'Para respaldo' and amount = 77;
  if n <> 1 then raise exception 'FALLO R1: la restauración no recuperó el movimiento (%)', n; end if;

  raise notice 'TODAS LAS PRUEBAS DE MOVIMIENTOS DE CAJA, COBRO MIXTO Y RESPALDO DESDE LA APP PASARON';
end $t$;

rollback;
