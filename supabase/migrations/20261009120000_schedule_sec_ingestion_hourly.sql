do $migration$
declare
  sec_job_id bigint;
begin
  if not exists (
    select 1
    from vault.decrypted_secrets
    where name = 'sec_ingestion_key'
  ) then
    raise exception 'Vault secret sec_ingestion_key is required before scheduling SEC ingestion';
  end if;

  select jobid
  into sec_job_id
  from cron.job
  where jobname = 'sec-ingestion-hourly';

  if sec_job_id is null then
    perform cron.schedule(
      'sec-ingestion-hourly',
      '0 * * * *',
      $cron$
        select net.http_post(
          url := 'https://osykwhhsvxbcaldczrdd.supabase.co/functions/v1/scrape-sec',
          headers := jsonb_build_object(
            'x-sec-ingestion-key',
            (select decrypted_secret from vault.decrypted_secrets where name = 'sec_ingestion_key' limit 1),
            'Content-Type',
            'application/json'
          ),
          body := jsonb_build_object('ticker', tracked_stocks.ticker),
          timeout_milliseconds := 60000
        )
        from public.tracked_stocks
        where enabled = true
      $cron$
    );
  else
    perform cron.alter_job(
      job_id := sec_job_id,
      schedule := '0 * * * *',
      active := true,
      command := $cron$
        select net.http_post(
          url := 'https://osykwhhsvxbcaldczrdd.supabase.co/functions/v1/scrape-sec',
          headers := jsonb_build_object(
            'x-sec-ingestion-key',
            (select decrypted_secret from vault.decrypted_secrets where name = 'sec_ingestion_key' limit 1),
            'Content-Type',
            'application/json'
          ),
          body := jsonb_build_object('ticker', tracked_stocks.ticker),
          timeout_milliseconds := 60000
        )
        from public.tracked_stocks
        where enabled = true
      $cron$
    );
  end if;
end
$migration$;
