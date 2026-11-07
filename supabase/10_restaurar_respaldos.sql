-- =====================================================================
-- DepositoAPP · 10_restaurar_respaldos.sql
-- Restauración (importación) de un respaldo generado por la propia aplicación.
-- Ejecutar DESPUÉS de instalar_todo.sql, 07_respaldos.sql y 09_respaldos_y_cobros.sql.
-- Se puede re-ejecutar sin problema (create or replace). No toca datos al instalarse.
--
-- Qué hace restore_backup():
--   * Solo la puede usar el administrador principal.
--   * Todo ocurre en UNA transacción: si algo falla, no queda nada a medias.
--   * Modo 'replace': reemplaza el contenido de las tablas incluidas en el respaldo.
--   * Modo 'merge'  : agrega solo lo que falta; no modifica ni borra lo existente.
--   * Acepta respaldos manuales (format_version 2) y automáticos (format_version 1).
--   * Usuarios: las contraseñas viven en Supabase Auth y NO viajan en el respaldo.
--       - Cada perfil del respaldo se vincula con la cuenta de Auth que tenga el mismo
--         id o, si no existe, el mismo correo (así sirve también en un proyecto nuevo).
--       - Si falta la cuenta de un proveedor o de personal de depósito, la restauración
--         se detiene y lista los correos que hay que crear antes (Administración > Usuarios).
--       - Si falta la cuenta de otro perfil (p. ej. un administrador), se omite ese perfil
--         y sus referencias quedan vacías; el resto se restaura igual.
--   * Los contadores de numeración (pedido N, movimientos) se ajustan al máximo restaurado.
--   * El administrador que ejecuta la restauración nunca se elimina a sí mismo.
-- =====================================================================

create or replace function public.restore_backup(
  p_tables     jsonb,
  p_mode       text    default 'merge',
  p_dry_run    boolean default false,
  p_photo_base text    default null
) returns jsonb
language plpgsql security definer set search_path = public set statement_timeout = '180s' as $fn$
declare
  -- Orden de carga: primero los datos de los que dependen los demás.
  c_load constant text[] := array[
    'roles','order_transitions','profiles','suppliers','warehouse_workers','categories','products',
    'inventory','product_costs','customers','orders','order_items','order_item_costs',
    'stock_reservations','stock_movements','order_status_history','notifications','audit_logs',
    'customer_movements','order_payments','backup_settings'
  ];
  -- Tablas de catálogo fijo: nunca se vacían, solo se agregan las filas que falten.
  c_static constant text[] := array['roles','order_transitions'];
  -- Columnas opcionales que apuntan a un usuario: quedan vacías si ese usuario no existe en Auth.
  c_userref constant jsonb := '{
    "customers":["created_by"],
    "orders":["assigned_to","approved_by","delivered_by"],
    "stock_movements":["user_id"],
    "order_status_history":["user_id"],
    "audit_logs":["user_id"],
    "customer_movements":["created_by"],
    "order_payments":["created_by"],
    "backup_settings":["updated_by"]
  }'::jsonb;

  v_caller   uuid := auth.uid();
  v_text     text;
  v_tbls     jsonb;
  v_unmapped uuid[] := '{}';
  v_remap    integer := 0;
  v_missing  jsonb := '[]'::jsonb;
  v_block    jsonb := '[]'::jsonb;
  v_warn     jsonb := '[]'::jsonb;
  v_counts   jsonb := '{}'::jsonb;
  v_ins      jsonb := '{}'::jsonb;
  v_skip     jsonb := '{}'::jsonb;
  v_ignored  jsonb := '[]'::jsonb;
  v_cur      text := '-';
  v_new      uuid;
  v_rows     jsonb;
  v_cols     text;
  v_sel      text;
  v_conf     text;
  v_ident    boolean;
  v_n        bigint;
  v_total    integer;
  v_down     text;
  v_pub_old  uuid;
  v_pub_new  uuid;
  r          record;
  t          text;
  i          integer;
