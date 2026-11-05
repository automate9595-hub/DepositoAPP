-- DepositoAPP: instalacion completa de la base (pegar TODO esto en SQL Editor y pulsar Run)

-- ########## 01_esquema.sql ##########
-- =====================================================================
-- DepositoAPP · 01_esquema.sql
-- Tablas, restricciones e índices. Ejecutar PRIMERO en Supabase > SQL Editor.
-- Es idempotente en lo posible (se puede volver a ejecutar sin romper datos).
-- =====================================================================

create table if not exists public.roles (
  code        text primary key,
  description text not null
);
insert into public.roles(code, description) values
  ('admin_principal', 'Administrador principal'),
  ('admin_secundario','Segundo administrador'),
  ('proveedor',       'Proveedor'),
  ('deposito',        'Personal del depósito')
on conflict (code) do nothing;

create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text,
  role        text references public.roles(code),
  full_name   text not null default '',
  phone       text,
  active      boolean not null default false,
  permissions jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
-- Solo puede existir un administrador principal.
create unique index if not exists profiles_one_principal on public.profiles(role) where role = 'admin_principal';

create table if not exists public.suppliers (
  id           uuid primary key default gen_random_uuid(),
  profile_id   uuid not null unique references public.profiles(id),
  company_name text not null check (length(trim(company_name)) > 0),
  contact_name text,
  address      text,
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);

create table if not exists public.warehouse_workers (
  id           uuid primary key default gen_random_uuid(),
  profile_id   uuid not null unique references public.profiles(id),
  display_name text not null,
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);

