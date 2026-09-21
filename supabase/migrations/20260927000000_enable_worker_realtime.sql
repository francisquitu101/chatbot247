alter publication supabase_realtime add table public.analyst_state;
alter publication supabase_realtime add table public.decision_events;

create or replace function public.block_analyst_job(
  p_job_id uuid,
  p_reason text
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
  set status = 'cancelled', cancel_reason = p_reason, error_code = 'WORKER_BLOCKED', error_message = p_reason, updated_at = now()
  where id = p_job_id and status = 'processing'
  returning * into job_row;
  return job_row;
end;
$$;

revoke all on function public.block_analyst_job(uuid, text) from public, anon, authenticated;
grant execute on function public.block_analyst_job(uuid, text) to service_role;
