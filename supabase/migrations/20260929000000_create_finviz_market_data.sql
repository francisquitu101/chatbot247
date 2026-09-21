create table if not exists public.finviz_market_data (
  id uuid primary key default gen_random_uuid(),
  ticker text not null,
  price numeric,
  change_value numeric,
  change_pct numeric,
  volume numeric,
  avg_volume numeric,
  market_cap numeric,
  pe numeric,
  forward_pe numeric,
  eps_growth numeric,
  sales_growth numeric,
  beta numeric,
  high_52w numeric,
  low_52w numeric,
  insider_ownership numeric,
  institutional_ownership numeric,
  source text not null default 'FINVIZ',
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint finviz_market_data_ticker_check check (length(btrim(ticker)) > 0)
);

create index if not exists finviz_market_data_ticker_updated_idx
  on public.finviz_market_data (ticker, updated_at desc);

create index if not exists finviz_market_data_source_idx
  on public.finviz_market_data (source);

alter table public.finviz_market_data enable row level security;

create policy if not exists "authenticated users can read Finviz market data"
  on public.finviz_market_data
  for select
  to authenticated
  using (true);
