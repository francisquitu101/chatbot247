alter table public.orders
  rename column mp_preference_id to paypal_order_id;

alter table public.orders
  rename column mp_payment_id to paypal_capture_id;

alter table public.orders
  rename constraint orders_mp_preference_id_key to orders_paypal_order_id_key;

drop function public.complete_pro_order(uuid, text, numeric, text);

create function public.complete_paypal_order(
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

  insert into public.profiles (id, is_pro)
  values (order_user_id, true)
  on conflict (id) do update
  set is_pro = true;
end;
$$;

revoke all on function public.complete_paypal_order(uuid, text, numeric, text) from public, anon, authenticated;
grant execute on function public.complete_paypal_order(uuid, text, numeric, text) to service_role;
