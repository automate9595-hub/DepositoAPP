-- =====================================================================
-- DATOS DE PRUEBA MASIVOS — simula la operación completa de la distribuidora
-- Cómo usarlo: Supabase › SQL Editor › pegar TODO este archivo › Run.
--   · Carga 1.200 productos de prueba (códigos TST-xxxxx, rubros «[TEST] …») con costo y stock.
--   · Crea 15 preventistas y 3 operarios de depósito de prueba («[TEST] …»; no pueden iniciar sesión) y ~8 clientes por preventista.
--   · Ejecuta el flujo REAL de la aplicación (mismas funciones que usa la app, con sus permisos): pedidos enviados por los preventistas,
--     aprobados por TU administrador principal, preparados por el depósito (con faltantes), entregados y cobrados (efectivo, transferencia,
--     tarjeta, parcial y a cuenta corriente), cancelados y rechazados; ingresos y ajustes de stock; pagos de clientes y pagos de comisiones.
--   · Un 25 % de los pedidos queda a propósito en estados intermedios (pendiente / aprobado / listo) para ver todas las pantallas llenas.
--   · Todo queda a nombre de su administrador principal en Auditoría, Caja, Clientes, Inventario, Estadísticas y Comisiones.
-- Se puede ejecutar varias veces: el catálogo y los usuarios no se duplican y cada ejecución agrega más pedidos.
-- Requisitos: haber instalado hasta la migración 16. Para borrar todo lo de prueba: ejecutar limpiar_pruebas.sql (supabase/tests/carga/).
-- ⚠ NO cierra la caja del día (no interfiere con su cierre real).
-- =====================================================================

-- ---------------------------------------------------------------------
-- Catálogo de prueba
-- ---------------------------------------------------------------------
insert into public.categories(name)
select '[TEST] ' || c from unnest(array['Gaseosas','Aguas y jugos','Cervezas','Vinos','Lácteos','Fiambres','Almacén','Galletitas','Golosinas',
  'Snacks','Limpieza','Perfumería','Congelados','Descartables','Infusiones']) c
where not exists (select 1 from public.categories where name = '[TEST] ' || c);

with cat as (select name, row_number() over (order by name) rn from public.categories where name like '[TEST] %'),
rubros(rn, nombre, tipos, marcas, pres, base) as (values
  (1,'Gaseosas',  array['Cola','Lima limón','Naranja','Pomelo','Tónica','Ginger'], array['Fresca','Burbuja','Sierra','Norte'], array['500 ml','1,5 L','2,25 L','lata 354 ml'], 1500),
  (2,'Aguas y jugos', array['Agua mineral','Agua saborizada','Jugo de naranja','Jugo de manzana','Jugo multifruta'], array['Manantial','Cumbres','Vita','Pura'], array['500 ml','1,5 L','2 L','tetra 1 L'], 900),
  (3,'Cervezas',  array['Rubia','Negra','IPA','Roja','Light'], array['Andina','Patagonia Sur','Cerro','Pampa'], array['lata 473 ml','botella 1 L','retornable 1 L','pack x6'], 2200),
  (4,'Vinos',     array['Malbec','Cabernet','Torrontés','Blend tinto','Chardonnay'], array['Valle Alto','Bodega Sol','Finca Luna','Altura'], array['750 ml','1,125 L','tetra 1 L'], 4200),
  (5,'Lácteos',   array['Leche entera','Leche descremada','Yogur firme','Yogur bebible','Queso cremoso','Manteca','Dulce de leche'], array['La Granja','Pradera','Sierras','Campo'], array['1 L','200 g','500 g','1 kg'], 1800),
  (6,'Fiambres',  array['Jamón cocido','Salame','Mortadela','Paleta','Queso de máquina','Bondiola'], array['Casa Rossi','Del Pago','Fino','Criollo'], array['200 g','500 g','1 kg'], 3500),
  (7,'Almacén',   array['Arroz','Fideos','Harina 000','Azúcar','Aceite girasol','Sal fina','Puré de tomate','Lentejas','Polenta','Yerba'], array['Granero','Doña Rosa','Sol','Campo Verde'], array['500 g','1 kg','900 ml','5 kg'], 1700),
  (8,'Galletitas',array['Dulces','Crackers','Surtidas','Rellenas','Integrales','Obleas'], array['Crocante','Delicia','Merienda','Trigal'], array['100 g','200 g','300 g','pack x3'], 1100),
  (9,'Golosinas',  array['Caramelos','Chicles','Alfajor','Chocolate','Gomitas','Turrón','Bombones'], array['Dulcería','Nube','Capricho','Arcoíris'], array['unidad','caja x12','bolsa 500 g'], 600),
  (10,'Snacks',    array['Papas fritas','Maníes','Palitos','Chizitos','Nachos','Pochoclo'], array['Crujiente','Tostado','Mix','Cancha'], array['40 g','100 g','200 g','familiar'], 800),
  (11,'Limpieza',  array['Lavandina','Detergente','Jabón en polvo','Suavizante','Limpiador piso','Desengrasante','Esponja'], array['Brillo','Pureza','Hogar','Espuma'], array['500 ml','900 ml','2 L','3 kg'], 1400),
  (12,'Perfumería',array['Shampoo','Acondicionador','Jabón de tocador','Desodorante','Pasta dental','Crema corporal','Papel higiénico'], array['Aura','Fresca Piel','Nativa','Dermo'], array['200 ml','400 ml','pack x4','pack x12'], 2000),
  (13,'Congelados',array['Hamburguesas','Nuggets','Papas prefritas','Empanadas','Pizza','Helado','Vegetales'], array['Frío Sur','Polar','Ártico','Nevado'], array['x4','x12','500 g','1 kg'], 3000),
  (14,'Descartables',array['Vasos','Platos','Servilletas','Bolsas residuo','Papel aluminio','Film','Cubiertos'], array['Práctico','Eco','Fiesta','Uno'], array['x50','x100','rollo','pack x10'], 700),
  (15,'Infusiones',array['Té negro','Té de hierbas','Café molido','Café instantáneo','Mate cocido','Edulcorante'], array['Aroma','Hebras','Tostado','Alba'], array['x25','x100','250 g','500 g'], 1300)),
