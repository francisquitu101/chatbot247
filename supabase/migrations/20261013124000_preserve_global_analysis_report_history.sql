alter table public.global_ticker_analysis_reports
  add column id uuid not null default gen_random_uuid();

alter table public.global_ticker_analysis_reports
  drop constraint global_ticker_analysis_reports_pkey;

alter table public.global_ticker_analysis_reports
  add constraint global_ticker_analysis_reports_pkey primary key (id);

create index if not exists global_ticker_analysis_reports_ticker_created_at_idx
  on public.global_ticker_analysis_reports (ticker, created_at desc);
