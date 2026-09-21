create unique index if not exists evidence_items_source_ticker_external_key
  on public.evidence_items (source_type, ticker, external_id)
  where external_id is not null;

create table public.evidence_ingestion_jobs (
  id uuid primary key default gen_random_uuid(),
  source_type text not null check (source_type in ('SEC', 'NEWS', 'INSIDER', 'EARNINGS', 'COMPANY_RELEASE')),
  ticker text not null,
  status text not null default 'queued' check (status in ('queued', 'processing', 'completed', 'failed')),
  watermark jsonb not null default '{}'::jsonb,
  fetched_count integer not null default 0 check (fetched_count >= 0),
  new_evidence_count integer not null default 0 check (new_evidence_count >= 0),
  duplicate_count integer not null default 0 check (duplicate_count >= 0),
  failed_count integer not null default 0 check (failed_count >= 0),
  started_at timestamptz,
  completed_at timestamptz,
  error_code text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index evidence_ingestion_jobs_lookup_idx
  on public.evidence_ingestion_jobs (source_type, ticker, created_at desc);

alter table public.evidence_ingestion_jobs enable row level security;

create policy evidence_ingestion_jobs_owner_read on public.evidence_ingestion_jobs
  for select using (exists (
    select 1 from public.analysts a
    where a.ticker = evidence_ingestion_jobs.ticker
      and (a.user_id = auth.uid() or a.is_public = true)
  ));