base as (
  select r.rn rubro, r.nombre, t.tipo, m.marca, p.pres, r.base,
         row_number() over (order by r.rn, t.tipo, m.marca, p.pres) n
  from rubros r, unnest(r.tipos) t(tipo), unnest(r.marcas) m(marca), unnest(r.pres) p(pres)),
sel as (select * from base where n <= 1200)
insert into public.products(code, name, description, category_id, price, active)
select 'TST-' || lpad(s.n::text, 5, '0'),
       s.tipo || ' ' || s.marca || ' ' || s.pres,
       'Producto de prueba del rubro ' || s.nombre,
       (select c.id from public.categories c where c.name = '[TEST] ' || s.nombre),
       round((s.base * (0.6 + (abs(hashtext(s.n::text)) % 1000) / 1000.0 * 1.4))::numeric, 0),
       (s.n % 97 <> 0)      -- ~1 % de productos inactivos, como en la vida real
from sel s
on conflict (code) do nothing;

insert into public.product_costs(product_id, cost_price)
select p.id, round(p.price * (0.62 + (abs(hashtext(p.code)) % 20) / 100.0), 2)     -- costo = 62 % a 81 % del precio
from public.products p where p.code like 'TST-%'
on conflict (product_id) do nothing;

-- Stock inicial: de 0 a ~2.000 unidades (algunos productos agotados a propósito)
update public.inventory i set physical_stock = case when abs(hashtext(p.code || 's')) % 40 = 0 then 0 else 50 + abs(hashtext(p.code || 'q')) % 1950 end
from public.products p where p.id = i.product_id and p.code like 'TST-%' and i.physical_stock = 0 and i.reserved_stock = 0;


-- ---------------------------------------------------------------------
-- Ayudas (se eliminan al final)
-- ---------------------------------------------------------------------
drop schema if exists _load cascade;
create schema _load;
create or replace function _load.as_(u uuid) returns void language plpgsql as $f$
begin perform set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true); set local role authenticated; end $f$;
grant usage on schema _load to authenticated;

-- ---------------------------------------------------------------------
-- Usuarios y clientes de prueba
-- ---------------------------------------------------------------------
do $actors$
declare
  v_pri uuid; v_id uuid; v_email text; v_col text; i int;
  v_n_prev constant int := 15; v_n_dep constant int := 3; v_cust constant int := 8;
