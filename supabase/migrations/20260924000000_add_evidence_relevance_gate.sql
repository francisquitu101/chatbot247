alter table public.evidence_items
  add column if not exists relevance_priority text not null default 'normal'
    check (relevance_priority in ('ignored', 'low', 'normal', 'high', 'critical')),
  add column if not exists relevance_score integer not null default 50
    check (relevance_score between 0 and 100),
  add column if not exists relevance_reason text,
  add column if not exists relevance_classified_at timestamptz;

create index evidence_items_relevance_idx
  on public.evidence_items (ticker, source_type, relevance_priority, relevance_score desc);

alter table public.analyst_jobs
  add column if not exists job_reason text,
  add column if not exists cancel_reason text;

create index analyst_jobs_relevance_status_idx
  on public.analyst_jobs (status, cancel_reason, created_at desc);
