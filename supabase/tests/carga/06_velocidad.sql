-- Velocidad de las pantallas y funciones pesadas con la base ya cargada (correr después de 03_flujo_masivo.sh).
-- Referencia: Supabase corta cualquier consulta de usuario a los 8 s; aquí se considera aceptable < 500 ms, lento > 2 s.
create temp table _v(orden serial, prueba text, ms numeric, veredicto text);
do $t$
declare t0 timestamptz; ms numeric; j jsonb; pr uuid; ad uuid; dep uuid;
  tests text[][] := array[
    ['admin','Administración: lista de pedidos pendientes (50)', 'select count(*) from (select * from public.orders where status = ''PENDIENTE_APROBACION'' order by created_at limit 50) q'],
    ['admin','Administración: pedidos entregados de hoy', 'select count(*) from (select * from public.orders where status = ''ENTREGADO'' order by created_at desc limit 100) q'],
    ['admin','Administración: pedido con sus renglones', 'select count(*) from public.order_items where order_id = (select id from public.orders order by created_at desc limit 1)'],
    ['admin','Administración: estadísticas 30 días (admin_stats_range)', 'select public.admin_stats_range(current_date - 30, current_date)'],
    ['admin','Administración: estadísticas 365 días', 'select public.admin_stats_range(current_date - 365, current_date)'],
    ['admin','Caja: informe del día (cash_report)', 'select public.cash_report()'],
    ['admin','Clientes: cuentas corrientes de todos (customers_overview)', 'select public.customers_overview()'],
    ['admin','Comisiones: tablero de todos los preventistas', 'select public.commission_overview()'],
    ['admin','Comisiones: detalle de un preventista (mes)', 'select public.commission_summary((select id from public.suppliers where company_name = ''[TEST] Preventista 1''))'],
    ['admin','Inventario: lista completa con stock', 'select count(*) from (select p.*, i.physical_stock, i.reserved_stock from public.products p join public.inventory i on i.product_id = p.id order by p.name) q'],
    ['admin','Auditoría: últimos 200 movimientos', 'select count(*) from (select * from public.audit_logs order by created_at desc limit 200) q'],
    ['prev','Preventista: catálogo (búsqueda)', 'select count(*) from (select p.id, p.name, p.price, i.available_stock from public.products p join public.inventory i on i.product_id = p.id where p.active and p.name ilike ''%queso%'' order by p.name limit 50) q'],
    ['prev','Preventista: catálogo completo (1.200 productos)', 'select count(*) from (select p.id, p.name, p.price, p.category_id, i.available_stock from public.products p join public.inventory i on i.product_id = p.id where p.active order by p.name) q'],
    ['prev','Preventista: mis pedidos (30 últimos)', 'select count(*) from (select * from public.orders order by created_at desc limit 30) q'],
    ['prev','Preventista: mis pedidos del mes con renglones', 'select count(*) from public.order_items oi join public.orders o on o.id = oi.order_id where o.created_at >= date_trunc(''month'', now())'],
    ['prev','Preventista: su comisión (commission_summary)', 'select public.commission_summary()'],
    ['prev','Preventista: sus clientes', 'select public.customers_overview()'],
    ['dep','Depósito: cola de pedidos a preparar', 'select count(*) from (select * from public.orders where status in (''APROBADO'',''EN_PREPARACION'',''PREPARADO_PARCIALMENTE'',''LISTO_PARA_ENTREGAR'') order by created_at limit 50) q']
  ];
  i int;
begin
  select id into ad from _load.actors where kind = 'principal'; select id into pr from _load.actors where kind = 'prev' and n = 1; select id into dep from _load.actors where kind = 'deposito' and n = 1;
  for i in 1 .. array_length(tests, 1) loop
    perform set_config('request.jwt.claims', json_build_object('sub', case tests[i][1] when 'admin' then ad when 'prev' then pr else dep end, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    t0 := clock_timestamp();
    execute tests[i][3];
    ms := round(extract(epoch from clock_timestamp() - t0) * 1000, 1);
    execute 'reset role';
    insert into _v(prueba, ms, veredicto) values (tests[i][2], ms, case when ms < 500 then 'rápido' when ms < 2000 then 'aceptable' else 'LENTO' end);
  end loop;
end $t$;
select lpad(ms::text, 9) || ' ms  ' || rpad(veredicto, 10) || prueba as resultado from _v order by orden;