begin
  select id into v_pri from public.profiles where role = 'admin_principal' and active order by created_at limit 1;
  if v_pri is null then raise exception 'No hay un administrador principal activo. Ingrese a la app con su usuario central al menos una vez antes de cargar los datos.'; end if;

  for i in 1..(v_n_prev + v_n_dep) loop
    v_email := case when i <= v_n_prev then format('ld_prev%s@prueba.local', lpad(i::text, 2, '0')) else format('ld_dep%s@prueba.local', lpad((i - v_n_prev)::text, 2, '0')) end;
    if not exists (select 1 from auth.users where email = v_email) then
      insert into auth.users(id, instance_id, aud, role, email, raw_user_meta_data)
      values (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', v_email, '{}');
    end if;
  end loop;
  -- Columnas de Supabase Auth que no deben quedar nulas (si existen en este proyecto)
  for v_col in select column_name from information_schema.columns where table_schema = 'auth' and table_name = 'users'
      and column_name in ('confirmation_token','recovery_token','email_change_token_new','email_change','email_change_token_current','phone_change','phone_change_token','reauthentication_token') loop
    execute format('update auth.users set %I = %L where email like %L and %I is null', v_col, '', 'ld\_%@prueba.local', v_col);
  end loop;
  if exists (select 1 from information_schema.columns where table_schema = 'auth' and table_name = 'users' and column_name = 'email_confirmed_at') then
    update auth.users set email_confirmed_at = coalesce(email_confirmed_at, now()) where email like 'ld\_%@prueba.local';
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'auth' and table_name = 'users' and column_name = 'raw_app_meta_data') then
    update auth.users set raw_app_meta_data = '{"provider":"email","providers":["email"]}' where email like 'ld\_%@prueba.local' and (raw_app_meta_data is null or raw_app_meta_data = '{}'::jsonb);
  end if;

  -- Depósito
  update public.profiles p set role = 'deposito', active = true, full_name = '[TEST] Depósito ' || substr(p.email, 7, 2)
    where p.email like 'ld\_dep%@prueba.local';
  insert into public.warehouse_workers(profile_id, display_name)
    select p.id, p.full_name from public.profiles p where p.email like 'ld\_dep%@prueba.local'
    and not exists (select 1 from public.warehouse_workers w where w.profile_id = p.id);

  -- Preventistas (los crea el administrador principal, como en la app)
  for v_id, v_email in select p.id, p.email from public.profiles p where p.email like 'ld\_prev%@prueba.local' order by p.email loop
    if not exists (select 1 from public.suppliers s where s.profile_id = v_id) then
      perform set_config('request.jwt.claims', json_build_object('sub', v_pri, 'role', 'authenticated')::text, true);
      set local role authenticated;
      perform public.admin_set_user(v_id, 'proveedor', '[TEST] Preventista ' || substr(v_email, 8, 2), null, true, null, '[TEST] Preventista ' || substr(v_email, 8, 2));
      reset role;
    end if;
  end loop;

  -- Clientes
  insert into public.customers(name, supplier_id, credit_days)
    select '[TEST] Cliente ' || substr(p.email, 8, 2) || '-' || g, s.id, 15
    from public.profiles p join public.suppliers s on s.profile_id = p.id, generate_series(1, v_cust) g
    where p.email like 'ld\_prev%@prueba.local'
      and not exists (select 1 from public.customers c where c.supplier_id = s.id and c.name = '[TEST] Cliente ' || substr(p.email, 8, 2) || '-' || g);

  -- Comisiones: 2 de cada 3 preventistas (impares 3 % de lo vendido, pares 8 % de la ganancia)
  insert into public.supplier_commissions(supplier_id, pct, base)
    select s.id, case when substr(p.email, 8, 2)::int % 2 = 1 then 3 else 8 end, case when substr(p.email, 8, 2)::int % 2 = 1 then 'VENTAS' else 'GANANCIA' end
    from public.profiles p join public.suppliers s on s.profile_id = p.id
    where p.email like 'ld\_prev%@prueba.local' and substr(p.email, 8, 2)::int % 3 <> 0
    on conflict (supplier_id) do nothing;
end $actors$;

