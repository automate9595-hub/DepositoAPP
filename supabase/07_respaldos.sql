-- =====================================================================
-- DepositoAPP · 07_respaldos.sql
-- Programación y registro de respaldos automáticos externos.
-- Ejecutar DESPUÉS de instalar_todo.sql. No borra ni modifica datos del negocio.
-- =====================================================================

create table if not exists public.backup_settings (
  id integer primary key default 1 check (id = 1),
  interval_minutes integer not null default 1440 check (interval_minutes in (60,180,360,720,1440,2880,4320,10080)),
  run_time time,
  retention_days integer not null default 30 check (retention_days in (7,15,30,60,90,0)),
  download_mode text not null default 'ask' check (download_mode in ('ask','auto','off')),
  next_run_at timestamptz,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);
insert into public.backup_settings(id, interval_minutes, retention_days, download_mode, next_run_at)
values (1, 1440, 30, 'ask', now() + interval '1 minute')
on conflict (id) do nothing;

create table if not exists public.backup_runs (
  id uuid primary key default gen_random_uuid(),
  storage_path text,
  status text not null check (status in ('ok','failed')),
  size_bytes bigint,
  created_at timestamptz not null default now(),
  error_message text,
  triggered_by text not null default 'scheduler'
);
create index if not exists backup_runs_created on public.backup_runs(created_at desc);

alter table public.backup_settings enable row level security;
alter table public.backup_runs enable row level security;
drop policy if exists backup_settings_admin_read on public.backup_settings;
create policy backup_settings_admin_read on public.backup_settings for select to authenticated using (public.is_admin());
drop policy if exists backup_settings_admin_write on public.backup_settings;
create policy backup_settings_admin_write on public.backup_settings for all to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists backup_runs_admin_read on public.backup_runs;
create policy backup_runs_admin_read on public.backup_runs for select to authenticated using (public.is_admin());
grant select, insert, update on public.backup_settings to authenticated;
grant select on public.backup_runs to authenticated;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('database-backups','database-backups',false,52428800,array['application/json'])
on conflict (id) do update set public=false, file_size_limit=52428800, allowed_mime_types=array['application/json'];
drop policy if exists database_backups_admin_read on storage.objects;
create policy database_backups_admin_read on storage.objects for select to authenticated
  using (bucket_id='database-backups' and public.is_admin());

-- Snapshot JSON completo de las tablas de negocio. Solo administradores pueden solicitarlo.
-- Las identidades/contraseñas de Supabase Auth no se exportan: permanecen en Auth.
create or replace function public.backup_snapshot()
returns jsonb language plpgsql security definer set search_path=public as $fn$
declare t text; payload jsonb := '{}'::jsonb; rows_json jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' and not public.is_admin() then
    raise exception 'NO_AUTORIZADO: solo administración o el programador interno pueden generar respaldos';
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

-- Permitir a service_role operar en el bucket y registrar las ejecuciones (RLS se omite por service_role).
