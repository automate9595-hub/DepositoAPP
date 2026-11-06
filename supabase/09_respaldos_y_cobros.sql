-- Correcciones DepositoAPP: respaldo seguro completo y registro del cobro al entregar.
-- Ejecutar DESPUES de instalar_todo.sql y 07_respaldos.sql.

-- Snapshot de tablas desde una función SECURITY DEFINER: permite respaldar tablas
-- deliberadamente inaccesibles desde el cliente (por ejemplo order_item_costs).
create or replace function public.backup_selected_snapshot(p_tables text[] default null)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare
  t text;
  allowed constant text[] := array[
    'roles','profiles','suppliers','warehouse_workers','categories','products','inventory',
    'orders','order_items','stock_reservations','stock_movements','order_transitions',
    'order_status_history','notifications','audit_logs','customers','customer_movements',
    'product_costs','order_item_costs','order_payments','backup_settings','backup_runs'
  ];
  chosen text[];
  payload jsonb := '{}'::jsonb;
  rows_json jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' and not public.is_admin() then
    raise exception 'NO_AUTORIZADO: solo el administrador puede generar respaldos';
  end if;
  chosen := coalesce(p_tables, allowed);
  if cardinality(chosen) = 0 then raise exception 'SELECCION_VACIA: no hay tablas seleccionadas'; end if;
  if exists (select 1 from unnest(chosen) x where not (x = any(allowed))) then
    raise exception 'TABLA_NO_PERMITIDA: la selección contiene una tabla no respaldable';
  end if;
  foreach t in array chosen loop
    execute format('select coalesce(jsonb_agg(to_jsonb(x)), ''[]''::jsonb) from public.%I x', t) into rows_json;
    payload := payload || jsonb_build_object(t, coalesce(rows_json, '[]'::jsonb));
  end loop;
  return jsonb_build_object('format','depositoapp-backup','format_version',2,
    'generated_at',now(),'database_tables',payload,
    'notes',jsonb_build_object('auth_passwords_included',false,'storage_product_photos_included',false));
end $fn$;
revoke all on function public.backup_selected_snapshot(text[]) from public, anon;
grant execute on function public.backup_selected_snapshot(text[]) to authenticated, service_role;

-- Registro de cobros vinculados al pedido, también para ventas de contado/publico general.
create table if not exists public.order_payments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete restrict,
  amount numeric(14,2) not null check (amount > 0),
  method text not null check (method in ('Efectivo','Transferencia','Cheque','Tarjeta','Otro')),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index if not exists order_payments_order on public.order_payments(order_id, created_at);
alter table public.order_payments enable row level security;
drop policy if exists order_payments_admin_read on public.order_payments;
create policy order_payments_admin_read on public.order_payments for select to authenticated using (public.is_admin());
grant select on public.order_payments to authenticated;

create or replace function public.confirm_delivery_with_payment(
  p_order_id uuid,
  p_payment_amount numeric default 0,
  p_payment_method text default null
) returns void language plpgsql security definer set search_path = public as $fn$
declare v_order public.orders%rowtype; v_paid numeric(14,2);
begin
  if not (public.has_perm('orders') or public.is_worker()) then
    raise exception 'NO_AUTORIZADO: no tiene permiso para confirmar entregas';
  end if;
  if p_payment_amount is null or p_payment_amount < 0 then raise exception 'MONTO_INVALIDO: monto de pago inválido'; end if;
  if p_payment_amount > 0 and coalesce(p_payment_method,'') not in ('Efectivo','Transferencia','Cheque','Tarjeta','Otro') then
    raise exception 'MEDIO_INVALIDO: seleccione un medio de pago';
  end if;
  perform public.confirm_delivery(p_order_id);
  select * into v_order from public.orders where id = p_order_id for update;
  v_paid := round(coalesce(v_order.total_delivered,0),2);
  if p_payment_amount > v_paid then raise exception 'MONTO_EXCEDIDO: el pago no puede superar el total entregado'; end if;
  if p_payment_amount > 0 then
    insert into public.order_payments(order_id,amount,method,created_by)
    values (p_order_id,round(p_payment_amount,2),p_payment_method,auth.uid());
    -- La entrega ya generó el cargo automático a cuenta corriente; registrar el pago
    -- compensa ese cargo. El cliente público no tiene cuenta y solo conserva el comprobante.
    if v_order.customer_id is not null and exists (
      select 1 from public.customers c where c.id=v_order.customer_id and not c.is_public
    ) then
      insert into public.customer_movements(customer_id,kind,amount,order_id,method,note,created_by)
      values (v_order.customer_id,'PAGO',-round(p_payment_amount,2),p_order_id,p_payment_method,'Cobro al entregar pedido',auth.uid());
    end if;
  end if;
end $fn$;
revoke all on function public.confirm_delivery_with_payment(uuid,numeric,text) from public, anon;
grant execute on function public.confirm_delivery_with_payment(uuid,numeric,text) to authenticated;
