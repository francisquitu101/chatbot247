create extension if not exists "pgcrypto";

create table public.sources (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  enabled boolean not null default true
);

insert into public.sources (slug)
values ('finviz'), ('sec'), ('stocktwits')
on conflict (slug) do nothing;

create table public.tracked_stocks (
  id uuid primary key default gen_random_uuid(),
  ticker text not null unique,
  company_name text,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.scraped_items (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.sources(id),
  ticker text,
  title text,
  content text,
  author text,
  url text not null,
  published_at timestamptz,
  scraped_at timestamptz not null default now(),
  content_hash text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  item_type text not null
);

create unique index scraped_items_source_ticker_hash_key
  on public.scraped_items (source_id, ticker, content_hash);

create unique index scraped_items_source_ticker_url_key
  on public.scraped_items (source_id, ticker, url);

create index tracked_stocks_enabled_ticker_idx
  on public.tracked_stocks (enabled, ticker);

create index scraped_items_ticker_published_at_idx
  on public.scraped_items (ticker, published_at desc);

create index scraped_items_source_ticker_idx
  on public.scraped_items (source_id, ticker);