create table if not exists public.categories (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique check (length(trim(name)) > 0),
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.products (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique check (length(trim(code)) > 0),
  name        text not null check (length(trim(name)) > 0),
  description text not null default '',
  category_id uuid references public.categories(id),
  photo_url   text,
  price       numeric(12,2) not null check (price >= 0),
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists products_active_name on public.products(active, lower(name));
create index if not exists products_category    on public.products(category_id);

-- Inventario único y compartido. available_stock = physical - reserved (columna calculada).
create table if not exists public.inventory (
  product_id      uuid primary key references public.products(id) on delete cascade,
  physical_stock  integer not null default 0 check (physical_stock >= 0),
  reserved_stock  integer not null default 0 check (reserved_stock >= 0),
  available_stock integer generated always as (physical_stock - reserved_stock) stored,
  updated_at      timestamptz not null default now(),
  constraint inventory_reserved_le_physical check (reserved_stock <= physical_stock)
);

create table if not exists public.orders (
  id                uuid primary key default gen_random_uuid(),
  order_number      bigint generated always as identity unique,
  supplier_id       uuid not null references public.suppliers(id),
  client_request_id uuid not null,
  status            text not null default 'PENDIENTE_APROBACION' check (status in
    ('PENDIENTE_APROBACION','APROBADO','EN_PREPARACION','PREPARADO_PARCIALMENTE',
     'LISTO_PARA_ENTREGAR','ENTREGADO','RECHAZADO','CANCELADO')),
  supplier_notes    text,
  admin_notes       text,
  total_requested   numeric(14,2) not null default 0,
  total_approved    numeric(14,2),
  total_delivered   numeric(14,2),
  assigned_to       uuid references public.profiles(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  approved_at       timestamptz,
  approved_by       uuid references public.profiles(id),
  prepared_at       timestamptz,
  delivered_at      timestamptz,
  delivered_by      uuid references public.profiles(id),
  -- Protección contra pedidos duplicados (idempotencia por solicitud)
  constraint orders_idempotency unique (supplier_id, client_request_id)
);
create index if not exists orders_status_created   on public.orders(status, created_at desc);
create index if not exists orders_supplier_created on public.orders(supplier_id, created_at desc);

create table if not exists public.order_items (
  id              uuid primary key default gen_random_uuid(),
  order_id        uuid not null references public.orders(id),
  product_id      uuid not null references public.products(id),
  product_code    text not null,                                   -- fotografía histórica
  product_name    text not null,                                   -- fotografía histórica
  unit_price      numeric(12,2) not null check (unit_price >= 0),  -- fotografía histórica del precio
  qty_requested   integer not null check (qty_requested > 0),
  qty_approved    integer check (qty_approved >= 0),
  qty_prepared    integer check (qty_prepared >= 0),
  qty_delivered   integer check (qty_delivered >= 0),
  prepared        boolean not null default false,
  shortage_reason text,
  constraint order_items_unique_product unique (order_id, product_id)
);
create index if not exists order_items_order   on public.order_items(order_id);
create index if not exists order_items_product on public.order_items(product_id);

create table if not exists public.stock_reservations (
  id            uuid primary key default gen_random_uuid(),
  order_item_id uuid not null unique references public.order_items(id),
  order_id      uuid not null references public.orders(id),
  product_id    uuid not null references public.products(id),
  quantity      integer not null check (quantity >= 0),
  status        text not null default 'ACTIVA' check (status in ('ACTIVA','LIBERADA','CONSUMIDA')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists reservations_order on public.stock_reservations(order_id);

create table if not exists public.stock_movements (
  id              bigint generated always as identity primary key,
  product_id      uuid not null references public.products(id),
  order_id        uuid references public.orders(id),
  movement_type   text not null check (movement_type in ('INGRESO','AJUSTE','RESERVA','LIBERACION','ENTREGA')),
  quantity        integer not null,
  physical_before integer not null,
  physical_after  integer not null,
  reserved_before integer not null,
  reserved_after  integer not null,
  user_id         uuid references public.profiles(id),
  note            text,
  created_at      timestamptz not null default now()
);
create index if not exists movements_product on public.stock_movements(product_id, created_at desc);
create index if not exists movements_order   on public.stock_movements(order_id);

create table if not exists public.order_transitions (
  from_status text not null,
  to_status   text not null,
  primary key (from_status, to_status)
);
insert into public.order_transitions(from_status, to_status) values
  ('PENDIENTE_APROBACION','APROBADO'),
  ('PENDIENTE_APROBACION','RECHAZADO'),
  ('PENDIENTE_APROBACION','CANCELADO'),
  ('APROBADO','EN_PREPARACION'),
  ('APROBADO','CANCELADO'),
  ('EN_PREPARACION','PREPARADO_PARCIALMENTE'),
  ('EN_PREPARACION','LISTO_PARA_ENTREGAR'),
  ('EN_PREPARACION','CANCELADO'),
  ('PREPARADO_PARCIALMENTE','LISTO_PARA_ENTREGAR'),
  ('PREPARADO_PARCIALMENTE','CANCELADO'),
  ('LISTO_PARA_ENTREGAR','ENTREGADO'),
  ('LISTO_PARA_ENTREGAR','CANCELADO')
on conflict do nothing;

create table if not exists public.order_status_history (
  id          bigint generated always as identity primary key,
  order_id    uuid not null references public.orders(id),
  from_status text,
  to_status   text not null,
  user_id     uuid references public.profiles(id),
  note        text,
  created_at  timestamptz not null default now()
);
create index if not exists status_history_order on public.order_status_history(order_id, created_at);

create table if not exists public.notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  title      text not null,
  body       text,
  order_id   uuid references public.orders(id),
  read       boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists notifications_user on public.notifications(user_id, read, created_at desc);

create table if not exists public.audit_logs (
  id         bigint generated always as identity primary key,
  user_id    uuid references public.profiles(id),
  action     text not null,
  entity     text not null,
  entity_id  text,
  details    jsonb,
  created_at timestamptz not null default now()
);
create index if not exists audit_created on public.audit_logs(created_at desc);

-- ########## 02_funciones.sql ##########
-- =====================================================================
-- DepositoAPP · 02_funciones.sql
-- Lógica crítica en PostgreSQL: permisos, reservas atómicas, estados, auditoría.
-- Ejecutar DESPUÉS de 01_esquema.sql. Se puede re-ejecutar (create or replace).
-- Convención de errores: 'CODIGO: mensaje en español' (la app muestra el mensaje).
-- =====================================================================

-- ---------- Helpers de identidad y permisos ----------
create or replace function public.my_role() returns text
language sql stable security definer set search_path = public as $fn$
  select role from public.profiles where id = auth.uid() and active
$fn$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $fn$
  select coalesce(public.my_role() in ('admin_principal','admin_secundario'), false)
$fn$;

-- Permisos: orders, inventory, products, users, stats, audit.
-- El principal tiene todos; el segundo administrador según profiles.permissions.
create or replace function public.has_perm(p text) returns boolean
language plpgsql stable security definer set search_path = public as $fn$
declare r text; perms jsonb;
begin
  select role, permissions into r, perms from public.profiles where id = auth.uid() and active;
  if r = 'admin_principal' then return true; end if;
  if r = 'admin_secundario' then return coalesce((perms->>p)::boolean, false); end if;
  return false;
end $fn$;

create or replace function public.my_supplier_id() returns uuid
language sql stable security definer set search_path = public as $fn$
  select s.id from public.suppliers s
  where s.profile_id = auth.uid() and s.active and public.my_role() = 'proveedor'
$fn$;

create or replace function public.is_worker() returns boolean
language sql stable security definer set search_path = public as $fn$
  select public.my_role() = 'deposito'
     and exists (select 1 from public.warehouse_workers w where w.profile_id = auth.uid() and w.active)
$fn$;

-- Puede preparar pedidos: personal de depósito activo O administración con permiso de pedidos.
create or replace function public.can_prepare() returns boolean
language sql stable security definer set search_path = public as $fn$
  select public.is_worker() or public.has_perm('orders')
$fn$;

-- ---------- Triggers utilitarios ----------
create or replace function public.touch_updated_at() returns trigger
language plpgsql as $fn$
begin new.updated_at := now(); return new; end $fn$;

drop trigger if exists trg_products_touch on public.products;
create trigger trg_products_touch before update on public.products
  for each row execute function public.touch_updated_at();
drop trigger if exists trg_profiles_touch on public.profiles;
create trigger trg_profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();

-- Cada usuario nuevo de Auth recibe un perfil SIN rol y SIN activar.
-- Nunca se confía en metadatos enviados por el navegador para asignar roles.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  insert into public.profiles(id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', ''))
  on conflict (id) do nothing;
  return new;
end $fn$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Cada producto nuevo crea su fila de inventario en cero.
create or replace function public.create_inventory_row() returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  insert into public.inventory(product_id) values (new.id) on conflict do nothing;
  return new;
end $fn$;
drop trigger if exists trg_products_inventory on public.products;
create trigger trg_products_inventory after insert on public.products
  for each row execute function public.create_inventory_row();

-- ---------- Auditoría ----------
create or replace function public._audit(p_action text, p_entity text, p_id text, p_details jsonb default null)
returns void language plpgsql security definer set search_path = public as $fn$
begin
  insert into public.audit_logs(user_id, action, entity, entity_id, details)
  values (auth.uid(), p_action, p_entity, p_id, p_details);
end $fn$;

create or replace function public.audit_row() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare v_id text;
begin
  if tg_op = 'DELETE' then v_id := to_jsonb(old)->>'id'; else v_id := to_jsonb(new)->>'id'; end if;
  insert into public.audit_logs(user_id, action, entity, entity_id, details)
  values (auth.uid(), tg_op, tg_table_name, v_id,
          jsonb_build_object('old', case when tg_op = 'INSERT' then null else to_jsonb(old) end,
                             'new', case when tg_op = 'DELETE' then null else to_jsonb(new) end));
  return coalesce(new, old);
end $fn$;

drop trigger if exists trg_audit_products on public.products;
create trigger trg_audit_products after insert or update or delete on public.products
  for each row execute function public.audit_row();
drop trigger if exists trg_audit_categories on public.categories;
create trigger trg_audit_categories after insert or update or delete on public.categories
  for each row execute function public.audit_row();
drop trigger if exists trg_audit_profiles on public.profiles;
create trigger trg_audit_profiles after update on public.profiles
  for each row execute function public.audit_row();
drop trigger if exists trg_audit_suppliers on public.suppliers;
create trigger trg_audit_suppliers after insert or update on public.suppliers
  for each row execute function public.audit_row();
drop trigger if exists trg_audit_workers on public.warehouse_workers;
create trigger trg_audit_workers after insert or update on public.warehouse_workers
  for each row execute function public.audit_row();

-- ---------- Notificaciones ----------
create or replace function public._notify(p_user uuid, p_title text, p_body text, p_order uuid)
returns void language plpgsql security definer set search_path = public as $fn$
begin
  if p_user is not null then
    insert into public.notifications(user_id, title, body, order_id) values (p_user, p_title, p_body, p_order);
  end if;
end $fn$;

create or replace function public._notify_admins(p_title text, p_body text, p_order uuid, p_perm text default 'orders')
returns void language plpgsql security definer set search_path = public as $fn$
begin
  insert into public.notifications(user_id, title, body, order_id)
  select p.id, p_title, p_body, p_order from public.profiles p
  where p.active and (p.role = 'admin_principal'
        or (p.role = 'admin_secundario' and coalesce((p.permissions->>p_perm)::boolean, false)));
end $fn$;

create or replace function public._notify_warehouse(p_title text, p_body text, p_order uuid)
returns void language plpgsql security definer set search_path = public as $fn$
begin
  insert into public.notifications(user_id, title, body, order_id)
  select w.profile_id, p_title, p_body, p_order
  from public.warehouse_workers w join public.profiles p on p.id = w.profile_id
  where w.active and p.active and p.role = 'deposito';
end $fn$;

-- ---------- Estados de pedido (transiciones válidas + historial) ----------
create or replace function public.orders_guard() returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  if new.status is distinct from old.status then
    if not exists (select 1 from public.order_transitions t
                   where t.from_status = old.status and t.to_status = new.status) then
      raise exception 'TRANSICION_INVALIDA: no se puede pasar de % a %', old.status, new.status;
    end if;
  end if;
  return new;
end $fn$;
drop trigger if exists trg_orders_guard on public.orders;
create trigger trg_orders_guard before update on public.orders
  for each row execute function public.orders_guard();

create or replace function public._set_status(p_order uuid, p_new text, p_note text default null)
returns void language plpgsql security definer set search_path = public as $fn$
declare v_old text;
begin
  select status into v_old from public.orders where id = p_order;
  update public.orders set status = p_new, updated_at = now() where id = p_order;
  insert into public.order_status_history(order_id, from_status, to_status, user_id, note)
  values (p_order, v_old, p_new, auth.uid(), p_note);
end $fn$;

-- Registro de movimientos de inventario
create or replace function public._log_move(p_product uuid, p_order uuid, p_type text, p_qty int,
  pb int, pa int, rb int, ra int, p_note text default null)
returns void language plpgsql security definer set search_path = public as $fn$
begin
  insert into public.stock_movements(product_id, order_id, movement_type, quantity,
    physical_before, physical_after, reserved_before, reserved_after, user_id, note)
  values (p_product, p_order, p_type, p_qty, pb, pa, rb, ra, auth.uid(), p_note);
end $fn$;

-- Libera todas las reservas activas de un pedido (cancelación)
create or replace function public._release_reservations(p_order uuid)
returns void language plpgsql security definer set search_path = public as $fn$
declare v_res record; v_inv public.inventory%rowtype;
begin
  for v_res in select * from public.stock_reservations
               where order_id = p_order and status = 'ACTIVA' order by product_id loop
    select * into v_inv from public.inventory where product_id = v_res.product_id for update;
    update public.inventory set reserved_stock = reserved_stock - v_res.quantity, updated_at = now()
      where product_id = v_res.product_id;
    perform public._log_move(v_res.product_id, p_order, 'LIBERACION', -v_res.quantity,
      v_inv.physical_stock, v_inv.physical_stock, v_inv.reserved_stock, v_inv.reserved_stock - v_res.quantity,
      'Pedido cancelado');
    update public.stock_reservations set status = 'LIBERADA', updated_at = now() where id = v_res.id;
  end loop;
end $fn$;

-- =====================================================================
-- PROVEEDOR: enviar pedido (idempotente, precios y totales calculados en el servidor)
-- p_items: [{"product_id":"uuid","qty":3}, ...]
-- =====================================================================
create or replace function public.submit_order(p_client_request_id uuid, p_items jsonb, p_notes text default null)
returns uuid language plpgsql security definer set search_path = public as $fn$
declare
  v_sup uuid; v_order uuid; v_row record; v_prod record; v_total numeric(14,2) := 0; v_name text;
begin
  v_sup := public.my_supplier_id();
  if v_sup is null then raise exception 'NO_AUTORIZADO: solo los proveedores activos pueden enviar pedidos'; end if;
  if p_client_request_id is null then raise exception 'DATOS_INVALIDOS: falta el identificador de la solicitud'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'DATOS_INVALIDOS: el pedido no tiene productos';
  end if;
  if jsonb_array_length(p_items) > 300 then raise exception 'DATOS_INVALIDOS: demasiados productos en un pedido'; end if;
  if exists (select 1 from jsonb_array_elements(p_items) e
             where (e->>'product_id') is null or (e->>'qty') is null or (e->>'qty') !~ '^[0-9]{1,6}$' or (e->>'qty')::int <= 0) then
    raise exception 'DATOS_INVALIDOS: producto o cantidad no válidos';
  end if;

  -- Idempotencia: si la solicitud ya existe devuelve el mismo pedido (reintentos seguros)
  insert into public.orders(supplier_id, client_request_id, supplier_notes)
  values (v_sup, p_client_request_id, nullif(left(trim(coalesce(p_notes, '')), 500), ''))
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
  perform public._notify_admins('Nuevo pedido', 'Pedido de ' || v_name || ' pendiente de aprobación', v_order);
  perform public._audit('ENVIAR_PEDIDO', 'orders', v_order::text, jsonb_build_object('total', v_total));
  return v_order;
end $fn$;

-- =====================================================================
-- ADMIN: aprobar pedido (reserva atómica de stock con bloqueo de filas)
-- p_items opcional: [{"item_id":"uuid","qty":2}, ...] para modificar cantidades.
-- =====================================================================
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
  perform public._notify(v_sup_profile, 'Pedido aprobado', 'Su pedido #' || v_o.order_number || ' fue aprobado', p_order_id);
  perform public._notify_warehouse('Pedido para preparar', 'Pedido #' || v_o.order_number || ' listo para preparar', p_order_id);
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
  perform public._notify(v_sup_profile, 'Pedido modificado', 'Se modificaron cantidades del pedido #' || v_o.order_number, p_order_id);
  perform public._notify_warehouse('Pedido modificado', 'Cambió el pedido #' || v_o.order_number, p_order_id);
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
  perform public._notify(v_sup_profile, 'Pedido rechazado', 'Su pedido #' || v_o.order_number || ' fue rechazado: ' || trim(p_reason), p_order_id);
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
    perform public._notify(v_sup_profile, 'Pedido cancelado', 'Su pedido #' || v_o.order_number || ' fue cancelado', p_order_id);
  else
    perform public._notify_admins('Pedido cancelado', 'El proveedor canceló el pedido #' || v_o.order_number, p_order_id);
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
  perform public._notify(v_sup_profile, 'Pedido entregado', 'Su pedido #' || v_o.order_number || ' fue entregado', p_order_id);
  perform public._audit('CONFIRMAR_ENTREGA', 'orders', p_order_id::text);
end $fn$;

-- =====================================================================
-- INVENTARIO: ingresos y ajustes con motivo (nunca negativo ni bajo lo reservado)
-- =====================================================================
create or replace function public.adjust_stock(p_product_id uuid, p_delta int, p_type text, p_note text default null)
returns void language plpgsql security definer set search_path = public as $fn$
declare v_inv public.inventory%rowtype;
begin
  if not public.has_perm('inventory') then raise exception 'NO_AUTORIZADO: no tiene permiso para modificar el inventario'; end if;
  if p_type not in ('INGRESO','AJUSTE') then raise exception 'DATOS_INVALIDOS: tipo de movimiento no válido'; end if;
  if p_delta is null or p_delta = 0 or abs(p_delta) > 1000000 then raise exception 'DATOS_INVALIDOS: cantidad no válida'; end if;
  if p_type = 'INGRESO' and p_delta < 0 then raise exception 'DATOS_INVALIDOS: un ingreso debe ser positivo'; end if;
  if p_type = 'AJUSTE' and (p_note is null or length(trim(p_note)) = 0) then
    raise exception 'MOTIVO_REQUERIDO: indique el motivo del ajuste';
  end if;
  select * into v_inv from public.inventory where product_id = p_product_id for update;
  if not found then raise exception 'NO_ENCONTRADO: el producto no existe'; end if;
  if v_inv.physical_stock + p_delta < v_inv.reserved_stock then
    raise exception 'STOCK_INSUFICIENTE: el stock físico no puede quedar por debajo de lo reservado (%)', v_inv.reserved_stock;
  end if;
  update public.inventory set physical_stock = physical_stock + p_delta, updated_at = now() where product_id = p_product_id;
  perform public._log_move(p_product_id, null, p_type, p_delta,
    v_inv.physical_stock, v_inv.physical_stock + p_delta, v_inv.reserved_stock, v_inv.reserved_stock, nullif(trim(p_note), ''));
  perform public._audit('STOCK_' || p_type, 'inventory', p_product_id::text, jsonb_build_object('delta', p_delta, 'nota', p_note));
end $fn$;

-- =====================================================================
-- USUARIOS
-- =====================================================================
create or replace function public.admin_set_user(
  p_user uuid, p_role text, p_full_name text, p_phone text, p_active boolean,
  p_permissions jsonb default null, p_company text default null)
returns void language plpgsql security definer set search_path = public as $fn$
declare v_t public.profiles%rowtype; v_perm jsonb;
begin
  if not public.has_perm('users') then raise exception 'NO_AUTORIZADO: no tiene permiso para administrar usuarios'; end if;
  select * into v_t from public.profiles where id = p_user for update;
  if not found then raise exception 'NO_ENCONTRADO: el usuario no existe'; end if;
  if v_t.role = 'admin_principal' then raise exception 'NO_AUTORIZADO: el administrador principal no se puede modificar'; end if;
  if p_role not in ('admin_secundario','proveedor','deposito') then raise exception 'DATOS_INVALIDOS: rol no válido'; end if;
  if (p_role = 'admin_secundario' or v_t.role = 'admin_secundario') and public.my_role() <> 'admin_principal' then
    raise exception 'NO_AUTORIZADO: solo el administrador principal gestiona administradores';
  end if;
  if p_user = auth.uid() and not p_active then raise exception 'DATOS_INVALIDOS: no puede desactivar su propia cuenta'; end if;
  if p_full_name is null or length(trim(p_full_name)) = 0 then raise exception 'DATOS_INVALIDOS: el nombre es obligatorio'; end if;

  v_perm := case when p_role = 'admin_secundario'
    then coalesce(p_permissions, '{"orders":true,"inventory":true,"products":true,"stats":true,"users":false,"audit":false}'::jsonb)
    else '{}'::jsonb end;
  update public.profiles set role = p_role, full_name = trim(p_full_name), phone = nullif(trim(coalesce(p_phone, '')), ''),
    active = p_active, permissions = v_perm where id = p_user;

  if p_role = 'proveedor' then
    insert into public.suppliers(profile_id, company_name, contact_name, active)
    values (p_user, coalesce(nullif(trim(coalesce(p_company, '')), ''), trim(p_full_name)), trim(p_full_name), p_active)
    on conflict (profile_id) do update set
      company_name = coalesce(nullif(trim(coalesce(p_company, '')), ''), public.suppliers.company_name),
      contact_name = trim(p_full_name), active = p_active;
  elsif p_role = 'deposito' then
    insert into public.warehouse_workers(profile_id, display_name, active) values (p_user, trim(p_full_name), p_active)
    on conflict (profile_id) do update set display_name = trim(p_full_name), active = p_active;
  end if;
  -- Si cambió de rol, se desactivan las fichas del rol anterior
  if p_role <> 'proveedor' then update public.suppliers set active = false where profile_id = p_user; end if;
  if p_role <> 'deposito' then update public.warehouse_workers set active = false where profile_id = p_user; end if;
  perform public._audit('USUARIO_ACTUALIZADO', 'profiles', p_user::text, jsonb_build_object('rol', p_role, 'activo', p_active));
end $fn$;

create or replace function public.update_my_profile(p_full_name text, p_phone text default null)
returns void language plpgsql security definer set search_path = public as $fn$
begin
  if auth.uid() is null then raise exception 'NO_AUTORIZADO: sesión no válida'; end if;
  if p_full_name is null or length(trim(p_full_name)) = 0 then raise exception 'DATOS_INVALIDOS: el nombre es obligatorio'; end if;
  update public.profiles set full_name = left(trim(p_full_name), 120), phone = nullif(left(trim(coalesce(p_phone, '')), 40), '')
    where id = auth.uid();
end $fn$;

-- Solo se ejecuta desde el SQL Editor (ver 04_crear_administrador.sql). No se concede a usuarios de la app.
create or replace function public.bootstrap_principal(p_email text)
returns void language plpgsql security definer set search_path = public as $fn$
declare v_id uuid;
begin
  if exists (select 1 from public.profiles where role = 'admin_principal') then
    raise exception 'YA_EXISTE: ya hay un administrador principal';
  end if;
  select id into v_id from public.profiles where lower(email) = lower(trim(p_email));
  if v_id is null then
    raise exception 'NO_ENCONTRADO: no existe un usuario con ese correo; créelo antes en Authentication > Users';
  end if;
  update public.profiles set role = 'admin_principal', active = true, permissions = '{}'::jsonb,
    full_name = case when full_name = '' then 'Administrador' else full_name end where id = v_id;
end $fn$;

-- =====================================================================
-- NOTIFICACIONES y ESTADÍSTICAS
-- =====================================================================
create or replace function public.mark_notifications_read(p_ids uuid[] default null)
returns void language sql security definer set search_path = public as $fn$
  update public.notifications set read = true
  where user_id = auth.uid() and not read and (p_ids is null or id = any(p_ids))
$fn$;

create or replace function public.admin_stats(p_days int default 30)
returns jsonb language plpgsql stable security definer set search_path = public as $fn$
declare v_from timestamptz := now() - make_interval(days => greatest(1, least(coalesce(p_days, 30), 3650))); v_res jsonb;
begin
  if not public.has_perm('stats') then raise exception 'NO_AUTORIZADO: no tiene permiso para ver estadísticas'; end if;
  select jsonb_build_object(
    'orders_total', (select count(*) from public.orders where created_at >= v_from),
    'by_status', coalesce((select jsonb_object_agg(status, n) from
        (select status, count(*) n from public.orders where created_at >= v_from group by status) s), '{}'::jsonb),
    'delivered_amount', (select coalesce(sum(total_delivered), 0) from public.orders where status = 'ENTREGADO' and delivered_at >= v_from),
    'top_products', coalesce((select jsonb_agg(t) from (
        select oi.product_name as name, sum(oi.qty_delivered)::int as units
        from public.order_items oi join public.orders o on o.id = oi.order_id
        where o.status = 'ENTREGADO' and o.delivered_at >= v_from
        group by oi.product_name order by 2 desc limit 10) t), '[]'::jsonb),
    'by_supplier', coalesce((select jsonb_agg(t) from (
        select s.company_name as name, count(*)::int as orders, coalesce(sum(o.total_delivered), 0) as amount
        from public.orders o join public.suppliers s on s.id = o.supplier_id
        where o.created_at >= v_from group by s.company_name order by 3 desc, 2 desc limit 20) t), '[]'::jsonb),
    'low_stock', coalesce((select jsonb_agg(t) from (
        select p.name, i.available_stock as available from public.inventory i join public.products p on p.id = i.product_id
        where p.active and i.available_stock <= 5 order by i.available_stock, p.name limit 20) t), '[]'::jsonb)
  ) into v_res;
  return v_res;
end $fn$;

-- ########## 03_seguridad.sql ##########
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
