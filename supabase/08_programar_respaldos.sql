-- Ejecutar UNA SOLA VEZ, después de desplegar la Edge Function deposito-backup.
-- Antes: reemplazar los valores indicados y guardar las claves en Supabase Vault.
-- No pegar nunca service_role en archivos de la aplicación ni en GitHub.
--
-- 1) Crear los secretos en Vault (reemplazar valores):
-- select vault.create_secret('https://TU-PROYECTO.supabase.co', 'deposito_backup_project_url');
-- select vault.create_secret('TU_SERVICE_ROLE_KEY', 'deposito_backup_service_role_key');
--
-- 2) Habilitar extensiones y programar la comprobación cada 15 minutos.
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'deposito-backup-cada-15-minutos',
  '*/15 * * * *',
  $job$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'deposito_backup_project_url') || '/functions/v1/deposito-backup',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'deposito_backup_service_role_key')
      ),
      body := '{}'::jsonb
    );
  $job$
);

-- Para comprobar la programación:
-- select jobid, schedule, command from cron.job where jobname = 'deposito-backup-cada-15-minutos';
-- Para desprogramar:
-- select cron.unschedule(jobid) from cron.job where jobname = 'deposito-backup-cada-15-minutos';