begin
  -- ---------- Autorización y validaciones ----------
  if public.my_role() is distinct from 'admin_principal' then
    raise exception 'NO_AUTORIZADO: solo el administrador principal puede restaurar respaldos';
  end if;
  if p_mode is null or p_mode not in ('replace','merge') then
    raise exception 'MODO_INVALIDO: el modo de restauración debe ser «replace» o «merge»';
  end if;
  if p_tables is null or jsonb_typeof(p_tables) <> 'object' then
    raise exception 'RESPALDO_INVALIDO: el archivo no contiene un conjunto de tablas válido';
  end if;
  for t in select k from jsonb_object_keys(p_tables) k loop
    if t = any(c_load) then
      if jsonb_typeof(p_tables -> t) <> 'array' then
        raise exception 'RESPALDO_INVALIDO: la tabla «%» no tiene el formato esperado', t;
      end if;
    elsif t <> 'backup_runs' then
      v_ignored := v_ignored || to_jsonb(t);   -- tablas desconocidas: se informan y se ignoran
    end if;
  end loop;

  -- ---------- Vinculación de usuarios con Supabase Auth ----------
  v_text := p_tables::text;
  for r in
    select (x ->> 'id')::uuid as id,
           nullif(trim(x ->> 'email'), '') as email,
           x ->> 'role' as role,
           x ->> 'full_name' as name
    from jsonb_array_elements(coalesce(p_tables -> 'profiles', '[]'::jsonb)) x
  loop
    v_new := null;
    if exists (select 1 from auth.users u where u.id = r.id) then
      v_new := r.id;
    elsif r.email is not null then
      select u.id into v_new from auth.users u where lower(u.email) = lower(r.email) limit 1;
    end if;
    if v_new is null then
      v_unmapped := array_append(v_unmapped, r.id);
      v_missing := v_missing || jsonb_build_object('email', r.email, 'role', r.role, 'name', r.name);
    elsif v_new <> r.id then
      v_text := replace(v_text, r.id::text, v_new::text);   -- mismo usuario, identificador nuevo
      v_remap := v_remap + 1;
    end if;
  end loop;
  -- «Cliente público general» es único: si este sistema ya tiene el suyo, los pedidos del respaldo pasan a usarlo.
  if p_mode = 'merge' then
    select (x ->> 'id')::uuid into v_pub_old
    from jsonb_array_elements(coalesce(p_tables -> 'customers', '[]'::jsonb)) x
    where coalesce((x ->> 'is_public')::boolean, false) limit 1;
    select c.id into v_pub_new from public.customers c where c.is_public limit 1;
    if v_pub_old is not null and v_pub_new is not null and v_pub_old <> v_pub_new then
      v_text := replace(v_text, v_pub_old::text, v_pub_new::text);
    end if;
  end if;
  v_tbls := v_text::jsonb;

  -- Faltantes que impiden restaurar: proveedores / personal de depósito sin cuenta de acceso.
  select coalesce(jsonb_agg(jsonb_build_object('email', x ->> 'email', 'role', x ->> 'role', 'name', x ->> 'full_name')), '[]'::jsonb)
    into v_block
  from jsonb_array_elements(coalesce(v_tbls -> 'profiles', '[]'::jsonb)) x
  where (x ->> 'id')::uuid = any(v_unmapped)
    and (exists (select 1 from jsonb_array_elements(coalesce(v_tbls -> 'suppliers', '[]'::jsonb)) s where s ->> 'profile_id' = x ->> 'id')
      or exists (select 1 from jsonb_array_elements(coalesce(v_tbls -> 'warehouse_workers', '[]'::jsonb)) w where w ->> 'profile_id' = x ->> 'id'));

  foreach t in array c_load loop
    if v_tbls ? t then v_counts := v_counts || jsonb_build_object(t, jsonb_array_length(v_tbls -> t)); end if;
  end loop;

  if p_dry_run then
    return jsonb_build_object('dry_run', true, 'mode', p_mode, 'counts', v_counts,
      'missing_users', v_missing, 'blocked_users', v_block, 'ignored_tables', v_ignored, 'remapped_users', v_remap);
  end if;

  if jsonb_array_length(v_block) > 0 then
    raise exception 'USUARIOS_FALTANTES: antes de restaurar, cree en Administración > Usuarios las cuentas de: %. Luego vuelva a importar el respaldo.',
      (select string_agg(coalesce(b ->> 'email', b ->> 'name', '(sin correo)') || ' (' || coalesce(b ->> 'role', 'sin rol') || ')', ', ')
         from jsonb_array_elements(v_block) b);
  end if;

  -- ---------- Restauración (una sola transacción) ----------
  begin
    -- Las reglas automáticas (auditoría, inventario inicial, cargos) no deben dispararse al cargar datos históricos.
    foreach t in array c_load loop
      if v_tbls ? t then execute format('alter table public.%I disable trigger user', t); end if;
    end loop;

    if p_mode = 'replace' then
      for i in reverse array_length(c_load, 1)..1 loop
        t := c_load[i];
        continue when not (v_tbls ? t) or t = any(c_static);
        v_cur := t;
        if t = 'profiles' then
          delete from public.profiles where id is distinct from v_caller;   -- el administrador actual se conserva
        else
          execute format('delete from public.%I where true', t);   -- Supabase (pg_safeupdate) exige WHERE en todo DELETE
        end if;
      end loop;
    end if;

    foreach t in array c_load loop
      continue when not (v_tbls ? t);
      v_cur := t;
      v_rows := v_tbls -> t;

      if t = 'profiles' then
        -- Solo puede haber un administrador principal: si ya existe otro, este queda como segundo administrador.
        select x ->> 'email' into v_down
        from jsonb_array_elements(v_rows) x
        where x ->> 'role' = 'admin_principal'
          and exists (select 1 from public.profiles p where p.role = 'admin_principal' and p.id <> (x ->> 'id')::uuid)
        limit 1;
        if found then
          v_warn := v_warn || to_jsonb('El administrador principal del respaldo (' || coalesce(v_down, 'sin correo')
            || ') quedó como segundo administrador porque ya existe otro administrador principal.');
        end if;
        select coalesce(jsonb_agg(
                 case when x ->> 'role' = 'admin_principal'
                       and exists (select 1 from public.profiles p where p.role = 'admin_principal' and p.id <> (x ->> 'id')::uuid)
                      then jsonb_set(x, '{role}', '"admin_secundario"'::jsonb) else x end), '[]'::jsonb)
          into v_rows
        from jsonb_array_elements(v_rows) x
        where not ((x ->> 'id')::uuid = any(v_unmapped));
      elsif t = 'notifications' then
        select coalesce(jsonb_agg(x), '[]'::jsonb) into v_rows
        from jsonb_array_elements(v_rows) x
        where (x ->> 'user_id') is not null and not ((x ->> 'user_id')::uuid = any(v_unmapped));
      end if;

      v_total := jsonb_array_length(v_rows);
      if v_total = 0 then
        v_ins := v_ins || jsonb_build_object(t, 0);
        continue;
      end if;

      -- Columnas a cargar: las que trae el respaldo y existen hoy (se omiten las calculadas).
      select string_agg(quote_ident(c.column_name), ', ' order by c.ordinal_position),
             string_agg(
               case when coalesce((c_userref -> t) ? (c.column_name::text), false)
                    then format('case when x.%1$I = any($2) then null else x.%1$I end', c.column_name)
                    else format('x.%I', c.column_name) end,
               ', ' order by c.ordinal_position)
        into v_cols, v_sel
      from information_schema.columns c
      where c.table_schema = 'public' and c.table_name::text = t and c.is_generated = 'NEVER'
        and c.column_name::text in (select jsonb_object_keys(v_rows -> 0));
      if v_cols is null then
        raise exception 'RESPALDO_INVALIDO: las filas de «%» no tienen columnas reconocibles', t;
      end if;

      v_ident := exists (select 1 from information_schema.columns c
                         where c.table_schema = 'public' and c.table_name::text = t and c.is_identity = 'YES');
      v_conf := case when t = 'profiles'
        then 'on conflict (id) do update set email = excluded.email, role = excluded.role, full_name = excluded.full_name, '
             || 'phone = excluded.phone, active = excluded.active, permissions = excluded.permissions '
             || 'where profiles.role is null'     -- solo completa perfiles en blanco (cuentas recién creadas)
        else 'on conflict do nothing' end;

      execute format('insert into public.%I (%s)%s select %s from jsonb_populate_recordset(null::public.%I, $1) as x %s',
                     t, v_cols, case when v_ident then ' overriding system value' else '' end, v_sel, t, v_conf)
        using v_rows, v_unmapped;
      get diagnostics v_n = row_count;
      v_ins := v_ins || jsonb_build_object(t, v_n);
      if v_n < v_total then v_skip := v_skip || jsonb_build_object(t, v_total - v_n); end if;
    end loop;

    v_cur := 'ajustes finales';
    -- Las fotografías apuntan al almacenamiento de ESTE proyecto (el respaldo puede venir de otro).
    if p_photo_base is not null and length(p_photo_base) > 0 and v_tbls ? 'products' then
      update public.products
         set photo_url = p_photo_base || regexp_replace(photo_url, '^.*/product-photos/', '')
       where photo_url like '%/product-photos/%'
         and left(photo_url, length(p_photo_base)) <> p_photo_base;
    end if;
    -- Todo producto debe tener su fila de inventario.
    if v_tbls ? 'products' then
      insert into public.inventory(product_id)
        select p.id from public.products p where not exists (select 1 from public.inventory i where i.product_id = p.id)
      on conflict do nothing;
    end if;
    -- Los contadores de numeración continúan después del mayor valor restaurado.
    for r in
      select c.table_name::text as tbl, c.column_name::text as col
      from information_schema.columns c
      where c.table_schema = 'public' and c.is_identity = 'YES' and c.table_name::text = any(c_load)
    loop
      continue when not (v_tbls ? r.tbl);
      execute format('select setval(pg_get_serial_sequence(%L, %L), coalesce(max(%I), 1), max(%I) is not null) from public.%I',
                     'public.' || r.tbl, r.col, r.col, r.col, r.tbl);
    end loop;

    foreach t in array c_load loop
      if v_tbls ? t then execute format('alter table public.%I enable trigger user', t); end if;
    end loop;

    perform public._audit('RESTAURAR_RESPALDO', 'backup', null,
      jsonb_build_object('modo', p_mode, 'registros', v_ins, 'omitidos', v_skip, 'usuarios_sin_cuenta', v_missing));
  exception
    when others then
      if sqlstate = '23503' then
        raise exception 'DEPENDENCIAS: no se pudo cargar «%» porque hay datos relacionados que no están en este respaldo (%). Use un respaldo completo o el modo «Agregar lo que falta».', v_cur, sqlerrm;
      end if;
      raise exception 'RESTAURACION_FALLIDA: % (tabla: %). No se modificó ningún dato.', sqlerrm, v_cur;
  end;

  return jsonb_build_object('ok', true, 'mode', p_mode, 'inserted', v_ins, 'skipped', v_skip,
    'missing_users', v_missing, 'remapped_users', v_remap, 'ignored_tables', v_ignored, 'warnings', v_warn);
end $fn$;

revoke all on function public.restore_backup(jsonb, text, boolean, text) from public, anon;
grant execute on function public.restore_backup(jsonb, text, boolean, text) to authenticated;
