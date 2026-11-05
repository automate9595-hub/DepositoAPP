-- =====================================================================
-- DepositoAPP · 04_crear_administrador.sql
-- Convierte a UN usuario ya creado en Administrador principal.
-- Pasos:
--  1) Supabase > Authentication > Users > "Add user" > "Create new user"
--     (marque "Auto Confirm User"). Use su correo y una contraseña segura.
--  2) Cambie el correo de abajo por el suyo y ejecute este script.
-- Solo funciona si todavía no existe un administrador principal.
-- =====================================================================
select public.bootstrap_principal('CAMBIE-ESTE-CORREO@ejemplo.com');
