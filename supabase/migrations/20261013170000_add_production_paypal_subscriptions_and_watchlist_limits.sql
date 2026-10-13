alter table public.profiles
  add column if not exists legacy_pro_access boolean not null default false;

update public.profiles
set legacy_pro_access = is_pro
where is_pro and not legacy_pro_access;

create or replace function public.complete_paypal_order(
  p_order_id uuid,
  p_capture_id text,
  p_amount numeric,
  p_currency_code text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  order_user_id uuid;
  order_amount numeric(10, 2);
  order_status text;
  recorded_capture_id text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service role required';
  end if;

  select user_id, amount, status, paypal_capture_id
  into order_user_id, order_amount, order_status, recorded_capture_id
  from public.orders
  where id = p_order_id
  for update;

  if not found then
    raise exception 'order not found';
  end if;
  if p_capture_id is null
    or p_capture_id = ''
    or p_currency_code is distinct from 'USD'
    or p_amount is distinct from order_amount
  then
    raise exception 'payment does not match order';
  end if;
  if order_status = 'completed' then
    if recorded_capture_id = p_capture_id then
      return;
    end if;
    raise exception 'order already completed with a different capture';
  end if;
  if order_status <> 'pending' then
    raise exception 'order is not pending';
  end if;

  update public.orders
  set status = 'completed', paypal_capture_id = p_capture_id
  where id = p_order_id;

  insert into public.profiles (id, is_pro, legacy_pro_access)
  values (order_user_id, true, true)
  on conflict (id) do update
    set is_pro = true,
        legacy_pro_access = true;
end;
$$;

revoke all on function public.complete_paypal_order(uuid, text, numeric, text)
  from public, anon, authenticated;
grant execute on function public.complete_paypal_order(uuid, text, numeric, text)
  to service_role;

create table public.pro_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  paypal_subscription_id text not null unique,
  paypal_plan_id text not null,
  status text not null check (
    status in ('approval_pending', 'active', 'suspended', 'cancelled', 'expired')
  ),
  current_period_end timestamptz,
  last_event_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index pro_subscriptions_one_open_per_user_idx
  on public.pro_subscriptions (user_id)
  where status in ('approval_pending', 'active', 'suspended');

create index pro_subscriptions_user_created_idx
  on public.pro_subscriptions (user_id, created_at desc);

alter table public.pro_subscriptions enable row level security;
revoke all on public.pro_subscriptions from anon, authenticated;
grant select on public.pro_subscriptions to authenticated;
grant all on public.pro_subscriptions to service_role;

create policy pro_subscriptions_own_read
  on public.pro_subscriptions
  for select
  to authenticated
  using (auth.uid() = user_id);

create table public.paypal_webhook_events (
  event_id text primary key,
  subscription_id text not null,
  event_type text not null,
  event_at timestamptz not null,
  received_at timestamptz not null default now()
);

alter table public.paypal_webhook_events enable row level security;
revoke all on public.paypal_webhook_events from public, anon, authenticated;
grant all on public.paypal_webhook_events to service_role;

create or replace function public.enforce_user_watchlist_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  user_is_pro boolean := false;
  ticker_limit integer;
  ticker_count integer;
begin
  if tg_op = 'UPDATE'
    and old.user_id = new.user_id
    and old.ticker = new.ticker
  then
    return new;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(new.user_id::text, 0)
  );

  if exists (
    select 1
    from public.user_watchlist
    where user_id = new.user_id
      and ticker = new.ticker
  ) then
    return new;
  end if;

  select coalesce(p.is_pro, false)
  into user_is_pro
  from public.profiles p
  where p.id = new.user_id;

  ticker_limit := case when user_is_pro then 10 else 3 end;

  select count(*)::integer
  into ticker_count
  from public.user_watchlist
  where user_id = new.user_id
    and (
      tg_op <> 'UPDATE'
      or old.user_id <> new.user_id
      or ticker <> old.ticker
    );

  if ticker_count >= ticker_limit then
    raise exception using
      errcode = 'P0001',
      message = 'WATCHLIST_LIMIT_REACHED',
      detail = pg_catalog.format(
        'This plan allows up to %s watchlist tickers.',
        ticker_limit
      );
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_user_watchlist_limit() from public, anon, authenticated;

