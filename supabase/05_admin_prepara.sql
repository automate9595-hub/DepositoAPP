-- =====================================================================
-- DepositoAPP · 05_admin_prepara.sql
-- MIGRACIÓN para instalaciones YA existentes (no hace falta si instala desde cero
-- con instalar_todo.sql, que ya lo incluye).
-- Permite que la administración (principal, o segundo admin con permiso "Pedidos")
-- prepare pedidos con el mismo rol que el personal de depósito:
-- iniciar preparación, marcar preparado / faltante, finalizar y ser asignada.
-- Ejecutar UNA vez en Supabase → SQL Editor. Se puede re-ejecutar sin problema.
-- =====================================================================

-- Puede preparar pedidos: personal de depósito activo O administración con permiso de pedidos.
create or replace function public.can_prepare() returns boolean
language sql stable security definer set search_path = public as $fn$
  select public.is_worker() or public.has_perm('orders')
$fn$;

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
      'Pedido #' || v_o.order_number || ': "' || v_it.product_name || '" ' || p_qty || ' de ' || v_it.qty_approved
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
  perform public._notify(v_sup_profile, 'Pedido listo', 'Su pedido #' || v_o.order_number || ' está listo para entregar', p_order_id);
  perform public._notify_admins('Pedido listo para entregar', 'Pedido #' || v_o.order_number || ' terminó de prepararse', p_order_id);
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


revoke all on function public.can_prepare() from public, anon;
grant execute on function public.can_prepare() to authenticated;
