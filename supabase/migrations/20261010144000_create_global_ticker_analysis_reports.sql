create table if not exists public.global_ticker_analysis_reports (
  ticker text primary key,
  analysis jsonb not null check (jsonb_typeof(analysis) = 'object'),
  bibliography jsonb not null check (jsonb_typeof(bibliography) = 'array'),
  data_counts jsonb not null check (jsonb_typeof(data_counts) = 'object'),
  generated_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint global_ticker_analysis_reports_ticker_check
    check (ticker ~ '^[A-Z][A-Z0-9.-]{0,9}$')
);

create index if not exists global_ticker_analysis_reports_generated_at_idx
  on public.global_ticker_analysis_reports (generated_at desc);

alter table public.global_ticker_analysis_reports enable row level security;

create policy "authenticated users can read global ticker analysis reports"
  on public.global_ticker_analysis_reports
  for select
  to authenticated
  using (true);

grant select on public.global_ticker_analysis_reports to authenticated;
grant all on public.global_ticker_analysis_reports to service_role;
