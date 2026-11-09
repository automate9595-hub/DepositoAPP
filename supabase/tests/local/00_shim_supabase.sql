-- =====================================================================
-- SOLO PARA PRUEBAS LOCALES (PostgreSQL común, sin Supabase).
-- Simula lo mínimo que Supabase trae de fábrica: roles, auth.uid(), auth.users, storage y realtime.
-- NO se ejecuta nunca en Supabase.
-- =====================================================================
do $$ begin
  if not exists (select from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;
create extension if not exists pgcrypto;
create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(), instance_id uuid, aud text, role text, email text,
  encrypted_password text, raw_user_meta_data jsonb default '{}'::jsonb,
  email_confirmed_at timestamptz default now(), confirmed_at timestamptz default now(),
  created_at timestamptz default now(), updated_at timestamptz default now());
create or replace function auth.uid() returns uuid language sql stable as
  $$ select nullif(coalesce(current_setting('request.jwt.claim.sub', true), current_setting('request.jwt.claims', true)::jsonb ->> 'sub'), '')::uuid $$;
create or replace function auth.role() returns text language sql stable as
  $$ select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), current_setting('request.jwt.claims', true)::jsonb ->> 'role', 'anon') $$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid(), auth.role() to anon, authenticated, service_role;
create schema if not exists storage;
create table if not exists storage.buckets (id text primary key, name text, public boolean default false, file_size_limit bigint, allowed_mime_types text[]);
create table if not exists storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid, metadata jsonb, created_at timestamptz default now());
alter table storage.objects enable row level security;
grant usage on schema storage to anon, authenticated, service_role;
grant select, insert, update, delete on storage.objects to authenticated, service_role;
do $$ begin if not exists (select from pg_publication where pubname = 'supabase_realtime') then create publication supabase_realtime; end if; end $$;
grant all on schema public to postgres;

-- Supabase concede por defecto TODO a anon/authenticated sobre lo que se crea en public: se replica para que
-- las pruebas detecten tablas o funciones nuevas que olviden cerrarse (REVOKE / RLS).
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
