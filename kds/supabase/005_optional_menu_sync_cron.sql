-- OPTIONAL: refresh the menu + item availability from Square every 15 minutes.
-- Square already tells the KDS about changes instantly (webhooks); this is a back-up so
-- anything changed directly in Square (e.g. an item marked Sold Out on the POS) always shows up.
-- Replace YOUR-PROJECT-REF and YOUR-CRON-SECRET (same values as in 002), then Run.
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net  with schema extensions;

select cron.schedule(
  'kds-menu-sync',
  '*/15 * * * *',
  $$
  select net.http_post(
    url     := 'https://YOUR-PROJECT-REF.supabase.co/functions/v1/square-sync',
    headers := '{"Content-Type":"application/json","x-cron-secret":"YOUR-CRON-SECRET"}'::jsonb,
    body    := '{"action":"catalog"}'::jsonb
  );
  $$
);
-- To remove: select cron.unschedule('kds-menu-sync');
