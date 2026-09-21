create table public.analyst_jobs (
  id uuid primary key default gen_random_uuid(),
  analyst_id uuid not null references public.analysts(id) on delete cascade,
  evidence_id uuid references public.evidence_items(id) on delete set null,
  trigger_type text not null check (trigger_type in ('evidence', 'manual', 'scheduled', 'reprocess')),
  priority integer not null default 100 check (priority between 0 and 1000),
  status text not null default 'queued' check (status in ('queued', 'processing', 'completed', 'failed', 'cancelled')),
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 3 check (max_attempts between 1 and 10),
  scheduled_for timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  error_code text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index analyst_jobs_queue_idx
  on public.analyst_jobs (status, priority desc, scheduled_for, created_at)
  where status = 'queued';

create unique index analyst_jobs_active_evidence_key
  on public.analyst_jobs (analyst_id, evidence_id)
  where evidence_id is not null and status in ('queued', 'processing');

create table public.analyst_runs (
  id uuid primary key default gen_random_uuid(),
  analyst_id uuid not null references public.analysts(id) on delete cascade,
  job_id uuid not null unique references public.analyst_jobs(id) on delete cascade,
  evidence_id uuid references public.evidence_items(id) on delete set null,
  status text not null check (status in ('started', 'completed', 'failed')),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  provider text,
  model text,
  result_json jsonb,
  error_message text,
  created_at timestamptz not null default now()
);

create index analyst_runs_analyst_created_idx
  on public.analyst_runs (analyst_id, created_at desc);

create table public.analyst_assumptions (
  id uuid primary key default gen_random_uuid(),
  analyst_id uuid not null references public.analysts(id) on delete cascade,
  name text not null,
  category text not null default 'general',
  value_numeric numeric,
  value_text text,
  unit text,
  source text,
  confidence integer check (confidence between 0 and 100),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (analyst_id, name)
);

create index analyst_assumptions_active_idx
  on public.analyst_assumptions (analyst_id, is_active)
  where is_active = true;

create table public.analyst_assumption_versions (
  id uuid primary key default gen_random_uuid(),
  assumption_id uuid not null references public.analyst_assumptions(id) on delete cascade,
  analyst_id uuid not null references public.analysts(id) on delete cascade,
  name text not null,
  category text not null,
  previous_value_numeric numeric,
  previous_value_text text,
  new_value_numeric numeric,
  new_value_text text,
  unit text,
  source text,
  confidence integer check (confidence between 0 and 100),
  reason text not null,
  evidence_id uuid references public.evidence_items(id) on delete set null,
  created_at timestamptz not null default now()
);

create index analyst_assumption_versions_history_idx
  on public.analyst_assumption_versions (analyst_id, name, created_at desc);

alter table public.analyst_state
  add column if not exists processing_status text not null default 'idle'
    check (processing_status in ('idle', 'queued', 'analyzing', 'updated', 'error')),
  add column if not exists last_processed_evidence_id uuid references public.evidence_items(id) on delete set null;

alter table public.analyst_jobs enable row level security;
alter table public.analyst_runs enable row level security;
alter table public.analyst_assumptions enable row level security;
alter table public.analyst_assumption_versions enable row level security;

create policy analyst_jobs_owner_read on public.analyst_jobs
  for select using (exists (select 1 from public.analysts a where a.id = analyst_id and (a.user_id = auth.uid() or a.is_public = true)));

create policy analyst_runs_owner_read on public.analyst_runs
  for select using (exists (select 1 from public.analysts a where a.id = analyst_id and (a.user_id = auth.uid() or a.is_public = true)));

create policy analyst_assumptions_owner_read on public.analyst_assumptions
  for select using (exists (select 1 from public.analysts a where a.id = analyst_id and (a.user_id = auth.uid() or a.is_public = true)));

create policy analyst_assumption_versions_owner_read on public.analyst_assumption_versions
  for select using (exists (select 1 from public.analysts a where a.id = analyst_id and (a.user_id = auth.uid() or a.is_public = true)));

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
    and j.status = 'queued'
    and j.scheduled_for <= now()
    and (a.user_id = p_user_id or a.is_public = true)
  for update of j skip locked;

  if claimed.id is null then
    return null;
  end if;

  update public.analyst_jobs
  set status = 'processing',
      attempts = attempts + 1,
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

create or replace function public.complete_analyst_job(
  p_job_id uuid,
  p_run_id uuid,
  p_result jsonb,
  p_provider text,
  p_model text,
  p_error_message text default null
)
returns public.analyst_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  job_row public.analyst_jobs;
  analyst_row public.analysts;
  state_row public.analyst_state;
  run_status text := case when p_error_message is null then 'completed' else 'failed' end;
  result_summary text := nullif(p_result->>'thesisSummary', '');
  result_confidence integer := nullif(p_result->>'confidence', '')::integer;
  new_thesis_version integer;
  assumption_item jsonb;
  existing_assumption public.analyst_assumptions;
  previous_numeric numeric;
  previous_text text;
  new_numeric numeric;
  new_text text;
  changed boolean := coalesce((p_result->>'thesisChanged')::boolean, false)
    or coalesce((p_result->>'valuationChanged')::boolean, false)
    or jsonb_array_length(coalesce(p_result->'affectedAssumptions', '[]'::jsonb)) > 0;
begin
  select * into job_row from public.analyst_jobs where id = p_job_id for update;
  if job_row.id is null then raise exception 'JOB_NOT_FOUND'; end if;
  select * into analyst_row from public.analysts where id = job_row.analyst_id;
  select * into state_row from public.analyst_state where analyst_id = job_row.analyst_id for update;

  insert into public.analyst_runs (id, analyst_id, job_id, evidence_id, status, started_at, completed_at, provider, model, result_json, error_message)
  values (p_run_id, job_row.analyst_id, job_row.id, job_row.evidence_id, run_status, coalesce(job_row.started_at, now()), now(), p_provider, p_model, p_result, p_error_message)
  on conflict (job_id) do update set
    status = excluded.status,
    completed_at = excluded.completed_at,
    provider = excluded.provider,
    model = excluded.model,
    result_json = excluded.result_json,
    error_message = excluded.error_message;

  if p_error_message is not null then
    update public.analyst_jobs
    set status = case when attempts < max_attempts then 'queued' else 'failed' end,
        error_code = 'PROCESSOR_ERROR', error_message = p_error_message, updated_at = now()
    where id = job_row.id
    returning * into job_row;
    update public.analyst_state set processing_status = 'error', updated_at = now() where analyst_id = job_row.analyst_id;
    return job_row;
  end if;

  for assumption_item in select value from jsonb_array_elements(coalesce(p_result->'affectedAssumptions', '[]'::jsonb)) loop
    select * into existing_assumption
    from public.analyst_assumptions
    where analyst_id = job_row.analyst_id and name = assumption_item->>'name'
    for update;

    previous_numeric := existing_assumption.value_numeric;
    previous_text := existing_assumption.value_text;
    new_numeric := nullif(assumption_item->>'newValue', '')::numeric;
    new_text := nullif(assumption_item->>'newValueText', '');

    if existing_assumption.id is null then
      insert into public.analyst_assumptions (analyst_id, name, category, value_numeric, value_text, source, confidence)
      values (job_row.analyst_id, assumption_item->>'name', coalesce(assumption_item->>'category', 'general'), new_numeric, new_text, 'analyst_engine', result_confidence);
      select * into existing_assumption from public.analyst_assumptions where analyst_id = job_row.analyst_id and name = assumption_item->>'name';
    else
      update public.analyst_assumptions
      set value_numeric = coalesce(new_numeric, value_numeric), value_text = coalesce(new_text, value_text), source = 'analyst_engine', confidence = coalesce(result_confidence, confidence), updated_at = now()
      where id = existing_assumption.id;
    end if;

    insert into public.analyst_assumption_versions (assumption_id, analyst_id, name, category, previous_value_numeric, previous_value_text, new_value_numeric, new_value_text, unit, source, confidence, reason, evidence_id)
    values (existing_assumption.id, job_row.analyst_id, existing_assumption.name, existing_assumption.category, previous_numeric, previous_text, new_numeric, new_text, assumption_item->>'unit', 'analyst_engine', result_confidence, coalesce(assumption_item->>'changeSummary', 'Updated by new evidence'), job_row.evidence_id);
  end loop;

  if coalesce((p_result->>'thesisChanged')::boolean, false) then
    select coalesce(max(version), 0) + 1 into new_thesis_version from public.thesis_versions where analyst_id = job_row.analyst_id;
    insert into public.thesis_versions (analyst_id, version, summary, confidence, catalysts, risks, assumptions)
    values (job_row.analyst_id, new_thesis_version, coalesce(result_summary, analyst_row.current_thesis, 'Thesis updated by new evidence'), coalesce(result_confidence, analyst_row.confidence), coalesce(p_result->'catalystsAdded', '[]'::jsonb), coalesce(p_result->'risksAdded', '[]'::jsonb), coalesce(p_result->'affectedAssumptions', '[]'::jsonb));
  end if;

  if coalesce((p_result->>'valuationChanged')::boolean, false) then
    insert into public.valuation_versions (analyst_id, reason, evidence, old_value, new_value, affected_assumptions)
    values (job_row.analyst_id, coalesce(p_result->>'decisionSummary', 'Valuation updated by new evidence'), p_result->>'thesisSummary', (p_result->>'previousFairValue')::numeric, (p_result->>'newFairValue')::numeric, coalesce(p_result->'affectedAssumptions', '[]'::jsonb));
  end if;

  if changed then
    insert into public.decision_events (analyst_id, event, evidence, impact, reasoning_summary, affected_assumptions, old_value, new_value, source, source_type, timestamp, confidence)
    values (job_row.analyst_id, case when (p_result->>'valuationChanged')::boolean then 'valuation_changed' when (p_result->>'thesisChanged')::boolean then 'thesis_changed' else 'assumption_changed' end, p_result->>'decisionSummary', initcap(coalesce(p_result->>'impact', 'neutral')), p_result->>'decisionSummary', coalesce(p_result->'affectedAssumptions', '[]'::jsonb), p_result->>'previousFairValue', p_result->>'newFairValue', p_provider, 'analyst_engine', now(), coalesce(result_confidence, analyst_row.confidence));
  end if;

  update public.analysts
  set current_thesis = coalesce(result_summary, current_thesis),
      current_fair_value = case when (p_result->>'valuationChanged')::boolean then (p_result->>'newFairValue')::numeric else current_fair_value end,
      previous_fair_value = case when (p_result->>'valuationChanged')::boolean then (p_result->>'previousFairValue')::numeric else previous_fair_value end,
      confidence = coalesce(result_confidence, confidence), updated_at = now(), last_processed_at = now()
  where id = job_row.analyst_id;

  update public.analyst_state
  set current_thesis = coalesce(result_summary, current_thesis),
      current_fair_value = case when (p_result->>'valuationChanged')::boolean then (p_result->>'newFairValue')::numeric else current_fair_value end,
      previous_fair_value = case when (p_result->>'valuationChanged')::boolean then (p_result->>'previousFairValue')::numeric else previous_fair_value end,
      confidence = coalesce(result_confidence, confidence), status = 'live', processing_status = case when changed then 'updated' else 'idle' end,
      last_processed_at = now(), last_processed_evidence_id = job_row.evidence_id, updated_at = now()
  where analyst_id = job_row.analyst_id;

  update public.analyst_jobs
  set status = 'completed', completed_at = now(), error_code = null, error_message = null, updated_at = now()
  where id = job_row.id
  returning * into job_row;
  return job_row;
end;
$$;

revoke all on function public.claim_analyst_job(uuid, uuid) from public, anon, authenticated;
grant execute on function public.claim_analyst_job(uuid, uuid) to service_role;
revoke all on function public.complete_analyst_job(uuid, uuid, jsonb, text, text, text) from public, anon, authenticated;
grant execute on function public.complete_analyst_job(uuid, uuid, jsonb, text, text, text) to service_role;
