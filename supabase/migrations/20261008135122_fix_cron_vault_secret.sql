do $$
declare
  worker_job record;
begin
  for worker_job in
    select jobid
    from cron.job
    where jobname in ('analyst-worker-every-minute', 'analyst-worker-every-5-minutes')
  loop
    perform cron.unschedule(worker_job.jobid);
  end loop;

  if not exists (
    select 1
    from vault.decrypted_secrets
    where name = 'analyst_worker_key'
  ) then
    raise exception 'Vault secret analyst_worker_key is missing';
  end if;

  perform cron.schedule(
    'analyst-worker-every-minute',
    '* * * * *',
    $command$
      select net.http_post(
        url := 'https://osykwhhsvxbcaldczrdd.supabase.co/functions/v1/run-analyst-worker',
        headers := jsonb_build_object(
          'x-analyst-worker-key',
          (select decrypted_secret from vault.decrypted_secrets where name = 'analyst_worker_key' limit 1),
          'Content-Type',
          'application/json'
        ),
        body := '{}'::jsonb
      );
    $command$
  );
end;
$$;