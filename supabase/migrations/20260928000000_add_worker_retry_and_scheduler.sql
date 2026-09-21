create or replace function public.retry_analyst_job(
  p_job_id uuid,
  p_reason text,
  p_delay_seconds integer default 300
)
returns public.analyst_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  job_row public.analyst_jobs;
begin
  update public.analyst_jobs
  set status = case when attempts < max_attempts then 'queued' else 'cancelled' end,
      scheduled_for = case when attempts < max_attempts then now() + make_interval(secs => greatest(p_delay_seconds, 1)) else scheduled_for end,
      cancel_reason = case when attempts < max_attempts then null else 'retry_limit' end,
      error_code = 'TRANSIENT_ENRICHMENT_ERROR',
      error_message = p_reason,
      updated_at = now()
  where id = p_job_id and status = 'processing'
  returning * into job_row;
  return job_row;
end;
$$;

revoke all on function public.retry_analyst_job(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.retry_analyst_job(uuid, text, integer) to service_role;

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'analyst-worker-every-5-minutes',
  '*/5 * * * *',
  $$select net.http_post(
    url := 'https://osykwhhsvxbcaldczrdd.supabase.co/functions/v1/run-analyst-worker',
    headers := jsonb_build_object('x-analyst-worker-key', vault.get_secret('analyst_worker_key'), 'Content-Type', 'application/json'),
    body := '{}'::jsonb
  );$$
)
where not exists (select 1 from cron.job where jobname = 'analyst-worker-every-5-minutes');
