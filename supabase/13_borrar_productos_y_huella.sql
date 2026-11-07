-- =====================================================================
-- DepositoAPP · 13_borrar_productos_y_huella.sql
-- 1) Se puede eliminar un producto aunque haya estado en pedidos ya terminados
--    (los pedidos conservan su nombre, código y precio). Solo se bloquea si está en pedidos EN CURSO.
-- 2) Ingreso con huella o rostro registrado en la base (passkeys): tablas y funciones.
-- Ejecutar DESPUÉS de 11 y 12. Se puede re-ejecutar sin problema.
-- =====================================================================

-- ---------- 1. Eliminar productos ----------
do $do$
begin
  alter table public.order_items alter column product_id drop not null;
  alter table public.order_items drop constraint if exists order_items_product_id_fkey;
  alter table public.order_items add constraint order_items_product_id_fkey
    foreign key (product_id) references public.products(id) on delete set null;   -- el pedido queda con su fotografía histórica
end $do$;

create or replace function public.delete_product(p_product_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare v_name text; v_code text; v_photo text; v_open integer; v_nums text; v_hist integer; v_stock integer;
begin
  if not public.has_perm('products') then
    raise exception 'NO_AUTORIZADO: no tiene permiso para eliminar productos';
  end if;
  select name, code, photo_url into v_name, v_code, v_photo from public.products where id = p_product_id for update;
  if not found then raise exception 'NO_ENCONTRADO: el producto ya no existe'; end if;

  select count(distinct o.id), string_agg(distinct '#' || o.order_number::text, ', ')
    into v_open, v_nums
  from public.order_items oi join public.orders o on o.id = oi.order_id
  where oi.product_id = p_product_id and o.status not in ('ENTREGADO', 'RECHAZADO', 'CANCELADO');
  if v_open > 0 then
    raise exception 'EN_USO: «%» está en % pedido(s) en curso (%). Espere a que se entreguen o cancélelos y después podrá eliminarlo.', v_name, v_open, v_nums;
  end if;

  select count(*) into v_hist from public.order_items where product_id = p_product_id;
  select coalesce(physical_stock, 0) into v_stock from public.inventory where product_id = p_product_id;
  delete from public.stock_reservations where product_id = p_product_id;
  delete from public.stock_movements    where product_id = p_product_id;
  delete from public.products           where id = p_product_id;   -- inventario y costos en cascada; order_items.product_id queda vacío

  perform public._audit('ELIMINAR_PRODUCTO', 'products', p_product_id::text,
    jsonb_build_object('codigo', v_code, 'nombre', v_name, 'stock_al_eliminar', coalesce(v_stock, 0), 'lineas_de_pedidos_cerrados', v_hist));
  return jsonb_build_object('photo_url', v_photo);
end $fn$;
revoke all on function public.delete_product(uuid) from public, anon;
grant execute on function public.delete_product(uuid) to authenticated;

-- ---------- 2. Ingreso con huella / rostro (passkeys) ----------
create table if not exists public.passkeys (
  id           text primary key,                                   -- identificador de la credencial (base64url)
  user_id      uuid not null references auth.users(id) on delete cascade,
  public_key   text not null,                                      -- clave PÚBLICA (SPKI, base64url)
  alg          integer not null check (alg in (-7, -257)),
  label        text,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz
);
create index if not exists passkeys_user on public.passkeys(user_id);

create table if not exists public.passkey_challenges (
  id         uuid primary key default gen_random_uuid(),
  challenge  text not null,
  expires_at timestamptz not null default now() + interval '3 minutes'
);

-- Cerradas a la API: solo la Edge Function (service_role) y las funciones de abajo las usan
alter table public.passkeys enable row level security;
alter table public.passkey_challenges enable row level security;
revoke all on public.passkeys, public.passkey_challenges from anon, authenticated;

create or replace function public.register_passkey(p_id text, p_public_key text, p_alg integer, p_label text default null) returns void
language plpgsql security definer set search_path = public as $fn$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null or not exists (select 1 from public.profiles where id = v_uid and active and role is not null) then
    raise exception 'NO_AUTORIZADO: debe iniciar sesión con una cuenta activa';
  end if;
  if p_id is null or length(p_id) < 8 or length(p_id) > 1024 or p_public_key is null or length(p_public_key) < 40 or length(p_public_key) > 2048 then
    raise exception 'DATOS_INVALIDOS: la clave de acceso no es válida';
  end if;
  if (select count(*) from public.passkeys where user_id = v_uid) >= 10
     and not exists (select 1 from public.passkeys where id = p_id and user_id = v_uid) then
    raise exception 'LIMITE: ya tiene 10 dispositivos registrados; elimine alguno primero';
  end if;
  insert into public.passkeys(id, user_id, public_key, alg, label)
    values (p_id, v_uid, p_public_key, p_alg, left(p_label, 80))
  on conflict (id) do update set public_key = excluded.public_key, alg = excluded.alg, label = excluded.label
    where public.passkeys.user_id = v_uid;          -- nadie puede tomar la clave de otra persona
  perform public._audit('ACTIVAR_HUELLA', 'passkeys', left(p_id, 16), jsonb_build_object('dispositivo', left(p_label, 80)));
end $fn$;

create or replace function public.delete_passkey(p_id text) returns void
language plpgsql security definer set search_path = public as $fn$
begin
  if auth.uid() is null then raise exception 'NO_AUTORIZADO: debe iniciar sesión'; end if;
  delete from public.passkeys where id = p_id and user_id = auth.uid();
end $fn$;

create or replace function public.my_passkeys() returns table(id text, label text, created_at timestamptz, last_used_at timestamptz)
language sql security definer stable set search_path = public as $fn$
  select p.id, p.label, p.created_at, p.last_used_at from public.passkeys p where p.user_id = auth.uid() order by p.created_at;
$fn$;

revoke all on function public.register_passkey(text, text, integer, text) from public, anon;
revoke all on function public.delete_passkey(text) from public, anon;
revoke all on function public.my_passkeys() from public, anon;
grant execute on function public.register_passkey(text, text, integer, text) to authenticated;
grant execute on function public.delete_passkey(text) to authenticated;
grant execute on function public.my_passkeys() to authenticated;

-- La Edge Function (rol service_role) debe poder usar estas tablas y leer perfiles.
-- Los proyectos nuevos de Supabase ya no entregan este permiso automáticamente en las tablas nuevas.
grant usage on schema public to service_role;
grant all on public.passkeys, public.passkey_challenges to service_role;
grant select on public.profiles to service_role;
