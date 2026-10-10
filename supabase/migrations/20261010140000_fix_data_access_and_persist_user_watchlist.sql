grant select on table public.scraped_items to authenticated;

drop policy if exists "authenticated users can read scraped items" on public.scraped_items;
create policy "authenticated users can read scraped items"
  on public.scraped_items
  for select
  to authenticated
  using (true);

create table public.user_watchlist (
  user_id uuid not null references auth.users(id) on delete cascade,
  ticker text not null references public.tracked_stocks(ticker) on update cascade on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, ticker)
);

create index user_watchlist_user_created_idx
  on public.user_watchlist (user_id, created_at);

alter table public.user_watchlist enable row level security;
grant select on table public.user_watchlist to authenticated;
grant all on table public.user_watchlist to service_role;

create policy "users can read their own watchlist"
  on public.user_watchlist
  for select
  to authenticated
  using (auth.uid() = user_id);
