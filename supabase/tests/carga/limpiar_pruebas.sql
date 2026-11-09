-- Borra TODO lo creado por las pruebas masivas (catálogo TST-, usuarios/clientes/pedidos de prueba "ld_*"/"[TEST]").
-- Ejecutar con el rol postgres (SQL Editor de Supabase). No toca datos reales.
begin;
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
delete from public.customers where name like '[TEST]%';
delete from public.product_costs where product_id in (select id from public.products where code like 'TST-%');
delete from public.inventory where product_id in (select id from public.products where code like 'TST-%');
delete from public.products where code like 'TST-%';
delete from public.categories where name like '[TEST] %';
commit;
