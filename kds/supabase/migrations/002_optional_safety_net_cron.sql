-- OPTIONAL: every 2 minutes, re-pull the last 10 minutes of Square orders.
-- This is a safety net in case a webhook is ever missed (orders already received are skipped).
--
-- Before running:
--   1. Dashboard → Database → Extensions: enable "pg_cron" and "pg_net"
--   2. Replace YOUR-PROJECT-REF and YOUR-CRON-SECRET below
--      (YOUR-CRON-SECRET must match the CRON_SECRET edge-function secret)

select cron.schedule(
  'kds-square-safety-net',
  '*/2 * * * *',
  $$
  select net.http_post(
    url     := 'https://YOUR-PROJECT-REF.supabase.co/functions/v1/square-sync',
    headers := '{"Content-Type":"application/json","x-cron-secret":"YOUR-CRON-SECRET"}'::jsonb,
    body    := '{"action":"orders","minutes":10}'::jsonb
  );
  $$
);

-- To remove it later:
-- select cron.unschedule('kds-square-safety-net');
