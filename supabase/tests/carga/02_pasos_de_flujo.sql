-- Pasos del flujo real, cada uno se ejecuta como su propio usuario y en su propia transacción (como en la app).
create or replace function _load.as_(u uuid) returns void language plpgsql as $f$
begin perform set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true); set local role authenticated; end $f$;
create or replace function _load.actor(k text, nn int) returns uuid language sql stable as $f$ select id from _load.actors where kind = k and n = nn $f$;

-- Un preventista arma un pedido de 3 a 8 productos con stock; 1 de cada 5 es para el público general
create or replace function _load.step_submit(p_prev int, p_hot boolean default false) returns uuid language plpgsql as $f$
declare v_items jsonb; v_cust uuid; v_k int := 3 + floor(random() * 6)::int; v_uid uuid := _load.actor('prev', p_prev); v_sup uuid; v_id uuid;
begin
  select supplier_id into v_sup from _load.actors where kind = 'prev' and n = p_prev;
  select jsonb_agg(jsonb_build_object('product_id', x.product_id, 'qty', 1 + floor(random() * least(6, x.available_stock))::int)) into v_items from (
    select i.product_id, i.available_stock from public.inventory i join public.products p on p.id = i.product_id
    where p.active and i.available_stock > 0 and (not p_hot or p.code <= 'TST-00005')
    order by random() limit v_k) x;
  if v_items is null then return null; end if;
  if random() < 0.2 then select id into v_cust from public.customers where is_public;
  else select id into v_cust from public.customers where supplier_id = v_sup order by random() limit 1; end if;
  perform _load.as_(v_uid);
  v_id := public.submit_order(gen_random_uuid(), v_items, 'carga', v_cust);
  return v_id;
exception when others then
  if sqlerrm like 'STOCK_INSUFICIENTE%' or sqlerrm like 'PRODUCTO_NO_DISPONIBLE%' then return null; end if;
  raise;
end $f$;

create or replace function _load.step_approve() returns uuid language plpgsql as $f$
declare v_id uuid;
begin
  select id into v_id from public.orders where status = 'PENDIENTE_APROBACION' order by created_at limit 1 for update skip locked;
  if v_id is null then return null; end if;
  perform _load.as_(_load.actor('admin', 1 + floor(random() * 3)::int));
  perform public.approve_order(v_id);
  return v_id;
exception when others then if sqlerrm like 'STOCK_INSUFICIENTE%' then return null; end if; raise;
end $f$;

-- Preparación completa: 1 de cada 8 renglones con faltante
create or replace function _load.step_prepare() returns uuid language plpgsql as $f$
declare v_id uuid; v_w uuid := _load.actor('deposito', 1 + floor(random() * 4)::int); it record;
begin
  select id into v_id from public.orders where status = 'APROBADO' order by created_at limit 1 for update skip locked;
  if v_id is null then return null; end if;
  perform _load.as_(v_w);
  perform public.start_preparation(v_id);
  for it in select id, qty_approved from public.order_items where order_id = v_id and qty_approved > 0 loop
    if random() < 0.125 and it.qty_approved > 1 then perform public.report_item(it.id, it.qty_approved - 1, 'faltante de prueba');
    else perform public.report_item(it.id, it.qty_approved); end if;
  end loop;
  perform public.finish_preparation(v_id);
  return v_id;
end $f$;

-- Entrega con cobro (la mitad paga todo, un cuarto paga parte, un cuarto queda a cuenta corriente)
create or replace function _load.step_deliver() returns uuid language plpgsql as $f$
declare v_id uuid; v_r numeric := random(); v_tot numeric; v_m text := (array['Efectivo','Transferencia','Tarjeta'])[1 + floor(random() * 3)::int];
begin
  select id into v_id from public.orders where status = 'LISTO_PARA_ENTREGAR' order by created_at limit 1 for update skip locked;
  if v_id is null then return null; end if;
  select coalesce(sum(qty_prepared * unit_price), 0) into v_tot from public.order_items where order_id = v_id;
  perform _load.as_(_load.actor('admin', 1 + floor(random() * 3)::int));
  perform public.confirm_delivery_with_payment(v_id, case when v_r < 0.5 then v_tot when v_r < 0.75 then round(v_tot / 2, 2) else 0 end, v_m);
  return v_id;
end $f$;

create or replace function _load.step_cancel() returns uuid language plpgsql as $f$
declare v_id uuid; v_sup uuid;
begin
  select o.id, o.supplier_id into v_id, v_sup from public.orders o where status = 'PENDIENTE_APROBACION' order by random() limit 1 for update skip locked;
  if v_id is null then return null; end if;
  perform _load.as_((select profile_id from public.suppliers where id = v_sup));
  perform public.cancel_order(v_id, 'cliente se arrepintió');
  return v_id;
end $f$;

-- Lecturas típicas de pantalla
create or replace function _load.step_read(p_prev int) returns int language plpgsql as $f$
declare n int; v_uid uuid := _load.actor('prev', p_prev); r numeric := random();
begin
  perform _load.as_(v_uid);
  if r < 0.35 then select count(*) into n from (select p.id, p.name, p.price, i.available_stock from public.products p join public.inventory i on i.product_id = p.id where p.active and p.name ilike '%' || (array['cola','jugo','queso','arroz','galle','limp'])[1 + floor(random()*6)::int] || '%' order by p.name limit 50) q;
  elsif r < 0.65 then select count(*) into n from (select * from public.orders order by created_at desc limit 30) q;
  elsif r < 0.85 then select jsonb_array_length(public.customers_overview()) into n;
  else select jsonb_array_length((public.commission_summary() -> 'orders')) into n; end if;
  return n;
end $f$;
grant usage on schema _load to authenticated;
grant execute on all functions in schema _load to authenticated;
