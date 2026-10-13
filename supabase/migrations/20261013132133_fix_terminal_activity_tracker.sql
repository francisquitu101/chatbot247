-- Expose only recent event fields for enabled tickers, without requiring a public analyst record.
create or replace function public.get_public_terminal_activity(p_ticker text, p_since timestamptz default null)
returns table (
  event_id text,
  ticker text,
  event_type text,
  event_date text,
  event_date_only boolean,
  event_label text,
  received_at timestamptz,
  source_filed_at text,
  message text
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  with requested_ticker as (
    select upper(btrim(coalesce(p_ticker, ''))) as ticker
  ),
  enabled_ticker as (
    select stocks.ticker
    from public.tracked_stocks as stocks
    cross join requested_ticker as requested
    where stocks.enabled = true
      and stocks.ticker = requested.ticker
      and requested.ticker ~ '^[A-Z][A-Z0-9.-]{0,9}$'
  ),
  news_events as (
    select
      'news:' || items.id::text as event_id,
      items.ticker,
      'news'::text as event_type,
      case
        when items.metadata->>'source_event_date' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then items.metadata->>'source_event_date'
        when items.published_at is not null then to_char(items.published_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        else null
      end as event_date,
      coalesce(items.metadata->>'source_event_date' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$', false) as event_date_only,
      'Published'::text as event_label,
      items.created_at as received_at,
      null::text as source_filed_at,
      'Market article: ' || coalesce(nullif(btrim(items.title), ''), 'Untitled article') as message
    from public.scraped_items as items
    join enabled_ticker as enabled on enabled.ticker = items.ticker
    where items.item_type = 'news'
      and items.metadata->>'source' is distinct from 'SEC'
      and (p_since is null or items.created_at >= p_since)
    order by items.created_at desc
    limit case when p_since is null then 50 else 250 end
  ),
  filing_events as (
    select
      'filing:' || items.id::text as event_id,
      items.ticker,
      'filing'::text as event_type,
      coalesce(items.metadata->>'filingDate', (items.published_at at time zone 'UTC')::date::text) as event_date,
      true as event_date_only,
      'Filing date'::text as event_label,
      items.created_at as received_at,
      null::text as source_filed_at,
      'SEC filing filed: ' || coalesce(nullif(btrim(items.title), ''), 'Filing') as message
    from public.scraped_items as items
    join enabled_ticker as enabled on enabled.ticker = items.ticker
    where (
      items.metadata->>'source' = 'SEC'
      or items.metadata->>'accessionNumber' is not null
    )
      and (p_since is null or items.created_at >= p_since)
    order by items.created_at desc
    limit case when p_since is null then 50 else 250 end
  ),
  rating_events as (
    select
      'rating:' || ratings.id::text as event_id,
      ratings.ticker,
      'rating'::text as event_type,
      ratings.rating_date::text as event_date,
      true as event_date_only,
      'Rating date'::text as event_label,
      ratings.created_at as received_at,
      null::text as source_filed_at,
      'Analyst update' ||
        case when nullif(btrim(ratings.analyst), '') is not null then ' from ' || btrim(ratings.analyst) else '' end ||
        case
          when nullif(btrim(ratings.action), '') is not null
            or nullif(btrim(ratings.rating_change), '') is not null
            or nullif(btrim(ratings.price_target_change), '') is not null
          then ': ' || concat_ws(' · ',
            nullif(btrim(ratings.action), ''),
            nullif(btrim(ratings.rating_change), ''),
            nullif(btrim(ratings.price_target_change), '')
          )
          else ''
        end as message
    from public.finviz_analyst_ratings as ratings
    join enabled_ticker as enabled on enabled.ticker = ratings.ticker
    where p_since is null or ratings.created_at >= p_since
    order by ratings.created_at desc
    limit case when p_since is null then 50 else 250 end
  ),
  insider_events as (
    select
      'insider:' || trades.id::text as event_id,
      trades.ticker,
      'insider'::text as event_type,
      trades.transaction_date::text as event_date,
      true as event_date_only,
      'Transaction date'::text as event_label,
      trades.created_at as received_at,
      nullif(btrim(trades.form4_display_timestamp), '') as source_filed_at,
      'Insider action: ' || coalesce(nullif(btrim(trades.transaction), ''), 'Trade') ||
        ' by ' || coalesce(nullif(btrim(trades.insider_name), ''), 'unknown insider') as message
    from public.finviz_insider_trades as trades
    join enabled_ticker as enabled on enabled.ticker = trades.ticker
    where p_since is null or trades.created_at >= p_since
    order by trades.created_at desc
    limit case when p_since is null then 50 else 250 end
  ),
  activity as (
    select * from news_events
    union all select * from filing_events
    union all select * from rating_events
    union all select * from insider_events
  )
  select *
  from activity
  order by received_at desc nulls last, event_id
  limit 1000;
$$;

revoke all on function public.get_public_terminal_activity(text, timestamptz) from public;
grant execute on function public.get_public_terminal_activity(text, timestamptz) to anon, authenticated;

do $$
declare
  table_name text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach table_name in array array['scraped_items', 'finviz_insider_trades', 'finviz_analyst_ratings']
    loop
      if not exists (
        select 1
        from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = table_name
      ) then
        execute format('alter publication supabase_realtime add table public.%I', table_name);
      end if;
    end loop;
  end if;
end
$$;
