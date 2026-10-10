grant select, insert, update, delete on table public.user_watchlist to authenticated;

drop policy if exists "users can read their own watchlist" on public.user_watchlist;
drop policy if exists "users can insert their own watchlist" on public.user_watchlist;
drop policy if exists "users can update their own watchlist" on public.user_watchlist;
drop policy if exists "users can delete their own watchlist" on public.user_watchlist;

create policy "users can read their own watchlist"
  on public.user_watchlist
  for select
  to authenticated
  using (auth.uid() = user_id);

create policy "users can insert their own watchlist"
  on public.user_watchlist
  for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "users can update their own watchlist"
  on public.user_watchlist
  for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "users can delete their own watchlist"
  on public.user_watchlist
  for delete
  to authenticated
  using (auth.uid() = user_id);
