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
  if p_payment_id is null or p_payment_id = '' or p_currency_id is distinct from 'CLP' or p_amount is distinct from order_amount then
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
