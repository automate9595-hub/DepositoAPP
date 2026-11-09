-- =====================================================================
-- DepositoAPP · pruebas de escenarios (SQL Editor de Supabase)
-- Ejecuta el flujo completo con usuarios de prueba y termina en ROLLBACK:
-- NO deja datos en su base. Si algo falla, el mensaje indica la prueba.
-- Cubre las pruebas obligatorias 1 a 17 (la 18, reconexión, se prueba en la app).
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

do $t$
declare
  ua uuid := gen_random_uuid(); us1 uuid := gen_random_uuid(); us2 uuid := gen_random_uuid(); uw uuid := gen_random_uuid();
  p1 uuid; p2 uuid; o1 uuid; o1b uuid; it1 uuid; s1 uuid; req uuid := gen_random_uuid();
  n int; phys int; resv int; st text;
begin
  -- 1. Crear un administrador (secundario con todos los permisos, para no tocar al principal real)
  insert into auth.users(id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at) values
    (ua,  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 't_admin@test.local', '{}', now(), now()),
    (us1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 't_prov1@test.local', '{}', now(), now()),
    (us2, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 't_prov2@test.local', '{}', now(), now()),
    (uw,  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 't_dep@test.local',   '{}', now(), now());
  update public.profiles set role = 'admin_secundario', active = true, full_name = 'Admin Test',
    permissions = '{"orders":true,"inventory":true,"products":true,"stats":true,"users":true,"audit":true}'::jsonb where id = ua;
  if not exists (select 1 from public.profiles where id = ua and active) then raise exception 'FALLO 1: administrador'; end if;
  -- Un usuario recién registrado NO tiene acceso hasta que un admin lo active
  if (select role from public.profiles where id = us1) is not null then raise exception 'FALLO 1b: perfil nuevo no debe tener rol'; end if;

  -- 2. Crear dos proveedores (y un trabajador) como administrador
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  perform public.admin_set_user(us1, 'proveedor', 'Prov Uno', null, true, null, 'Proveedor Uno SA');
  perform public.admin_set_user(us2, 'proveedor', 'Prov Dos', null, true, null, 'Proveedor Dos SA');
  perform public.admin_set_user(uw, 'deposito', 'Operario', null, true);

  -- 3. Crear productos  /  4. Cargar stock
  insert into public.products(code, name, price) values ('T-001', 'Producto Test 1', 100) returning id into p1;
  insert into public.products(code, name, price) values ('T-002', 'Producto Test 2', 50) returning id into p2;
  perform public.adjust_stock(p1, 10, 'INGRESO', 'carga inicial');
  perform public.adjust_stock(p2, 5, 'INGRESO', 'carga inicial');

  -- 5. Consultar stock desde ambos proveedores
  perform set_config('request.jwt.claims', json_build_object('sub', us1, 'role', 'authenticated')::text, true);
  select available_stock into n from public.inventory where product_id = p1;
  if n <> 10 then raise exception 'FALLO 5: proveedor 1 ve % en lugar de 10', n; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', us2, 'role', 'authenticated')::text, true);
  select available_stock into n from public.inventory where product_id = p1;
  if n <> 10 then raise exception 'FALLO 5: proveedor 2 ve % en lugar de 10', n; end if;

  -- 6. Crear un pedido (proveedor 1) y 17. comprobar que no se duplica
  perform set_config('request.jwt.claims', json_build_object('sub', us1, 'role', 'authenticated')::text, true);
  o1 := public.submit_order(req, jsonb_build_array(jsonb_build_object('product_id', p1, 'qty', 6)), 'nota', (select id from public.customers where is_public));
  o1b := public.submit_order(req, jsonb_build_array(jsonb_build_object('product_id', p1, 'qty', 6)), 'nota', (select id from public.customers where is_public));
  if o1 is distinct from o1b then raise exception 'FALLO 17: el reintento creó otro pedido'; end if;
  select count(*) into n from public.orders where client_request_id = req;
  if n <> 1 then raise exception 'FALLO 17: % pedidos duplicados', n; end if;
  select id into it1 from public.order_items where order_id = o1;

  -- 7. Recibirlo en el administrador / 8. Aprobarlo
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  select count(*) into n from public.orders where id = o1 and status = 'PENDIENTE_APROBACION';
  if n <> 1 then raise exception 'FALLO 7: el admin no ve el pedido pendiente'; end if;
  perform public.approve_order(o1);

  -- 9. Verificar la reserva
  select reserved_stock, available_stock into resv, n from public.inventory where product_id = p1;
  if resv <> 6 or n <> 4 then raise exception 'FALLO 9: reservado %, disponible %', resv, n; end if;

  -- 10. Pedido con stock insuficiente (proveedor 2)
  perform set_config('request.jwt.claims', json_build_object('sub', us2, 'role', 'authenticated')::text, true);
  if not _t.fails(format($q$select public.submit_order(gen_random_uuid(), '[{"product_id":"%s","qty":5}]'::jsonb, null, %L)$q$, p1, (select id from public.customers where is_public)), 'STOCK_INSUFICIENTE') then
    raise exception 'FALLO 10: se aceptó un pedido sin stock suficiente';
  end if;

  -- 11. Preparar / 12. Informar faltante
  perform set_config('request.jwt.claims', json_build_object('sub', uw, 'role', 'authenticated')::text, true);
  perform public.start_preparation(o1);
  if not _t.fails(format('select public.report_item(%L, 2)', it1), 'MOTIVO_REQUERIDO') then
    raise exception 'FALLO 12: faltante sin motivo aceptado';
  end if;
  perform public.report_item(it1, 4, 'faltan unidades en estantería');
  select status into st from public.orders where id = o1;
  if st <> 'PREPARADO_PARCIALMENTE' then raise exception 'FALLO 12: estado %', st; end if;
  perform public.finish_preparation(o1);

  -- 13. Confirmar entrega parcial
  perform public.confirm_delivery(o1);
  execute 'reset role';
  select status into st from public.orders where id = o1;
  if st <> 'ENTREGADO' then raise exception 'FALLO 13: estado %', st; end if;

  -- 14. Movimientos de inventario: físico 10-4 = 6, reservado 0
  select physical_stock, reserved_stock into phys, resv from public.inventory where product_id = p1;
  if phys <> 6 or resv <> 0 then raise exception 'FALLO 14: físico %, reservado %', phys, resv; end if;
  select count(*) into n from public.stock_movements where product_id = p1;
  if n <> 4 then raise exception 'FALLO 14: % movimientos (se esperaban 4)', n; end if;

  -- 15. Historial visible para el proveedor
  perform set_config('request.jwt.claims', json_build_object('sub', us1, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into n from public.order_status_history where order_id = o1;
  if n < 6 then raise exception 'FALLO 15: historial con % filas', n; end if;

  -- 16. Permisos entre usuarios
  with u as (update public.products set price = 1 returning 1) select count(*) into n from u;
  if n <> 0 then raise exception 'FALLO 16: el proveedor modificó precios'; end if;
  if not _t.fails(format('select public.adjust_stock(%L, 5, ''INGRESO'')', p1), 'NO_AUTORIZADO') then
    raise exception 'FALLO 16: el proveedor modificó stock';
  end if;
  if not _t.fails(format('update public.inventory set physical_stock = 999 where product_id = %L', p1), 'permission denied') then
    raise exception 'FALLO 16: el proveedor escribió en inventory';
  end if;
  if not _t.fails(format('select public.approve_order(%L)', o1), 'NO_AUTORIZADO') then
    raise exception 'FALLO 16: el proveedor aprobó un pedido';
  end if;
  perform set_config('request.jwt.claims', json_build_object('sub', us2, 'role', 'authenticated')::text, true);
  select count(*) into n from public.orders where id = o1;
  if n <> 0 then raise exception 'FALLO 16: un proveedor ve pedidos de otro'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', uw, 'role', 'authenticated')::text, true);
  with u as (update public.products set price = 1 returning 1) select count(*) into n from u;
  if n <> 0 then raise exception 'FALLO 16: el depósito modificó precios'; end if;
  if not _t.fails('select public.admin_set_user(gen_random_uuid(), ''proveedor'', ''x'', null, true)', 'NO_AUTORIZADO') then
    raise exception 'FALLO 16: el depósito administró usuarios';
  end if;
  execute 'reset role';

  raise notice 'TODAS LAS PRUEBAS PASARON (1-17). La 18 (reconexión) se prueba en la app.';
end $t$;

rollback;
