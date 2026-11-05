-- =====================================================================
-- DepositoAPP · 03_seguridad.sql
-- RLS en TODAS las tablas, permisos mínimos, Realtime y Storage de fotos.
-- Ejecutar DESPUÉS de 02_funciones.sql. Se puede re-ejecutar.
-- La app solo escribe en tablas mediante funciones transaccionales (02_funciones.sql),
-- salvo catálogo (products/categories) que exige permiso 'products' por política RLS.
-- =====================================================================

alter table public.roles                enable row level security;
alter table public.profiles             enable row level security;
alter table public.suppliers            enable row level security;
alter table public.warehouse_workers    enable row level security;
alter table public.categories           enable row level security;
alter table public.products             enable row level security;
alter table public.inventory            enable row level security;
alter table public.orders               enable row level security;
alter table public.order_items          enable row level security;
alter table public.stock_reservations   enable row level security;
alter table public.stock_movements      enable row level security;
alter table public.order_transitions    enable row level security;
alter table public.order_status_history enable row level security;
alter table public.notifications        enable row level security;
alter table public.audit_logs           enable row level security;

-- Limpieza para poder re-ejecutar
do $do$
declare r record;
begin
  for r in select policyname, tablename from pg_policies where schemaname = 'public' loop
    execute format('drop policy if exists %I on public.%I', r.policyname, r.tablename);
  end loop;
end $do$;

-- Permisos de tabla: nada para anon; lectura para autenticados (filtrada por RLS)
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
grant usage on schema public to anon, authenticated;
grant select on public.roles, public.profiles, public.suppliers, public.warehouse_workers, public.categories,
  public.products, public.inventory, public.orders, public.order_items, public.stock_reservations,
  public.stock_movements, public.order_status_history, public.notifications, public.audit_logs
  to authenticated;
-- Único acceso de escritura directo: catálogo (además filtrado por política con has_perm('products'))
grant insert, update on public.categories, public.products to authenticated;

-- ---------- Políticas ----------
create policy roles_read on public.roles for select to authenticated using (true);

create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_admin());

create policy suppliers_select on public.suppliers for select to authenticated
  using (profile_id = auth.uid() or public.is_admin() or public.my_role() = 'deposito');

create policy workers_select on public.warehouse_workers for select to authenticated
  using (profile_id = auth.uid() or public.is_admin());

create policy categories_select on public.categories for select to authenticated
  using ((active and public.my_role() is not null) or public.has_perm('products'));
create policy categories_insert on public.categories for insert to authenticated
  with check (public.has_perm('products'));
create policy categories_update on public.categories for update to authenticated
  using (public.has_perm('products')) with check (public.has_perm('products'));

create policy products_select on public.products for select to authenticated
  using ((active and public.my_role() is not null) or public.has_perm('products') or public.has_perm('orders') or public.has_perm('inventory'));
create policy products_insert on public.products for insert to authenticated
  with check (public.has_perm('products'));
create policy products_update on public.products for update to authenticated
  using (public.has_perm('products')) with check (public.has_perm('products'));

-- Inventario: lectura para usuarios activos; ninguna política de escritura (solo funciones SQL)
create policy inventory_select on public.inventory for select to authenticated
  using (public.my_role() is not null);

create policy orders_select on public.orders for select to authenticated
  using (
    supplier_id = public.my_supplier_id()
    or public.has_perm('orders')
    or (public.my_role() = 'deposito'
        and status in ('APROBADO','EN_PREPARACION','PREPARADO_PARCIALMENTE','LISTO_PARA_ENTREGAR','ENTREGADO'))
  );

create policy order_items_select on public.order_items for select to authenticated
  using (exists (select 1 from public.orders o where o.id = order_id));

create policy status_history_select on public.order_status_history for select to authenticated
  using (exists (select 1 from public.orders o where o.id = order_id));

create policy reservations_select on public.stock_reservations for select to authenticated
  using (public.has_perm('inventory') or public.has_perm('orders'));

create policy movements_select on public.stock_movements for select to authenticated
  using (public.has_perm('inventory'));

create policy notifications_select on public.notifications for select to authenticated
  using (user_id = auth.uid());

create policy audit_select on public.audit_logs for select to authenticated
  using (public.has_perm('audit'));

-- order_transitions: sin políticas = sin acceso desde la app (solo triggers SECURITY DEFINER)

-- ---------- Permisos de ejecución de funciones ----------
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
-- Funciones internas y de arranque: nunca invocables desde la app
revoke execute on function public.bootstrap_principal(text) from authenticated;
revoke execute on function public._notify(uuid, text, text, uuid) from authenticated;
revoke execute on function public._notify_admins(text, text, uuid, text) from authenticated;
revoke execute on function public._notify_warehouse(text, text, uuid) from authenticated;
revoke execute on function public._audit(text, text, text, jsonb) from authenticated;
revoke execute on function public._set_status(uuid, text, text) from authenticated;
revoke execute on function public._log_move(uuid, uuid, text, int, int, int, int, int, text) from authenticated;
revoke execute on function public._release_reservations(uuid) from authenticated;

-- ---------- Realtime (cambios en vivo, respetando RLS) ----------
do $do$
declare t text;
begin
  foreach t in array array['orders','notifications','inventory'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $do$;

-- ---------- Storage: fotos de productos (lectura pública, escritura solo con permiso) ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('product-photos', 'product-photos', true, 2097152, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set public = true, file_size_limit = 2097152,
  allowed_mime_types = array['image/jpeg','image/png','image/webp'];

drop policy if exists product_photos_insert on storage.objects;
create policy product_photos_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'product-photos' and public.has_perm('products'));
drop policy if exists product_photos_update on storage.objects;
create policy product_photos_update on storage.objects for update to authenticated
  using (bucket_id = 'product-photos' and public.has_perm('products'));
drop policy if exists product_photos_delete on storage.objects;
create policy product_photos_delete on storage.objects for delete to authenticated
  using (bucket_id = 'product-photos' and public.has_perm('products'));
