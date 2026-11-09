-- Borra TODO lo creado por 17_datos_de_prueba_masivos.sql: catálogo TST-, preventistas/depósito de prueba (ld_*@prueba.local),
-- clientes «[TEST]», sus pedidos, cobros, comisiones, movimientos y los registros de auditoría que generaron.
-- Ejecutar en el SQL Editor de Supabase. No toca datos reales.
begin;
create temp table _fake as select id from public.profiles where email like 'ld\_%@prueba.local';
create temp table _ids as select id::text as id from public.products where code like 'TST-%' union select id::text from public.categories where name like '[TEST] %' union select id::text from public.warehouse_workers where display_name like '[TEST]%';
create temp table _ped as select id from public.orders where supplier_id in (select id from public.suppliers where company_name like '[TEST]%');
delete from public.order_commissions where order_id in (select id from _ped);
delete from public.commission_payouts where supplier_id in (select id from public.suppliers where company_name like '[TEST]%');
delete from public.supplier_commissions where supplier_id in (select id from public.suppliers where company_name like '[TEST]%');
delete from public.order_payments where order_id in (select id from _ped);
delete from public.customer_movements where order_id in (select id from _ped) or customer_id in (select id from public.customers where name like '[TEST]%');
delete from public.order_item_costs where order_item_id in (select id from public.order_items where order_id in (select id from _ped));
delete from public.stock_reservations where order_id in (select id from _ped);
delete from public.stock_movements where order_id in (select id from _ped) or product_id in (select id from public.products where code like 'TST-%');
delete from public.order_status_history where order_id in (select id from _ped);
delete from public.notifications where order_id in (select id from _ped);
alter table public.orders disable trigger user;
delete from public.order_items where order_id in (select id from _ped);
delete from public.orders where id in (select id from _ped);
alter table public.orders enable trigger user;
-- Auditoría generada por la prueba (por usuarios de prueba o sobre entidades de prueba)
delete from public.audit_logs where user_id in (select id from _fake)
  or entity_id in (select id::text from _ped)
  or entity_id in (select id::text from public.customers where name like '[TEST]%')
  or entity_id in (select id::text from public.products where code like 'TST-%')
  or entity_id in (select id::text from _fake)
  or entity_id in (select id::text from public.suppliers where company_name like '[TEST]%');
delete from public.customers where name like '[TEST]%';
delete from public.product_costs where product_id in (select id from public.products where code like 'TST-%');
delete from public.inventory where product_id in (select id from public.products where code like 'TST-%');
delete from public.products where code like 'TST-%';
delete from public.categories where name like '[TEST] %';
delete from public.warehouse_workers where profile_id in (select id from _fake);
delete from public.suppliers where profile_id in (select id from _fake);
delete from public.notifications where user_id in (select id from _fake);
delete from public.profiles where id in (select id from _fake);
delete from auth.users where id in (select id from _fake);
-- Rastro que dejó esta misma limpieza y la carga (altas/bajas de productos, rubros y depósito de prueba)
delete from public.audit_logs where entity_id in (select id from _ids) or entity_id in (select id::text from _fake);
commit;
