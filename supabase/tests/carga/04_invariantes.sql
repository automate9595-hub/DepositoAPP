-- Verificación de INVARIANTES tras una corrida masiva: ninguna cuenta puede estar mal, pase lo que pase en la concurrencia.
-- Requiere _load.stock0 (foto del stock antes de la corrida, la crea 03_flujo_masivo.sh).
create temp table _inv(nombre text, violaciones bigint, detalle text);
insert into _inv select 'stock >= 0 y reservado >= 0', count(*), null from public.inventory where physical_stock < 0 or reserved_stock < 0;
insert into _inv select 'reservado <= físico', count(*), null from public.inventory where reserved_stock > physical_stock;
insert into _inv select 'reservado == suma de reservas activas', count(*), string_agg(i.product_id::text, ',') from (
  select i.product_id from public.inventory i left join (select product_id, sum(quantity) q from public.stock_reservations where status = 'ACTIVA' group by 1) r on r.product_id = i.product_id
  where i.reserved_stock <> coalesce(r.q, 0) limit 5) i;
insert into _inv select 'cadena de movimientos de stock sin saltos', count(*), null from (
  select physical_before, lag(physical_after) over (partition by product_id order by id) prev, reserved_before, lag(reserved_after) over (partition by product_id order by id) rprev
  from public.stock_movements) m where (prev is not null and physical_before <> prev) or (rprev is not null and reserved_before <> rprev);
insert into _inv select 'stock actual == stock inicial - unidades entregadas', count(*), null from (
  select i.product_id from public.inventory i join _load.stock0 s using (product_id)
  left join (select oi.product_id, sum(oi.qty_delivered) q from public.order_items oi join public.orders o on o.id = oi.order_id where o.status = 'ENTREGADO' group by 1) d on d.product_id = i.product_id
  where i.physical_stock <> s.physical_stock - coalesce(d.q, 0)) x;
insert into _inv select 'reservas activas solo en pedidos vivos', count(*), null from public.stock_reservations r join public.orders o on o.id = r.order_id
  where r.status = 'ACTIVA' and o.status not in ('APROBADO','EN_PREPARACION','PREPARADO_PARCIALMENTE','LISTO_PARA_ENTREGAR');
insert into _inv select 'total entregado == suma de renglones entregados', count(*), null from public.orders o
  where o.status = 'ENTREGADO' and round(o.total_delivered, 2) <> (select round(coalesce(sum(qty_delivered * unit_price), 0), 2) from public.order_items where order_id = o.id);
insert into _inv select 'cuenta corriente: 1 cargo por pedido entregado a cliente con cuenta', count(*), null from public.orders o join public.customers c on c.id = o.customer_id
  where o.status = 'ENTREGADO' and not c.is_public and (select count(*) from public.customer_movements m where m.order_id = o.id and m.kind = 'CARGO') <> 1;
insert into _inv select 'cuenta corriente: sin cargos de pedidos no entregados', count(*), null from public.customer_movements m join public.orders o on o.id = m.order_id where m.kind = 'CARGO' and o.status <> 'ENTREGADO';
insert into _inv select 'cobros <= entregado', count(*), null from public.orders o
  where (select coalesce(sum(amount), 0) from public.order_payments where order_id = o.id) > round(coalesce(o.total_delivered, 0), 2);
insert into _inv select 'comisión: una por pedido entregado (si el % > 0), ninguna en los demás', count(*), null from public.orders o
  left join public.order_commissions c on c.order_id = o.id left join public.supplier_commissions sc on sc.supplier_id = o.supplier_id
  where (o.status = 'ENTREGADO' and coalesce(o.total_delivered, 0) > 0 and coalesce(sc.pct, 0) > 0 and c.order_id is null) or (o.status <> 'ENTREGADO' and c.order_id is not null);
insert into _inv select 'comisión: importe == base x % (redondeado)', count(*), null from public.order_commissions where amount <> round(base_amount * pct / 100, 2);
insert into _inv select 'comisión sobre ventas: base == total entregado', count(*), null from public.order_commissions c join public.orders o on o.id = c.order_id where c.base = 'VENTAS' and c.base_amount <> round(o.total_delivered, 2);
insert into _inv select 'comisión sobre ganancia: base == entregado - costo congelado', count(*), null from public.order_commissions c join public.orders o on o.id = c.order_id
  where c.base = 'GANANCIA' and c.base_amount <> greatest(round(o.total_delivered - (select coalesce(sum(ic.unit_cost * oi.qty_delivered), 0) from public.order_items oi join public.order_item_costs ic on ic.order_item_id = oi.id where oi.order_id = o.id), 2), 0);
insert into _inv select 'pagos de comisión <= comisión ganada (por preventista)', count(*), null from public.suppliers s
  where (select coalesce(sum(amount), 0) from public.commission_payouts where supplier_id = s.id) > (select coalesce(sum(amount), 0) from public.order_commissions where supplier_id = s.id);
insert into _inv select 'pedidos con transición inválida en el historial', count(*), null from (
  select order_id, to_status, lag(to_status) over (partition by order_id order by id) ps from public.order_status_history) h
  where (ps = 'ENTREGADO' and to_status <> 'ENTREGADO') or (ps in ('CANCELADO','RECHAZADO') and to_status is not null);
select nombre, violaciones, case when violaciones = 0 then 'OK' else 'FALLA ' || coalesce(detalle, '') end as resultado from _inv order by 1;
select case when exists (select 1 from _inv where violaciones > 0) then 'INVARIANTES: HAY VIOLACIONES' else 'INVARIANTES: TODAS OK (' || (select count(*) from _inv) || ' controles)' end as resultado_final;
