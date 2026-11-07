-- =====================================================================
-- DepositoAPP · 11_eliminar_productos_clientes.sql
-- Eliminación segura de productos y clientes.
-- Ejecutar DESPUÉS de los scripts anteriores. Se puede re-ejecutar sin problema.
--
-- Regla de oro: NO se borra nada que ya figure en pedidos o en cuentas corrientes, porque
-- se perdería el historial contable. En ese caso se pide desactivarlo (queda oculto, pero
-- los pedidos viejos siguen mostrando su nombre y su código).
-- =====================================================================

create or replace function public.delete_product(p_product_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare v_name text; v_code text; v_photo text; v_used integer; v_stock integer;
begin
  if not public.has_perm('products') then
    raise exception 'NO_AUTORIZADO: no tiene permiso para eliminar productos';
  end if;
  select name, code, photo_url into v_name, v_code, v_photo from public.products where id = p_product_id for update;
  if not found then raise exception 'NO_ENCONTRADO: el producto ya no existe'; end if;

  select count(*) into v_used from public.order_items where product_id = p_product_id;
  if v_used > 0 then
    raise exception 'CON_HISTORIAL: «%» figura en % línea(s) de pedidos. Para no perder el historial no se puede eliminar; desactívelo para ocultarlo del catálogo.', v_name, v_used;
  end if;

  select coalesce(physical_stock, 0) into v_stock from public.inventory where product_id = p_product_id;
  delete from public.stock_movements    where product_id = p_product_id;
  delete from public.stock_reservations where product_id = p_product_id;
  delete from public.products           where id = p_product_id;   -- inventario y costos se borran en cascada

  perform public._audit('ELIMINAR_PRODUCTO', 'products', p_product_id::text,
    jsonb_build_object('codigo', v_code, 'nombre', v_name, 'stock_al_eliminar', coalesce(v_stock, 0)));
  return jsonb_build_object('photo_url', v_photo);
end $fn$;

create or replace function public.delete_customer(p_customer_id uuid) returns void
language plpgsql security definer set search_path = public as $fn$
declare v_name text; v_public boolean; v_orders integer; v_movs integer;
begin
  if not public.has_perm('customers') then
    raise exception 'NO_AUTORIZADO: no tiene permiso para eliminar clientes';
  end if;
  select name, is_public into v_name, v_public from public.customers where id = p_customer_id for update;
  if not found then raise exception 'NO_ENCONTRADO: el cliente ya no existe'; end if;
  if v_public then raise exception 'PROTEGIDO: «Cliente público general» es del sistema y no se puede eliminar'; end if;

  select count(*) into v_orders from public.orders where customer_id = p_customer_id;
  select count(*) into v_movs   from public.customer_movements where customer_id = p_customer_id;
  if v_orders > 0 or v_movs > 0 then
    raise exception 'CON_HISTORIAL: «%» tiene % pedido(s) y % movimiento(s) de cuenta. Para no perder el historial no se puede eliminar; desactívelo para ocultarlo.', v_name, v_orders, v_movs;
  end if;

  delete from public.customers where id = p_customer_id;
  perform public._audit('ELIMINAR_CLIENTE', 'customers', p_customer_id::text, jsonb_build_object('nombre', v_name));
end $fn$;

revoke all on function public.delete_product(uuid)  from public, anon;
revoke all on function public.delete_customer(uuid) from public, anon;
grant execute on function public.delete_product(uuid)  to authenticated;
grant execute on function public.delete_customer(uuid) to authenticated;
