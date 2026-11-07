-- =====================================================================
-- DepositoAPP · 12_seguridad_respaldos.sql
-- Corrección de seguridad (auditoría): los respaldos completos contienen costos, usuarios, auditoría y
-- cuentas corrientes. Hasta ahora podía pedirlos por la API cualquier administrador, incluido el
-- secundario aunque no tuviera esos permisos. Desde ahora solo el administrador PRINCIPAL
-- (o el programador interno del servidor, con service_role).
-- Ejecutar DESPUÉS de 07, 09, 10 y 11. Se puede re-ejecutar sin problema.
-- =====================================================================

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
  if coalesce(auth.role(), '') <> 'service_role' and public.my_role() is distinct from 'admin_principal' then
    raise exception 'NO_AUTORIZADO: solo el administrador principal puede generar respaldos';
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

create or replace function public.backup_snapshot()
returns jsonb language plpgsql security definer set search_path=public as $fn$
declare t text; payload jsonb := '{}'::jsonb; rows_json jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' and public.my_role() is distinct from 'admin_principal' then
    raise exception 'NO_AUTORIZADO: solo el administrador principal o el programador interno pueden generar respaldos';
  end if;
  foreach t in array array[
    'roles','profiles','suppliers','warehouse_workers','categories','products','inventory',
    'orders','order_items','stock_reservations','stock_movements','order_transitions',
    'order_status_history','notifications','audit_logs','customers','customer_movements',
    'product_costs','order_item_costs','order_payments','backup_settings','backup_runs'
  ] loop
    execute format('select coalesce(jsonb_agg(to_jsonb(x)), ''[]''::jsonb) from public.%I x', t) into rows_json;
    payload := payload || jsonb_build_object(t, rows_json);
  end loop;
  return jsonb_build_object(
    'format','depositoapp-backup','format_version',1,
    'generated_at',now(),'database_tables',payload,
    'notes',jsonb_build_object('auth_passwords_included',false,'storage_product_photos_included',false)
  );
end $fn$;
revoke all on function public.backup_snapshot() from public, anon;
grant execute on function public.backup_snapshot() to authenticated, service_role;
