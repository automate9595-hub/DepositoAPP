-- SOLO LOCAL (usa el simulador de Supabase): crea 1 administrador principal, 3 administradores secundarios con caja,
-- 4 operarios de depósito y 60 preventistas (la mitad con comisión), con ~10 clientes cada uno.
drop schema if exists _load cascade;
create schema _load;
create table _load.actors(kind text, n int, id uuid, supplier_id uuid, primary key(kind, n));
insert into _load.actors(kind, n, id) select k, g, gen_random_uuid()
  from (values ('principal',1),('admin',3),('deposito',4),('prev',60)) v(k, c), generate_series(1, c) g;
insert into auth.users(id, instance_id, aud, role, email, raw_user_meta_data)
  select id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ld_' || kind || n || '@t.local', '{}' from _load.actors;
update public.profiles p set role = 'admin_principal', active = true, full_name = '[TEST] Principal' from _load.actors a where a.id = p.id and a.kind = 'principal';
update public.profiles p set role = 'admin_secundario', active = true, full_name = '[TEST] Admin ' || a.n, permissions = '{"orders":true,"cash":true,"customers":true,"stats":true}'
  from _load.actors a where a.id = p.id and a.kind = 'admin';
update public.profiles p set role = 'deposito', active = true, full_name = '[TEST] Depósito ' || a.n from _load.actors a where a.id = p.id and a.kind = 'deposito';
insert into public.warehouse_workers(profile_id, display_name) select id, '[TEST] Depósito ' || n from _load.actors where kind = 'deposito';
grant usage on schema _load to authenticated;
grant select on _load.actors to authenticated;
select set_config('request.jwt.claims', json_build_object('sub', (select id from _load.actors where kind = 'principal'), 'role', 'authenticated')::text, false);
set role authenticated;
select public.admin_set_user(a.id, 'proveedor', '[TEST] Preventista ' || a.n, null, true, null, '[TEST] Preventista ' || a.n) from _load.actors a where kind = 'prev';
reset role;
update _load.actors a set supplier_id = s.id from public.suppliers s where s.profile_id = a.id;
insert into public.customers(name, supplier_id, credit_days)
  select '[TEST] Cliente ' || a.n || '-' || g, a.supplier_id, 15 from _load.actors a, generate_series(1, 10) g where a.kind = 'prev';
-- Mitad de los preventistas con comisión: impares 3 % de ventas, múltiplos de 4 el 8 % de la ganancia
insert into public.supplier_commissions(supplier_id, pct, base)
  select supplier_id, case when n % 2 = 1 then 3 else 8 end, case when n % 2 = 1 then 'VENTAS' else 'GANANCIA' end from _load.actors where kind = 'prev' and n % 4 <> 2;
select kind, count(*) from _load.actors group by kind order by 1;
