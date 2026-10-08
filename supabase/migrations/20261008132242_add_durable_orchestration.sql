alter table public.analyst_jobs
  add column progress_state jsonb,
  add column lease_token uuid,
  add column lease_expires_at timestamptz;

create table public.analyst_job_chunk_results (
  job_id uuid not null references public.analyst_jobs(id) on delete cascade,
  chunk_index integer not null check (chunk_index >= 0),
  result_text text not null,
  section text not null,
  provider text not null,
  model text not null,
  response_id text,
  latency_ms integer check (latency_ms is null or latency_ms >= 0),
  input_tokens integer check (input_tokens is null or input_tokens >= 0),
  output_tokens integer check (output_tokens is null or output_tokens >= 0),
  success boolean not null,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (job_id, chunk_index)
);

alter table public.analyst_job_chunk_results enable row level security;
revoke all on public.analyst_job_chunk_results from public, anon, authenticated;
grant select, insert, update, delete on public.analyst_job_chunk_results to service_role;

create policy analyst_job_chunk_results_service_role_all
  on public.analyst_job_chunk_results
  for all to service_role
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

create or replace function public.claim_analyst_job(p_job_id uuid, p_user_id uuid)
returns public.analyst_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed public.analyst_jobs;
begin
  select j.* into claimed
  from public.analyst_jobs j
  join public.analysts a on a.id = j.analyst_id
  where j.id = p_job_id
    and j.scheduled_for <= now()
    and (
      j.status = 'queued'
      or (
        j.status = 'processing'
        and coalesce(j.lease_expires_at, j.updated_at + interval '5 minutes') <= now()
      )
    )
    and (a.user_id = p_user_id or a.is_public = true)
  for update of j skip locked;

  if claimed.id is null then
    return null;
  end if;

  update public.analyst_jobs
  set status = 'processing',
      lease_token = gen_random_uuid(),
      lease_expires_at = now() + interval '5 minutes',
      started_at = coalesce(started_at, now()),
      updated_at = now()
  where id = claimed.id
  returning * into claimed;

  update public.analyst_state
  set processing_status = 'analyzing', updated_at = now()
  where analyst_id = claimed.analyst_id;

  return claimed;
end;
$$;

revoke all on function public.claim_analyst_job(uuid, uuid) from public, anon, authenticated;
grant execute on function public.claim_analyst_job(uuid, uuid) to service_role;

