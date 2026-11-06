-- =====================================================================
-- DepositoAPP · 06_clientes_costos.sql
-- Ejecutar DESPUÉS de 01, 02 y 03 (o pegar completo en una instalación existente). Se puede re-ejecutar.
-- Agrega:
--   * Clientes (con "Cliente público general"), cuenta corriente y estado "al día / con saldo / vencido".
--   * Precio de costo por producto (visible SOLO para administradores) y ganancia en estadísticas.
--   * Pedidos que muestran "Pedido número N del cliente X" (el cliente es obligatorio al enviar).
--   * La administración puede agregar productos a un pedido recibido.
--   * Estadísticas por período con series diarias (gráficos).
--   * Nuevo permiso "customers" (Clientes) para segundos administradores.
--   * Incluye todo lo de 05_admin_prepara.sql (administración prepara pedidos).
-- Nota: si vuelve a ejecutar 03_seguridad.sql, ejecute este archivo otra vez después.
-- =====================================================================

-- ---------- Clientes ----------
create table if not exists public.customers (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(trim(name)) > 0),
  phone       text,
  email       text,
  address     text,
  tax_id      text,
  notes       text,
  supplier_id uuid references public.suppliers(id),        -- null = disponible para todos los proveedores
  is_public   boolean not null default false,              -- "Cliente público general" (contado, sin cuenta corriente)
  credit_days integer not null default 30 check (credit_days between 0 and 365),
  active      boolean not null default true,
  created_by  uuid references public.profiles(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index if not exists customers_one_public on public.customers(is_public) where is_public;
create index if not exists customers_supplier on public.customers(supplier_id);
insert into public.customers(name, is_public, credit_days)
  select 'Cliente público general', true, 0
  where not exists (select 1 from public.customers where is_public);
drop trigger if exists trg_customers_touch on public.customers;
create trigger trg_customers_touch before update on public.customers
  for each row execute function public.touch_updated_at();

-- Pedido -> cliente (con fotografía del nombre, igual que precios y nombres de productos)
alter table public.orders add column if not exists customer_id   uuid references public.customers(id);
alter table public.orders add column if not exists customer_name text;
create index if not exists orders_customer on public.orders(customer_id, created_at desc);
update public.orders o set customer_id = c.id, customer_name = c.name
  from public.customers c where c.is_public and o.customer_id is null;

-- Etiqueta legible del pedido: "Pedido número 12 del cliente Juan Pérez"
create or replace function public._order_label(p_order uuid) returns text
language sql stable security definer set search_path = public as $fn$
  select 'Pedido número ' || o.order_number || ' del cliente ' || coalesce(nullif(o.customer_name, ''), 'Cliente público general')
  from public.orders o where o.id = p_order
$fn$;

-- Puede preparar pedidos: depósito activo o administración con permiso de pedidos (ver 05)
create or replace function public.can_prepare() returns boolean
language sql stable security definer set search_path = public as $fn$
  select public.is_worker() or public.has_perm('orders')
$fn$;

-- ---------- Enviar pedido: ahora exige un cliente ----------
drop function if exists public.submit_order(uuid, jsonb, text);
create or replace function public.submit_order(p_client_request_id uuid, p_items jsonb, p_notes text default null, p_customer_id uuid default null)
returns uuid language plpgsql security definer set search_path = public as $fn$
declare
  v_sup uuid; v_order uuid; v_row record; v_prod record; v_total numeric(14,2) := 0; v_name text; v_cust public.customers%rowtype;
begin
  v_sup := public.my_supplier_id();
  if v_sup is null then raise exception 'NO_AUTORIZADO: solo los proveedores activos pueden enviar pedidos'; end if;
  if p_client_request_id is null then raise exception 'DATOS_INVALIDOS: falta el identificador de la solicitud'; end if;
  if p_customer_id is null then raise exception 'CLIENTE_REQUERIDO: elija un cliente o "Cliente público general"'; end if;
  select * into v_cust from public.customers c
    where c.id = p_customer_id and c.active and (c.is_public or c.supplier_id is null or c.supplier_id = v_sup);
  if not found then raise exception 'CLIENTE_INVALIDO: el cliente no existe o no está disponible para usted'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'DATOS_INVALIDOS: el pedido no tiene productos';
  end if;
  if jsonb_array_length(p_items) > 300 then raise exception 'DATOS_INVALIDOS: demasiados productos en un pedido'; end if;
  if exists (select 1 from jsonb_array_elements(p_items) e
             where (e->>'product_id') is null or (e->>'qty') is null or (e->>'qty') !~ '^[0-9]{1,6}$' or (e->>'qty')::int <= 0) then
    raise exception 'DATOS_INVALIDOS: producto o cantidad no válidos';
  end if;

  insert into public.orders(supplier_id, client_request_id, supplier_notes, customer_id, customer_name)
  values (v_sup, p_client_request_id, nullif(left(trim(coalesce(p_notes, '')), 500), ''), v_cust.id, v_cust.name)
  on conflict (supplier_id, client_request_id) do nothing
  returning id into v_order;
  if v_order is null then
    select id into v_order from public.orders where supplier_id = v_sup and client_request_id = p_client_request_id;
    return v_order;
  end if;

  for v_row in
    select (e->>'product_id')::uuid as pid, sum((e->>'qty')::int)::int as qty
    from jsonb_array_elements(p_items) e group by 1 order by 1
  loop
    select p.id, p.code, p.name, p.price, i.available_stock into v_prod
    from public.products p join public.inventory i on i.product_id = p.id
    where p.id = v_row.pid and p.active;
    if not found then raise exception 'PRODUCTO_NO_DISPONIBLE: uno de los productos ya no está disponible'; end if;
    if v_row.qty > v_prod.available_stock then
      raise exception 'STOCK_INSUFICIENTE: "%" tiene % unidades disponibles y pidió %', v_prod.name, v_prod.available_stock, v_row.qty;
    end if;
    insert into public.order_items(order_id, product_id, product_code, product_name, unit_price, qty_requested)
    values (v_order, v_prod.id, v_prod.code, v_prod.name, v_prod.price, v_row.qty);
    v_total := v_total + v_prod.price * v_row.qty;
  end loop;

  update public.orders set total_requested = v_total where id = v_order;
  insert into public.order_status_history(order_id, from_status, to_status, user_id, note)
  values (v_order, null, 'PENDIENTE_APROBACION', auth.uid(), 'Pedido enviado');
  select company_name into v_name from public.suppliers where id = v_sup;
  perform public._notify_admins('Nuevo pedido', public._order_label(v_order) || ' · enviado por ' || v_name || ', pendiente de aprobación', v_order);
  perform public._audit('ENVIAR_PEDIDO', 'orders', v_order::text, jsonb_build_object('total', v_total, 'cliente', v_cust.name));
  return v_order;
end $fn$;


-- ---------- Funciones de pedidos actualizadas (texto 'Pedido número N del cliente X' y preparación por administración) ----------
create or replace function public.approve_order(p_order_id uuid, p_items jsonb default null, p_notes text default null)
returns void language plpgsql security definer set search_path = public as $fn$
declare
  v_o public.orders%rowtype; v_e jsonb; v_it record; v_inv public.inventory%rowtype; v_sup_profile uuid;
begin
  if not public.has_perm('orders') then raise exception 'NO_AUTORIZADO: no tiene permiso para aprobar pedidos'; end if;
  select * into v_o from public.orders where id = p_order_id for update;
  if not found then raise exception 'NO_ENCONTRADO: el pedido no existe'; end if;
  if v_o.status <> 'PENDIENTE_APROBACION' then
    raise exception 'ESTADO_INVALIDO: el pedido ya no está pendiente de aprobación (estado: %)', v_o.status;
  end if;

  if p_items is not null then
    if jsonb_typeof(p_items) <> 'array' then raise exception 'DATOS_INVALIDOS: formato de cantidades no válido'; end if;
    for v_e in select * from jsonb_array_elements(p_items) loop
      update public.order_items set qty_approved = (v_e->>'qty')::int
        where id = (v_e->>'item_id')::uuid and order_id = p_order_id
          and (v_e->>'qty')::int between 0 and qty_requested;
      if not found then raise exception 'DATOS_INVALIDOS: cantidad aprobada fuera de rango'; end if;
    end loop;
  end if;
  update public.order_items set qty_approved = qty_requested where order_id = p_order_id and qty_approved is null;

  if not exists (select 1 from public.order_items where order_id = p_order_id and qty_approved > 0) then
    raise exception 'SIN_CANTIDADES: no hay cantidades para aprobar, use Rechazar';
  end if;

  -- Orden fijo por producto para evitar bloqueos cruzados (deadlocks)
  for v_it in select * from public.order_items where order_id = p_order_id and qty_approved > 0 order by product_id loop
    select * into v_inv from public.inventory where product_id = v_it.product_id for update;
    if v_it.qty_approved > v_inv.available_stock then
      raise exception 'STOCK_INSUFICIENTE: "%" tiene % unidades disponibles y se intenta aprobar %',
        v_it.product_name, v_inv.available_stock, v_it.qty_approved;
    end if;
    update public.inventory set reserved_stock = reserved_stock + v_it.qty_approved, updated_at = now()
      where product_id = v_it.product_id;
    insert into public.stock_reservations(order_item_id, order_id, product_id, quantity)
      values (v_it.id, p_order_id, v_it.product_id, v_it.qty_approved);
    perform public._log_move(v_it.product_id, p_order_id, 'RESERVA', v_it.qty_approved,
      v_inv.physical_stock, v_inv.physical_stock, v_inv.reserved_stock, v_inv.reserved_stock + v_it.qty_approved,
      'Pedido aprobado');
  end loop;

  update public.orders set
    approved_by = auth.uid(), approved_at = now(),
    admin_notes = coalesce(nullif(trim(p_notes), ''), admin_notes),
    total_approved = (select coalesce(sum(unit_price * qty_approved), 0) from public.order_items where order_id = p_order_id)
  where id = p_order_id;
  perform public._set_status(p_order_id, 'APROBADO', nullif(trim(p_notes), ''));

  select profile_id into v_sup_profile from public.suppliers where id = v_o.supplier_id;
  perform public._notify(v_sup_profile, 'Pedido aprobado', public._order_label(v_o.id) || ' fue aprobado', p_order_id);
  perform public._notify_warehouse('Pedido para preparar', public._order_label(v_o.id) || ' listo para preparar', p_order_id);
  perform public._audit('APROBAR_PEDIDO', 'orders', p_order_id::text, p_items);
end $fn$;

-- =====================================================================
-- ADMIN: modificar cantidades de un pedido ya aprobado (recalcula reservas)
-- =====================================================================
create or replace function public.modify_approved_order(p_order_id uuid, p_items jsonb, p_notes text default null)
returns void language plpgsql security definer set search_path = public as $fn$
declare
  v_o public.orders%rowtype; v_it record; v_inv public.inventory%rowtype;
  v_delta int; v_n int; v_matched int := 0; v_sup_profile uuid;
begin
  if not public.has_perm('orders') then raise exception 'NO_AUTORIZADO: no tiene permiso para modificar pedidos'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'DATOS_INVALIDOS: no hay cantidades para modificar';
  end if;
  select * into v_o from public.orders where id = p_order_id for update;
  if not found then raise exception 'NO_ENCONTRADO: el pedido no existe'; end if;
  if v_o.status not in ('APROBADO','EN_PREPARACION','PREPARADO_PARCIALMENTE') then
    raise exception 'ESTADO_INVALIDO: solo se pueden modificar pedidos aprobados o en preparación (estado: %)', v_o.status;
  end if;
  select count(*) into v_n from jsonb_array_elements(p_items);

  for v_it in
    select oi.id, oi.product_id, oi.product_name, oi.qty_approved, oi.qty_prepared, oi.qty_requested, oi.prepared,
           (e->>'qty')::int as new_qty
    from jsonb_array_elements(p_items) e
    join public.order_items oi on oi.id = (e->>'item_id')::uuid and oi.order_id = p_order_id
    order by oi.product_id
  loop
    v_matched := v_matched + 1;
    if v_it.new_qty < coalesce(v_it.qty_prepared, 0) or v_it.new_qty > v_it.qty_requested then
      raise exception 'DATOS_INVALIDOS: cantidad de "%" fuera de rango (mínimo preparado %, máximo pedido %)',
        v_it.product_name, coalesce(v_it.qty_prepared, 0), v_it.qty_requested;
    end if;
    v_delta := v_it.new_qty - coalesce(v_it.qty_approved, 0);
    if v_delta <> 0 then
      select * into v_inv from public.inventory where product_id = v_it.product_id for update;
      if v_delta > v_inv.available_stock then
        raise exception 'STOCK_INSUFICIENTE: "%" tiene % unidades disponibles y se necesitan % más',
          v_it.product_name, v_inv.available_stock, v_delta;
      end if;
      update public.inventory set reserved_stock = reserved_stock + v_delta, updated_at = now()
        where product_id = v_it.product_id;
      insert into public.stock_reservations(order_item_id, order_id, product_id, quantity, status)
        values (v_it.id, p_order_id, v_it.product_id, v_it.new_qty, 'ACTIVA')
        on conflict (order_item_id) do update set quantity = excluded.quantity, status = 'ACTIVA', updated_at = now();
      perform public._log_move(v_it.product_id, p_order_id, case when v_delta > 0 then 'RESERVA' else 'LIBERACION' end, v_delta,
        v_inv.physical_stock, v_inv.physical_stock, v_inv.reserved_stock, v_inv.reserved_stock + v_delta,
        'Pedido modificado por administrador');
      update public.order_items set qty_approved = v_it.new_qty,
        prepared = case when v_it.prepared and v_it.new_qty > coalesce(v_it.qty_prepared, 0) then false else v_it.prepared end
        where id = v_it.id;
    end if;
  end loop;
  if v_matched <> v_n then raise exception 'DATOS_INVALIDOS: algún producto no pertenece al pedido'; end if;
  if not exists (select 1 from public.order_items where order_id = p_order_id and qty_approved > 0) then
    raise exception 'SIN_CANTIDADES: el pedido no puede quedar sin productos, use Cancelar';
  end if;

  update public.orders set
    admin_notes = coalesce(nullif(trim(p_notes), ''), admin_notes),
    total_approved = (select coalesce(sum(unit_price * qty_approved), 0) from public.order_items where order_id = p_order_id),
    updated_at = now()
  where id = p_order_id;
  insert into public.order_status_history(order_id, from_status, to_status, user_id, note)
    values (p_order_id, v_o.status, v_o.status, auth.uid(), 'Cantidades modificadas');
  select profile_id into v_sup_profile from public.suppliers where id = v_o.supplier_id;
  perform public._notify(v_sup_profile, 'Pedido modificado', 'Se modificaron cantidades de: ' || public._order_label(v_o.id), p_order_id);
  perform public._notify_warehouse('Pedido modificado', 'Cambió: ' || public._order_label(v_o.id), p_order_id);
  perform public._audit('MODIFICAR_PEDIDO', 'orders', p_order_id::text, p_items);
end $fn$;

-- =====================================================================
-- ADMIN: rechazar
-- =====================================================================
create or replace function public.reject_order(p_order_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $fn$
declare v_o public.orders%rowtype; v_sup_profile uuid;
begin
  if not public.has_perm('orders') then raise exception 'NO_AUTORIZADO: no tiene permiso para rechazar pedidos'; end if;
  if p_reason is null or length(trim(p_reason)) = 0 then raise exception 'MOTIVO_REQUERIDO: indique el motivo del rechazo'; end if;
  select * into v_o from public.orders where id = p_order_id for update;
  if not found then raise exception 'NO_ENCONTRADO: el pedido no existe'; end if;
  if v_o.status <> 'PENDIENTE_APROBACION' then
    raise exception 'ESTADO_INVALIDO: solo se pueden rechazar pedidos pendientes (estado: %)', v_o.status;
  end if;
  update public.orders set admin_notes = trim(p_reason) where id = p_order_id;
  perform public._set_status(p_order_id, 'RECHAZADO', trim(p_reason));
  select profile_id into v_sup_profile from public.suppliers where id = v_o.supplier_id;
  perform public._notify(v_sup_profile, 'Pedido rechazado', public._order_label(v_o.id) || ' fue rechazado: ' || trim(p_reason), p_order_id);
  perform public._audit('RECHAZAR_PEDIDO', 'orders', p_order_id::text, jsonb_build_object('motivo', p_reason));
end $fn$;

-- =====================================================================
-- Cancelar: el proveedor solo sus pedidos pendientes; el admin cualquiera no final.
-- =====================================================================
create or replace function public.cancel_order(p_order_id uuid, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $fn$
declare v_o public.orders%rowtype; v_sup uuid; v_sup_profile uuid;
begin
  select * into v_o from public.orders where id = p_order_id for update;
  if not found then raise exception 'NO_ENCONTRADO: el pedido no existe'; end if;
  v_sup := public.my_supplier_id();
  if v_sup is not null and v_o.supplier_id = v_sup then
    if v_o.status <> 'PENDIENTE_APROBACION' then
      raise exception 'ESTADO_INVALIDO: solo puede cancelar pedidos pendientes; contacte al administrador';
    end if;
  elsif not public.has_perm('orders') then
    raise exception 'NO_AUTORIZADO: no tiene permiso para cancelar este pedido';
  end if;
  perform public._release_reservations(p_order_id);
  update public.orders set admin_notes = coalesce(nullif(trim(p_reason), ''), admin_notes) where id = p_order_id;
  perform public._set_status(p_order_id, 'CANCELADO', nullif(trim(p_reason), ''));
  if v_sup is null then
    select profile_id into v_sup_profile from public.suppliers where id = v_o.supplier_id;
    perform public._notify(v_sup_profile, 'Pedido cancelado', public._order_label(v_o.id) || ' fue cancelado', p_order_id);
  else
    perform public._notify_admins('Pedido cancelado', 'El proveedor canceló: ' || public._order_label(v_o.id), p_order_id);
  end if;
  perform public._audit('CANCELAR_PEDIDO', 'orders', p_order_id::text, jsonb_build_object('motivo', p_reason));
end $fn$;

-- =====================================================================
-- DEPÓSITO
-- =====================================================================
create or replace function public.start_preparation(p_order_id uuid)
returns void language plpgsql security definer set search_path = public as $fn$
declare v_o public.orders%rowtype;
begin
  if not public.can_prepare() then raise exception 'NO_AUTORIZADO: solo el depósito o la administración con permiso de pedidos pueden preparar pedidos'; end if;
  select * into v_o from public.orders where id = p_order_id for update;
  if not found then raise exception 'NO_ENCONTRADO: el pedido no existe'; end if;
  if v_o.status = 'APROBADO' then
    update public.orders set assigned_to = auth.uid() where id = p_order_id;
    perform public._set_status(p_order_id, 'EN_PREPARACION', 'Preparación iniciada');
    perform public._audit('INICIAR_PREPARACION', 'orders', p_order_id::text);
  elsif v_o.status in ('EN_PREPARACION','PREPARADO_PARCIALMENTE') and v_o.assigned_to is null then
    update public.orders set assigned_to = auth.uid() where id = p_order_id;
  elsif v_o.assigned_to is distinct from auth.uid() then
    raise exception 'ASIGNADO_A_OTRO: el pedido está siendo preparado por otra persona';
  end if;
end $fn$;

-- Marca un producto como preparado con la cantidad realmente preparada.
create or replace function public.report_item(p_item_id uuid, p_qty int, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $fn$
declare v_it public.order_items%rowtype; v_o public.orders%rowtype; v_short boolean;
begin
  if not public.can_prepare() then raise exception 'NO_AUTORIZADO: solo el depósito o la administración con permiso de pedidos pueden preparar pedidos'; end if;
  select * into v_it from public.order_items where id = p_item_id;
  if not found then raise exception 'NO_ENCONTRADO: el producto del pedido no existe'; end if;
  select * into v_o from public.orders where id = v_it.order_id for update;
  if v_o.status not in ('EN_PREPARACION','PREPARADO_PARCIALMENTE') then
    raise exception 'ESTADO_INVALIDO: el pedido no está en preparación (estado: %)', v_o.status;
  end if;
  if v_o.assigned_to is distinct from auth.uid() then
    raise exception 'ASIGNADO_A_OTRO: el pedido está siendo preparado por otra persona';
  end if;
  if coalesce(v_it.qty_approved, 0) <= 0 then raise exception 'DATOS_INVALIDOS: este producto no tiene cantidad aprobada'; end if;
  if p_qty is null or p_qty < 0 or p_qty > v_it.qty_approved then
    raise exception 'DATOS_INVALIDOS: la cantidad preparada debe estar entre 0 y %', v_it.qty_approved;
  end if;
  v_short := p_qty < v_it.qty_approved;
  if v_short and (p_reason is null or length(trim(p_reason)) = 0) then
    raise exception 'MOTIVO_REQUERIDO: indique el motivo del faltante';
  end if;
  update public.order_items set prepared = true, qty_prepared = p_qty,
    shortage_reason = case when v_short then trim(p_reason) else null end where id = p_item_id;
  if v_short then
    if v_o.status = 'EN_PREPARACION' then
      perform public._set_status(v_o.id, 'PREPARADO_PARCIALMENTE', 'Faltante informado');
    end if;
    perform public._notify_admins('Faltante en pedido',
      public._order_label(v_o.id) || ': "' || v_it.product_name || '" ' || p_qty || ' de ' || v_it.qty_approved
      || ' (' || trim(p_reason) || ')', v_o.id);
    perform public._audit('FALTANTE', 'order_items', p_item_id::text,
      jsonb_build_object('aprobado', v_it.qty_approved, 'preparado', p_qty, 'motivo', p_reason));
  end if;
end $fn$;

create or replace function public.unprepare_item(p_item_id uuid)
returns void language plpgsql security definer set search_path = public as $fn$
declare v_it public.order_items%rowtype; v_o public.orders%rowtype;
begin
  if not public.can_prepare() then raise exception 'NO_AUTORIZADO: solo el depósito o la administración con permiso de pedidos pueden preparar pedidos'; end if;
  select * into v_it from public.order_items where id = p_item_id;
  if not found then raise exception 'NO_ENCONTRADO: el producto del pedido no existe'; end if;
  select * into v_o from public.orders where id = v_it.order_id for update;
  if v_o.status not in ('EN_PREPARACION','PREPARADO_PARCIALMENTE') or v_o.assigned_to is distinct from auth.uid() then
    raise exception 'ESTADO_INVALIDO: no se puede deshacer en este momento';
  end if;
  update public.order_items set prepared = false, qty_prepared = null, shortage_reason = null where id = p_item_id;
end $fn$;

create or replace function public.finish_preparation(p_order_id uuid)
returns void language plpgsql security definer set search_path = public as $fn$
declare v_o public.orders%rowtype; v_short int; v_sup_profile uuid;
begin
  if not public.can_prepare() then raise exception 'NO_AUTORIZADO: solo el depósito o la administración con permiso de pedidos pueden preparar pedidos'; end if;
  select * into v_o from public.orders where id = p_order_id for update;
  if not found then raise exception 'NO_ENCONTRADO: el pedido no existe'; end if;
  if v_o.status not in ('EN_PREPARACION','PREPARADO_PARCIALMENTE') then
    raise exception 'ESTADO_INVALIDO: el pedido no está en preparación (estado: %)', v_o.status;
  end if;
  if v_o.assigned_to is distinct from auth.uid() then
    raise exception 'ASIGNADO_A_OTRO: el pedido está siendo preparado por otra persona';
  end if;
  if exists (select 1 from public.order_items where order_id = p_order_id and qty_approved > 0 and not prepared) then
    raise exception 'PREPARACION_INCOMPLETA: faltan productos por marcar como preparados';
  end if;
  select count(*) into v_short from public.order_items
    where order_id = p_order_id and qty_approved > 0 and coalesce(qty_prepared, 0) < qty_approved;
  update public.orders set prepared_at = now() where id = p_order_id;
  perform public._set_status(p_order_id, 'LISTO_PARA_ENTREGAR', case when v_short > 0 then v_short || ' producto(s) con faltante' end);
  select profile_id into v_sup_profile from public.suppliers where id = v_o.supplier_id;
  perform public._notify(v_sup_profile, 'Pedido listo', public._order_label(v_o.id) || ' está listo para entregar', p_order_id);
  perform public._notify_admins('Pedido listo para entregar', public._order_label(v_o.id) || ' terminó de prepararse', p_order_id);
  perform public._audit('FINALIZAR_PREPARACION', 'orders', p_order_id::text, jsonb_build_object('faltantes', v_short));
end $fn$;

-- Reasignación manual (por ejemplo si quien preparaba no puede continuar)
create or replace function public.assign_order(p_order_id uuid, p_worker uuid default null)
returns void language plpgsql security definer set search_path = public as $fn$
begin
  if not public.has_perm('orders') then raise exception 'NO_AUTORIZADO: no tiene permiso para asignar pedidos'; end if;
  if p_worker is not null and not exists (
      select 1 from public.profiles p where p.id = p_worker and p.active and (
        (p.role = 'deposito' and exists (select 1 from public.warehouse_workers w where w.profile_id = p.id and w.active))
        or p.role = 'admin_principal'
        or (p.role = 'admin_secundario' and coalesce((p.permissions->>'orders')::boolean, false)))) then
    raise exception 'DATOS_INVALIDOS: el usuario indicado no puede preparar pedidos';
  end if;
  update public.orders set assigned_to = p_worker, updated_at = now()
    where id = p_order_id and status in ('APROBADO','EN_PREPARACION','PREPARADO_PARCIALMENTE');
  if not found then raise exception 'ESTADO_INVALIDO: el pedido no admite reasignación'; end if;
  perform public._audit('ASIGNAR_PEDIDO', 'orders', p_order_id::text, jsonb_build_object('worker', p_worker));
end $fn$;

-- =====================================================================
-- ENTREGA: descuenta stock físico real y libera lo reservado
-- =====================================================================
create or replace function public.confirm_delivery(p_order_id uuid)
returns void language plpgsql security definer set search_path = public as $fn$
declare
  v_o public.orders%rowtype; v_res record; v_inv public.inventory%rowtype; v_d int; v_rest int; v_sup_profile uuid;
begin
  if not (public.has_perm('orders') or public.is_worker()) then
    raise exception 'NO_AUTORIZADO: no tiene permiso para confirmar entregas';
  end if;
  select * into v_o from public.orders where id = p_order_id for update;
  if not found then raise exception 'NO_ENCONTRADO: el pedido no existe'; end if;
  if v_o.status <> 'LISTO_PARA_ENTREGAR' then
    raise exception 'ESTADO_INVALIDO: el pedido no está listo para entregar (estado: %)', v_o.status;
  end if;

  for v_res in
    select r.id, r.product_id, r.quantity, coalesce(oi.qty_prepared, 0) as prepared
    from public.stock_reservations r join public.order_items oi on oi.id = r.order_item_id
    where r.order_id = p_order_id and r.status = 'ACTIVA' order by r.product_id
  loop
    select * into v_inv from public.inventory where product_id = v_res.product_id for update;
    v_d := least(v_res.prepared, v_res.quantity);
    v_rest := v_res.quantity - v_d;
    if v_d > 0 then
      update public.inventory set physical_stock = physical_stock - v_d, reserved_stock = reserved_stock - v_d, updated_at = now()
        where product_id = v_res.product_id;
      perform public._log_move(v_res.product_id, p_order_id, 'ENTREGA', -v_d,
        v_inv.physical_stock, v_inv.physical_stock - v_d, v_inv.reserved_stock, v_inv.reserved_stock - v_d, 'Entrega de pedido');
    end if;
    if v_rest > 0 then
      update public.inventory set reserved_stock = reserved_stock - v_rest, updated_at = now()
        where product_id = v_res.product_id;
      perform public._log_move(v_res.product_id, p_order_id, 'LIBERACION', -v_rest,
        v_inv.physical_stock - v_d, v_inv.physical_stock - v_d, v_inv.reserved_stock - v_d, v_inv.reserved_stock - v_d - v_rest,
        'Unidades no entregadas');
    end if;
    update public.stock_reservations set status = 'CONSUMIDA', updated_at = now() where id = v_res.id;
  end loop;

  update public.order_items set qty_delivered = least(coalesce(qty_prepared, 0), coalesce(qty_approved, 0))
    where order_id = p_order_id;
  update public.orders set delivered_at = now(), delivered_by = auth.uid(),
    total_delivered = (select coalesce(sum(unit_price * qty_delivered), 0) from public.order_items where order_id = p_order_id)
    where id = p_order_id;
  perform public._set_status(p_order_id, 'ENTREGADO', 'Entrega confirmada');
  select profile_id into v_sup_profile from public.suppliers where id = v_o.supplier_id;
  perform public._notify(v_sup_profile, 'Pedido entregado', public._order_label(v_o.id) || ' fue entregado', p_order_id);
  perform public._audit('CONFIRMAR_ENTREGA', 'orders', p_order_id::text);
end $fn$;


-- ---------- Cuenta corriente de clientes ----------
-- amount > 0 aumenta la deuda (CARGO por pedido entregado, o AJUSTE); amount < 0 la reduce (PAGO, o AJUSTE a favor).
create table if not exists public.customer_movements (
  id          bigint generated always as identity primary key,
  customer_id uuid not null references public.customers(id),
  kind        text not null check (kind in ('CARGO','PAGO','AJUSTE')),
  amount      numeric(14,2) not null,
  order_id    uuid references public.orders(id),
  method      text,
  note        text,
  created_by  uuid references public.profiles(id),
  created_at  timestamptz not null default now(),
  constraint customer_mov_sign check (
    (kind = 'CARGO' and amount > 0) or (kind = 'PAGO' and amount < 0) or (kind = 'AJUSTE' and amount <> 0))
);
create index if not exists customer_mov_customer on public.customer_movements(customer_id, created_at);
create unique index if not exists customer_mov_one_charge on public.customer_movements(order_id) where kind = 'CARGO';

-- Al entregar un pedido se carga su total entregado a la cuenta del cliente (el público general paga al contado)
create or replace function public.orders_charge_customer() returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  if new.status = 'ENTREGADO' and old.status is distinct from 'ENTREGADO'
     and new.customer_id is not null and coalesce(new.total_delivered, 0) > 0
     and not exists (select 1 from public.customers c where c.id = new.customer_id and c.is_public) then
    insert into public.customer_movements(customer_id, kind, amount, order_id, note, created_by)
    values (new.customer_id, 'CARGO', new.total_delivered, new.id, 'Pedido entregado', new.delivered_by)
    on conflict (order_id) where kind = 'CARGO' do nothing;
  end if;
  return new;
end $fn$;
drop trigger if exists trg_orders_charge on public.orders;
create trigger trg_orders_charge after update of status on public.orders
  for each row execute function public.orders_charge_customer();

-- ---------- Costos (solo administración) ----------
create table if not exists public.product_costs (
  product_id uuid primary key references public.products(id) on delete cascade,
  cost_price numeric(12,2) not null default 0 check (cost_price >= 0),
  updated_at timestamptz not null default now()
);
create table if not exists public.order_item_costs (
  order_item_id uuid primary key references public.order_items(id) on delete cascade,
  unit_cost     numeric(12,2) not null default 0 check (unit_cost >= 0)
);
create or replace function public.order_item_cost_snapshot() returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  insert into public.order_item_costs(order_item_id, unit_cost)
  values (new.id, coalesce((select cost_price from public.product_costs where product_id = new.product_id), 0))
  on conflict (order_item_id) do nothing;
  return new;
end $fn$;
drop trigger if exists trg_order_item_cost on public.order_items;
create trigger trg_order_item_cost after insert on public.order_items
  for each row execute function public.order_item_cost_snapshot();
insert into public.order_item_costs(order_item_id, unit_cost)
  select oi.id, coalesce(pc.cost_price, 0) from public.order_items oi
  left join public.product_costs pc on pc.product_id = oi.product_id
on conflict (order_item_id) do nothing;

create or replace function public.set_product_cost(p_product_id uuid, p_cost numeric)
returns void language plpgsql security definer set search_path = public as $fn$
begin
  if not public.has_perm('products') then raise exception 'NO_AUTORIZADO: no tiene permiso para modificar productos'; end if;
  if p_cost is null or p_cost < 0 or p_cost > 1000000000 then raise exception 'DATOS_INVALIDOS: el precio de costo no es válido'; end if;
  if not exists (select 1 from public.products where id = p_product_id) then raise exception 'NO_ENCONTRADO: el producto no existe'; end if;
  insert into public.product_costs(product_id, cost_price, updated_at) values (p_product_id, round(p_cost, 2), now())
    on conflict (product_id) do update set cost_price = excluded.cost_price, updated_at = now();
  -- Pedidos todavía no entregados toman el costo vigente
  update public.order_item_costs ic set unit_cost = round(p_cost, 2)
    from public.order_items oi join public.orders o on o.id = oi.order_id
    where ic.order_item_id = oi.id and oi.product_id = p_product_id
      and o.status in ('PENDIENTE_APROBACION','APROBADO','EN_PREPARACION','PREPARADO_PARCIALMENTE','LISTO_PARA_ENTREGAR');
  perform public._audit('COSTO_PRODUCTO', 'products', p_product_id::text, jsonb_build_object('costo', p_cost));
end $fn$;

-- ---------- Clientes: alta/edición, resumen y movimientos ----------
create or replace function public.save_customer(
  p_id uuid, p_name text, p_phone text default null, p_email text default null, p_address text default null,
  p_tax_id text default null, p_notes text default null, p_credit_days int default null,
  p_supplier_id uuid default null, p_active boolean default true)
returns uuid language plpgsql security definer set search_path = public as $fn$
declare v_sup uuid; v_adm boolean; v_c public.customers%rowtype; v_id uuid; v_name text;
begin
  v_sup := public.my_supplier_id(); v_adm := public.has_perm('customers');
  if not v_adm and v_sup is null then raise exception 'NO_AUTORIZADO: no tiene permiso para administrar clientes'; end if;
  v_name := left(trim(coalesce(p_name, '')), 120);
  if length(v_name) = 0 then raise exception 'DATOS_INVALIDOS: el nombre del cliente es obligatorio'; end if;
  if p_credit_days is not null and (p_credit_days < 0 or p_credit_days > 365) then raise exception 'DATOS_INVALIDOS: el plazo de pago debe estar entre 0 y 365 días'; end if;

  if p_id is null then
    insert into public.customers(name, phone, email, address, tax_id, notes, supplier_id, credit_days, active, created_by)
    values (v_name, nullif(left(trim(coalesce(p_phone, '')), 40), ''), nullif(left(trim(coalesce(p_email, '')), 120), ''),
            nullif(left(trim(coalesce(p_address, '')), 200), ''), nullif(left(trim(coalesce(p_tax_id, '')), 40), ''),
            nullif(left(trim(coalesce(p_notes, '')), 500), ''),
            case when v_adm then p_supplier_id else v_sup end,
            case when v_adm then coalesce(p_credit_days, 30) else 30 end,
            case when v_adm then coalesce(p_active, true) else true end, auth.uid())
    returning id into v_id;
  else
    select * into v_c from public.customers where id = p_id for update;
    if not found then raise exception 'NO_ENCONTRADO: el cliente no existe'; end if;
    if v_c.is_public then raise exception 'NO_AUTORIZADO: el cliente público general no se puede modificar'; end if;
    if not v_adm and v_c.supplier_id is distinct from v_sup then raise exception 'NO_AUTORIZADO: no puede modificar este cliente'; end if;
    update public.customers set name = v_name,
      phone = nullif(left(trim(coalesce(p_phone, '')), 40), ''), email = nullif(left(trim(coalesce(p_email, '')), 120), ''),
      address = nullif(left(trim(coalesce(p_address, '')), 200), ''), tax_id = nullif(left(trim(coalesce(p_tax_id, '')), 40), ''),
      notes = nullif(left(trim(coalesce(p_notes, '')), 500), ''),
      supplier_id = case when v_adm then p_supplier_id else supplier_id end,
      credit_days = case when v_adm then coalesce(p_credit_days, credit_days) else credit_days end,
      active = case when v_adm then coalesce(p_active, active) else active end
    where id = p_id;
    v_id := p_id;
    update public.orders set customer_name = v_name where customer_id = v_id and customer_name is distinct from v_name;
  end if;
  perform public._audit('CLIENTE_GUARDADO', 'customers', v_id::text, jsonb_build_object('nombre', v_name));
  return v_id;
end $fn$;

create or replace function public.customers_overview()
returns jsonb language plpgsql stable security definer set search_path = public as $fn$
declare v_sup uuid := public.my_supplier_id(); v_adm boolean := public.has_perm('customers'); v_res jsonb;
begin
  if not v_adm and v_sup is null then raise exception 'NO_AUTORIZADO: no tiene permiso para ver clientes'; end if;
  select jsonb_agg(to_jsonb(t) order by t.is_public desc, lower(t.name)) into v_res from (
    select c.id, c.name, c.phone, c.email, c.address, c.tax_id, c.notes, c.supplier_id, c.is_public, c.credit_days, c.active,
           s.company_name as supplier_name,
           x.acc as has_account,
           case when x.acc then coalesce(m.balance, 0) end as balance,
           case when x.acc then coalesce(m.charged, 0) end as charged,
           case when x.acc then coalesce(m.paid, 0) end as paid,
           case when x.acc then m.last_payment end as last_payment,
           case when x.acc then d.due_since end as due_since,
           case when not x.acc then null
                when coalesce(m.balance, 0) <= 0 then 'AL_DIA'
                when d.due_since is not null and d.due_since + make_interval(days => c.credit_days) < now() then 'VENCIDO'
                else 'CON_SALDO' end as account_status
    from public.customers c
    left join public.suppliers s on s.id = c.supplier_id
    cross join lateral (select (not c.is_public and (v_adm or (c.supplier_id is not null and c.supplier_id = v_sup))) as acc) x
    left join lateral (
      select sum(cm.amount) as balance,
             sum(cm.amount) filter (where cm.amount > 0) as charged,
             -sum(cm.amount) filter (where cm.amount < 0) as paid,
             max(cm.created_at) filter (where cm.kind = 'PAGO') as last_payment
      from public.customer_movements cm where cm.customer_id = c.id) m on true
    left join lateral (
      select min(z.created_at) as due_since from (
        select cm.created_at, sum(cm.amount) over (order by cm.created_at, cm.id) as run
        from public.customer_movements cm where cm.customer_id = c.id and cm.amount > 0) z
      where z.run > coalesce(m.paid, 0)) d on true
    where v_adm or (c.active and (c.is_public or c.supplier_id is null or c.supplier_id = v_sup))
  ) t;
  return coalesce(v_res, '[]'::jsonb);
end $fn$;

create or replace function public.customer_register_payment(p_customer uuid, p_amount numeric, p_method text default null, p_note text default null)
returns void language plpgsql security definer set search_path = public as $fn$
begin
  if not public.has_perm('customers') then raise exception 'NO_AUTORIZADO: no tiene permiso para registrar pagos'; end if;
  if p_amount is null or p_amount <= 0 or p_amount > 1000000000 then raise exception 'DATOS_INVALIDOS: el monto del pago no es válido'; end if;
  if not exists (select 1 from public.customers where id = p_customer and not is_public) then
    raise exception 'NO_ENCONTRADO: el cliente no existe o no lleva cuenta corriente';
  end if;
  insert into public.customer_movements(customer_id, kind, amount, method, note, created_by)
  values (p_customer, 'PAGO', -round(p_amount, 2), nullif(left(trim(coalesce(p_method, '')), 40), ''), nullif(left(trim(coalesce(p_note, '')), 300), ''), auth.uid());
  perform public._audit('PAGO_CLIENTE', 'customers', p_customer::text, jsonb_build_object('monto', p_amount, 'medio', p_method));
end $fn$;

create or replace function public.customer_adjust(p_customer uuid, p_amount numeric, p_note text)
returns void language plpgsql security definer set search_path = public as $fn$
begin
  if not public.has_perm('customers') then raise exception 'NO_AUTORIZADO: no tiene permiso para ajustar cuentas'; end if;
  if p_amount is null or p_amount = 0 or abs(p_amount) > 1000000000 then raise exception 'DATOS_INVALIDOS: el monto del ajuste no es válido'; end if;
  if p_note is null or length(trim(p_note)) = 0 then raise exception 'MOTIVO_REQUERIDO: indique el motivo del ajuste'; end if;
  if not exists (select 1 from public.customers where id = p_customer and not is_public) then
    raise exception 'NO_ENCONTRADO: el cliente no existe o no lleva cuenta corriente';
  end if;
  insert into public.customer_movements(customer_id, kind, amount, note, created_by)
  values (p_customer, 'AJUSTE', round(p_amount, 2), left(trim(p_note), 300), auth.uid());
  perform public._audit('AJUSTE_CLIENTE', 'customers', p_customer::text, jsonb_build_object('monto', p_amount, 'motivo', p_note));
end $fn$;

-- ---------- Administración: agregar productos a un pedido ----------
-- p_items: [{"product_id":"uuid","qty":3}, ...]. Pendiente: suma a lo pedido. Aprobado/en preparación: suma y reserva stock.
create or replace function public.admin_add_order_items(p_order_id uuid, p_items jsonb)
returns void language plpgsql security definer set search_path = public as $fn$
declare
  v_o public.orders%rowtype; v_row record; v_prod record; v_inv public.inventory%rowtype; v_it public.order_items%rowtype;
  v_pending boolean; v_item uuid; v_app int; v_sup_profile uuid;
begin
  if not public.has_perm('orders') then raise exception 'NO_AUTORIZADO: no tiene permiso para modificar pedidos'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'DATOS_INVALIDOS: no hay productos para agregar';
  end if;
  if jsonb_array_length(p_items) > 300 then raise exception 'DATOS_INVALIDOS: demasiados productos'; end if;
  if exists (select 1 from jsonb_array_elements(p_items) e
             where (e->>'product_id') is null or (e->>'qty') is null or (e->>'qty') !~ '^[0-9]{1,6}$' or (e->>'qty')::int <= 0) then
    raise exception 'DATOS_INVALIDOS: producto o cantidad no válidos';
  end if;
  select * into v_o from public.orders where id = p_order_id for update;
  if not found then raise exception 'NO_ENCONTRADO: el pedido no existe'; end if;
  if v_o.status not in ('PENDIENTE_APROBACION','APROBADO','EN_PREPARACION','PREPARADO_PARCIALMENTE') then
    raise exception 'ESTADO_INVALIDO: solo se pueden agregar productos a pedidos pendientes, aprobados o en preparación (estado: %)', v_o.status;
  end if;
  v_pending := (v_o.status = 'PENDIENTE_APROBACION');

  for v_row in
    select (e->>'product_id')::uuid as pid, sum((e->>'qty')::int)::int as qty
    from jsonb_array_elements(p_items) e group by 1 order by 1
  loop
    select p.id, p.code, p.name, p.price into v_prod from public.products p where p.id = v_row.pid and p.active;
    if not found then raise exception 'PRODUCTO_NO_DISPONIBLE: uno de los productos no existe o está inactivo'; end if;
    select * into v_inv from public.inventory where product_id = v_row.pid for update;
    if not found or v_row.qty > v_inv.available_stock then
      raise exception 'STOCK_INSUFICIENTE: "%" tiene % unidades disponibles y se intenta agregar %', v_prod.name, coalesce(v_inv.available_stock, 0), v_row.qty;
    end if;

    select * into v_it from public.order_items where order_id = p_order_id and product_id = v_row.pid for update;
    if found then
      v_item := v_it.id;
      update public.order_items set
        qty_requested = qty_requested + v_row.qty,
        qty_approved = case when v_pending then qty_approved else coalesce(qty_approved, 0) + v_row.qty end,
        prepared = case when v_pending then prepared else false end
      where id = v_item;
    else
      insert into public.order_items(order_id, product_id, product_code, product_name, unit_price, qty_requested, qty_approved)
      values (p_order_id, v_prod.id, v_prod.code, v_prod.name, v_prod.price, v_row.qty, case when v_pending then null else v_row.qty end)
      returning id into v_item;
    end if;

    if not v_pending then
      select qty_approved into v_app from public.order_items where id = v_item;
      update public.inventory set reserved_stock = reserved_stock + v_row.qty, updated_at = now() where product_id = v_row.pid;
      insert into public.stock_reservations(order_item_id, order_id, product_id, quantity, status)
        values (v_item, p_order_id, v_row.pid, v_app, 'ACTIVA')
        on conflict (order_item_id) do update set quantity = excluded.quantity, status = 'ACTIVA', updated_at = now();
      perform public._log_move(v_row.pid, p_order_id, 'RESERVA', v_row.qty,
        v_inv.physical_stock, v_inv.physical_stock, v_inv.reserved_stock, v_inv.reserved_stock + v_row.qty,
        'Producto agregado por administración');
    end if;
  end loop;

  update public.orders set
    total_requested = (select coalesce(sum(unit_price * qty_requested), 0) from public.order_items where order_id = p_order_id),
    total_approved = case when v_pending then total_approved
                          else (select coalesce(sum(unit_price * qty_approved), 0) from public.order_items where order_id = p_order_id) end,
    updated_at = now()
  where id = p_order_id;
  insert into public.order_status_history(order_id, from_status, to_status, user_id, note)
    values (p_order_id, v_o.status, v_o.status, auth.uid(), 'Productos agregados por administración');
  select profile_id into v_sup_profile from public.suppliers where id = v_o.supplier_id;
  perform public._notify(v_sup_profile, 'Pedido modificado', 'Se agregaron productos a: ' || public._order_label(p_order_id), p_order_id);
  if not v_pending then
    perform public._notify_warehouse('Pedido modificado', 'Se agregaron productos a: ' || public._order_label(p_order_id), p_order_id);
  end if;
  perform public._audit('AGREGAR_PRODUCTOS_PEDIDO', 'orders', p_order_id::text, p_items);
end $fn$;

-- ---------- Estadísticas por período ----------
create or replace function public.admin_stats_range(p_from date, p_to date, p_tz text default 'UTC')
returns jsonb language plpgsql stable security definer set search_path = public as $fn$
declare v_start timestamptz; v_end timestamptz; v_tz text := coalesce(nullif(trim(p_tz), ''), 'UTC'); v_res jsonb;
begin
  if not public.has_perm('stats') then raise exception 'NO_AUTORIZADO: no tiene permiso para ver estadísticas'; end if;
  if p_from is null or p_to is null or p_to < p_from then raise exception 'DATOS_INVALIDOS: el período no es válido'; end if;
  if p_to - p_from > 1830 then raise exception 'DATOS_INVALIDOS: el período máximo es de 5 años'; end if;
  begin perform now() at time zone v_tz; exception when others then v_tz := 'UTC'; end;
  v_start := p_from::timestamp at time zone v_tz;
  v_end := (p_to + 1)::timestamp at time zone v_tz;

  v_res := (
    with d as (
      select o.id as order_id, o.supplier_id, o.customer_name, o.total_delivered,
             (o.delivered_at at time zone v_tz)::date as day
      from public.orders o
      where o.status = 'ENTREGADO' and o.delivered_at >= v_start and o.delivered_at < v_end
    ), l as (
      select d.order_id, d.supplier_id, d.day, oi.product_name, oi.qty_delivered, oi.unit_price,
             coalesce(ic.unit_cost, 0) as unit_cost
      from d join public.order_items oi on oi.order_id = d.order_id
      left join public.order_item_costs ic on ic.order_item_id = oi.id
      where coalesce(oi.qty_delivered, 0) > 0
    )
    select jsonb_build_object(
      'from', p_from, 'to', p_to,
      'totals', jsonb_build_object(
        'orders_total', (select count(*) from public.orders where created_at >= v_start and created_at < v_end),
        'delivered_orders', (select count(*) from d),
        'revenue', (select coalesce(sum(total_delivered), 0) from d),
        'cost', (select coalesce(sum(qty_delivered * unit_cost), 0) from l),
        'units', (select coalesce(sum(qty_delivered), 0) from l),
        'items_without_cost', (select count(*) from l where unit_cost = 0)),
      'by_status', coalesce((select jsonb_object_agg(s.status, s.n) from
          (select status, count(*) as n from public.orders where created_at >= v_start and created_at < v_end group by status) s), '{}'::jsonb),
      'series', coalesce((
          select jsonb_agg(jsonb_build_object('d', g.day, 'orders', coalesce(oc.n, 0), 'revenue', coalesce(r.rev, 0), 'cost', coalesce(r.cost, 0)) order by g.day)
          from (select generate_series(p_from::timestamp, p_to::timestamp, interval '1 day')::date as day) g
          left join (select (o.created_at at time zone v_tz)::date as day, count(*) as n
                     from public.orders o where o.created_at >= v_start and o.created_at < v_end group by 1) oc on oc.day = g.day
          left join (select l.day, sum(l.unit_price * l.qty_delivered) as rev, sum(l.qty_delivered * l.unit_cost) as cost
                     from l group by l.day) r on r.day = g.day), '[]'::jsonb),
      'top_products', coalesce((select jsonb_agg(t) from (
          select l.product_name as name, sum(l.qty_delivered)::int as units, sum(l.unit_price * l.qty_delivered) as revenue,
                 sum((l.unit_price - l.unit_cost) * l.qty_delivered) as profit
          from l group by l.product_name order by 3 desc, 2 desc limit 30) t), '[]'::jsonb),
      'by_supplier', coalesce((select jsonb_agg(t) from (
          select s.company_name as name, count(distinct l.order_id)::int as orders, sum(l.unit_price * l.qty_delivered) as revenue,
                 sum((l.unit_price - l.unit_cost) * l.qty_delivered) as profit
          from l join public.suppliers s on s.id = l.supplier_id group by s.company_name order by 3 desc limit 10) t), '[]'::jsonb),
      'by_customer', coalesce((select jsonb_agg(t) from (
          select coalesce(d.customer_name, 'Sin cliente') as name, count(*)::int as orders, coalesce(sum(d.total_delivered), 0) as revenue
          from d group by 1 order by 3 desc, 2 desc limit 10) t), '[]'::jsonb),
      'receivables', (select jsonb_build_object('total_debt', coalesce(sum(b.bal), 0), 'debtors', count(*))
          from (select sum(amount) as bal from public.customer_movements group by customer_id having sum(amount) > 0) b),
      'stock_value', (select jsonb_build_object('cost', coalesce(sum(i.physical_stock * coalesce(pc.cost_price, 0)), 0),
                                                'sale', coalesce(sum(i.physical_stock * p.price), 0))
          from public.inventory i join public.products p on p.id = i.product_id
          left join public.product_costs pc on pc.product_id = p.id where p.active),
      'low_stock', coalesce((select jsonb_agg(t) from (
          select p.name, i.available_stock as available from public.inventory i join public.products p on p.id = i.product_id
          where p.active and i.available_stock <= 5 order by i.available_stock, p.name limit 20) t), '[]'::jsonb)
    )
  );
  return v_res;
end $fn$;

-- ---------- Seguridad (RLS y permisos) ----------
alter table public.customers          enable row level security;
alter table public.customer_movements enable row level security;
alter table public.product_costs      enable row level security;
alter table public.order_item_costs   enable row level security;
revoke all on public.customers, public.customer_movements, public.product_costs, public.order_item_costs from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
grant select on public.customers, public.customer_movements, public.product_costs to authenticated;
-- order_item_costs: sin acceso desde la app (solo funciones del servidor)

drop policy if exists customers_select on public.customers;
create policy customers_select on public.customers for select to authenticated using (
  public.has_perm('customers') or public.has_perm('orders')
  or (active and public.my_supplier_id() is not null
      and (is_public or supplier_id is null or supplier_id = public.my_supplier_id())));

drop policy if exists customer_movements_select on public.customer_movements;
create policy customer_movements_select on public.customer_movements for select to authenticated using (
  public.has_perm('customers')
  or exists (select 1 from public.customers c
             where c.id = customer_id and c.supplier_id is not null and c.supplier_id = public.my_supplier_id()));

drop policy if exists product_costs_select on public.product_costs;
create policy product_costs_select on public.product_costs for select to authenticated using (
  public.has_perm('products') or public.has_perm('stats'));

do $do$
declare r record;
begin
  for r in select p.oid::regprocedure as sig
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.prokind = 'f' loop
    execute format('revoke all on function %s from public, anon', r.sig);
    execute format('grant execute on function %s to authenticated', r.sig);
  end loop;
end $do$;
revoke execute on function public.bootstrap_principal(text) from authenticated;
revoke execute on function public._notify(uuid, text, text, uuid) from authenticated;
revoke execute on function public._notify_admins(text, text, uuid, text) from authenticated;
revoke execute on function public._notify_warehouse(text, text, uuid) from authenticated;
revoke execute on function public._audit(text, text, text, jsonb) from authenticated;
revoke execute on function public._set_status(uuid, text, text) from authenticated;
revoke execute on function public._log_move(uuid, uuid, text, int, int, int, int, int, text) from authenticated;
revoke execute on function public._release_reservations(uuid) from authenticated;
revoke execute on function public._order_label(uuid) from authenticated;
revoke execute on function public.orders_charge_customer() from authenticated;
revoke execute on function public.order_item_cost_snapshot() from authenticated;
