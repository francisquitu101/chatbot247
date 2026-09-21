create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'finviz-watchlist-every-10-minutes',
  '*/10 * * * *',
  $$
  select net.http_post(
    url := 'https://osykwhhsvxbcaldczrdd.supabase.co/functions/v1/scrape-watchlist',
    headers := jsonb_build_object(
      'x-finviz-ingestion-key', (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'finviz_ingestion_key'
        limit 1
      ),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
)
where not exists (
  select 1 from cron.job where jobname = 'finviz-watchlist-every-10-minutes'
);
