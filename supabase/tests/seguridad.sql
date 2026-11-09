-- =====================================================================
-- DepositoAPP · PRUEBAS DE SEGURIDAD de la base de datos
-- Ejecutar con todas las migraciones instaladas (SQL Editor de Supabase o psql). Termina en ROLLBACK.
-- Recorre TODO lo que la app expone (tablas y funciones) y ataca como cada tipo de usuario.
-- Al final lista todos los hallazgos juntos; si no hay ninguno dice "SEGURIDAD OK".
-- =====================================================================
begin;

create schema if not exists _t;
grant usage on schema _t to authenticated, anon;
create or replace function _t.fails(q text, pat text default '') returns boolean
language plpgsql as $f$
begin execute q; return false;
exception when others then return pat = '' or sqlerrm ilike '%' || pat || '%';
end $f$;
-- ¿La consulta devuelve alguna fila? (0 = no ve nada, o error de permiso = tampoco ve)
create or replace function _t.rows_seen(q text) returns int language plpgsql as $f$
declare n int; begin execute 'select count(*) from (' || q || ') x' into n; return n;
exception when insufficient_privilege then return 0; end $f$;
-- ¿Cuántas filas llegó a modificar una sentencia? (0 = RLS la dejó sin efecto; error de permiso = también 0)
create or replace function _t.rows_affected(q text) returns int language plpgsql as $f$
declare n int; begin execute q; get diagnostics n = row_count; return n;
exception when insufficient_privilege then return 0; end $f$;
create or replace function _t.as_user(u uuid) returns void language sql as $f$
  select set_config('request.jwt.claims', case when u is null then '{"role":"anon"}' else json_build_object('sub', u, 'role', 'authenticated')::text end, true) $f$;
grant execute on function _t.fails(text, text), _t.rows_seen(text), _t.rows_affected(text), _t.as_user(uuid) to authenticated, anon;
create temp table _hallazgos(n serial, area text, detalle text);
grant all on _hallazgos to authenticated, anon;
grant usage on sequence _hallazgos_n_seq to authenticated, anon;
create or replace function _t.hallazgo(a text, d text) returns void language sql as $f$ insert into _hallazgos(area, detalle) values (a, d) $f$;
grant execute on function _t.hallazgo(text, text) to authenticated, anon;
create temp table _pruebas(n int);   -- cuenta de comprobaciones hechas
grant all on _pruebas to authenticated, anon;

do $t$
declare
  up uuid := gen_random_uuid(); u2 uuid := gen_random_uuid(); u3 uuid := gen_random_uuid(); ua uuid := gen_random_uuid();
  ub uuid := gen_random_uuid(); uw uuid := gen_random_uuid(); un uuid := gen_random_uuid(); ui uuid := gen_random_uuid();
  sa uuid; sb uuid; p1 uuid; cust_a uuid; cust_b uuid; cust_pub uuid; oa uuid; ob uuid; itb uuid;
  r record; n int; st text; q text; args text; j jsonb; persona uuid;
  checks int := 0;
  personas uuid[]; pnames text[] := array['pendiente (sin rol)','preventista','depósito','secundario sin permisos','preventista inactivo'];
  i int; k int;
  -- Funciones que cualquier usuario con sesión PUEDE ejecutar con éxito (consultan o editan lo propio).
  self_service constant text[] := array['my_role','is_admin','has_perm','my_supplier_id','is_worker','can_prepare',
    'update_my_profile','mark_notifications_read','my_passkeys','register_passkey','delete_passkey','commission_summary','customers_overview'];