-- ---------------------------------------------------------------------
-- FLUJO MASIVO  ←  cambie v_orders por la cantidad de pedidos que quiere simular en esta ejecución
-- (si el editor corta por tiempo, use un número menor y ejecute varias veces)
-- ---------------------------------------------------------------------
do $flow$
declare
  v_orders constant int := 400;
  v_pri uuid; v_prevs uuid[]; v_deps uuid[]; v_id uuid; v_uid uuid; v_sup uuid; v_cust uuid; v_items jsonb; v_k int; r numeric;
  i int; it record; o record; v_tot numeric; v_m text; v_bal numeric; c record;
  n_sub int := 0; n_can int := 0; n_rej int := 0; n_apr int := 0; n_prep int := 0; n_del int := 0; n_skip int := 0;
begin
  select id into v_pri from public.profiles where role = 'admin_principal' and active order by created_at limit 1;
  select array_agg(id order by email) into v_prevs from public.profiles where email like 'ld\_prev%@prueba.local';
  select array_agg(id order by email) into v_deps from public.profiles where email like 'ld\_dep%@prueba.local';
  create temp table if not exists _o(id uuid primary key, fate text, sup uuid) on commit drop;
  truncate _o;

  -- 1) Los preventistas envían pedidos
  for i in 1..v_orders loop
    v_uid := v_prevs[1 + floor(random() * array_length(v_prevs, 1))::int];
    select s.id into v_sup from public.suppliers s where s.profile_id = v_uid;
    v_k := 3 + floor(random() * 8)::int;
    select jsonb_agg(jsonb_build_object('product_id', x.product_id, 'qty', 1 + floor(random() * least(12, x.available_stock))::int)) into v_items from (
      select inv.product_id, inv.available_stock from public.inventory inv join public.products p on p.id = inv.product_id
      where p.active and inv.available_stock > 0 and p.code like 'TST-%' order by random() limit v_k) x;
    continue when v_items is null;
    if random() < 0.15 then select id into v_cust from public.customers where is_public limit 1;
    else select id into v_cust from public.customers where supplier_id = v_sup order by random() limit 1; end if;
    begin
      perform _load.as_(v_uid);
      v_id := public.submit_order(gen_random_uuid(), v_items, 'Pedido de prueba masiva', v_cust);
      reset role;
      r := random();
      insert into _o values (v_id, case when r < .08 then 'cancel' when r < .12 then 'reject' when r < .20 then 'pending' when r < .27 then 'approved' when r < .34 then 'ready' else 'deliver' end, v_uid);
      n_sub := n_sub + 1;
    exception when others then
      reset role;
      if sqlerrm like 'STOCK_INSUFICIENTE%' or sqlerrm like 'PRODUCTO_NO_DISPONIBLE%' then n_skip := n_skip + 1; else raise; end if;
    end;
  end loop;

  -- 2) Cancelaciones (las hace el preventista) y rechazos (los hace el administrador)
  for o in select * from _o where fate = 'cancel' loop
    perform _load.as_(o.sup); perform public.cancel_order(o.id, 'El cliente se arrepintió (prueba)'); reset role; n_can := n_can + 1;
  end loop;
  for o in select * from _o where fate = 'reject' loop
    perform _load.as_(v_pri); perform public.reject_order(o.id, 'Sin cupo de crédito (prueba)'); reset role; n_rej := n_rej + 1;
  end loop;

  -- 3) El administrador principal aprueba
  for o in select * from _o where fate in ('approved', 'ready', 'deliver') loop
    begin
      perform _load.as_(v_pri); perform public.approve_order(o.id); reset role; n_apr := n_apr + 1;
    exception when others then
      reset role;
      if sqlerrm like 'STOCK_INSUFICIENTE%' then update _o set fate = 'pending' where id = o.id; n_skip := n_skip + 1; else raise; end if;
    end;
  end loop;

  -- 4) El depósito prepara (1 de cada 8 renglones con faltante)
  for o in select * from _o where fate in ('ready', 'deliver') loop
    perform _load.as_(v_deps[1 + floor(random() * array_length(v_deps, 1))::int]);
    perform public.start_preparation(o.id);
    for it in select id, qty_approved from public.order_items where order_id = o.id and qty_approved > 0 loop
      if random() < 0.125 and it.qty_approved > 1 then perform public.report_item(it.id, it.qty_approved - 1, 'Faltante de prueba');
      else perform public.report_item(it.id, it.qty_approved); end if;
    end loop;
    perform public.finish_preparation(o.id);
    reset role; n_prep := n_prep + 1;
  end loop;

  -- 5) Entrega y cobro: 50 % paga todo, 25 % paga la mitad, 25 % queda en cuenta corriente
  for o in select * from _o where fate = 'deliver' loop
    r := random(); v_m := (array['Efectivo','Transferencia','Tarjeta','Efectivo'])[1 + floor(random() * 4)::int];
    select coalesce(sum(qty_prepared * unit_price), 0) into v_tot from public.order_items where order_id = o.id;
    perform _load.as_(v_pri);
    perform public.confirm_delivery_with_payment(o.id, case when r < .5 then v_tot when r < .75 then round((v_tot / 2)::numeric, 2) else 0 end, v_m);
    reset role; n_del := n_del + 1;
  end loop;

  -- 6) Ingresos y ajustes de stock
  perform _load.as_(v_pri);
  for c in select p.id from public.products p where p.code like 'TST-%' order by random() limit 40 loop
    perform public.adjust_stock(c.id, 20 + floor(random() * 300)::int, 'INGRESO', 'Compra a proveedor (prueba)');
  end loop;
  for c in select p.id from public.products p join public.inventory inv on inv.product_id = p.id where p.code like 'TST-%' and inv.physical_stock - inv.reserved_stock > 20 order by random() limit 12 loop
    perform public.adjust_stock(c.id, -(1 + floor(random() * 5)::int), 'AJUSTE', 'Rotura / merma (prueba)');
  end loop;
  reset role;

  -- 7) Clientes pagan su cuenta corriente
  for c in select cu.id, coalesce(sum(m.amount), 0) as bal from public.customers cu join public.customer_movements m on m.customer_id = cu.id
           where cu.name like '[TEST]%' and not cu.is_public group by cu.id having coalesce(sum(m.amount), 0) > 0 order by random() limit 60 loop
    perform _load.as_(v_pri);
    perform public.customer_register_payment(c.id, round((c.bal * (0.3 + random() * 0.7))::numeric, 2), (array['Efectivo','Transferencia'])[1 + floor(random() * 2)::int], 'Pago a cuenta (prueba)');
    reset role;
  end loop;

  -- 8) Pago de comisiones a la mitad de los preventistas con saldo
  for c in select s.id from public.suppliers s join public.supplier_commissions sc on sc.supplier_id = s.id where s.company_name like '[TEST]%' order by s.id loop
    perform _load.as_(v_pri);
    v_bal := (public.commission_summary(c.id) ->> 'balance')::numeric;
    if v_bal > 1 and random() < 0.5 then perform public.commission_pay(c.id, round((v_bal * (0.4 + random() * 0.6))::numeric, 2), (array['Efectivo','Transferencia','Mercado Pago'])[1 + floor(random() * 3)::int], 'Pago de comisión (prueba)'); end if;
    reset role;
  end loop;

  raise notice 'Pedidos enviados: %, cancelados: %, rechazados: %, aprobados: %, preparados: %, entregados: %, omitidos por stock: %', n_sub, n_can, n_rej, n_apr, n_prep, n_del, n_skip;
end $flow$;

drop schema _load cascade;

-- ---------------------------------------------------------------------
-- Resumen de lo que quedó cargado
-- ---------------------------------------------------------------------
select 'Productos de prueba' as concepto, count(*)::text as cantidad from public.products where code like 'TST-%'
union all select 'Clientes de prueba', count(*)::text from public.customers where name like '[TEST]%'
union all select 'Preventistas de prueba', count(*)::text from public.suppliers where company_name like '[TEST]%'
union all select 'Pedidos de prueba (total)', count(*)::text from public.orders where supplier_id in (select id from public.suppliers where company_name like '[TEST]%')
union all select '  · ' || o.status, count(*)::text from public.orders o where o.supplier_id in (select id from public.suppliers where company_name like '[TEST]%') group by o.status
union all select 'Cobros registrados', count(*)::text from public.order_payments where order_id in (select id from public.orders where supplier_id in (select id from public.suppliers where company_name like '[TEST]%'))
union all select 'Movimientos de stock', count(*)::text from public.stock_movements
union all select 'Registros de auditoría', count(*)::text from public.audit_logs
union all select 'Pagos de comisiones', count(*)::text from public.commission_payouts
union all select 'Comisiones devengadas', count(*)::text from public.order_commissions
order by 1;