create trigger enforce_user_watchlist_limit_before_write
  before insert or update on public.user_watchlist
  for each row execute function public.enforce_user_watchlist_limit();

create or replace function public.add_ticker_to_user_watchlist(
  p_user_id uuid,
  p_ticker text
)
returns public.tracked_stocks
language plpgsql
security definer
set search_path = ''
as $$
declare
  tracked_stock public.tracked_stocks;
  user_is_pro boolean := false;
  ticker_limit integer;
  ticker_count integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service role required';
  end if;

  if p_ticker is null or p_ticker !~ '^[A-Z0-9.^=-]{1,20}$' then
    raise exception 'INVALID_WATCHLIST_TICKER';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_user_id::text, 0)
  );

  select ts.*
  into tracked_stock
  from public.user_watchlist uw
  join public.tracked_stocks ts on ts.ticker = uw.ticker
  where uw.user_id = p_user_id
    and uw.ticker = p_ticker;

  if found then
    return tracked_stock;
  end if;

  select coalesce(p.is_pro, false)
  into user_is_pro
  from public.profiles p
  where p.id = p_user_id;

  ticker_limit := case when user_is_pro then 10 else 3 end;

  select count(*)::integer
  into ticker_count
  from public.user_watchlist
  where user_id = p_user_id;

  if ticker_count >= ticker_limit then
    raise exception using
      errcode = 'P0001',
      message = 'WATCHLIST_LIMIT_REACHED',
      detail = pg_catalog.format(
        'This plan allows up to %s watchlist tickers.',
        ticker_limit
      );
  end if;

  insert into public.tracked_stocks (ticker, enabled)
  values (p_ticker, true)
  on conflict (ticker) do update
    set enabled = true
  returning * into tracked_stock;

  insert into public.user_watchlist (user_id, ticker)
  values (p_user_id, p_ticker)
  on conflict (user_id, ticker) do nothing;

  return tracked_stock;
end;
$$;

revoke all on function public.add_ticker_to_user_watchlist(uuid, text)
  from public, anon, authenticated;
grant execute on function public.add_ticker_to_user_watchlist(uuid, text)
  to service_role;

create or replace function public.apply_paypal_subscription_event(
  p_event_id text,
  p_subscription_id text,
  p_event_type text,
  p_status text,
  p_event_at timestamptz,
  p_current_period_end timestamptz default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  subscription_user_id uuid;
  subscription_last_event_at timestamptz;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service role required';
  end if;

  if p_status not in ('approval_pending', 'active', 'suspended', 'cancelled', 'expired') then
    raise exception 'INVALID_PAYPAL_SUBSCRIPTION_STATUS';
  end if;

  select user_id, last_event_at
  into subscription_user_id, subscription_last_event_at
  from public.pro_subscriptions
  where paypal_subscription_id = p_subscription_id
  for update;

  if not found then
    raise exception 'PAYPAL_SUBSCRIPTION_NOT_FOUND';
  end if;

  if p_event_id is not null then
    insert into public.paypal_webhook_events (
      event_id,
      subscription_id,
      event_type,
      event_at
    )
    values (
      p_event_id,
      p_subscription_id,
      p_event_type,
      coalesce(p_event_at, now())
    )
    on conflict (event_id) do nothing;

    if not found then
      return;
    end if;
  end if;

  if p_event_at is null
    or subscription_last_event_at is null
    or p_event_at >= subscription_last_event_at
  then
    update public.pro_subscriptions
    set status = p_status,
        current_period_end = coalesce(p_current_period_end, current_period_end),
        last_event_at = coalesce(p_event_at, last_event_at),
        updated_at = now()
    where paypal_subscription_id = p_subscription_id;

    insert into public.profiles (id, is_pro)
    values (
      subscription_user_id,
      exists (
        select 1
        from public.pro_subscriptions
        where user_id = subscription_user_id
          and status = 'active'
      )
      or exists (
        select 1
        from public.profiles
        where id = subscription_user_id
          and legacy_pro_access
      )
    )
    on conflict (id) do update
      set is_pro = excluded.is_pro;
  end if;
end;
$$;

revoke all on function public.apply_paypal_subscription_event(
  text, text, text, text, timestamptz, timestamptz
) from public, anon, authenticated;
grant execute on function public.apply_paypal_subscription_event(
  text, text, text, text, timestamptz, timestamptz
) to service_role;