begin
  -- ---------- Datos de prueba ----------
  insert into auth.users(id, instance_id, aud, role, email, raw_user_meta_data)
    select u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 's_' || left(u::text, 8) || '@t.local', '{}'
    from unnest(array[up, u2, u3, ua, ub, uw, un, ui]) u;
  update public.profiles set role = 'admin_principal', active = true, full_name = 'Principal' where id = up;
  update public.profiles set role = 'admin_secundario', active = true, full_name = 'Sec sin permisos', permissions = '{}' where id = u2;
  update public.profiles set role = 'admin_secundario', active = true, full_name = 'Sec con usuarios', permissions = '{"users":true,"orders":true}' where id = u3;
  perform _t.as_user(up); execute 'set local role authenticated';
  perform public.admin_set_user(ua, 'proveedor', 'Ana', null, true, null, 'Ana');
  perform public.admin_set_user(ub, 'proveedor', 'Beto', null, true, null, 'Beto');
  perform public.admin_set_user(uw, 'deposito', 'Operario', null, true);
  perform public.admin_set_user(ui, 'proveedor', 'Inactivo', null, false, null, 'Inactivo');
  execute 'reset role';
  select id into sa from public.suppliers where profile_id = ua;
  select id into sb from public.suppliers where profile_id = ub;
  select id into cust_pub from public.customers where is_public;
  insert into public.customers(name, supplier_id) values ('Cliente de Ana', sa) returning id into cust_a;
  insert into public.customers(name, supplier_id) values ('Cliente de Beto', sb) returning id into cust_b;
  insert into public.products(code, name, price) values ('SEG-1', 'Producto seguridad', 100) returning id into p1;
  insert into public.product_costs(product_id, cost_price) values (p1, 40);
  update public.inventory set physical_stock = 100 where product_id = p1;
  perform _t.as_user(ua); execute 'set local role authenticated';
  oa := public.submit_order(gen_random_uuid(), jsonb_build_array(jsonb_build_object('product_id', p1, 'qty', 2)), 'nota A', cust_a);
  perform _t.as_user(ub);
  ob := public.submit_order(gen_random_uuid(), jsonb_build_array(jsonb_build_object('product_id', p1, 'qty', 3)), 'nota B', cust_b);
  execute 'reset role';
  select id into itb from public.order_items where order_id = ob;
  insert into public.audit_logs(action, entity) values ('SEMILLA', 'x');
  insert into storage.objects(bucket_id, name) values ('database-backups', '2026/11/respaldo-secreto.json');

  -- ================= A. Superficie de tablas =================
  for r in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity loop
    perform _t.hallazgo('RLS', 'La tabla public.' || r.relname || ' no tiene RLS activado');
  end loop;
  for r in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r','v') loop
    if has_table_privilege('anon', 'public.' || quote_ident(r.relname), 'select,insert,update,delete') then
      perform _t.hallazgo('ANON', 'anon (sin sesión) tiene privilegios sobre public.' || r.relname);
    end if;
  end loop;
  for r in select c.relname, string_agg(p.priv, ',') privs
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
           cross join (values ('insert'),('update'),('delete'),('truncate')) p(priv)
           where n.nspname = 'public' and c.relkind = 'r' and has_table_privilege('authenticated', 'public.' || quote_ident(c.relname), p.priv)
           group by c.relname loop
    if r.relname not in ('categories','products','backup_settings') then
      perform _t.hallazgo('ESCRITURA', 'authenticated puede (' || r.privs || ') directo en public.' || r.relname);
    end if;
  end loop;
  foreach st in array array['cash_closings','cash_openings','supplier_commissions','order_commissions','commission_payouts','passkey_challenges'] loop
    if has_table_privilege('authenticated', 'public.' || st, 'select') then
      perform _t.hallazgo('LECTURA', 'authenticated puede leer directo public.' || st);
    end if;
  end loop;

  -- ================= B. Superficie de funciones =================
  for r in select p.oid::regprocedure::text sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.prosecdef and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%') loop
    perform _t.hallazgo('FUNCION', r.sig || ' es SECURITY DEFINER sin search_path fijo (riesgo de secuestro)');
  end loop;
  for r in select p.oid::regprocedure::text sig, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.prokind = 'f'
             and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e') loop
    if has_function_privilege('anon', r.sig, 'execute') and r.sig not like '%touch_updated_at%' then
      perform _t.hallazgo('FUNCION', 'anon puede ejecutar ' || r.sig);
    end if;
    if r.proname like '\_%' and has_function_privilege('authenticated', r.sig, 'execute') then
      perform _t.hallazgo('FUNCION', 'función interna ' || r.sig || ' invocable por usuarios');
    end if;
  end loop;
  if has_function_privilege('authenticated', 'public.bootstrap_principal(text)', 'execute') then
    perform _t.hallazgo('FUNCION', 'bootstrap_principal invocable por usuarios (podría convertirse en administrador principal)');
  end if;

  -- B3. Fuzz: cada función pública se invoca con argumentos de relleno como usuarios SIN privilegios.
  -- Si alguna se ejecuta sin error (y no es de uso propio), se informa: faltaría una validación de permiso.
  personas := array[un, ua, uw, u2, ui];
  for r in select p.oid::regprocedure::text sig, p.proname, p.proargtypes::oid[] argt
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.prokind = 'f' and p.prorettype <> 'trigger'::regtype
             and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
             and has_function_privilege('authenticated', p.oid, 'execute') and p.proname <> all (self_service)
           order by 1 loop
    args := '';
    for k in 1 .. coalesce(array_length(r.argt, 1), 0) loop
      args := args || case when k > 1 then ',' else '' end || case r.argt[k]::regtype::text
        when 'uuid' then quote_literal(gen_random_uuid()::text) || '::uuid'
        when 'text' then '''x''' when 'integer' then '1' when 'bigint' then '1' when 'numeric' then '1'
        when 'jsonb' then '''[]''::jsonb' when 'date' then 'current_date' when 'boolean' then 'false'
        when 'text[]' then '''{}''::text[]' when 'uuid[]' then '''{}''::uuid[]' when 'timestamp with time zone' then 'now()'
        else 'null' end;
    end loop;
    for i in 1 .. array_length(personas, 1) loop
      perform _t.as_user(personas[i]); execute 'set local role authenticated';
      q := format('select %s(%s)', r.sig::regprocedure::oid::regproc, args);
      begin
        execute q;
        raise exception 'EJECUTO_SIN_ERROR';
      exception when others then
        if sqlerrm = 'EJECUTO_SIN_ERROR' then
          perform _t.hallazgo('FUZZ', pnames[i] || ' pudo ejecutar ' || r.sig || ' sin que se rechazara');
        end if;
      end;
      execute 'reset role'; checks := checks + 1;
    end loop;
  end loop;

  -- ================= C. Aislamiento entre usuarios =================
  -- Ana (preventista) solo ve lo suyo
  perform _t.as_user(ua); execute 'set local role authenticated';
  if _t.rows_seen(format('select 1 from public.orders where id = %L', ob)) <> 0 then perform _t.hallazgo('AISLAMIENTO', 'Ana ve el pedido de Beto'); end if;
  if _t.rows_seen('select 1 from public.orders') <> 1 then perform _t.hallazgo('AISLAMIENTO', 'Ana debería ver exactamente 1 pedido'); end if;
  if _t.rows_seen(format('select 1 from public.order_items where order_id = %L', ob)) <> 0 then perform _t.hallazgo('AISLAMIENTO', 'Ana ve los renglones del pedido de Beto'); end if;
  if _t.rows_seen(format('select 1 from public.order_status_history where order_id = %L', ob)) <> 0 then perform _t.hallazgo('AISLAMIENTO', 'Ana ve el historial del pedido de Beto'); end if;
  if _t.rows_seen(format('select 1 from public.customers where id = %L', cust_b)) <> 0 then perform _t.hallazgo('AISLAMIENTO', 'Ana ve el cliente de Beto'); end if;
  if _t.rows_seen('select 1 from public.profiles') <> 1 then perform _t.hallazgo('AISLAMIENTO', 'Ana ve perfiles ajenos'); end if;
  if _t.rows_seen('select 1 from public.suppliers') <> 1 then perform _t.hallazgo('AISLAMIENTO', 'Ana ve a otros preventistas'); end if;
  if _t.rows_seen('select 1 from public.notifications') > 0 and _t.rows_seen(format('select 1 from public.notifications where user_id <> %L', ua)) > 0 then perform _t.hallazgo('AISLAMIENTO', 'Ana ve avisos ajenos'); end if;
  foreach st in array array['product_costs','order_item_costs','audit_logs','stock_movements','stock_reservations','customer_movements','order_payments',
                            'backup_runs','backup_settings','passkeys','cash_closings','cash_openings','supplier_commissions','order_commissions','commission_payouts','order_transitions'] loop
    if _t.rows_seen('select 1 from public.' || st) <> 0 then perform _t.hallazgo('AISLAMIENTO', 'Ana puede leer public.' || st || ' (costos, auditoría o dinero)'); end if;
  end loop;
  if _t.rows_seen($$select 1 from storage.objects where bucket_id = 'database-backups'$$) <> 0 then perform _t.hallazgo('AISLAMIENTO', 'Ana ve archivos de respaldo en el almacenamiento'); end if;
  if not _t.fails(format('select public.cancel_order(%L, ''x'')', ob), 'NO_AUTORIZADO') then perform _t.hallazgo('AISLAMIENTO', 'Ana canceló el pedido de Beto'); end if;
  if not _t.fails(format('select public.submit_order(gen_random_uuid(), %L::jsonb, null, %L)', jsonb_build_array(jsonb_build_object('product_id', p1, 'qty', 1)), cust_b), 'CLIENTE_INVALIDO') then
    perform _t.hallazgo('AISLAMIENTO', 'Ana hizo un pedido a nombre del cliente de Beto'); end if;
  if not _t.fails(format('select public.save_customer(%L, ''Hack'')', cust_b), 'NO_AUTORIZADO') then perform _t.hallazgo('AISLAMIENTO', 'Ana editó el cliente de Beto'); end if;
  if not _t.fails(format('select public.customer_register_payment(%L, 10, ''Efectivo'')', cust_a), 'NO_AUTORIZADO') then perform _t.hallazgo('AISLAMIENTO', 'Ana registró un pago en una cuenta corriente'); end if;
  -- Ana no puede ponerse comisión ni verla de otro
  if not _t.fails(format('select public.admin_set_commission(%L, 90)', sa), 'NO_AUTORIZADO') then perform _t.hallazgo('COMISIONES', 'Ana se configuró su propia comisión'); end if;
  j := public.commission_summary(sb);
  if j ->> 'supplier_id' <> sa::text then perform _t.hallazgo('COMISIONES', 'Ana vio la comisión de Beto'); end if;
  execute 'reset role'; checks := checks + 28;

  -- Depósito: solo pedidos aprobados en adelante; nada de dinero
  perform _t.as_user(uw); execute 'set local role authenticated';
  if _t.rows_seen('select 1 from public.orders') <> 0 then perform _t.hallazgo('AISLAMIENTO', 'El depósito ve pedidos pendientes de aprobación'); end if;
  foreach st in array array['product_costs','order_item_costs','audit_logs','customer_movements','order_payments','cash_closings','supplier_commissions','order_commissions','commission_payouts','customers'] loop
    if _t.rows_seen('select 1 from public.' || st) <> 0 then perform _t.hallazgo('AISLAMIENTO', 'El depósito puede leer public.' || st); end if;
  end loop;
  execute 'reset role'; checks := checks + 11;

  -- Usuario sin rol (recién registrado) y preventista inactivo: no ven ni hacen nada
  foreach persona in array array[un, ui] loop
    perform _t.as_user(persona); execute 'set local role authenticated';
    foreach st in array array['orders','products','inventory','customers','categories'] loop
      if _t.rows_seen('select 1 from public.' || st) <> 0 then perform _t.hallazgo('AISLAMIENTO', 'Un usuario sin rol/inactivo ve public.' || st); end if;
    end loop;
    if _t.rows_seen('select 1 from public.suppliers where profile_id <> auth.uid()') <> 0 then perform _t.hallazgo('AISLAMIENTO', 'Un usuario sin rol/inactivo ve fichas ajenas de preventistas'); end if;
    if not _t.fails(format('select public.submit_order(gen_random_uuid(), %L::jsonb, null, %L)', jsonb_build_array(jsonb_build_object('product_id', p1, 'qty', 1)), cust_pub), 'NO_AUTORIZADO') then
      perform _t.hallazgo('AISLAMIENTO', 'Un usuario sin rol/inactivo pudo hacer un pedido'); end if;
    execute 'reset role'; checks := checks + 7;
  end loop;

  -- ================= D. Escaladas de privilegio =================
  perform _t.as_user(ua); execute 'set local role authenticated';
  if not _t.fails(format('update public.profiles set role = ''admin_principal'', active = true where id = %L', ua), 'permission denied') then perform _t.hallazgo('ESCALADA', 'un preventista pudo cambiarse el rol con UPDATE'); end if;
  if not _t.fails(format('select public.admin_set_user(%L, ''admin_secundario'', ''Ana'', null, true, ''{"users":true,"cash":true}'')', ua), 'NO_AUTORIZADO') then perform _t.hallazgo('ESCALADA', 'un preventista se ascendió a administrador'); end if;
  if not _t.fails(format('update public.inventory set physical_stock = 99999 where product_id = %L', p1), 'permission denied') then perform _t.hallazgo('ESCALADA', 'un preventista modificó el inventario'); end if;
  if not _t.fails(format('select public.adjust_stock(%L, 1000, ''INGRESO'')', p1), 'NO_AUTORIZADO') then perform _t.hallazgo('ESCALADA', 'un preventista ajustó stock'); end if;
  if not _t.fails(format('insert into public.products(code, name, price) values (''X'', ''X'', 1)'), '') then perform _t.hallazgo('ESCALADA', 'un preventista creó un producto'); end if;
  if _t.rows_affected(format('update public.products set price = 1 where id = %L', p1)) <> 0 then perform _t.hallazgo('ESCALADA', 'un preventista cambió precios'); end if;
  if not _t.fails(format('select public.set_product_cost(%L, 1)', p1), 'NO_AUTORIZADO') then perform _t.hallazgo('ESCALADA', 'un preventista cambió costos'); end if;
  if not _t.fails(format('select public.confirm_delivery(%L)', oa), 'NO_AUTORIZADO') then perform _t.hallazgo('ESCALADA', 'un preventista confirmó una entrega'); end if;
  if not _t.fails(format('select public.approve_order(%L)', oa), 'NO_AUTORIZADO') then perform _t.hallazgo('ESCALADA', 'un preventista aprobó su propio pedido'); end if;
  if not _t.fails('select public.backup_snapshot()', 'NO_AUTORIZADO') then perform _t.hallazgo('ESCALADA', 'un preventista pidió el respaldo completo'); end if;
  if not _t.fails('select public.restore_backup(''{}''::jsonb, ''replace'', false, null)', 'NO_AUTORIZADO') then perform _t.hallazgo('ESCALADA', 'un preventista pudo restaurar un respaldo'); end if;
  if not _t.fails('select public.cash_report()', 'NO_AUTORIZADO') then perform _t.hallazgo('ESCALADA', 'un preventista vio la caja'); end if;
  if not _t.fails('select public.cash_open(current_date, 1, 1, 1)', 'NO_AUTORIZADO') then perform _t.hallazgo('ESCALADA', 'un preventista abrió la caja'); end if;
  if not _t.fails('select public.cash_close(current_date, 0, 0, 0)', 'NO_AUTORIZADO') then perform _t.hallazgo('ESCALADA', 'un preventista cerró la caja'); end if;
  -- Los clientes de un preventista: ve los suyos (con saldo), los generales y el público; NUNCA los de otro preventista
  j := public.customers_overview();
  if exists (select 1 from jsonb_array_elements(j) c where c ->> 'id' = cust_b::text) then perform _t.hallazgo('AISLAMIENTO', 'un preventista ve en Clientes al cliente de otro preventista'); end if;
  if exists (select 1 from jsonb_array_elements(j) c where (c ->> 'supplier_id') is distinct from sa::text and (c ->> 'is_public')::boolean = false and (c ->> 'balance') is not null) then
    perform _t.hallazgo('AISLAMIENTO', 'un preventista ve saldos de cuentas corrientes que no son suyas'); end if;
  if not _t.fails('select public.admin_stats_range(current_date - 30, current_date)', 'NO_AUTORIZADO') then perform _t.hallazgo('ESCALADA', 'un preventista vio las estadísticas del negocio'); end if;
  execute 'reset role'; checks := checks + 16;
  -- Secundario con permiso de usuarios: no puede crear/ascender administradores ni tocar al principal
  perform _t.as_user(u3); execute 'set local role authenticated';
  if not _t.fails(format('select public.admin_set_user(%L, ''admin_secundario'', ''Yo'', null, true, ''{"cash":true,"users":true,"audit":true}'')', u3), 'NO_AUTORIZADO') then perform _t.hallazgo('ESCALADA', 'un secundario se dio más permisos a sí mismo'); end if;
  if not _t.fails(format('select public.admin_set_user(%L, ''proveedor'', ''Principal'', null, false)', up), 'NO_AUTORIZADO') then perform _t.hallazgo('ESCALADA', 'un secundario modificó al administrador principal'); end if;
  if not _t.fails(format('select public.admin_set_user(%L, ''admin_secundario'', ''Ana'', null, true)', ua), 'NO_AUTORIZADO') then perform _t.hallazgo('ESCALADA', 'un secundario creó otro administrador'); end if;
  if not _t.fails('select public.backup_snapshot()', 'NO_AUTORIZADO') then perform _t.hallazgo('ESCALADA', 'un secundario obtuvo el respaldo completo'); end if;
  if not _t.fails(format('select public.admin_set_commission(%L, 50)', sa), 'NO_AUTORIZADO') then perform _t.hallazgo('ESCALADA', 'un secundario con permiso de usuarios configuró comisiones'); end if;
  if not _t.fails(format('select public.commission_pay(%L, 1, ''Efectivo'')', sa), 'NO_AUTORIZADO') then perform _t.hallazgo('ESCALADA', 'un secundario sin caja pagó comisiones'); end if;
  perform _t.as_user(u2);
  if not _t.fails('select public.cash_report()', 'NO_AUTORIZADO') then perform _t.hallazgo('ESCALADA', 'un secundario sin permiso vio la caja'); end if;
  if not _t.fails(format('select public.approve_order(%L)', oa), 'NO_AUTORIZADO') then perform _t.hallazgo('ESCALADA', 'un secundario sin permiso aprobó pedidos'); end if;
  execute 'reset role'; checks := checks + 8;
  -- Un perfil recién registrado no puede activarse ni elegir rol
  perform _t.as_user(un); execute 'set local role authenticated';
  if not _t.fails(format('update public.profiles set role = ''admin_principal'', active = true where id = %L', un), '') then perform _t.hallazgo('ESCALADA', 'un usuario nuevo pudo activarse por UPDATE'); end if;
  if not _t.fails('select public.update_my_profile(''Yo'', ''123'')', '') then null; end if;   -- permitido o no: no debe cambiar rol
  execute 'reset role';
  if (select role from public.profiles where id = un) is not null or (select active from public.profiles where id = un) then perform _t.hallazgo('ESCALADA', 'el usuario nuevo quedó con rol/activo'); end if;
  checks := checks + 3;

  -- ================= E. Inyección SQL y entradas hostiles =================
  perform _t.as_user(up); execute 'set local role authenticated';
  if not _t.fails($$select public.backup_selected_snapshot(array['orders; drop table public.orders'])$$, 'TABLA_NO_PERMITIDA') then perform _t.hallazgo('INYECCION', 'backup_selected_snapshot acepta nombres de tabla arbitrarios'); end if;
  if not _t.fails($$select public.backup_selected_snapshot(array['pg_catalog.pg_authid'])$$, 'TABLA_NO_PERMITIDA') then perform _t.hallazgo('INYECCION', 'el respaldo permite leer tablas del sistema'); end if;
  j := public.restore_backup(jsonb_build_object('orders; drop table public.orders', '[{"a":1}]'::jsonb, 'auth.users', '[{"id":"x"}]'::jsonb), 'merge', true, null);
  if jsonb_array_length(j -> 'ignored_tables') <> 2 then perform _t.hallazgo('INYECCION', 'restore_backup no ignoró las tablas con nombre malicioso'); end if;
  -- Textos con comillas, SQL y HTML: se guardan literalmente y no rompen nada
  q := $$'); drop table public.orders; --<img src=x onerror=alert(1)>$$;
  perform public.save_customer(null, q);
  perform _t.as_user(ua);
  perform public.submit_order(gen_random_uuid(), jsonb_build_array(jsonb_build_object('product_id', p1, 'qty', 1)), q, cust_a);
  execute 'reset role';
  if to_regclass('public.orders') is null then perform _t.hallazgo('INYECCION', 'una nota con SQL borró la tabla orders'); end if;
  if not exists (select 1 from public.customers where name = left(q, 120)) then perform _t.hallazgo('INYECCION', 'el nombre hostil no se guardó literal'); end if;
  perform _t.as_user(up); execute 'set local role authenticated';
  if not _t.fails($$select public.submit_order(gen_random_uuid(), '[{"product_id":"no-es-uuid","qty":1}]'::jsonb, null, null)$$, '') then perform _t.hallazgo('ENTRADAS', 'submit_order aceptó un uuid inválido'); end if;
  perform _t.as_user(ua);
  if not _t.fails(format($$select public.submit_order(gen_random_uuid(), '[{"product_id":"%s","qty":"1; drop table x"}]'::jsonb, null, %L)$$, p1, cust_a), 'DATOS_INVALIDOS') then perform _t.hallazgo('ENTRADAS', 'submit_order aceptó una cantidad con SQL'); end if;
  if not _t.fails(format($$select public.submit_order(gen_random_uuid(), '[{"product_id":"%s","qty":-5}]'::jsonb, null, %L)$$, p1, cust_a), 'DATOS_INVALIDOS') then perform _t.hallazgo('ENTRADAS', 'submit_order aceptó cantidad negativa'); end if;
  if not _t.fails(format($$select public.submit_order(gen_random_uuid(), '[{"product_id":"%s","qty":0}]'::jsonb, null, %L)$$, p1, cust_a), 'DATOS_INVALIDOS') then perform _t.hallazgo('ENTRADAS', 'submit_order aceptó cantidad 0'); end if;
  if not _t.fails(format($$select public.submit_order(gen_random_uuid(), '[{"product_id":"%s","qty":99999999999}]'::jsonb, null, %L)$$, p1, cust_a), 'DATOS_INVALIDOS') then perform _t.hallazgo('ENTRADAS', 'submit_order aceptó una cantidad desbordada'); end if;
  if not _t.fails(format($$select public.submit_order(gen_random_uuid(), (select jsonb_agg(jsonb_build_object('product_id', %L, 'qty', 1)) from generate_series(1, 301)), null, %L)$$, p1, cust_a), 'DATOS_INVALIDOS') then perform _t.hallazgo('ENTRADAS', 'submit_order aceptó 301 renglones'); end if;
  if not _t.fails(format($$select public.submit_order(gen_random_uuid(), '[{"product_id":"%s","qty":1000}]'::jsonb, null, %L)$$, p1, cust_a), 'STOCK_INSUFICIENTE') then perform _t.hallazgo('STOCK', 'se aceptó un pedido por más stock del disponible'); end if;
  perform _t.as_user(up);
  foreach st in array array['1e9','1000000001','-1','NaN','Infinity'] loop
    if not _t.fails(format('select public.commission_pay(%L, %L::numeric, ''Efectivo'')', sa, st), '') then perform _t.hallazgo('ENTRADAS', 'commission_pay aceptó el monto ' || st); end if;
  end loop;
  if not _t.fails('select public.cash_close(current_date, -1, 0, 0)', 'MONTO_INVALIDO') then perform _t.hallazgo('ENTRADAS', 'cash_close aceptó fondo negativo'); end if;
  if not _t.fails('select public.cash_close(current_date, 0, 0, 1e12)', 'MONTO_INVALIDO') then perform _t.hallazgo('ENTRADAS', 'cash_close aceptó un monto desbordado'); end if;
  if not _t.fails('select public.cash_report(current_date + 1)', 'FECHA_INVALIDA') then perform _t.hallazgo('ENTRADAS', 'cash_report aceptó una fecha futura'); end if;
  if not _t.fails('select public.cash_report(date ''1900-01-01'')', 'FECHA_INVALIDA') then perform _t.hallazgo('ENTRADAS', 'cash_report aceptó el año 1900'); end if;
  if not _t.fails('select public.cash_open(current_date, 0, 0, 101)', 'PORCENTAJE_INVALIDO') then perform _t.hallazgo('ENTRADAS', 'cash_open aceptó retención de 101%'); end if;
  execute 'reset role'; checks := checks + 20;

  -- ================= F. Integridad (incluso contra errores del propio sistema) =================
  if not _t.fails(format('update public.inventory set physical_stock = -1 where product_id = %L', p1), 'check') then perform _t.hallazgo('INTEGRIDAD', 'se pudo dejar stock físico negativo'); end if;
  if not _t.fails(format('update public.inventory set reserved_stock = physical_stock + 1 where product_id = %L', p1), 'check') then perform _t.hallazgo('INTEGRIDAD', 'se pudo reservar más que el stock físico'); end if;
  if not _t.fails(format('update public.orders set status = ''ENTREGADO'' where id = %L', oa), 'TRANSICION_INVALIDA') then perform _t.hallazgo('INTEGRIDAD', 'un pedido pendiente pasó a ENTREGADO sin aprobarse'); end if;
  if not _t.fails(format('insert into public.order_commissions(order_id, supplier_id, pct, base, base_amount, amount) values (%L, %L, 5, ''VENTAS'', 1, -1)', oa, sa), 'check') then perform _t.hallazgo('INTEGRIDAD', 'comisión negativa'); end if;
  if not _t.fails(format('insert into public.commission_payouts(supplier_id, amount, method) values (%L, 0, ''Efectivo'')', sa), 'check') then perform _t.hallazgo('INTEGRIDAD', 'pago de comisión en cero'); end if;
  if not _t.fails(format('insert into public.supplier_commissions(supplier_id, pct) values (%L, 150)', sb), 'check') then perform _t.hallazgo('INTEGRIDAD', 'comisión mayor a 100%'); end if;
  if not _t.fails(format('insert into public.order_payments(order_id, amount, method) values (%L, 5, ''Cripto'')', oa), 'check') then perform _t.hallazgo('INTEGRIDAD', 'medio de pago inválido aceptado'); end if;
  checks := checks + 7;

  -- ================= Resultado =================
  raise notice 'Comprobaciones realizadas: % (incluye % llamadas de fuzz)', checks, (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public');
  if exists (select 1 from _hallazgos) then
    raise notice '------- HALLAZGOS -------';
    for r in select * from _hallazgos order by n loop raise notice '[%] %', r.area, r.detalle; end loop;
    raise exception 'SEGURIDAD: % hallazgo(s)', (select count(*) from _hallazgos);
  end if;
  raise notice 'SEGURIDAD OK: ninguna de las % comprobaciones encontró fallas', checks;
end $t$;

rollback;
