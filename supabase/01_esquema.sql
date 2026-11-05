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