create or replace function public.save_analyst_job_chunk(
  p_job_id uuid,
  p_lease_token uuid,
  p_progress_state jsonb,
  p_chunk_result jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  job_row public.analyst_jobs;
begin
  select * into job_row
  from public.analyst_jobs
  where id = p_job_id
    and status = 'processing'
    and lease_token = p_lease_token
    and lease_expires_at > now()
  for update;

  if job_row.id is null then
    raise exception 'JOB_LEASE_LOST';
  end if;

  insert into public.analyst_job_chunk_results (
    job_id, chunk_index, result_text, section, provider, model,
    response_id, latency_ms, input_tokens, output_tokens, success,
    error_message, updated_at
  )
  values (
    p_job_id,
    (p_chunk_result->>'chunk_index')::integer,
    coalesce(p_chunk_result->>'result_text', ''),
    coalesce(p_chunk_result->>'section', 'unknown'),
    coalesce(p_chunk_result->>'provider', 'unknown'),
    coalesce(p_chunk_result->>'model', 'unknown'),
    p_chunk_result->>'response_id',
    nullif(p_chunk_result->>'latency_ms', '')::integer,
    nullif(p_chunk_result->>'input_tokens', '')::integer,
    nullif(p_chunk_result->>'output_tokens', '')::integer,
    coalesce((p_chunk_result->>'success')::boolean, false),
    p_chunk_result->>'error_message',
    now()
  )
  on conflict (job_id, chunk_index) do update set
    result_text = excluded.result_text,
    section = excluded.section,
    provider = excluded.provider,
    model = excluded.model,
    response_id = excluded.response_id,
    latency_ms = excluded.latency_ms,
    input_tokens = excluded.input_tokens,
    output_tokens = excluded.output_tokens,
    success = excluded.success,
    error_message = excluded.error_message,
    updated_at = now();

  update public.analyst_jobs
  set progress_state = p_progress_state,
      lease_expires_at = now() + interval '5 minutes',
      updated_at = now()
  where id = p_job_id;
end;
$$;

revoke all on function public.save_analyst_job_chunk(uuid, uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.save_analyst_job_chunk(uuid, uuid, jsonb, jsonb) to service_role;

create or replace function public.release_analyst_job_batch(
  p_job_id uuid,
  p_lease_token uuid
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
  set status = 'queued',
      scheduled_for = now(),
      lease_token = null,
      lease_expires_at = null,
      updated_at = now()
  where id = p_job_id
    and status = 'processing'
    and lease_token = p_lease_token
    and lease_expires_at > now()
  returning * into job_row;

  if job_row.id is null then
    raise exception 'JOB_LEASE_LOST';
  end if;
  return job_row;
end;
$$;

revoke all on function public.release_analyst_job_batch(uuid, uuid) from public, anon, authenticated;
grant execute on function public.release_analyst_job_batch(uuid, uuid) to service_role;

create or replace function public.fail_analyst_job(
  p_job_id uuid,
  p_lease_token uuid,
  p_reason text,
  p_delay_seconds integer default 300,
  p_chunk_result jsonb default null
)
returns public.analyst_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  job_row public.analyst_jobs;
begin
  select * into job_row
  from public.analyst_jobs
  where id = p_job_id
    and status = 'processing'
    and lease_token = p_lease_token
  for update;

  if job_row.id is null then
    raise exception 'JOB_LEASE_LOST';
  end if;

  if p_chunk_result is not null then
    insert into public.analyst_job_chunk_results (
      job_id, chunk_index, result_text, section, provider, model,
      response_id, latency_ms, input_tokens, output_tokens, success,
      error_message, updated_at
    )
    values (
      p_job_id,
      (p_chunk_result->>'chunk_index')::integer,
      coalesce(p_chunk_result->>'result_text', ''),
      coalesce(p_chunk_result->>'section', 'unknown'),
      coalesce(p_chunk_result->>'provider', 'unknown'),
      coalesce(p_chunk_result->>'model', 'unknown'),
      p_chunk_result->>'response_id',
      nullif(p_chunk_result->>'latency_ms', '')::integer,
      nullif(p_chunk_result->>'input_tokens', '')::integer,
      nullif(p_chunk_result->>'output_tokens', '')::integer,
      false,
      coalesce(p_chunk_result->>'error_message', p_reason),
      now()
    )
    on conflict (job_id, chunk_index) do update set
      result_text = excluded.result_text,
      section = excluded.section,
      provider = excluded.provider,
      model = excluded.model,
      response_id = excluded.response_id,
      latency_ms = excluded.latency_ms,
      input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens,
      success = false,
      error_message = excluded.error_message,
      updated_at = now();
  end if;

  update public.analyst_jobs
  set attempts = attempts + 1,
      status = case when attempts + 1 < max_attempts then 'queued' else 'failed' end,
      scheduled_for = case when attempts + 1 < max_attempts then now() + make_interval(secs => greatest(p_delay_seconds, 1)) else scheduled_for end,
      lease_token = null,
      lease_expires_at = null,
      error_code = 'PROCESSOR_ERROR',
      error_message = p_reason,
      updated_at = now()
  where id = p_job_id
  returning * into job_row;

  if job_row.status = 'failed' then
    update public.analyst_state
    set processing_status = 'error', updated_at = now()
    where analyst_id = job_row.analyst_id;
  end if;
  return job_row;
end;
$$;

revoke all on function public.fail_analyst_job(uuid, uuid, text, integer, jsonb) from public, anon, authenticated;
grant execute on function public.fail_analyst_job(uuid, uuid, text, integer, jsonb) to service_role;

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
  set attempts = attempts + 1,
      status = case when attempts + 1 < max_attempts then 'queued' else 'cancelled' end,
      scheduled_for = case when attempts + 1 < max_attempts then now() + make_interval(secs => greatest(p_delay_seconds, 1)) else scheduled_for end,
      cancel_reason = case when attempts + 1 < max_attempts then null else 'retry_limit' end,
      lease_token = null,
      lease_expires_at = null,
      error_code = 'TRANSIENT_ENRICHMENT_ERROR',
      error_message = p_reason,
      updated_at = now()
  where id = p_job_id and status = 'processing'
  returning * into job_row;

  if job_row.status = 'cancelled' then
    update public.analyst_state
    set processing_status = 'error', updated_at = now()
    where analyst_id = job_row.analyst_id;
  end if;
  return job_row;
end;
$$;

revoke all on function public.retry_analyst_job(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.retry_analyst_job(uuid, text, integer) to service_role;

create or replace function public.clear_analyst_job_lease_on_terminal_status()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.status in ('completed', 'failed', 'cancelled') then
    new.lease_token := null;
    new.lease_expires_at := null;
  end if;
  return new;
end;
$$;

create trigger analyst_jobs_clear_lease_on_terminal_status
before update of status on public.analyst_jobs
for each row
when (old.status is distinct from new.status)
execute function public.clear_analyst_job_lease_on_terminal_status();

select cron.unschedule(jobid)
from cron.job
where jobname in ('analyst-worker-every-5-minutes', 'analyst-worker-every-minute');

select cron.schedule(
  'analyst-worker-every-minute',
  '* * * * *',
  $$select net.http_post(
    url := 'https://osykwhhsvxbcaldczrdd.supabase.co/functions/v1/run-analyst-worker',
    headers := jsonb_build_object('x-analyst-worker-key', vault.get_secret('analyst_worker_key'), 'Content-Type', 'application/json'),
    body := '{}'::jsonb
  );$$
);