alter table public.profiles
  add column is_pro boolean not null default false;

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  mp_preference_id text not null unique,
  mp_payment_id text,
  status text not null default 'pending',
  amount numeric(10, 2) not null check (amount >= 0),
  created_at timestamptz not null default now()
);

create index orders_user_id_created_at_idx
  on public.orders (user_id, created_at desc);

alter table public.profiles enable row level security;
alter table public.orders enable row level security;

drop policy if exists profiles_own_read_write on public.profiles;
drop policy if exists profiles_own_read on public.profiles;
create policy profiles_own_read
  on public.profiles
  for select
  to authenticated
  using (auth.uid() = id);

create policy profiles_own_insert
  on public.profiles
  for insert
  to authenticated
  with check (auth.uid() = id);

create policy profiles_own_update
  on public.profiles
  for update
  to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);

create policy orders_own_read
  on public.orders
  for select
  to authenticated
  using (auth.uid() = user_id);

revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;
grant insert (id, full_name, avatar_url) on public.profiles to authenticated;
grant update (full_name, avatar_url) on public.profiles to authenticated;

revoke all on public.orders from anon, authenticated;
grant select on public.orders to authenticated;
grant all on public.orders to service_role;

create or replace function public.complete_pro_order(
  p_order_id uuid,
  p_payment_id text,
  p_amount numeric,
  p_currency_id text
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
  recorded_payment_id text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service role required';
  end if;

  select user_id, amount, status, mp_payment_id
  into order_user_id, order_amount, order_status, recorded_payment_id
  from public.orders
  where id = p_order_id
  for update;

  if not found then
    raise exception 'order not found';
  end if;
  if p_payment_id is null or p_payment_id = '' or p_currency_id is distinct from 'USD' or p_amount is distinct from order_amount then
    raise exception 'payment does not match order';
  end if;
  if order_status = 'completed' then
    if recorded_payment_id = p_payment_id then
      return;
    end if;
    raise exception 'order already completed with a different payment';
  end if;
  if order_status <> 'pending' then
    raise exception 'order is not pending';
  end if;

  update public.orders
  set status = 'completed', mp_payment_id = p_payment_id
  where id = p_order_id;

  insert into public.profiles (id, is_pro)
  values (order_user_id, true)
  on conflict (id) do update
  set is_pro = true;
end;
$$;

revoke all on function public.complete_pro_order(uuid, text, numeric, text) from public, anon, authenticated;
grant execute on function public.complete_pro_order(uuid, text, numeric, text) to service_role;