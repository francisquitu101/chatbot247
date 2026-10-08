grant select on table public.tracked_stocks to authenticated;

do $migration$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'tracked_stocks'
      and policyname = 'authenticated users can read tracked stocks'
  ) then
    execute 'create policy "authenticated users can read tracked stocks"
      on public.tracked_stocks
      for select
      to authenticated
      using (true)';
  end if;
end
$migration$;