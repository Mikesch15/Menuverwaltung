-- Stündlicher Aufruf der Erinnerungs-Funktion
create extension if not exists pg_net;
create extension if not exists pg_cron;

select cron.schedule(
  'menu-erinnerung',
  '0 * * * *',
  $$
  select net.http_post(
    url := 'https://evozevkzwcvpbnvcmmfp.supabase.co/functions/v1/menu-erinnerung',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select cron_secret from public.menu_push_config where id = 1)
    ),
    body := '{"modus":"cron"}'::jsonb
  );
  $$
);
